// PR #178 check round 1 (20 Oct): a crew whose provider answered 402 woke the captain twice, once from
// thread.failed and once from the next crew-watch pass, also across a plugin reload between the two.
// These are the checker's two probes, assertions unchanged.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { UPSTREAM_SKILL_NAMES } from "./lib/upstream-surface.ts";
import { stubProviderCatalog } from "./test/provider-catalog.mjs";

const SKILLS = [...new Set(["captain", "firstmate", "skill-routing", ...UPSTREAM_SKILL_NAMES])];
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
const sentTo = (host: Host, threadId: string) => host.harness.sdk.callsTo("threads.send").map((call) => call[0] as { threadId: string; input?: Array<{ text?: string }> })
  .filter((call) => call.threadId === threadId).map((call) => call.input?.map((part) => part.text ?? "").join("") ?? "");
const failed = (host: Host, threadId: string, error: string) => host.harness.behavior.emitThreadEvent("thread.failed", { thread: makeThreadResponse({ id: threadId, status: "error", projectId: "proj_1" }), error } as never);

const GROK_402 = { type: "provider/error", data: { message: "Provider error", detail: "Internal error: {\"message\":\"API error (status 402 Payment Required): Grok Build usage balance exhausted\",\"http_status\":402}" } };
const kept = { providerId: "acp-grok", model: null, environmentId: "env_wt", branch: "fm/c1-fix", prUrl: "https://github.com/o/r/pull/7" };
function withGrok(host: Host) {
  host.harness.sdk.stub("providers.list", async () => [{ id: "claude-code", available: true }, { id: "codex", available: true }, { id: "acp-grok", available: true }]);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => threadId === "thr_cap"
    ? makeThreadResponse({ id: "thr_cap", status: "idle", providerId: "claude-code", projectId: "proj_1" })
    : makeThreadResponse({ id: threadId, status: "error", providerId: "acp-grok", environmentId: "env_wt", projectId: "proj_1", parentThreadId: "thr_cap" }));
}

async function onePass(host: Host) {
  await host.bb.storage.kv.set("watch-meta", { checked: -1 });
  const run = host.harness.behavior.runService("crew-watch");
  try {
    const until = Date.now() + 5000;
    while (Date.now() < until) {
      const meta = await host.bb.storage.kv.get("watch-meta") as { checked?: number };
      if (meta?.checked !== -1) { assert.equal(meta?.checked, 1); return; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("watch pass timed out");
  } finally { run.controller.abort(); await run.done; }
}
for (const reload of [false, true]) {
  test(`402 captain wake stays unique after supervision pass; reload=${reload}`, async () => {
    const { host } = await deck();
    let next: Host | undefined;
    try {
      withGrok(host);
      const before = crewRow("c1", "thr_crew", kept);
      await host.bb.storage.kv.set("crews", [before]);
      await host.bb.storage.kv.set("watch", { c1: {status: "active", hash: "", at: Date.now(), stuck: false} });
      host.harness.sdk.stub("threads.events.list", async () => [GROK_402]);
      await failed(host, "thr_crew", "Provider error");
      await failed(host, "thr_crew", "Provider error");
      assert.equal(sentTo(host, "thr_cap").length, 1, "repeated lifecycle events deduplicate");
      const target = reload ? (await deck()).host : host;
      if (reload) {
        next = target;
        for (const key of await host.bb.storage.kv.list("")) {
          await target.bb.storage.kv.set(key, await host.bb.storage.kv.get(key));
        }
        withGrok(target);
        target.harness.sdk.stub("threads.events.list", async () => [GROK_402]);
        await failed(target, "thr_crew", "Provider error");
        assert.equal(sentTo(target, "thr_cap").length, 0, "lifecycle wake deduplicates after reload");
      }
      await onePass(target);
      const wakes = [...sentTo(host, "thr_cap"), ...(reload ? sentTo(target, "thr_cap") : [])];
      console.log(JSON.stringify({reload, wakes, spawns: target.harness.sdk.callsTo("threads.spawn").length}));
      assert.deepEqual(((await target.bb.storage.kv.get("crews")) as unknown[])[0], before);
      assert.equal(wakes.length, 1, "one captain wake across lifecycle event and supervision pass");
    } finally { await host.harness.lifecycle.dispose(); if (next) await next.harness.lifecycle.dispose(); }
  });
}

// PR #178 check round 2: BB's event read failed during the next pass, and the pass read that as "no 402".
async function seed(host: Host, tracked = true) {
  withGrok(host);
  await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", kept)]);
  if (tracked) await host.bb.storage.kv.set("watch", {c1: {status: "active", hash: "", at: Date.now(), stuck: false}});
}
test("an event-read outage after a 402 lifecycle wake must not send a second wake", async () => {
  const {host} = await deck();
  try {
    await seed(host);
    host.harness.sdk.stub("threads.events.list", async () => [GROK_402]);
    await failed(host, "thr_crew", "Provider error");
    assert.equal(sentTo(host, "thr_cap").length, 1);
    host.harness.sdk.stub("threads.events.list", async (args: {threadId?: string; types?: string[]}) => {
      if (args.threadId === "thr_crew" && args.types?.includes("provider/error")) throw new Error("BB events service temporarily unavailable");
      return [];
    });
    await host.bb.storage.kv.set("watch-meta", {checked: -1});
    const run = host.harness.behavior.runService("crew-watch");
    try {
      const until = Date.now() + 5000;
      let settled = false;
      while (Date.now() < until) {
        const meta = await host.bb.storage.kv.get("watch-meta") as {checked?: number};
        if (meta?.checked !== -1 || host.harness.logEntries.some(row => row.message.includes("supervise:"))) {settled = true; break;}
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      assert.ok(settled, "the outage pass completed or deferred");
    } finally {run.controller.abort(); await run.done;}
    const wakes = sentTo(host, "thr_cap");
    console.log(JSON.stringify({scenario: "event-read outage", wakes}));
    assert.equal(wakes.length, 1, "event-read outage must preserve the prior 402 notification");
    host.harness.sdk.stub("threads.events.list", async () => [GROK_402]);
    await onePass(host);
    assert.equal(sentTo(host, "thr_cap").length, 1, "a successful later read must still deduplicate");
  } finally {await host.harness.lifecycle.dispose();}
});

// 20 Oct: after Grok answered 402 "usage balance exhausted", nothing stopped the next dispatch on acp-grok.
// Ten Grok crew threads failed on 402 between 01:19 and 03:49 UTC.
const capCtx = { threadId: "thr_cap", projectId: "proj_1" };
const dispatchText = async (host: Host, input: Record<string, unknown>) => {
  const tool = host.harness.inspection.registrations.agentTools.find((t) => t.name === "firstmate_dispatch")!;
  const out = await tool.execute({ projectId: "proj_1", shape: "scout", ...input }, capCtx);
  return typeof out === "string" ? out : (out as { content?: Array<{ text?: string }> }).content?.map((c) => c.text ?? "").join("\n") ?? "";
};
const turnFailed = (host: Host, threadId: string) => host.harness.behavior.emitThreadEvent("turn.failed",
  { threadId, requestId: `req_${threadId}`, turnId: null, errorInfo: null, inputAccepted: true, rateLimits: null, attemptNumber: 1 } as never);
const codexSignedIn = (cmd: string) => (cmd.includes("codex login status") ? { payload: "Logged in using ChatGPT" } : {});
async function grokDeck() {
  const { host } = await deck(codexSignedIn);
  withGrok(host);
  stubProviderCatalog(host);
  host.harness.sdk.stub("threads.events.list", async () => [GROK_402]);
  await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", kept)]);
  return host;
}
const spawnedOn = (host: Host) => host.harness.sdk.callsTo("threads.spawn").map(([args]) => (args as { providerId?: string }).providerId);

test("a 402 holds its provider: a named dispatch on it is refused, another provider dispatches, a reload keeps the hold, and it ends", async (t) => {
  const host = await grokDeck();
  let next: Host | undefined;
  try {
    await turnFailed(host, "thr_crew");
    const refused = await dispatchText(host, { task: "check the invoice total", providerId: "acp-grok", model: "grok-4.6" });
    console.log(JSON.stringify({ refused, spawned: spawnedOn(host) }));
    assert.match(refused, /acp-grok is out of balance \(HTTP 402 Payment Required\) until \d{4}-\d\d-\d\d \d\d:\d\d UTC.*dispatch on another provider with providerId/);
    assert.deepEqual(spawnedOn(host), [], "nothing was dispatched on the held provider");

    await dispatchText(host, { task: "check the invoice total", providerId: "codex", model: "gpt-6.1-sol" });
    assert.deepEqual(spawnedOn(host), ["codex"], "a dispatch on another provider is unaffected");

    next = (await deck()).host;
    for (const key of await host.bb.storage.kv.list("")) await next.bb.storage.kv.set(key, await host.bb.storage.kv.get(key));
    withGrok(next);
    stubProviderCatalog(next);
    assert.match(await dispatchText(next, { task: "check the refund total", providerId: "acp-grok", model: "grok-4.6" }), /acp-grok is out of balance/, "the hold survives a plugin reload");

    const now = Date.now();
    t.mock.method(Date, "now", () => now + 61 * 60_000);
    await dispatchText(next, { task: "check the tax total", providerId: "acp-grok", model: "grok-4.6" });
    assert.deepEqual(spawnedOn(next), ["acp-grok"], "the hold ends after one hour");
  } finally { await host.harness.lifecycle.dispose(); if (next) await next.harness.lifecycle.dispose(); }
});

test("a crew turn that completes on the held provider ends the hold", async () => {
  const host = await grokDeck();
  try {
    await turnFailed(host, "thr_crew");
    assert.match(await dispatchText(host, { task: "check the invoice total", providerId: "acp-grok", model: "grok-4.6" }), /out of balance/);
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew", kept), crewRow("c2", "thr_grok2", { providerId: "acp-grok", model: "grok-4.6" })]);
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_grok2", status: "idle", providerId: "acp-grok", projectId: "proj_1", parentThreadId: "thr_cap" }), lastAssistantText: "Working on the tests." } as never);
    await dispatchText(host, { task: "check the refund total", providerId: "acp-grok", model: "grok-4.6" });
    assert.deepEqual(spawnedOn(host), ["acp-grok"], "a served turn proves the balance is back");
  } finally { await host.harness.lifecycle.dispose(); }
});
