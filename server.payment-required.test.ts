// PR #178 check round 1 (20 Oct): a crew whose provider answered 402 woke the captain twice, once from
// thread.failed and once from the next crew-watch pass, also across a plugin reload between the two.
// These are the checker's two probes, assertions unchanged.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { UPSTREAM_SKILL_NAMES } from "./lib/upstream-surface.ts";

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
