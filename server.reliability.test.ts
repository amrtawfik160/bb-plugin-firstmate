import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createInboundLedger } from "./lib/inbound-ledger.ts";
import { parseInboundTelegram } from "./lib/telegram-envelope.ts";

type Host = ReturnType<typeof createFakePluginHost>;

async function load(seed: (host: Host) => Promise<void> = async () => {}) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["captain", "firstmate"] });
  await seed(host);
  await plugin(host.bb);
  return host;
}

function tool(host: Host, name: string) {
  const found = host.harness.inspection.registrations.agentTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not registered`);
  return found!;
}

function text(result: unknown): string {
  if (typeof result === "string") return result;
  return (result as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("\n");
}

function isError(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;
}

const envelope = (name: string) => readFileSync(new URL(`./test/fixtures/envelopes/${name}.txt`, import.meta.url), "utf8");

async function telegramFlags(host: Host) {
  await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on" }) });
}

function recordTelegram(host: Host, captain: string, messageId: string, receivedAt = 1_000) {
  const body = envelope("live-owner").replace("telegram_message_id: 1669", `telegram_message_id: ${messageId}`);
  return createInboundLedger(host.bb.storage.database()).record({
    captainThreadId: captain, text: body, receivedAt, bbThreadId: captain, initiator: "user", telegram: parseInboundTelegram(body),
  })!;
}

const ledgerRow = (host: Host, messageId: string) =>
  createInboundLedger(host.bb.storage.database()).get({ source: "telegram", chatId: "200", messageId });

const reply = (host: Host, captain: string, ref: string) =>
  tool(host, "firstmate_reply").execute({ ref, text: "Rolled back." }, { threadId: captain, projectId: "proj_1" } as never);

test("firstmate_reply keeps the item open when telegram.reply queues nothing", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669");
    let result = { queued: 0, duplicate: false, mode: "on" };
    host.harness.sdk.stub("plugins.callRpc", async () => result);
    const refused = await reply(host, "thr_cap", "tg:200:1669");
    assert.ok(isError(refused), text(refused));
    assert.equal(ledgerRow(host, "1669")?.state, "received");
    result = { queued: 1, duplicate: false, mode: "on" };
    const sent = await reply(host, "thr_cap", "tg:200:1669");
    assert.ok(!isError(sent), text(sent));
    assert.equal(ledgerRow(host, "1669")?.state, "answered");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_reply reports a failed telegram.reply instead of claiming delivery", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669");
    host.harness.sdk.stub("plugins.callRpc", async () => { throw new Error("Telegram API unavailable"); });
    const refused = await reply(host, "thr_cap", "oldest");
    assert.ok(isError(refused), text(refused));
    assert.match(text(refused), /unavailable/);
    assert.equal(ledgerRow(host, "1669")?.state, "received");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_reply reserves the reply before sending, so a repeat never sends twice", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669");
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    assert.ok(!isError(await reply(host, "thr_cap", "tg:200:1669")));
    const again = await reply(host, "thr_cap", "tg:200:1669");
    assert.match(text(again), /Already replied/);
    assert.equal(host.harness.sdk.callsTo("plugins.callRpc").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_reply only answers items owned by the calling captain", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_capA", "1669", 1_000);
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    const oldest = await reply(host, "thr_capB", "oldest");
    assert.ok(isError(oldest), text(oldest));
    const explicit = await reply(host, "thr_capB", "tg:200:1669");
    assert.ok(isError(explicit), text(explicit));
    assert.equal(host.harness.sdk.callsTo("plugins.callRpc").length, 0);
    assert.equal(ledgerRow(host, "1669")?.state, "received");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

async function captainHost() {
  const host = await load(async (h) => { await h.bb.storage.kv.set("captain-project:thr_cap", "proj_1"); });
  await telegramFlags(host);
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active" }));
  return host;
}

const ownerMessage = (host: Host) => host.harness.inspection.registrations.hooks["message.dispatch"]!({
  thread: makeThreadResponse({ id: "thr_cap", status: "active" }),
  attempt: "join-turn", initiator: "user", senderThreadId: null, queuedMessages: [],
  input: { blocks: [], text: envelope("live-owner") },
} as never);

for (const [label, result] of [
  ["threaded replies are off", { queued: 0, duplicate: false, mode: "off" }],
  ["telegram.reply queues nothing", { queued: 0, duplicate: false, mode: "on" }],
] as const) {
  test(`an ack is not recorded as sent when ${label}`, async () => {
    const host = await captainHost();
    try {
      host.harness.sdk.stub("plugins.callRpc", async () => result);
      await ownerMessage(host);
      assert.equal(host.harness.sdk.callsTo("plugins.callRpc").length, 1);
      assert.equal(ledgerRow(host, "1669")?.state, "received");
      assert.equal(createInboundLedger(host.bb.storage.database()).outboxGet({ source: "telegram", chatId: "200", messageId: "1669" }, "ack"), undefined);
    } finally {
      await host.harness.lifecycle.dispose();
    }
  });
}

test("a delivered ack marks the item acknowledged", async () => {
  const host = await captainHost();
  try {
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    await ownerMessage(host);
    assert.equal(ledgerRow(host, "1669")?.state, "acked");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("captain idles repeat an unanswered-item reminder only after backoff", async () => {
  const host = await captainHost();
  try {
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.events.list", async () => []);
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({ captain: "true" }));
    recordTelegram(host, "thr_cap", "1669", Date.now() - 4 * 60_000);
    recordTelegram(host, "thr_other", "1670", Date.now() - 4 * 60_000);
    const reminders = () => host.harness.sdk.callsTo("threads.send")
      .map((c) => c[0] as { threadId: string; input: Array<{ text: string }> })
      .filter((a) => /Unanswered/.test(a.input[0]?.text ?? ""));
    for (let i = 0; i < 3; i++) {
      await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
    }
    assert.equal(reminders().length, 1);
    assert.equal(reminders()[0]!.threadId, "thr_cap");
    assert.match(reminders()[0]!.input[0]!.text, /1669/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
