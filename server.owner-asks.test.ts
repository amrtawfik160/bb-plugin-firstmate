import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createOwnerAsks, formatAskCard } from "./lib/owner-asks.ts";
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


test("explicit ask RPCs validate the captain and correct answered decisions", async () => {
  const host = await captainHost();
  try {
    const asks = createOwnerAsks(host.bb.storage.database());
    asks.create({ id: "aexisting", captain: "thr_cap", kind: "approval", text: "Publish Safi?", options: [{ label: "Publish", value: "publish" }, { label: "Wait", value: "wait" }], createdAt: Date.now() });
    assert.deepEqual(await host.harness.behavior.callRpc("linkAsk", { threadId: "thr_other", id: "aexisting", messageUrl: "https://t.me/c/200/3001" }), { ok: false });
    assert.deepEqual(await host.harness.behavior.callRpc("linkAsk", { threadId: "thr_cap", id: "aexisting", messageUrl: "https://t.me/c/200/3001" }), { ok: true });
    const board = await host.harness.behavior.callRpc("telegramCommand", { threadId: "thr_cap", command: "board" }) as { text: string };
    assert.equal(board.text, [
      "📌 Needs you (1)",
      "1. ✅ Publish Safi? (0 min, ask aexisting) https://t.me/c/200/3001",
      "Tap a question's button or reply with just its letter.",
      "",
      "✅ Done since you last looked: nothing new.",
      "",
      "🔧 In progress: nothing open.",
    ].join("\n"));
    assert.deepEqual(await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_other", id: "aexisting", resolution: "Publish" }), { ok: false });
    assert.deepEqual(await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: "aexisting", resolution: "Publish" }), { ok: true });
    assert.equal(asks.get("aexisting")?.resolution, "Publish");
    assert.deepEqual(await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: "aexisting", resolution: "Owner approved the address repair at 12:00 Cairo." }), { ok: true });
    assert.equal(asks.get("aexisting")?.resolution, "Owner approved the address repair at 12:00 Cairo.");
    assert.deepEqual(await host.harness.behavior.callRpc("telegramCommand", { threadId: "thr_cap", command: "board" }), { text: "📌 Needs you: nothing right now.\n\n✅ Done since you last looked: nothing new.\n\n🔧 In progress: nothing open.", away: false });

    const sent = host.harness.sdk.callsTo("plugins.callRpc").map((call) => call[0] as { method: string });
    assert.equal(sent.filter((call) => call.method === "ask").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});


test("listAsks includes open and recently answered asks only for its captain", async () => {
  const host = await captainHost();
  try {
    const asks = createOwnerAsks(host.bb.storage.database());
    const now = Date.now();
    const options = [{ label: "Publish", value: "publish" }, { label: "Wait", value: "wait" }];
    for (const id of ["open", "recent", "old", "cancelled", "foreign"]) {
      asks.create({ id, captain: id === "foreign" ? "thr_other" : "thr_cap", kind: "question", text: "Publish Safi?", options, createdAt: now - 172_800_000 });
    }
    asks.resolve("recent", "thr_cap", "answered", "Publish", now - 60_000);
    asks.resolve("old", "thr_cap", "answered", "Publish", now - 86_400_001);
    asks.resolve("cancelled", "thr_cap", "cancelled", "Obsolete", now);
    assert.deepEqual(await host.harness.behavior.callRpc("listAsks", { threadId: "thr_cap" }), { asks: [
      { id: "open", text: "Publish Safi?", options, state: "open", resolvedAt: null },
      { id: "recent", text: "Publish Safi?", options, state: "answered", resolvedAt: now - 60_000 },
    ] });
    await assert.rejects(host.harness.behavior.callRpc("listAsks", { threadId: "thr_other" }), /captain thread/);
    assert.equal(asks.get("recent")?.resolution, "Publish");
    assert.equal(asks.get("open")?.state, "open");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("captain can correct an answered ask and reopen it", async () => {
  const host = await captainHost();
  try {
    const asks = createOwnerAsks(host.bb.storage.database());
    asks.create({ id: "assh", captain: "thr_cap", kind: "question", text: "Addresses?", options: [], createdAt: 1 });
    asks.resolve("assh", "thr_cap", "answered", "What?", 2);
    const tool = host.harness.inspection.registrations.agentTools.find((item) => item.name === "firstmate_resolve_ask")!;
    const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
    await tool.execute({ id: "assh", resolution: "Owner approved the repair at 12:00 Cairo. T43 tracks it." }, ctx);
    assert.equal(asks.get("assh")?.resolution, "Owner approved the repair at 12:00 Cairo. T43 tracks it.");
    const edits = () => host.harness.sdk.callsTo("plugins.callRpc").map((call) => call[0] as { method: string; input: { askId: string; resolution: string; at: number; reopen?: boolean } }).filter((call) => call.method === "editAsk");
    assert.deepEqual(edits().map((call) => ({ ...call.input, at: 0 })), [{ askId: "assh", resolution: "Owner approved the repair at 12:00 Cairo. T43 tracks it.", at: 0 }]);
    await tool.execute({ id: "assh", resolution: "Recorded by mistake", reopen: true }, ctx);
    assert.deepEqual({ ...edits()[1]!.input, at: 0 }, { askId: "assh", resolution: "Recorded by mistake", at: 0, reopen: true });
    assert.equal(asks.get("assh")?.state, "open");
    assert.equal(asks.get("assh")?.resolution, null);
    assert.equal(asks.get("assh")?.resolvedAt, null);
  } finally { await host.harness.lifecycle.dispose(); }
});


test("firstmate_ask opens a card when the captain leaves out impact", async () => {
  const host = await captainHost();
  try {
    const result = await host.harness.behavior.callAgentTool("firstmate_ask", { question: "Decision 12: switch the brands audit to weekly?", kind: "question", options: [{ label: "Weekly" }, { label: "Keep daily" }] }, { threadId: "thr_cap" });
    assert.equal(typeof result === "object" && result !== null && "isError" in result, false);
    const [ask] = createOwnerAsks(host.bb.storage.database()).listOpen("thr_cap");
    assert.equal(formatAskCard(ask!), "❓ Question\n\nDecision 12: switch the brands audit to weekly?\nA. Weekly\nB. Keep daily");
  } finally { await host.harness.lifecycle.dispose(); }
});
