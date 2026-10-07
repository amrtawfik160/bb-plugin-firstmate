import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createOwnerAsks } from "./lib/owner-asks.ts";
async function captainHost() {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["captain", "firstmate"] });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await plugin(host.bb);
  await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on", asyncDispatch: "on" }) });
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_1", status: "starting" }));
  host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_new" }));
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("projects.get", async () => ({ id: "proj_1", name: "Areliaa", kind: "repo" }));
  host.harness.sdk.stub("plugins.callRpc", async () => ({ ok: true, queued: 1, duplicate: false, mode: "on" }));
  return host;
}


test("automatic ask RPCs validate the captain, reuse explicit records and close linked decisions", async () => {
  const host = await captainHost();
  try {
    const asks = createOwnerAsks(host.bb.storage.database());
    asks.create({ id: "aexisting", captain: "thr_cap", kind: "approval", text: "Publish Safi?", options: [{ label: "Publish", value: "publish" }, { label: "Wait", value: "wait" }], createdAt: Date.now() });
    const input = { threadId: "thr_cap", text: "**Publish Safi?**", options: [{ label: "A. Publish (Recommended)", value: "A" }, { label: "B. Wait", value: "B" }], sourceRef: "tg:200:3001:decision:0" };
    assert.deepEqual(await host.harness.behavior.callRpc("autoAsk", input), { id: "aexisting", created: false, state: "open" });
    assert.deepEqual(await host.harness.behavior.callRpc("linkAsk", { threadId: "thr_other", id: "aexisting", messageUrl: "https://t.me/c/200/3001" }), { ok: false });
    assert.deepEqual(await host.harness.behavior.callRpc("linkAsk", { threadId: "thr_cap", id: "aexisting", messageUrl: "https://t.me/c/200/3001" }), { ok: true });
    const board = await host.harness.behavior.callRpc("telegramCommand", { threadId: "thr_cap", command: "board" }) as { text: string };
    assert.equal(board.text, [
      "📌 Needs you (1)",
      "1. ✅ Publish Safi? (0 min, ask aexisting) https://t.me/c/200/3001",
      "Tap a question's button or reply to it to answer.",
      "",
      "✅ Done since you last looked: nothing new.",
      "",
      "🔧 In progress: nothing open.",
    ].join("\n"));
    assert.deepEqual(await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_other", id: "aexisting", resolution: "Publish" }), { ok: false });
    assert.deepEqual(await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: "aexisting", resolution: "Publish" }), { ok: true });
    assert.equal(asks.get("aexisting")?.resolution, "Publish");
    assert.deepEqual(await host.harness.behavior.callRpc("autoAsk", input), { id: "aexisting", created: false, state: "answered" });
    assert.deepEqual(await host.harness.behavior.callRpc("telegramCommand", { threadId: "thr_cap", command: "board" }), { text: "📌 Needs you: nothing right now.\n\n✅ Done since you last looked: nothing new.\n\n🔧 In progress: nothing open.", away: false });
    await assert.rejects(host.harness.behavior.callRpc("autoAsk", { ...input, threadId: "thr_other" }), /Automatic asks require a Firstmate captain thread/);
    const sent = host.harness.sdk.callsTo("plugins.callRpc").map((call) => call[0] as { method: string });
    assert.equal(sent.filter((call) => call.method === "ask").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
