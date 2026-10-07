// Provider failover, captain resume, missing outcome lines, and idle alerts for
// finished crews (fleet audit 2026-10-07).
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createDeliveries } from "./lib/pr-delivery.ts";
import { UPSTREAM_SKILL_NAMES } from "./lib/upstream-surface.ts";

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
