// Provider failover, captain resume, missing outcome lines, and idle alerts for
// finished crews (fleet audit 2026-10-07).
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createDeliveries } from "./lib/pr-delivery.ts";
import { UPSTREAM_SKILL_NAMES } from "./lib/upstream-surface.ts";
import { quietStaleVerdict, staleQueueRows } from "./lib/finished-crew-wakes.ts";
import { planLimitError, planLimitNotice, PROVIDER_UNAVAILABLE_KEY, unavailableProviderLines, unavailableUntil } from "./lib/provider-failover.ts";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SKILLS = [...new Set(["captain", "firstmate", "skill-routing", ...UPSTREAM_SKILL_NAMES])];
type Host = ReturnType<typeof createFakePluginHost>;

async function load() {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS });
  await plugin(host.bb);
  return host;
}

function shipRow(id: string, threadId: string, parentThreadId: string | null) {
  return { id, task: "fix login", projectId: "proj_1", threadId, parentThreadId, providerId: null, model: null, reasoningLevel: null,
    worktree: true, shape: "ship" as const, posture: "direct-PR", createdAt: "2026-09-18T00:00:00.000Z" };
}

async function seedCrew(host: Host) {
  await host.bb.storage.kv.set("crews", [{ ...shipRow("c1", "thr_crew", "thr_cap"), posture: "local-only" }]);
}

function sendCalls(host: Host) {
  return host.harness.sdk.callsTo("threads.send").map((call) => {
    const args = call[0] as { threadId?: string; input?: Array<{ text?: string }> };
    return { threadId: args.threadId, text: args.input?.[0]?.text ?? "" };
  });
}

function stubIdleSdk(host: Host) {
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_crew", status: "idle", environmentId: null }));
}

function emitIdle(host: Host, lastAssistantText: string | null) {
  return host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: "thr_crew", status: "idle", projectId: "proj_1" }),
    lastAssistantText,
  });
}

function wakeFrame(report: string): string {
  return "FM_BB_RECEIPT=" + JSON.stringify({ id: "fixture", phase: "ready", report, path: "/tmp/report.txt", replayed: false, truncated: false });
}

function hostRcPayload(payload: string, code = 0) {
  return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${payload}\n__FM_HOST_RC:${code}\n`).toString("base64") }] };
}

// Terminal output routed by command text; records every command the plugin ran.
function stubRoutedHost(host: Host, router: (cmd: string) => { payload?: string; code?: number }) {
  const cmds = new Map<string, string>();
  const seen: string[] = [];
  let n = 0;
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_crew", status: "active", environmentId: null }));
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
    const id = `t_${++n}`;
    const cmd = args.start?.command ?? "";
    cmds.set(id, cmd);
    seen.push(cmd);
    return { id };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
    const cmd = cmds.get(args.terminalId) ?? "";
    const r = router(cmd);
    const payload = r.payload ?? (cmd.includes("fm-bearings-snapshot.sh")
      ? JSON.stringify({ schema: "fm-bearings.v1", home: "/tmp/fm-home", in_flight: [], decisions_open: [], landed: [], gates: [], omitted: [] })
      : "");
    if (cmd.includes("FM_HOST_CAPTURE_V1")) return hostRcPayload(JSON.stringify({ protocol: "FM_HOST_CAPTURE_V1", exitCode: r.code ?? 0, stdout: payload, stderr: "" }), 0);
    return hostRcPayload(payload, r.code ?? 0);
  });
  return { seen };
}

// ---------------------------------------------------------------------------

function turnFailed(threadId: string, errorInfo: { category: string; httpStatusCode: number | null; providerCode: string | null } | null, attemptNumber = 1) {
  return { threadId, requestId: `req_${threadId}_${attemptNumber}`, turnId: null, errorInfo, inputAccepted: false, rateLimits: null, attemptNumber } as const;
}
const POOL_429 = { category: "rate-limit", httpStatusCode: 429, providerCode: null };
const AT_CAPACITY = { category: "overloaded", httpStatusCode: null, providerCode: "serverOverloaded" };

async function failoverHost(catalog: Array<{ id: string; available?: boolean }>) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { supervisionEnabled: true } });
  await plugin(host.bb);
  await host.bb.storage.kv.set("crews", [{ ...shipRow("c1", "thr_crew", "thr_cap"), providerId: "claude-code", model: "claude-opus-5-5" }]);
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.stop", async () => ({}));
  host.harness.sdk.stub("threads.archive", async () => ({}));
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => threadId === "thr_cap"
    ? makeThreadResponse({ id: "thr_cap", status: "idle", providerId: "claude-code", projectId: "proj_1" })
    : makeThreadResponse({ id: threadId, status: "error", providerId: "claude-code", environmentId: "env_wt", projectId: "proj_1", parentThreadId: "thr_cap" }));
  host.harness.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: "claude-opus-5-5", reasoningLevel: null, permissionMode: "auto" }));
  host.harness.sdk.stub("projects.defaultExecutionOptions", async () => ({ providerId: "claude-code", model: "claude-opus-5-5" }));
  host.harness.sdk.stub("environments.get", async () => ({ id: "env_wt", hostId: "host_1", status: "ready", path: "/repo/isolated", isWorktree: true }));
  host.harness.sdk.stub("providers.list", async () => catalog);
  host.harness.sdk.stub("providers.models", async ({ providerId }: { providerId: string }) => ({ models: [{ id: `${providerId}-default`, model: `${providerId}-default`, isDefault: true }] }));
  host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_crew2" }));
  return host;
}

test("a crew whose turn fails on an exhausted provider pool is relaunched once on another provider in the same worktree", async () => {
  const host = await failoverHost([{ id: "claude-code", available: true }, { id: "acp-antigravity", available: true }, { id: "codex", available: true }]);
  try {
    const emitted = await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_crew", POOL_429));
    assert.deepEqual(emitted.errors, []);
    const spawns = host.harness.sdk.callsTo("threads.spawn");
    assert.equal(spawns.length, 1, "one replacement worker");
    const args = spawns[0]![0] as { providerId?: string; model?: string; prompt: string; environment?: { type?: string; environmentId?: string } };
    assert.equal(args.providerId, "codex", "a ship crew skips the failed provider and acp-antigravity");
    assert.equal(args.model, "codex-default");
    assert.deepEqual(args.environment, { type: "reuse", environmentId: "env_wt" });
    assert.match(args.prompt, /re-verify/i);
    const crews = (await host.bb.storage.kv.get("crews")) as Array<{ threadId: string; providerId: string | null }>;
    assert.equal(crews[0]?.threadId, "thr_crew2");
    assert.ok(sendCalls(host).some((s) => s.threadId === "thr_cap" && /codex/.test(s.text)), "the captain is told where the crew moved");

    await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_crew2", AT_CAPACITY));
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1, "at most one failover per crew per hour");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a model-at-capacity failure also fails over, and a non-capacity failure does not", async () => {
  const host = await failoverHost([{ id: "claude-code", available: true }, { id: "codex", available: true }]);
  try {
    await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_crew", { category: "bad-request", httpStatusCode: 400, providerCode: null }));
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0, "a bad request is the captain's call");
    await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_crew", AT_CAPACITY));
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a ship crew with only acp-antigravity left is not failed over", async () => {
  const host = await failoverHost([{ id: "claude-code", available: true }, { id: "acp-antigravity", available: true }, { id: "codex", available: false }]);
  try {
    await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_crew", POOL_429));
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a captain turn that fails on an exhausted pool is retried after 2, 5 and 10 minutes, then left for the owner", async () => {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("threads.retry", async () => ({}));
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_cap", status: "error", projectId: "proj_1" }));
    const delays: number[] = [];
    for (let attempt = 1; attempt <= 4; attempt++) {
      const before = Date.now();
      const emitted = await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_cap", POOL_429, attempt));
      assert.deepEqual(emitted.errors, []);
      const calls = host.harness.sdk.callsTo("threads.retry");
      if (calls.length === delays.length) continue;
      const args = calls.at(-1)![0] as { threadId: string; sendAt?: number };
      assert.equal(args.threadId, "thr_cap");
      delays.push(Math.round(((args.sendAt ?? 0) - before) / 60_000));
    }
    assert.deepEqual(delays, [2, 5, 10], "three bounded retries, none after the third");
    await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_cap", { category: "unauthorized", httpStatusCode: 401, providerCode: null }));
    assert.equal(host.harness.sdk.callsTo("threads.retry").length, 3, "an auth failure is not a pool outage");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a captain that completes a turn after a pool outage gets a fresh retry budget", async () => {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("threads.retry", async () => ({}));
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_cap", status: "idle", projectId: "proj_1" }));
    for (let attempt = 1; attempt <= 3; attempt++) await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_cap", POOL_429, attempt));
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle", projectId: "proj_1" }), lastAssistantText: "Captain, back." });
    const before = Date.now();
    await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_cap", POOL_429));
    const calls = host.harness.sdk.callsTo("threads.retry");
    assert.equal(calls.length, 4);
    assert.equal(Math.round((((calls.at(-1)![0] as { sendAt: number }).sendAt) - before) / 60_000), 2);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a crew turn that ends without an outcome line gets one steer asking for it, once", async () => {
  const host = await load();
  try {
    stubIdleSdk(host);
    await host.harness.behavior.setSettings({ supervisionEnabled: true, nudgeEnabled: false });
    await seedCrew(host);
    await emitIdle(host, "I pushed the fix and opened the PR.");
    const asks = () => sendCalls(host).filter((s) => s.threadId === "thr_crew");
    assert.equal(asks().length, 1);
    assert.match(asks()[0]!.text, /DONE:/);
    assert.match(asks()[0]!.text, /BLOCKED:/);
    assert.match(asks()[0]!.text, /WAITING:/);
    await emitIdle(host, "The PR is open.");
    assert.equal(asks().length, 1, "the answer turn is not asked again");
    await emitIdle(host, "DONE: PR opened");
    assert.equal(asks().length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a native crew without an outcome line is asked once and shows as no outcome in bearings until it answers", async () => {
  const host = createFakePluginHost({
    pluginId: "firstmate", agentSkillIds: SKILLS,
    settings: { fmHome: "/tmp/fm-home", fmHostId: "host_1", watchOwner: "fm-watch", supervisionEnabled: true },
  });
  await plugin(host.bb);
  try {
    const { seen } = stubRoutedHost(host, () => ({}));
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.events.list", async () => []);
    host.harness.sdk.stub("threads.queuedMessages.list", async () => []);
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", projectId: "proj_1", environmentId: null }));
    await host.bb.storage.kv.set("crews", [{ ...shipRow("c1", "thr_crew", "thr_cap"), nativeHome: "/tmp/fm-home" }]);
    await emitIdle(host, "The pull request is open and ready for review.");
    const asked = () => seen.filter((cmd) => cmd.includes("c1") && /outcome line/i.test(cmd)).length + sendCalls(host).filter((s) => s.threadId === "thr_crew" && /outcome line/i.test(s.text)).length;
    assert.ok(asked() >= 1, "the crew is asked for its outcome line");
    const before = asked();
    let bearings = await host.harness.behavior.runCli(["bearings"], { projectId: "proj_1", threadId: "thr_cap" });
    assert.equal(bearings.exitCode, 0, bearings.stderr);
    assert.match(bearings.stdout, /c1[^\n]*no outcome/);
    await emitIdle(host, "Still checking.");
    assert.equal(asked(), before, "one ask per turn that was not itself the answer");
    await emitIdle(host, "DONE: PR open https://github.com/acme/repo/pull/1");
    bearings = await host.harness.behavior.runCli(["bearings"], { projectId: "proj_1", threadId: "thr_cap" });
    assert.doesNotMatch(bearings.stdout, /c1[^\n]*no outcome/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

const WAKE_ROWS = [
  "1791366841\t127\tstale\tbb:thr_c1\tstale: bb:thr_c1 (idle 451s, possible wedge, escalation 4)",
  "1791366842\t128\tcheck\tinactive-outcome:0ab9\tinactive terminal outcome awaiting captain presentation: child=c1 state=done",
  "1791366843\t129\tstale\tbb:thr_c2\tstale: bb:thr_c2 (idle 300s, possible wedge, escalation 1)",
];
function finishedCrewRouter(extra: (cmd: string) => string | null = () => null) {
  return (cmd: string) => {
    const hit = extra(cmd);
    if (hit !== null) return { payload: hit };
    if (cmd.includes("/state/c1.status") || cmd.includes("/state/c2.status")) {
      return { payload: "@@FM_STATUS c1\nworking: building\ndone: PR open https://github.com/acme/repo/pull/1\n@@FM_STATUS c2\nworking: rebasing on main" };
    }
    return { payload: wakeFrame([...WAKE_ROWS, "WAKE_ACK_REQUIRED: after handling completes run bin/fm-wake-drain.sh --ack-through 129 --recovery-generation g1"].join("\n")) };
  };
}
function trackPrs(host: Host) {
  const store = createDeliveries(host.bb.storage.database());
  store.register({ url: "https://github.com/acme/repo/pull/1", taskId: "c1", projectId: "proj_1", owner: "thr_cap", home: "/tmp/fm-home", worker: "thr_c1", requirement: "merged" });
  store.register({ url: "https://github.com/acme/repo/pull/2", taskId: "c2", projectId: "proj_1", owner: "thr_cap", home: "/tmp/fm-home", worker: "thr_c2", requirement: "merged" });
}

test("a wake drain hides idle alerts for a DONE crew whose PR the tracker owns, and keeps the rest", async () => {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { fmHome: "/tmp/fm-home", notifyOwner: "real", fmHostId: "host_1" } });
  await plugin(host.bb);
  try {
    stubRoutedHost(host, finishedCrewRouter());
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }));
    trackPrs(host);
    const result = await host.harness.behavior.runCli(["wake"], { projectId: "proj_1", threadId: "thr_cap" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.doesNotMatch(result.stdout, /thr_c1/);
    assert.doesNotMatch(result.stdout, /child=c1/);
    assert.match(result.stdout, /stale: bb:thr_c2/, "a crew that is not DONE keeps its alert");
    assert.match(result.stdout, /WAKE_RECEIPT: fixture/, "the receipt still covers the hidden rows");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an inactive-outcome check for a DONE crew whose PR the tracker owns does not wake the captain", async () => {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { fmHome: "/tmp/fm-home", watchOwner: "fm-watch", fmHostId: "host_1" } });
  await plugin(host.bb);
  try {
    stubRoutedHost(host, finishedCrewRouter((cmd) => cmd.includes("FM_BEAT_AGE")
      ? "FM_BEAT_AGE=5\nFM_RELAUNCHED=0\n---FM_LOGTAIL---\ncheck: inactive-outcome"
      : cmd.includes(".wake-queue") ? WAKE_ROWS[1]! : null));
    host.harness.sdk.stub("environments.list", async () => []);
    await host.bb.storage.kv.set("crews", []);
    await host.bb.storage.kv.set("fm-watch-captain:host_1", "thr_cap");
    trackPrs(host);
    const dropped = () => host.harness.logEntries.some((e) => /inactive-outcome/.test(e.message) && /finished/.test(e.message));
    const run = host.harness.behavior.runService("fm-watch-supervisor");
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline && !dropped() && sendCalls(host).length === 0) await new Promise((r) => setTimeout(r, 10));
    run.controller.abort();
    await run.done;
    assert.equal(sendCalls(host).filter((s) => s.threadId === "thr_cap").length, 0, "no captain wake");
    assert.ok(dropped(), "the relay logs why it dropped the check");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a wake drain keeps the wedge alert of a DONE crew that was steered back to work", async () => {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { fmHome: "/tmp/fm-home", notifyOwner: "real", fmHostId: "host_1" } });
  await plugin(host.bb);
  try {
    stubRoutedHost(host, finishedCrewRouter());
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: threadId === "thr_c1" ? "active" : "idle" }));
    trackPrs(host);
    const result = await host.harness.behavior.runCli(["wake"], { projectId: "proj_1", threadId: "thr_cap" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /stale: bb:thr_c1/);
    assert.doesNotMatch(result.stdout, /child=c1/, "the finished outcome row is still hidden");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a pool outage reported only in the error text still fails over, with the new provider's default reasoning level when it lacks the old one", async () => {
  const host = await failoverHost([{ id: "claude-code", available: true }, { id: "codex", available: true }]);
  try {
    await host.bb.storage.kv.set("crews", [{ ...shipRow("c1", "thr_crew", "thr_cap"), providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "max" }]);
    host.harness.sdk.stub("providers.list", async () => [{ id: "claude-code", available: true }, { id: "codex", available: true, reasoningLevels: [{ id: "medium", isDefault: true }, { id: "high" }] }]);
    host.harness.sdk.stub("threads.events.list", async () => [{ type: "provider/error", data: { message: "Provider error", detail: "API Error: Request rejected (429) · No Account Pooler account is currently eligible." } }]);
    await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_crew", { category: "unknown", httpStatusCode: null, providerCode: null }));
    const spawns = host.harness.sdk.callsTo("threads.spawn");
    assert.equal(spawns.length, 1);
    assert.equal((spawns[0]![0] as { reasoningLevel?: string }).reasoningLevel, "medium", "max is not offered by codex, so its default is used");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a refused failover is reported to the captain as a decision", async () => {
  const host = await failoverHost([{ id: "claude-code", available: true }, { id: "codex", available: true }]);
  try {
    await host.bb.storage.kv.set("crews", [{ ...shipRow("c1", "thr_crew", "thr_cap"), providerId: "claude-code", relaunches: 1 }]);
    await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_crew", POOL_429));
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
    assert.ok(sendCalls(host).some((s) => s.threadId === "thr_cap" && /failover to codex was refused/.test(s.text)));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// ---------------------------------------------------------------------------
// False alerts, forgotten crews, repeated completions and lost acknowledgements
// (crews of 2026-10-09).

const idleCrew = { forgotten: false, threadStatus: "idle", archived: false, statusVerb: null, lastMessage: null } as const;

test("a stale row is a false alert only for a resting crew that declared a wait, finished, or was forgotten", () => {
  assert.equal(quietStaleVerdict({ ...idleCrew, statusVerb: "paused" }), "declared-wait");
  assert.equal(quietStaleVerdict({ ...idleCrew, lastMessage: "waiting" }), "declared-wait");
  assert.equal(quietStaleVerdict({ ...idleCrew, statusVerb: "resolved", lastMessage: "waiting" }), "declared-wait");
  assert.equal(quietStaleVerdict({ ...idleCrew, statusVerb: "done" }), "finished");
  assert.equal(quietStaleVerdict({ ...idleCrew, lastMessage: "done" }), "finished");
  assert.equal(quietStaleVerdict({ ...idleCrew, archived: true, threadStatus: null, statusVerb: "done" }), "finished");
  assert.equal(quietStaleVerdict({ ...idleCrew, forgotten: true, threadStatus: "active" }), "forgotten");
  assert.equal(quietStaleVerdict(idleCrew), "surface", "no declaration and no outcome still surfaces");
  assert.equal(quietStaleVerdict({ ...idleCrew, statusVerb: "working" }), "surface");
  assert.equal(quietStaleVerdict({ ...idleCrew, statusVerb: "working", lastMessage: "waiting" }), "surface", "the status file wins over chat");
  assert.equal(quietStaleVerdict({ ...idleCrew, statusVerb: "blocked" }), "surface");
  assert.equal(quietStaleVerdict({ ...idleCrew, threadStatus: "active", statusVerb: "paused" }), "surface", "a running thread can still be wedged");
  assert.equal(quietStaleVerdict({ ...idleCrew, threadStatus: null, statusVerb: "paused" }), "surface", "an unreadable thread keeps its alert");
  assert.deepEqual(staleQueueRows([
    "1791366841\t7\tstale\tbb:thr_a\tstale: bb:thr_a (idle 451s, possible wedge, escalation 4)",
    "1791366842\t8\tsignal\tc1.status\tcrew c1 update",
    "1791366843\t9\tstale\tbb:thr_b\tstale: bb:thr_b",
    "not a row",
  ].join("\n")), [{ seq: 7, threadId: "thr_a" }, { seq: 9, threadId: "thr_b" }]);
});

const QUEUE_ROWS = [
  "1791366841\t1\tstale\tbb:thr_w\tstale: bb:thr_w (idle 317s, possible wedge, escalation 2)",
  "1791366842\t2\tstale\tbb:thr_d\tstale: bb:thr_d (idle 314s, possible wedge, escalation 1)",
  "1791366843\t3\tstale\tbb:thr_f\tstale: bb:thr_f (idle 339s, agent missing - the recorded endpoint is gone, so this is not a wedge)",
  "1791366844\t4\tstale\tbb:thr_u\tstale: bb:thr_u (idle 300s, possible wedge, escalation 1)",
  "1791366845\t5\tstale\tbb:thr_r\tstale: bb:thr_r (idle 300s, possible wedge, escalation 1)",
  "1791366846\t6\tsignal\tcu.status\tcrew cu update",
];
const QUIET_STATUS: Record<string, string> = {
  cw: "working [at=1]: started\npaused [at=5]: waiting for the six CI jobs\nnote: FM_DELIVERY_NOTICE=acme/repo#1:abc PR observation.",
  cd: "working [at=1]: started\ndone [at=9]: PR https://github.com/acme/repo/pull/2\nnote: FM_DELIVERY_NOTICE=acme/repo#2:def PR observation.",
  cu: "working [at=1]: started",
  cr: "paused [at=5]: waiting for CI",
};
async function seedQuietCrews(host: Host, home: string) {
  await host.bb.storage.kv.set("crews", ["cw", "cd", "cu", "cr"].map((id) => ({ ...shipRow(id, `thr_${id.slice(1)}`, "thr_cap"), nativeHome: home })));
  await host.bb.storage.kv.set("forgotten-crew:thr_f", "thr_cap");
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: threadId === "thr_r" ? "active" : "idle" }));
  host.harness.sdk.stub("threads.output", async () => ({ output: "" }));
}

test("a wake read removes stale rows about waiting, finished and forgotten crews from the queue, and keeps the rest", async () => {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { fmHome: "/tmp/fm-home", notifyOwner: "real", fmHostId: "host_1" } });
  await plugin(host.bb);
  try {
    const { seen } = stubRoutedHost(host, (cmd) => {
      if (cmd.includes("bb-quiet")) return {};
      if (cmd.includes('$3=="stale"')) return { payload: QUEUE_ROWS.join("\n") };
      const crew = Object.keys(QUIET_STATUS).find((id) => cmd.includes(`/state/${id}.status`));
      if (crew !== undefined) return { payload: QUIET_STATUS[crew]! };
      return { payload: wakeFrame("") };
    });
    await seedQuietCrews(host, "/tmp/fm-home");
    const result = await host.harness.behavior.runCli(["wake"], { projectId: "proj_1", threadId: "thr_cap" });
    assert.equal(result.exitCode, 0, result.stderr);
    const prunes = seen.filter((cmd) => cmd.includes("bb-quiet"));
    assert.equal(prunes.length, 1, "one removal under the queue lock");
    assert.match(prunes[0]!, /drop=[^ ]*\|1\|2\|3\|/, "the waiting, finished and forgotten crews' rows go");
    assert.doesNotMatch(prunes[0]!, /\|4\||\|5\||\|6\|/, "an undeclared crew, a running crew and a status update stay");
    assert.match(prunes[0]!, /fm_lock_acquire_wait/);
    const read = seen.findIndex((cmd) => cmd.includes("bb-wake-receipt") || cmd.includes(".fm-receipt-"));
    assert.ok(seen.indexOf(prunes[0]!) < read, "the rows are gone before the read presents the queue");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Runs the real native libraries when this machine has them (same switch as server.test.ts).
const FM_TEST_BIN = process.env.FM_TEST_BIN ?? join(process.env.FM_TEST_HOME ?? "/root/firstmate", "bin");
const HAVE_NATIVE = existsSync(join(FM_TEST_BIN, "fm-wake-lib.sh")) && existsSync(join(FM_TEST_BIN, "fm-classify-lib.sh"));

function stubRealHost(host: Host) {
  const cmds = new Map<string, string>();
  let n = 0;
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
    const id = `t_${++n}`;
    cmds.set(id, args.start?.command ?? "");
    return { id };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
    const wrapped = cmds.get(args.terminalId) ?? "";
    const m = /^__fm_cmd='([\s\S]*?)'; set \+e; "/.exec(wrapped);
    const r = spawnSync("bash", ["-c", m ? m[1]!.replace(/'\\''/g, "'") : wrapped], { encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"] });
    return hostRcPayload((r.stdout ?? "") + (r.stderr ?? ""), typeof r.status === "number" ? r.status : 1);
  });
}
// Named as thr_cap's own home, so the captain's wake state is the home's state directory.
function scratchHome(): { home: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "fm-quiet-"));
  const home = join(root, "firstmate-bb-homes/thr_cap");
  mkdirSync(join(home, "state"), { recursive: true });
  symlinkSync(FM_TEST_BIN, join(home, "bin"));
  return { home, root };
}
function nativeDeclaredWait(home: string, crew: string): string {
  return spawnSync("bash", ["-c", '. "$1"; status_declared_wait_line "$2"', "_", join(FM_TEST_BIN, "fm-classify-lib.sh"), join(home, `state/${crew}.status`)], { encoding: "utf8" }).stdout.trim();
}

test("native: a plugin note written after a crew's paused line leaves the wait standing for the watcher", { skip: !HAVE_NATIVE }, async () => {
  const { home, root } = scratchHome();
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { fmHome: home, notifyOwner: "real", fmHostId: "host_1", supervisionEnabled: true, captainWakeBatchMs: 0 } });
  await plugin(host.bb);
  try {
    stubRealHost(host);
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", environmentId: null }));
    const paused = "paused [at=1791586043]: waiting for the six CI jobs";
    writeFileSync(join(home, "state/c1.status"), `working [at=1791585843]: typecheck finished\n${paused}\n`);
    assert.equal(nativeDeclaredWait(home, "c1"), paused);
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    assert.deepEqual((await emitIdle(host, "BLOCKED: the staging deploy needs an owner sign-in")).errors, []);
    const status = readFileSync(join(home, "state/c1.status"), "utf8");
    assert.match(status, /^note: .*BLOCKED/m, "the report is still written as a note");
    assert.equal(nativeDeclaredWait(home, "c1"), paused, "the watcher still reads the declared wait");
    writeFileSync(join(home, "state/c1.status"), "working [at=1791585843]: building\n");
    assert.deepEqual((await emitIdle(host, "BLOCKED: a second, different problem")).errors, []);
    assert.equal(nativeDeclaredWait(home, "c1"), "", "a crew that declared nothing gains no wait");
    assert.doesNotMatch(readFileSync(join(home, "state/c1.status"), "utf8"), /^paused/m);
  } finally {
    await host.harness.lifecycle.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("native: the queue loses only the rows about quiet crews", { skip: !HAVE_NATIVE }, async () => {
  const { home, root } = scratchHome();
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { fmHome: home, notifyOwner: "real", fmHostId: "host_1" } });
  await plugin(host.bb);
  try {
    stubRealHost(host);
    await seedQuietCrews(host, home);
    for (const [id, text] of Object.entries(QUIET_STATUS)) writeFileSync(join(home, `state/${id}.status`), `${text}\n`);
    writeFileSync(join(home, "state/.wake-queue"), `${QUEUE_ROWS.join("\n")}\n`);
    await host.harness.behavior.runCli(["wake"], { projectId: "proj_1", threadId: "thr_cap" });
    const left = readFileSync(join(home, "state/.wake-queue"), "utf8").split("\n").filter(Boolean).map((row) => row.split("\t")[1]);
    for (const seq of ["1", "2", "3"]) assert.ok(!left.includes(seq), `row ${seq} is about a quiet crew`);
    for (const seq of ["4", "5"]) assert.ok(left.includes(seq), `row ${seq} still surfaces`);
  } finally {
    await host.harness.lifecycle.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a plugin note restates the crew's paused line through the watcher's own reader", async () => {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { fmHome: "/tmp/fm-home", notifyOwner: "real", fmHostId: "host_1", supervisionEnabled: true } });
  await plugin(host.bb);
  try {
    const { seen } = stubRoutedHost(host, () => ({}));
    stubIdleSdk(host);
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    assert.deepEqual((await emitIdle(host, "BLOCKED: the staging deploy needs an owner sign-in")).errors, []);
    const enqueue = seen.find((cmd) => cmd.includes("fm_wake_append_locked"));
    assert.ok(enqueue, "the report is queued");
    assert.match(enqueue!, /status_declared_wait_line/);
    assert.match(enqueue!, /status_is_paused/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

function stubForget(host: Host, opts: { dirty?: string[]; unpushed?: number } = {}) {
  stubRoutedHost(host, (cmd) => cmd.includes("rev-list") ? { payload: Array.from({ length: opts.unpushed ?? 0 }, (_, i) => String(i + 1).padStart(40, "0")).join("\n") } : {});
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", projectId: "proj_1", environmentId: threadId === "thr_cap" ? null : "env_wt" }));
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  host.harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  host.harness.sdk.stub("threads.archive", async () => ({}));
  host.harness.sdk.stub("threads.stop", async () => ({}));
  host.harness.sdk.stub("threads.output", async () => ({ output: "DONE: PR open https://github.com/acme/repo/pull/1" }));
  host.harness.sdk.stub("environments.get", async () => ({ id: "env_wt", hostId: "host_1", path: "/wt", isWorktree: true, status: "ready", mergeBaseBranch: "main" }));
  host.harness.sdk.stub("environments.diffFiles", async () => ({ files: (opts.dirty ?? []).map((path) => ({ path })) }));
  host.harness.sdk.stub("environments.pullRequest", async () => ({ pullRequest: { url: "https://github.com/acme/repo/pull/1", state: "open" } }));
  host.harness.sdk.stub("environments.delete", async () => ({ ok: true as const }));
}
const openDeliveries = (host: Host) => createDeliveries(host.bb.storage.database()).list({ owner: "thr_cap" });

test("forgetting a crew with an open PR keeps the PR tracked, archives the thread and marks its alerts as dropped", async () => {
  const host = await load();
  try {
    stubForget(host);
    await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
    createDeliveries(host.bb.storage.database()).register({ url: "https://github.com/acme/repo/pull/1", taskId: "c1", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_crew", requirement: "merged" });
    const result = await host.harness.behavior.runCli(["forget", "c1"], { projectId: "proj_1", threadId: "thr_cap" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /thread archived/);
    assert.equal(host.harness.sdk.callsTo("threads.archive").length, 1);
    assert.equal(host.harness.sdk.callsTo("environments.delete").length, 0, "the PR delivery still needs the environment");
    assert.equal(await host.bb.storage.kv.get("forgotten-crew:thr_crew"), "thr_cap");
    assert.equal(openDeliveries(host).length, 1, "the PR delivery stays tracked");
    assert.deepEqual(await host.bb.storage.kv.get("crews"), []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("forgetting a crew with an open PR refuses on unlanded work unless forced, and changes nothing", async () => {
  for (const unlanded of [{ dirty: ["src/app.ts"] }, { unpushed: 2 }]) {
    const host = await load();
    try {
      stubForget(host, unlanded);
      // The open PR does not cover the local commits.
      host.harness.sdk.stub("environments.pullRequest", async () => ({ pullRequest: { url: "https://github.com/acme/repo/pull/1", state: "open" } }));
      await host.bb.storage.kv.set("crews", [shipRow("c1", "thr_crew", "thr_cap")]);
      createDeliveries(host.bb.storage.database()).register({ url: "https://github.com/acme/repo/pull/1", taskId: "c1", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_crew", requirement: "merged" });
      const refused = await host.harness.behavior.runCli(["forget", "c1"], { projectId: "proj_1", threadId: "thr_cap" });
      assert.notEqual(refused.exitCode, 0);
      assert.match(refused.stderr, /Refusing: crew c1 has/);
      assert.equal(host.harness.sdk.callsTo("threads.archive").length, 0);
      assert.equal(((await host.bb.storage.kv.get("crews")) as unknown[]).length, 1, "the crew record is kept");
      const forced = await host.harness.behavior.runCli(["forget", "c1", "--force"], { projectId: "proj_1", threadId: "thr_cap" });
      assert.equal(forced.exitCode, 0, forced.stderr);
      assert.equal(host.harness.sdk.callsTo("threads.archive").length, 1);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  }
});

test("a crew forgotten earlier, with its PR tracked in another project, is finished by the same forget", async () => {
  const host = await load();
  try {
    stubForget(host);
    await host.bb.storage.kv.set("crews", []);
    createDeliveries(host.bb.storage.database()).register({ url: "https://github.com/acme/other/pull/7", taskId: "c9", projectId: "proj_2", owner: "thr_cap", home: "", worker: "thr_old", requirement: "merged",
      continuation: { ...shipRow("c9", "thr_old", "thr_cap"), projectId: "proj_2" } });
    const result = await host.harness.behavior.runCli(["forget", "c9"], { projectId: "proj_1", threadId: "thr_cap" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.deepEqual(host.harness.sdk.callsTo("threads.archive").map((call) => (call[0] as { threadId: string }).threadId), ["thr_old"]);
    assert.equal(await host.bb.storage.kv.get("forgotten-crew:thr_old"), "thr_cap");
    assert.equal(openDeliveries(host).length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a crew that just reported DONE is not compacted, so BB sends no second completion message", async () => {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { captainCompactAtTokens: 200000 } });
  await plugin(host.bb);
  try {
    stubIdleSdk(host);
    host.harness.sdk.stub("threads.context", async () => ({ usage: { usedTokens: 910000, modelContextWindow: 1000000, estimated: false } }));
    host.harness.sdk.stub("threads.compact", async () => ({ ok: true }));
    await seedCrew(host);
    await emitIdle(host, "DONE: PR https://github.com/acme/repo/pull/1 is open and checks are green.");
    assert.equal(host.harness.sdk.callsTo("threads.compact").length, 0);
    await emitIdle(host, "WAITING: the six CI jobs");
    assert.equal(host.harness.sdk.callsTo("threads.compact").length, 1, "a crew with turns still ahead is compacted as before");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("acknowledging a wake receipt that already completed succeeds and returns what is unread now", async () => {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { fmHome: "/tmp/fm-home", notifyOwner: "real", fmHostId: "host_1" } });
  await plugin(host.bb);
  try {
    // The receipt command is staged in a host file; each run of that file is one journal action.
    let runs = 0;
    const { seen } = stubRoutedHost(host, (cmd) => {
      if (!/^__fm_cmd='bash [^;]*\.fm-receipt-/.test(cmd)) return {};
      return ++runs === 1
        ? { payload: "Wake receipt absent or changed; no action or acknowledgement authorized", code: 1 }
        : { payload: wakeFrame("1791366846\t6\tsignal\tcu.status\tcrew cu update") };
    });
    const result = await host.harness.behavior.runCli(["wake", "--handled-wake", "8e0f3c22a5c7491e87fd22ea7629533a"], { projectId: "proj_1", threadId: "thr_cap" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /8e0f3c22a5c7491e87fd22ea7629533a is already complete/);
    assert.match(result.stdout, /crew cu update/, "the same call returns what is unread now");
    assert.match(result.stdout, /WAKE_RECEIPT: fixture/);
    assert.equal(runs, 2, "one acknowledgement attempt, then one read");
    assert.ok(seen.length > 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a wake read removes the rows it would only hide: a DONE crew with a tracked PR and no crew record", async () => {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { fmHome: "/tmp/fm-home", notifyOwner: "real", fmHostId: "host_1" } });
  await plugin(host.bb);
  try {
    const { seen } = stubRoutedHost(host, finishedCrewRouter((cmd) => cmd.includes("bb-quiet") ? "" : cmd.includes('$3=="stale"') ? WAKE_ROWS.join("\n") : cmd.includes(".fm-receipt-") ? wakeFrame("") : null));
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }));
    await host.bb.storage.kv.set("crews", []);
    trackPrs(host);
    const result = await host.harness.behavior.runCli(["wake"], { projectId: "proj_1", threadId: "thr_cap" });
    assert.equal(result.exitCode, 0, result.stderr);
    const prunes = seen.filter((cmd) => cmd.includes("bb-quiet"));
    assert.equal(prunes.length, 1);
    assert.match(prunes[0]!, /drop=[^ ]*\|127\|128\|/, "the DONE crew's wedge row and its finished-outcome row go");
    assert.doesNotMatch(prunes[0]!, /\|129\|/, "the crew that is not DONE keeps its row");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a receipt that holds only hidden rows is completed by the plugin, not handed to the captain", async () => {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { fmHome: "/tmp/fm-home", notifyOwner: "real", fmHostId: "host_1" } });
  await plugin(host.bb);
  try {
    let runs = 0;
    stubRoutedHost(host, finishedCrewRouter((cmd) => {
      if (cmd.includes('$3=="stale"')) return ""; // the receipt was opened before its rows could be removed
      if (!/^__fm_cmd='bash [^;]*\.fm-receipt-/.test(cmd)) return null;
      return ++runs === 1
        ? wakeFrame([WAKE_ROWS[0], WAKE_ROWS[1], "WARNING: queued wakes pending - drain them"].join("\n"))
        : "FM_BB_RECEIPT=" + JSON.stringify({ id: null, phase: "empty", report: "No unread reports.", path: "", replayed: false, truncated: false });
    }));
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }));
    trackPrs(host);
    const result = await host.harness.behavior.runCli(["wake"], { projectId: "proj_1", threadId: "thr_cap" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.equal(runs, 2, "one read, then the plugin's own acknowledgement");
    assert.doesNotMatch(result.stdout, /WAKE_RECEIPT|queued wakes pending|thr_c1/);
    assert.match(result.stdout, /No unread reports\./);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("forget on a crew whose thread is already archived asks nothing of its retired environment", async () => {
  const host = await load();
  try {
    stubForget(host);
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", projectId: "proj_1", environmentId: threadId === "thr_cap" ? null : "env_wt", archivedAt: threadId === "thr_cap" ? null : 1 }));
    host.harness.sdk.stub("environments.diffFiles", async () => { throw new Error("HTTP 409: Environment unavailable"); });
    const store = createDeliveries(host.bb.storage.database());
    store.register({ url: "https://github.com/acme/repo/pull/1", taskId: "c1", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_crew", requirement: "merged", continuation: shipRow("c1", "thr_crew", "thr_cap") });
    await host.bb.storage.kv.set("crews", []);
    const result = await host.harness.behavior.runCli(["forget", "c1"], { projectId: "proj_1", threadId: "thr_cap" });
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(result.stdout, /already archived/);
    assert.equal(await host.bb.storage.kv.get("forgotten-crew:thr_crew"), "thr_cap");
    assert.equal(host.harness.sdk.callsTo("threads.archive").length + host.harness.sdk.callsTo("threads.stop").length, 0);
    assert.equal(openDeliveries(host).length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// ---------------------------------------------------------------------------
// A provider at its plan limit (captain thr_pse43vv6tn, crews af4986b1 and d883a2a4,
// 2026-10-10): Cursor ended the turn as completed with this text as its only message,
// so no turn failure fired and both crews sat idle with no outcome.
const CURSOR_PLAN_LIMIT = "\n\nUpgrade your plan to continue";
const CURSOR_CATALOG = [{ id: "acp-cursor", available: true }, { id: "codex", available: true }, { id: "claude-code", available: true }];

async function planLimitHost(crewPatch: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { supervisionEnabled: true, defaultProvider: "claude-code", ...settings } });
  await plugin(host.bb);
  await host.bb.storage.kv.set("crews", [{ ...shipRow("c1", "thr_crew", "thr_cap"), providerId: null, model: "grok-4.6", ...crewPatch }]);
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.stop", async () => ({}));
  host.harness.sdk.stub("threads.archive", async () => ({}));
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => threadId === "thr_cap"
    ? makeThreadResponse({ id: "thr_cap", status: "idle", providerId: "codex", projectId: "proj_1" })
    : makeThreadResponse({ id: threadId, status: "idle", providerId: threadId === "thr_crew" ? "acp-cursor" : "claude-code", environmentId: "env_wt", projectId: "proj_1", parentThreadId: "thr_cap" }));
  host.harness.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: "grok-4.6", reasoningLevel: null, permissionMode: "auto" }));
  host.harness.sdk.stub("projects.defaultExecutionOptions", async () => ({ providerId: "acp-cursor", model: "grok-4.6" }));
  host.harness.sdk.stub("environments.get", async () => ({ id: "env_wt", hostId: "host_1", status: "ready", path: "/repo/isolated", isWorktree: true }));
  host.harness.sdk.stub("providers.list", async () => CURSOR_CATALOG);
  host.harness.sdk.stub("providers.models", async ({ providerId }: { providerId: string }) => ({ models: [{ id: `${providerId}-default`, model: `${providerId}-default`, isDefault: true }] }));
  host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_crew2" }));
  return host;
}

function emitIdleOn(host: Host, threadId: string, lastAssistantText: string | null) {
  return host.harness.behavior.emitThreadEvent("thread.idle", {
    thread: makeThreadResponse({ id: threadId, status: "idle", projectId: "proj_1" }),
    lastAssistantText,
  });
}

test("the Cursor plan-limit notice is recognised only as a whole short message, and a failed turn's detail anywhere", () => {
  assert.equal(planLimitNotice(CURSOR_PLAN_LIMIT), true);
  assert.equal(planLimitNotice("Upgrade your plan to continue."), true);
  assert.equal(planLimitNotice(null), false);
  assert.equal(planLimitNotice("DONE: the pricing page now says \"Upgrade your plan to continue\" on the paywall."), false, "a crew report that quotes the wording is a report");
  assert.equal(planLimitNotice("BLOCKED: Vercel answered: upgrade your plan to continue"), false);
  assert.equal(planLimitError("Provider error: You have hit your usage limit. Upgrade your plan to continue."), true);
  assert.equal(planLimitError("API Error: Request rejected (429) · No Account Pooler account is currently eligible."), false, "a rate limit keeps its own path");
});

test("the provider stays marked until the reset the error names, else 60 minutes", () => {
  const now = Date.parse("2026-10-10T06:00:00.000Z");
  assert.equal(unavailableUntil(CURSOR_PLAN_LIMIT, now), now + 60 * 60_000);
  assert.equal(unavailableUntil("Usage limit reached. Try again in 25 minutes.", now), now + 25 * 60_000);
  assert.equal(unavailableUntil("Quota exceeded; resets in 3 hours", now), now + 3 * 60 * 60_000);
});

test("a crew dispatched with no provider named that stops on a plan limit is restarted once on the default provider in the same worktree", async () => {
  const host = await planLimitHost();
  try {
    const emitted = await emitIdleOn(host, "thr_crew", CURSOR_PLAN_LIMIT);
    assert.deepEqual(emitted.errors, []);
    const spawns = host.harness.sdk.callsTo("threads.spawn");
    assert.equal(spawns.length, 1, "one replacement worker");
    const args = spawns[0]![0] as { providerId?: string; model?: string; permissionMode?: string; environment?: unknown; pluginMetadata?: Record<string, unknown> };
    assert.equal(args.providerId, "claude-code", "the configured default provider comes before the captain's own and the catalog order");
    assert.equal(args.model, "claude-code-default", "the Cursor model does not follow the crew to another provider");
    assert.deepEqual(args.environment, { type: "reuse", environmentId: "env_wt" });
    assert.equal(args.pluginMetadata?.["posture"], "direct-PR");
    assert.equal(args.pluginMetadata?.["deliveryRequirement"], "merged");
    const toCaptain = sendCalls(host).filter((s) => s.threadId === "thr_cap");
    assert.equal(toCaptain.length, 1, "one line to the captain");
    assert.match(toCaptain[0]!.text, /acp-cursor is at its plan limit.*restarted on claude-code/s);
    assert.equal(sendCalls(host).filter((s) => s.threadId === "thr_crew").length, 0, "the stopped worker is not asked for an outcome line");

    // The captain's next steer made Cursor answer the same notice again on the old thread.
    await emitIdleOn(host, "thr_crew", CURSOR_PLAN_LIMIT);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1);
    // The replacement's provider runs out too: no second switch, a loud failure instead.
    await emitIdleOn(host, "thr_crew2", "Upgrade your plan to continue");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1, "restarted once");
    assert.ok(sendCalls(host).some((s) => s.threadId === "thr_cap" && /crew c1: provider claude-code is at its plan limit; retry with another provider/.test(s.text)));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a crew whose provider the owner or captain named is not switched: the captain is told at once, one time", async () => {
  const host = await planLimitHost({ providerId: "acp-cursor", providerNamed: true });
  try {
    await emitIdleOn(host, "thr_crew", CURSOR_PLAN_LIMIT);
    await emitIdleOn(host, "thr_crew", CURSOR_PLAN_LIMIT);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
    const toCaptain = sendCalls(host).filter((s) => s.threadId === "thr_cap");
    assert.equal(toCaptain.length, 1);
    assert.match(toCaptain[0]!.text, /crew c1 failed/);
    assert.match(toCaptain[0]!.text, /crew c1: provider acp-cursor is at its plan limit; retry with another provider/);
    assert.equal(sendCalls(host).filter((s) => s.threadId === "thr_crew").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a failed turn whose error names the plan limit takes the same path", async () => {
  const host = await planLimitHost();
  try {
    host.harness.sdk.stub("threads.events.list", async () => [{ type: "provider/error", data: { message: "Provider error", detail: "Upgrade your plan to continue" } }]);
    await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_crew", { category: "unknown", httpStatusCode: null, providerCode: null }));
    assert.equal((host.harness.sdk.callsTo("threads.spawn")[0]?.[0] as { providerId?: string } | undefined)?.providerId, "claude-code");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an ordinary idle turn is not read as a plan limit", async () => {
  const host = await planLimitHost();
  try {
    await emitIdleOn(host, "thr_crew", "DONE: fixed the paywall copy \"Upgrade your plan to continue\".");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
    assert.equal(await host.bb.storage.kv.get(PROVIDER_UNAVAILABLE_KEY), undefined);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

function stubDispatchSdk(host: Host) {
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("threads.spawn", async () => ({ id: `thr_new${host.harness.sdk.callsTo("threads.spawn").length}` }));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "starting" }));
  host.harness.sdk.stub("projects.defaultExecutionOptions", async () => ({ providerId: "acp-cursor", model: "grok-4.6" }));
  host.harness.sdk.stub("providers.list", async () => CURSOR_CATALOG);
  host.harness.sdk.stub("providers.models", async ({ providerId }: { providerId: string }) => ({ models: [{ id: `${providerId}-default`, model: `${providerId}-default`, isDefault: true }] }));
}

test("the plan limit is remembered: the next dispatch with no provider named skips that provider, a named one keeps it, and the mark expires", async () => {
  const host = await load();
  try {
    stubDispatchSdk(host);
    const now = Date.now();
    await host.bb.storage.kv.set(PROVIDER_UNAVAILABLE_KEY, { "acp-cursor": { until: now + 30 * 60_000, reason: "at its plan limit" } });
    const unnamed = await host.harness.behavior.runCli(["dispatch", "--project", "proj_1", "--", "fix flaky login"], { projectId: "proj_1" });
    assert.equal(unnamed.exitCode, 0, unnamed.stderr);
    const first = host.harness.sdk.callsTo("threads.spawn")[0]![0] as { providerId?: string; model?: string };
    assert.equal(first.providerId, "codex", "BB's project default is Cursor, so the next provider in the catalog is used");
    assert.equal(first.model, "codex-default");
    assert.match(unnamed.stdout, /acp-cursor is at its plan limit until .* UTC; this crew runs on codex/);

    const named = await host.harness.behavior.runCli(["dispatch", "--project", "proj_1", "--provider", "acp-cursor", "--", "fix flaky signup"], { projectId: "proj_1" });
    assert.equal(named.exitCode, 0, named.stderr);
    assert.equal((host.harness.sdk.callsTo("threads.spawn")[1]![0] as { providerId?: string }).providerId, "acp-cursor");
    const crews = (await host.bb.storage.kv.get("crews")) as Array<{ providerId: string | null; providerNamed?: boolean }>;
    assert.deepEqual(crews.map((c) => [c.providerId, c.providerNamed === true]), [["acp-cursor", true], ["codex", false]]);

    await host.bb.storage.kv.set(PROVIDER_UNAVAILABLE_KEY, { "acp-cursor": { until: now - 1, reason: "at its plan limit" } });
    await host.harness.behavior.runCli(["dispatch", "--project", "proj_1", "--", "fix flaky logout"], { projectId: "proj_1" });
    assert.equal((host.harness.sdk.callsTo("threads.spawn")[2]![0] as { providerId?: string }).providerId, undefined, "an expired mark changes nothing");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("the toolchain report lists a provider that unnamed dispatches skip, with the time it ends", () => {
  const now = Date.parse("2026-10-10T06:00:00.000Z");
  assert.deepEqual(unavailableProviderLines({ "acp-cursor": { until: now + 60 * 60_000, reason: "at its plan limit" }, codex: { until: now - 1, reason: "at its plan limit" } }, now),
    ["PROVIDER_UNAVAILABLE: acp-cursor is at its plan limit; dispatches with no provider named skip it until 2026-10-10 07:00 UTC."]);
  assert.deepEqual(unavailableProviderLines(undefined, now), []);
});
