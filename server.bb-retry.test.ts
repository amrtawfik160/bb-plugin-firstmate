// BB 0.46 review B2: BB's provider-retry plugin, on by default, retries a turn that failed on a
// provider overload (and a subscription window with a known reset) up to four times. Firstmate
// moved the same crew to another provider on the same event, so the work ran twice. Firstmate
// now acts only once BB has declined the turn, or when BB's retry is off.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { UPSTREAM_SKILL_NAMES } from "./lib/upstream-surface.ts";

process.env.FM_BB_RETRY_WAIT_MS = "1";
const SKILLS = [...new Set(["captain", "firstmate", "skill-routing", ...UPSTREAM_SKILL_NAMES])];
type Host = ReturnType<typeof createFakePluginHost>;
type Decision = { requestId: string; observedAt: number; availability: { kind: string }; decision: { kind: "retry"; reason: string; sendAt: number } | { kind: "decline"; reason: string } } | null;

const AT_CAPACITY = { category: "overloaded", httpStatusCode: null, providerCode: "serverOverloaded" };
function turnFailed(threadId: string, attemptNumber = 1) {
  return { threadId, requestId: `req_${threadId}_${attemptNumber}`, turnId: null, errorInfo: AT_CAPACITY, inputAccepted: false, rateLimits: null, attemptNumber } as const;
}
const retryDecision = (requestId: string): Decision => ({ requestId, observedAt: Date.now(), availability: { kind: "not-routed" }, decision: { kind: "retry", reason: "Provider overloaded", sendAt: Date.now() + 5_000 } });
const declineDecision = (requestId: string): Decision => ({ requestId, observedAt: Date.now(), availability: { kind: "not-routed" }, decision: { kind: "decline", reason: "attempts-exhausted" } });

async function crewHost(opts: { decision?: () => Decision; queued?: () => unknown[]; rpcOff?: boolean } = {}) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS, settings: { supervisionEnabled: true } });
  await plugin(host.bb);
  await host.bb.storage.kv.set("crews", [{ id: "c1", task: "fix login", projectId: "proj_1", threadId: "thr_crew", parentThreadId: "thr_cap", providerId: "claude-code",
    model: "claude-opus-5-5", reasoningLevel: null, worktree: true, shape: "ship", posture: "direct-PR", createdAt: "2026-09-18T00:00:00.000Z" }]);
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.stop", async () => ({}));
  host.harness.sdk.stub("threads.archive", async () => ({}));
  host.harness.sdk.stub("threads.retry", async () => ({}));
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.output", async () => ({ output: "Working." }));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => threadId === "thr_cap"
    ? makeThreadResponse({ id: "thr_cap", status: "idle", providerId: "claude-code", projectId: "proj_1" })
    : makeThreadResponse({ id: threadId, status: "error", providerId: "claude-code", environmentId: "env_wt", projectId: "proj_1", parentThreadId: "thr_cap" }));
  host.harness.sdk.stub("threads.defaultExecutionOptions", async () => ({ model: "claude-opus-5-5", reasoningLevel: null, permissionMode: "auto" }));
  host.harness.sdk.stub("projects.defaultExecutionOptions", async () => ({ providerId: "claude-code", model: "claude-opus-5-5" }));
  host.harness.sdk.stub("environments.get", async () => ({ id: "env_wt", hostId: "host_1", status: "ready", path: "/repo/isolated", isWorktree: true }));
  host.harness.sdk.stub("providers.list", async () => [{ id: "claude-code", available: true }, { id: "codex", available: true }]);
  host.harness.sdk.stub("providers.models", async ({ providerId }: { providerId: string }) => ({ models: [{ id: `${providerId}-default`, model: `${providerId}-default`, isDefault: true }] }));
  host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_crew2" }));
  host.harness.sdk.stub("threads.queuedMessages.list", async () => opts.queued?.() ?? []);
  host.harness.sdk.stub("plugins.callRpc", async (args: { pluginId: string; method: string; input: { threadId: string }; outputSchema: { parse(v: unknown): unknown } }) => {
    if (opts.rpcOff || args.pluginId !== "provider-retry" || args.method !== "decision.get") throw new Error("plugin_not_found");
    return args.outputSchema.parse(opts.decision?.() ?? null);
  });
  return host;
}
const spawns = (host: Host) => host.harness.sdk.callsTo("threads.spawn").length;

test("a crew turn BB is retrying is not also moved to another provider; once BB gives up it is", async () => {
  let decision: Decision = retryDecision("req_thr_crew_1");
  const host = await crewHost({ decision: () => decision });
  try {
    await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_crew", 1));
    assert.equal(spawns(host), 0, "BB queued a retry of this turn, so Firstmate waits");
    decision = declineDecision("req_thr_crew_5");
    await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_crew", 5));
    assert.equal(spawns(host), 1, "BB declined the fifth attempt: Firstmate fails over once");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a queued BB retry row holds the failover even before BB records its decision", async () => {
  const host = await crewHost({ decision: () => null, queued: () => [{ id: "qm_1", threadId: "thr_crew", payload: { kind: "retry" }, content: [], failureReason: null }] });
  try {
    await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_crew"));
    assert.equal(spawns(host), 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a decision for an earlier turn does not hold the failover of a later one", async () => {
  const host = await crewHost({ decision: () => retryDecision("req_thr_crew_1") });
  try {
    await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_crew", 2));
    assert.equal(spawns(host), 1, "BB recorded nothing for attempt 2 within the wait, so no BB retry is coming");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("with BB's retry off, Firstmate fails over at once as before", async () => {
  const host = await crewHost({ rpcOff: true });
  try {
    await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_crew"));
    assert.equal(spawns(host), 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a captain turn BB is retrying gets no second retry from Firstmate", async () => {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: SKILLS });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await plugin(host.bb);
  try {
    host.harness.sdk.stub("threads.retry", async () => ({}));
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.queuedMessages.list", async () => []);
    host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_cap", status: "error", projectId: "proj_1" }));
    host.harness.sdk.stub("plugins.callRpc", async (args: { outputSchema: { parse(v: unknown): unknown } }) => args.outputSchema.parse(retryDecision("req_thr_cap_1")));
    await host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_cap", 1));
    assert.equal(host.harness.sdk.callsTo("threads.retry").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a crew that failed on an overload is not restarted as an unexpected exit while BB retries it", async () => {
  const host = await crewHost({ decision: () => retryDecision("req_thr_crew_1") });
  try {
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "error", providerId: "claude-code", environmentId: "env_wt", projectId: "proj_1", parentThreadId: "thr_cap" }));
    const failed = host.harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: "thr_crew", status: "error", projectId: "proj_1" }), error: "Provider overloaded" });
    const turn = host.harness.behavior.emitThreadEvent("turn.failed", turnFailed("thr_crew", 1));
    await Promise.all([failed, turn]);
    assert.equal(spawns(host), 0, "neither the unexpected-exit restart nor the failover runs");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a captain's provider change is refused while BB has a retry of the crew's turn queued", async () => {
  const host = await crewHost({ queued: () => [{ id: "qm_1", threadId: "thr_crew", payload: { kind: "retry" }, content: [], failureReason: null }] });
  try {
    const retry = host.harness.inspection.registrations.agentTools.find((t) => t.name === "firstmate_retry")!;
    const out = await retry.execute({ crewId: "c1", providerId: "codex", model: "codex-default", reason: "overloaded" }, { threadId: "thr_cap", projectId: "proj_1" });
    assert.equal(spawns(host), 0);
    assert.match(JSON.stringify(out), /provider-retry cancel thr_crew/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
