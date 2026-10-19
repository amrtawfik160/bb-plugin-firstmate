import { approvePr } from './test/production-approval.ts';
// Owner decisions Q9, Q10 and Q11 (17 Oct): wakes never block an action, a crew that ends without a
// report restarts once, a provider that is not signed in refuses the dispatch, and a shared test
// server serves one crew at a time.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { UPSTREAM_SKILL_NAMES } from "./lib/upstream-surface.ts";

const SKILLS = [...new Set(["captain", "firstmate", "skill-routing", ...UPSTREAM_SKILL_NAMES])];
const WARNING = "WARNING: queued wakes pending - drain them with bin/fm-wake-drain.sh before anything else.";
type Host = ReturnType<typeof createFakePluginHost>;

function crewRow(id: string, threadId: string, extra: Record<string, unknown> = {}) {
  return { id, task: "fix login", projectId: "proj_1", threadId, parentThreadId: "thr_cap", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: null,
    worktree: true, shape: "ship", posture: "direct-PR", createdAt: "2026-10-17T00:00:00.000Z", ...extra };
}

async function deck(router: (cmd: string) => { payload?: string; code?: number } = () => ({}), settings: Record<string, unknown> = {}) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { supervisionEnabled: true, ...settings } });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await plugin(host.bb);
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.send", async () => ({ delivery: "queued" }));
  host.harness.sdk.stub("threads.stop", async () => ({}));
  host.harness.sdk.stub("threads.archive", async () => ({}));
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.output", async () => ({ output: "" }));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => threadId === "thr_cap"
    ? makeThreadResponse({ id: "thr_cap", status: "idle", providerId: "claude-code", projectId: "proj_1" })
    : makeThreadResponse({ id: threadId, status: "error", providerId: "claude-code", environmentId: "env_wt", projectId: "proj_1", parentThreadId: "thr_cap" }));
  host.harness.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: "claude-opus-5-5", reasoningLevel: null, permissionMode: "auto" }));
  host.harness.sdk.stub("projects.defaultExecutionOptions", async () => ({ providerId: "claude-code", model: "claude-opus-5-5" }));
  host.harness.sdk.stub("projects.get", async () => ({ id: "proj_1", name: "Cyndra", kind: "repo" }));
  host.harness.sdk.stub("environments.get", async () => ({ id: "env_wt", hostId: "host_1", status: "ready", path: "/repo/isolated", isWorktree: true, branchName: "fm/c1-fix" }));
  host.harness.sdk.stub("environments.list", async () => [{ id: "env_source", hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("providers.list", async () => [{ id: "claude-code", available: true }, { id: "codex", available: true }]);
  host.harness.sdk.stub("providers.models", async ({ providerId }: { providerId: string }) => ({ models: [{ id: `${providerId}-default`, model: `${providerId}-default`, isDefault: true }, { id: "claude-opus-5-5", model: "claude-opus-5-5", isDefault: false }] }));
  let spawned = 0;
  host.harness.sdk.stub("threads.spawn", async () => ({ id: `thr_new${++spawned}` }));
  const seen: string[] = [];
  const byId = new Map<string, string>();
  let n = 0;
  host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => { const id = `t_${++n}`; byId.set(id, args.start?.command ?? ""); seen.push(args.start?.command ?? ""); return { id }; });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => {
    const cmd = byId.get(terminalId) ?? "";
    const r = router(cmd);
    const payload = r.payload ?? "";
    const captured = cmd.includes("FM_HOST_CAPTURE_V1");
    const out = captured ? JSON.stringify({ protocol: "FM_HOST_CAPTURE_V1", exitCode: r.code ?? 0, stdout: payload, stderr: "" }) : payload;
    return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${out}\n__FM_HOST_RC:${captured ? 0 : r.code ?? 0}\n`).toString("base64") }] };
  });
  return { host, seen };
}
const tool = (host: Host, name: string) => host.harness.inspection.registrations.agentTools.find((t) => t.name === name)!;
const text = (out: unknown) => typeof out === "string" ? out : (out as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? JSON.stringify(out);
const sentTo = (host: Host, threadId: string) => host.harness.sdk.callsTo("threads.send").map((call) => call[0] as { threadId: string; input?: Array<{ text?: string }> })
  .filter((call) => call.threadId === threadId).map((call) => call.input?.map((part) => part.text ?? "").join("") ?? "");
const failed = (host: Host, threadId: string, error: string) => host.harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: threadId, status: "error", projectId: "proj_1" }), error } as never);

test("a crew that ends without a final report is relaunched once with its brief; a second end goes to the captain", async () => {
  const { host } = await deck();
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew")]);
    await failed(host, "thr_crew", "Claude Code process exited with code 0");
    const spawns = host.harness.sdk.callsTo("threads.spawn");
    assert.equal(spawns.length, 1, `one restart: ${sentTo(host, "thr_cap").join(" || ")}`);
    assert.match((spawns[0]![0] as { prompt: string }).prompt, /Restart after an unexpected exit: the prior thread ended without a final report \(Claude Code process exited with code 0\)/);
    const relaunched = ((await host.bb.storage.kv.get("crews")) as Array<{ id: string; threadId: string }>).find((c) => c.id === "c1")!;
    assert.notEqual(relaunched.threadId, "thr_crew");
    await failed(host, relaunched.threadId, "Claude Code process exited with code 0");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1, "no second restart");
    assert.ok(sentTo(host, "thr_cap").some((m) => /ended without a final report a second time/.test(m)), sentTo(host, "thr_cap").join("\n---\n"));
  } finally { await host.harness.lifecycle.dispose(); }
});

test("a 401 from the provider is reported with the fix and not restarted (crew thr_uhwgmvpsds failed 12 times)", async () => {
  const { host } = await deck(() => ({}), { repairThreadId: "thr_repair" });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", { providerId: "codex", model: "gpt-6-astra" })]);
    await failed(host, "thr_crew", "Provider connection failed: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
    assert.ok(sentTo(host, "thr_cap").some((m) => /refused the sign-in .* It was not restarted: a restart fails the same way\. Fix: run `codex login` on that host/.test(m)), sentTo(host, "thr_cap").join("\n---\n"));
    assert.equal(sentTo(host, "thr_repair").length, 1);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("a dispatch on a provider that is not signed in is refused before any crew starts, with the fix and a repair notice", async () => {
  const { host } = await deck((cmd) => cmd.includes("codex login status") ? { payload: "Not logged in", code: 1 } : {}, { repairThreadId: "thr_repair", fmHostId: "host_1" });
  try {
    const out = text(await tool(host, "firstmate_dispatch").execute({ task: "Fix the Gmail trigger", providerId: "codex", shape: "ship" }, { threadId: "thr_cap", projectId: "proj_1" } as never));
    assert.match(out, /Refusing: Codex is not signed in on host host_1 \(`codex login status`: Not logged in\), so a crew on it would fail at once\. Nothing was dispatched\. Fix: run `codex login` on that host/);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
    assert.match(sentTo(host, "thr_repair")[0] ?? "", /Codex is not signed in on host host_1/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("the shared Cyndra dev server serves one crew at a time; release needs the reset; the next crew is told; a gone crew's lease expires", async () => {
  const { host } = await deck();
  try {
    await host.bb.storage.kv.set("crews", [crewRow("a1", "thr_a"), crewRow("b1", "thr_b"), crewRow("x1", "thr_x")]);
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", projectId: "proj_1", parentThreadId: "thr_cap" }));
    const lease = (as: string, action: string, reset?: string) => tool(host, "firstmate_lease").execute({ action, server: "cyndra-dev", ...(reset ? { reset } : {}) }, { threadId: as, projectId: "proj_1" } as never).then(text);
    assert.match(await lease("thr_a", "acquire"), /The lease on cyndra-dev \(the shared Cyndra dev server\) is yours/);
    assert.match(await lease("thr_b", "acquire"), /Wait: crew a1 holds cyndra-dev .* You are number 1 in line/);
    assert.match(await lease("thr_cap", "acquire"), /only a crew leases a shared test server/);
    assert.match(await lease("thr_a", "release"), /Release needs reset/);
    assert.match(await lease("thr_a", "release", "deployed main to dev"), /Released cyndra-dev; crew b1 has it now/);
    assert.ok(sentTo(host, "thr_b").some((m) => /The lease on cyndra-dev is yours now/.test(m)));
    assert.match(await lease("thr_x", "acquire"), /Wait: crew b1 holds/);
    await host.bb.storage.kv.set("crews", [crewRow("x1", "thr_x")]);
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.match(await lease("thr_x", "status"), /cyndra-dev: held by crew x1/);
    assert.ok(sentTo(host, "thr_x").some((m) => /The lease on cyndra-dev is yours now \(crew b1's lease expired\)/.test(m)));
  } finally { await host.harness.lifecycle.dispose(); }
});

test("a native refusal leads with its own reason, never the queued-wakes warning; waiting wakes are read and handed over before the merge", async () => {
  const wakes = { count: 2 };
  const { host, seen } = await deck((cmd) => {
    if (cmd.includes(".wake-queue")) return { payload: `FMWAKES=${wakes.count}` };
    // The wake read runs as an encoded receipt script.
    if (/^__fm_cmd='bash '\\''\/tmp\/\.fm-receipt-/.test(cmd)) return { payload: `FM_BB_RECEIPT=${JSON.stringify({ id: "rcpt1", phase: "ready", report: "check: crew c9 finished; PR #2501 waits for review", path: "/tmp/r.txt", replayed: false, truncated: false })}` };
    if (cmd.includes("gh pr view")) return { payload: JSON.stringify({url:"https://github.com/o/r/pull/1",number:1,title:"Change",headRefOid:"a".repeat(40),state:"OPEN",mergeable:"MERGEABLE",files:[{path:"docs/x.md"}]}) };
    if (cmd.includes("fm-pr-merge.sh")) return { payload: `${WARNING}\nREFUSED: worktree /wt has uncommitted changes`, code: 1 };
    return {};
  }, { fmHome: "/native", fmHostId: "host_1" });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", { posture: "direct-PR", nativeHome: "/native", prUrl: "https://github.com/o/r/pull/1" })]);
    approvePr(host.bb.storage.database(), "thr_cap", "o/r#1", "a".repeat(40));
    const cli = await host.harness.behavior.runCli(["merge", "c1", "--yes", "--allow-unverified", "the owner said merge it"], { threadId: "thr_cap", projectId: "proj_1" });
    assert.equal(cli.exitCode, 1);
    assert.match(cli.stderr, /REFUSED: worktree \/wt has uncommitted changes/);
    assert.doesNotMatch(cli.stderr, /queued wakes pending/);
    assert.ok(seen.some((cmd) => /\.fm-receipt-/.test(cmd)), "the wakes were read before the merge");
    assert.ok(sentTo(host, "thr_cap").some((m) => /WAKES READ BEFORE MERGE: 2 wake\(s\) were waiting.*\n.*crew c9 finished/s.test(m)), sentTo(host, "thr_cap").join("\n---\n"));
  } finally { await host.harness.lifecycle.dispose(); }
});

// Checker FF2-verdict-1 (18 Oct): a merge sent with handledWake holds the captain's receipt lock, and the
// wake read before the merge waited for that same lock, so the merge never finished.
test("a merge sent with a handled wake finishes: the wake read before it does not wait on the receipt it runs under", async () => {
  const { host } = await deck((cmd) => {
    if (cmd.includes(".wake-queue")) return { payload: "FMWAKES=2" };
    if (/^__fm_cmd='bash '\\''\/tmp\/\.fm-receipt-/.test(cmd)) return { payload: `FM_BB_RECEIPT=${JSON.stringify({ id: "rcpt1", phase: "ready", report: "check: crew c9 finished", path: "/tmp/r.txt", replayed: false, truncated: false })}` };
    if (cmd.includes("fm-merge-local.sh")) return { payload: "merged c1 by fast-forward" };
    return {};
  }, { fmHome: "/native", fmHostId: "host_1" });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", { posture: "local-only", nativeHome: "/native" })]);
    const merge = tool(host, "firstmate_merge").execute({ crewId: "c1", yes: true, handledWake: "rcpt1" }, { threadId: "thr_cap", projectId: "proj_1" } as never);
    const outcome = await Promise.race([merge.then(() => "finished"), new Promise((resolve) => setTimeout(() => resolve("deadlocked"), 15_000))]);
    assert.equal(outcome, "finished");
  } finally { await host.harness.lifecycle.dispose(); }
});

// #146 finding 3: a holder whose crew failed for good (a 401, not restarted) loses the lease at the next sweep.
test("a lease held by a crew whose thread failed and was not restarted goes to the next crew", async () => {
  const { host } = await deck();
  try {
    await host.bb.storage.kv.set("crews", [crewRow("a1", "thr_a", { providerId: "codex" }), crewRow("b1", "thr_b")]);
    const lease = (as: string, action: string) => tool(host, "firstmate_lease").execute({ action, server: "cyndra-dev" }, { threadId: as, projectId: "proj_1" } as never).then(text);
    let failedA = false;
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: threadId === "thr_a" && failedA ? "error" : "idle", providerId: "claude-code", environmentId: "env_wt", projectId: "proj_1", parentThreadId: "thr_cap" }));
    assert.match(await lease("thr_a", "acquire"), /is yours/);
    assert.match(await lease("thr_b", "acquire"), /Wait/);
    failedA = true;
    await failed(host, "thr_a", "unexpected status 401 Unauthorized");
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.match(await lease("thr_b", "status"), /held by crew b1/);
  } finally { await host.harness.lifecycle.dispose(); }
});

// #146 finding 4: a wake acknowledgement that failed after its action is finished after a plugin restart.
test("a handled wake whose acknowledgement failed is acknowledged after the plugin restarts", async () => {
  process.env.FM_WAKE_ACK_RETRY_MS = "10,10,10";
  try {
    const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { supervisionEnabled: true, fmHome: "/native", fmHostId: "host_1" } });
    await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
    await host.bb.storage.kv.set("wake-handled:thr_cap:rcpt9", Date.now() - 60_000);
    const seen: string[] = [];
    host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => { seen.push(args.start?.command ?? ""); return { id: `t_${seen.length}` }; });
    host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    host.harness.sdk.stub("terminals.close", async () => ({}));
    host.harness.sdk.stub("terminals.output", async () => ({ nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`FM_BB_RECEIPT=${JSON.stringify({ id: "rcpt9", phase: "complete", report: "", path: "/tmp/r", replayed: false, truncated: false })}\n__FM_HOST_RC:0\n`).toString("base64") }] }));
    host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("environments.list", async () => [{ id: "env_source", hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
    await plugin(host.bb);
    try {
      for (let i = 0; i < 100 && await host.bb.storage.kv.get("wake-handled:thr_cap:rcpt9") !== undefined; i++) await new Promise((resolve) => setTimeout(resolve, 20));
      assert.equal(await host.bb.storage.kv.get("wake-handled:thr_cap:rcpt9"), undefined, "the acknowledgement was retried and finished");
      assert.ok(seen.some((cmd) => /\.fm-receipt-/.test(cmd)), "it ran the receipt completion on the host");
    } finally { await host.harness.lifecycle.dispose(); }
  } finally { delete process.env.FM_WAKE_ACK_RETRY_MS; }
});
