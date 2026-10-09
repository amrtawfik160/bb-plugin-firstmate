import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createDispatchJobs } from "./lib/async-dispatch.ts";
import { createDoorbellHold } from "./lib/doorbell-hold.ts";
import { createInboundLedger } from "./lib/inbound-ledger.ts";
import { createLaunches } from "./lib/launch.ts";
import { createDeliveries } from "./lib/pr-delivery.ts";
import { createOwnerAsks } from "./lib/owner-asks.ts";
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

test("live repro: no reminder for an owner message the connector already answered with the captain's turn text", async () => {
  const host = await captainHost();
  try {
    host.harness.sdk.stub("threads.send", async () => ({}));
    host.harness.sdk.stub("threads.events.list", async () => []);
    host.harness.sdk.stub("threads.getPluginMetadata", async () => ({ captain: "true" }));
    const asked: unknown[] = [];
    host.harness.sdk.stub("plugins.callRpc", async (args: { method: string; input: { messageIds: string[] } }) => {
      asked.push(args.input);
      return args.method === "replied" ? { replied: args.input.messageIds.filter((id) => id === "1926") } : { queued: 1, duplicate: false, mode: "on" };
    });
    recordTelegram(host, "thr_cap", "1926", Date.now() - 4 * 60_000);
    recordTelegram(host, "thr_cap", "1927", Date.now() - 4 * 60_000);
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
    const reminders = host.harness.sdk.callsTo("threads.send")
      .map((c) => (c[0] as { input: Array<{ text: string }> }).input[0]?.text ?? "")
      .filter((text) => /Unanswered/.test(text));
    assert.deepEqual(asked, [{ chatId: "200", messageIds: ["1926", "1927"] }]);
    assert.equal(reminders.length, 1, reminders.join("\n"));
    assert.match(reminders[0]!, /1927/);
    assert.equal(ledgerRow(host, "1926")?.state, "answered");
    assert.equal(ledgerRow(host, "1927")?.state, "received");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

const asyncOn = (host: Host, extra: Record<string, string> = {}) =>
  host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ asyncDispatch: "on", ...extra }) });

function stubSpawn(host: Host, status: (threadId: string) => string = () => "starting") {
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_new" }));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: status(threadId) }));
}

async function until(check: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition not reached in time");
}

const capCtx = { projectId: "proj_1", threadId: "thr_cap" } as never;
const spawnArgs = (host: Host) => host.harness.sdk.callsTo("threads.spawn").map((c) => c[0] as {
  providerId?: string; environment?: { workspace?: { type?: string } };
});

function crewRow(id: string, threadId: string) {
  return { id, task: "fix login", projectId: "proj_1", threadId, parentThreadId: "thr_cap", providerId: null, model: null, reasoningLevel: null, worktree: true, shape: "ship", posture: "direct-PR", createdAt: "2026-09-18T00:00:00.000Z" };
}

test("an async dispatch does not block the per-minute follow-up after it finishes", async () => {
  const host = await load();
  try {
    await asyncOn(host);
    stubSpawn(host);
    const reserved = await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", projectId: "proj_1" }, capCtx);
    assert.match(text(reserved), /Reserved crew/);
    await until(() => host.harness.sdk.callsTo("threads.spawn").length === 1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const before = host.harness.inspection.realtimeSignals.length;
    await host.harness.behavior.runSchedule("pr-delivery-follow-up");
    assert.ok(host.harness.inspection.realtimeSignals.length > before, "the follow-up pass ran and published the fleet");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an async dispatch uses the same worktree, provider, and posture setup as a direct dispatch", async () => {
  const host = await load();
  try {
    await asyncOn(host);
    await host.harness.behavior.setSettings({ defaultProvider: "codex" });
    stubSpawn(host);
    await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", projectId: "proj_1" }, capCtx);
    await until(() => host.harness.sdk.callsTo("threads.spawn").length === 1);
    const [args] = spawnArgs(host);
    assert.equal(args!.environment?.workspace?.type, "managed-worktree");
    assert.equal(args!.providerId, "codex");
    const crews = await host.bb.storage.kv.get<Array<{ posture: string }>>("crews");
    assert.equal(crews?.[0]?.posture, "no-mistakes");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

async function captainIdle(host: Host) {
  await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
}

async function knownCaptainHost() {
  const host = await load(async (h) => { await h.bb.storage.kv.set("captain-project:thr_cap", "proj_1"); });
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({ captain: "true" }));
  return host;
}

test("a captain idle drains only over-cap dispatches, never the queued backlog", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    stubSpawn(host);
    const added = await tool(host, "firstmate_queue").execute({ action: "add", title: "later: tidy docs" }, capCtx);
    assert.match(text(added), /Queued/);
    await captainIdle(host);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an over-cap dispatch starts with its own provider and a worktree once a slot opens", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    await host.bb.storage.kv.set("crews", Array.from({ length: 10 }, (_, i) => crewRow(`c${i + 1}`, `thr_c${i + 1}`)));
    let busy = true;
    stubSpawn(host, () => (busy ? "active" : "idle"));
    const queued = await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", projectId: "proj_1", providerId: "codex" }, capCtx);
    assert.match(text(queued), /Queued as/);
    busy = false;
    await captainIdle(host);
    const [args] = spawnArgs(host);
    assert.ok(args, "the over-cap item started");
    assert.equal(args.providerId, "codex");
    assert.equal(args.environment?.workspace?.type, "managed-worktree");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a crew whose status read fails still holds a cap slot", async () => {
  const host = await load();
  try {
    await asyncOn(host);
    await host.bb.storage.kv.set("crews", Array.from({ length: 10 }, (_, i) => crewRow(`c${i + 1}`, `thr_c${i + 1}`)));
    stubSpawn(host);
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
      if (threadId.startsWith("thr_c")) throw new Error("host unreachable");
      return makeThreadResponse({ id: threadId, status: "starting" });
    });
    const result = await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", projectId: "proj_1" }, capCtx);
    assert.match(text(result), /Queued as/);
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a held crew doorbell reaches the captain once", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }));
    const doorbell = "🔔 crew c1 done [ship] :: fix login";
    const decision = await host.harness.inspection.registrations.hooks["message.dispatch"]!({
      thread: makeThreadResponse({ id: "thr_cap", status: "active" }),
      attempt: "join-turn", initiator: "system", senderThreadId: null, queuedMessages: [],
      input: { blocks: [], text: doorbell },
    } as never);
    assert.equal(decision.action, "wait", "BB holds the original doorbell and re-delivers it");
    await captainIdle(host);
    const copies = host.harness.sdk.callsTo("threads.send").filter((c) => JSON.stringify(c[0]).includes("crew c1 done"));
    assert.equal(copies.length, 0, "the plugin must not send a second copy");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

async function watchedCrewHost() {
  const host = await load();
  await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ honestStatus: "on" }), supervisionEnabled: true });
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", environmentId: null }));
  await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew")]);
  return host;
}

const crewIdle = (host: Host, lastAssistantText: string) => host.harness.behavior.emitThreadEvent("thread.idle", {
  thread: makeThreadResponse({ id: "thr_crew", status: "idle", projectId: "proj_1" }), lastAssistantText,
});
const watchdogNotes = (host: Host) => host.harness.sdk.callsTo("threads.send")
  .map((c) => JSON.stringify(c[0])).filter((t) => /[Ww]atchdog/.test(t));

test("the loop watchdog ignores crews that keep producing new output", async () => {
  const host = await watchedCrewHost();
  try {
    for (let i = 0; i < 10; i++) await crewIdle(host, `working: step ${i} edited file ${i}`);
    assert.deepEqual(watchdogNotes(host), []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("the loop watchdog notes repeated empty turns once and says the crew still runs", async () => {
  const host = await watchedCrewHost();
  try {
    for (let i = 0; i < 12; i++) await crewIdle(host, "");
    const notes = watchdogNotes(host);
    assert.equal(notes.length, 1);
    assert.doesNotMatch(notes[0]!, /stopped crew/);
    assert.match(notes[0]!, /not stopped/);
    assert.equal(host.harness.sdk.callsTo("threads.stop").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

async function interruptedCrewHost() {
  const host = await load();
  await host.harness.behavior.setSettings({ supervisionEnabled: true, nudgeEnabled: false });
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  host.harness.sdk.stub("threads.output", async () => ({ output: "" }));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle", environmentId: null }));
  await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_crew")]);
  return host;
}

const section = (out: string, name: string) => out.split(`== ${name} ==`)[1]?.split("\n==")[0] ?? "";

test("issue 47: a crew that goes idle with no outcome is not reported done", async () => {
  const host = await interruptedCrewHost();
  try {
    await crewIdle(host, "");
    const pings = host.harness.sdk.callsTo("threads.send").filter((c) => (c[0] as { threadId?: string }).threadId === "thr_cap").map((c) => JSON.stringify(c[0]));
    assert.equal(pings.length, 1);
    assert.doesNotMatch(pings[0]!, /crew c1 done/);
    assert.doesNotMatch(pings[0]!, /firstmate deliver/);
    assert.match(pings[0]!, /no outcome/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("issue 47: bearings lists an idle crew with no outcome under Captain's Call, not Ready to review", async () => {
  const host = await interruptedCrewHost();
  try {
    const result = await host.harness.behavior.runCli(["bearings"], capCtx);
    assert.equal(result.exitCode, 0, result.stderr);
    assert.match(section(result.stdout, "Captain's Call"), /c1 .*no outcome/);
    assert.doesNotMatch(result.stdout, /c1 .*ready to review/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("issue 47: a crew that reported DONE is still ready to review", async () => {
  const host = await interruptedCrewHost();
  try {
    host.harness.sdk.stub("threads.output", async () => ({ output: "DONE: shipped the fix" }));
    const result = await host.harness.behavior.runCli(["bearings"], capCtx);
    assert.match(result.stdout, /c1 .*ready to review/);
    assert.doesNotMatch(section(result.stdout, "Captain's Call"), /c1/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_reply answers one message with several questions as one quoted reply per question", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669");
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
    const send = (quote: string, more?: boolean) =>
      tool(host, "firstmate_reply").execute({ ref: "tg:200:1669", text: `About: ${quote}`, quote, ...(more === undefined ? {} : { more }) }, ctx);
    const first = await send("Is the deploy done?", true);
    assert.ok(!isError(first), text(first));
    assert.equal(ledgerRow(host, "1669")?.state, "received", "more=true keeps the message open");
    assert.match(text(first), /tg:200:1669/, "the result lists what is still waiting");
    assert.ok(!isError(await send("Who owns billing?")));
    assert.equal(ledgerRow(host, "1669")?.state, "answered");
    assert.match(text(await send("Who owns billing?")), /Already replied to tg:200:1669 for that quote/);
    const quotes = host.harness.sdk.callsTo("plugins.callRpc").map((call) => (call[0] as { input: { quote?: string } }).input.quote);
    assert.deepEqual(quotes, ["Is the deploy done?", "Who owns billing?"]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_reply answers a later message while an older one is still open, and lists the older one", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669", 1_000);
    recordTelegram(host, "thr_cap", "1670", 2_000);
    host.harness.sdk.stub("plugins.callRpc", async () => ({ queued: 1, duplicate: false, mode: "on" }));
    const result = await reply(host, "thr_cap", "tg:200:1670");
    assert.ok(!isError(result), text(result));
    assert.equal(ledgerRow(host, "1670")?.state, "answered");
    assert.equal(ledgerRow(host, "1669")?.state, "received");
    assert.match(text(result), /1 owner message\(s\) still need a final answer:\n- tg:200:1669/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_inbox lists open and delegated owner messages for the calling captain only", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    recordTelegram(host, "thr_cap", "1669", 1_000);
    recordTelegram(host, "thr_cap", "1670", 2_000);
    recordTelegram(host, "thr_other", "1671", 3_000);
    createInboundLedger(host.bb.storage.database()).markDelegated({ source: "telegram", chatId: "200", messageId: "1670" }, "thr_crew", 2_500);
    const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
    const listed = text(await tool(host, "firstmate_inbox").execute({}, ctx));
    assert.match(listed, /^2 owner message\(s\) still need a final answer:/);
    assert.match(listed, /tg:200:1669 \(\d+ min, needs your reply\)/);
    assert.match(listed, /tg:200:1670 \(\d+ min, with crew thr_crew\)/);
    assert.equal(listed.includes("1671"), false);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("telegramCommand answers /inbox and /workers for the captain only", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (
      threadId === "thr_cap" ? { captain: "true" } : {}
    ));
    host.harness.sdk.stub("threads.list", async () => []);
    recordTelegram(host, "thr_cap", "1669");
    const inbox = await host.harness.behavior.callRpc("telegramCommand", { command: "inbox", threadId: "thr_cap" }) as { text: string };
    assert.match(inbox.text, /^1 owner message\(s\) still need a final answer:\n- tg:200:1669/);
    const workers = await host.harness.behavior.callRpc("telegramCommand", { command: "workers", threadId: "thr_cap" }) as { text: string };
    assert.equal(typeof workers.text, "string");
    assert.ok(workers.text.length > 0, workers.text);
    const stranger = await host.harness.behavior.callRpc("telegramCommand", { command: "inbox", threadId: "thr_other" }) as { text: string };
    assert.match(stranger.text, /not a Firstmate captain/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

type RpcCall = { pluginId: string; method: string; input: Record<string, unknown> };
const rpcCalls = (host: Host) => host.harness.sdk.callsTo("plugins.callRpc").map((c) => c[0] as RpcCall);
const asks = (host: Host) => createOwnerAsks(host.bb.storage.database());
const askTool = (host: Host, params: Record<string, unknown>, captain = "thr_cap") =>
  tool(host, "firstmate_ask").execute({ impact: "Customers can use this feature.", ...params }, { threadId: captain, projectId: "proj_1" } as never);
const connectorOk = (host: Host) => host.harness.sdk.stub("plugins.callRpc", async (args: RpcCall) => (
  args.method === "refreshBoard" ? { ok: true } : { queued: 1, duplicate: false, mode: "on" }
));
const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16);

test("firstmate_ask records the ask and sends the connector a question card with its options and recommendation", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    await host.harness.behavior.setSettings({ askDefaultMinutes: 30 });
    connectorOk(host);
    const result = await askTool(host, {
      question: "Dark mode by default?", kind: "question",
      options: [{ label: "Yes" }, { label: "No", value: "no" }], recommended: 0,
    });
    assert.ok(!isError(result), text(result));
    const id = /ask (a[0-9a-z]{6})/.exec(text(result))?.[1];
    assert.ok(id, text(result));
    assert.match(text(result), /Keep working on other things/);
    const stored = asks(host).get(id)!;
    assert.equal(stored.state, "open");
    assert.equal(stored.captain, "thr_cap");
    assert.equal(stored.defaultAt! - stored.createdAt, 30 * 60_000, "the deadline comes from askDefaultMinutes");
    const calls = rpcCalls(host);
    assert.deepEqual(calls.map((c) => [c.pluginId, c.method]), [["telegram", "ask"], ["telegram", "refreshBoard"]]);
    assert.deepEqual(calls[0]!.input, {
      askId: id,
      text: `Customers can use this feature.\n\n❓ Question\n\nDark mode by default?\nA. Yes\nB. No\n\nRecommended: Yes\nIf no answer by ${hhmm(stored.defaultAt!)} UTC, I'll go with Yes.`,
      options: [{ label: "Yes", value: "A" }, { label: "No", value: "no" }],
      recommended: 0,
    });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_ask keeps the ask open and warns when the connector cannot send the card", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    host.harness.sdk.stub("plugins.callRpc", async () => { throw new Error("Telegram API unavailable"); });
    const result = await askTool(host, { question: "Need the Stripe key.", kind: "blocker" });
    assert.ok(!isError(result), text(result));
    assert.match(text(result), /Warning: the question card was not sent to Telegram \(Telegram API unavailable\)/);
    const id = /ask (a[0-9a-z]{6})/.exec(text(result))![1]!;
    assert.equal(asks(host).get(id)?.state, "open");
    assert.equal(asks(host).get(id)?.defaultAt, null);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_ask refuses a deadline on an approval or an irreversible ask, and never gives one a default", async () => {
  const host = await load();
  try {
    await telegramFlags(host);
    connectorOk(host);
    const options = [{ label: "Deploy" }, { label: "Wait" }];
    const approval = await askTool(host, { question: "Deploy billing?", kind: "approval", options, recommended: 0, defaultAfterMinutes: 30 });
    assert.ok(isError(approval), text(approval));
    assert.match(text(approval), /defaultAfterMinutes is not allowed for an approval/);
    const gated = await askTool(host, { question: "Delete old data?", kind: "question", options, recommended: 1, defaultAfterMinutes: 30, irreversible: true });
    assert.ok(isError(gated), text(gated));
    assert.match(text(gated), /defaultAfterMinutes is not allowed for an irreversible ask/);
    assert.deepEqual(asks(host).listOpen("thr_cap"), []);
    assert.equal(rpcCalls(host).length, 0);
    const waiting = await askTool(host, { question: "Delete old data?", kind: "question", options, recommended: 1, irreversible: true });
    const id = /ask (a[0-9a-z]{6})/.exec(text(waiting))![1]!;
    assert.equal(asks(host).get(id)?.defaultAt, null, "askDefaultMinutes never applies to an irreversible ask");
    assert.equal(rpcCalls(host)[0]!.input.text, "Customers can use this feature.\n\n❓ Question\n\nDelete old data?\nA. Deploy\nB. Wait\n\nRecommended: Wait");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

const askReply = (askId: string, body = "Roll it back") => envelope("live-reply")
  .replace('"sourceEventId":"evt_1"', `"sourceEventId":"ask:${askId}"`)
  .replace(/Roll it back$/, body);

test("only a letter reply to an ask card answers that ask and refreshes the board; another captain's ask is untouched", async () => {
  const host = await captainHost();
  try {
    connectorOk(host);
    const opts = [{ label: "Yes", value: "yes" }];
    asks(host).create({ id: "a000001", captain: "thr_cap", kind: "question", text: "Ship it?", options: opts, recommended: 0, createdAt: 1 });
    asks(host).create({ id: "a000002", captain: "thr_other", kind: "question", text: "Other?", options: opts, createdAt: 2 });
    const hook = host.harness.inspection.registrations.hooks["message.dispatch"]!;
    const send = (body: string) => hook({
      thread: makeThreadResponse({ id: "thr_cap", status: "active" }),
      attempt: "join-turn", initiator: "user", senderThreadId: null, queuedMessages: [],
      input: { blocks: [], text: body },
    } as never);
    await send(askReply("a000002"));
    assert.equal(asks(host).get("a000002")?.state, "open");
    assert.equal(rpcCalls(host).filter((c) => c.method === "refreshBoard").length, 0);
    await send(askReply("a000001", "What?"));
    assert.equal(asks(host).get("a000001")?.state, "open");
    const pending = createInboundLedger(host.bb.storage.database()).listPending("thr_cap");
    assert.equal(pending.length, 1);
    await send(askReply("a000001", "a."));
    const answered = asks(host).get("a000001")!;
    assert.equal(answered.state, "answered");
    assert.equal(answered.resolution, "Yes");
    assert.equal(rpcCalls(host).filter((c) => c.method === "refreshBoard").length, 1);
    const header = parseInboundTelegram(askReply("a000001", "Yes"))!;
    const row = createInboundLedger(host.bb.storage.database()).get({ source: "telegram", chatId: header.chatId, messageId: header.messageId });
    assert.equal(row?.state, "answered", "an answer to a card raises no unanswered reminder");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a captain idle defaults an overdue reversible ask once and never an irreversible one", async () => {
  const host = await knownCaptainHost();
  try {
    await telegramFlags(host);
    connectorOk(host);
    host.harness.sdk.stub("threads.list", async () => []);
    const opts = [{ label: "Use Postgres", value: "pg" }, { label: "Use SQLite", value: "sqlite" }];
    const past = Date.now() - 60_000;
    asks(host).create({ id: "a000001", captain: "thr_cap", kind: "question", text: "Which DB?", options: opts, recommended: 0, defaultAt: past, createdAt: 1 });
    asks(host).create({ id: "a000002", captain: "thr_cap", kind: "question", text: "Drop table?", options: opts, recommended: 1, defaultAt: past, irreversible: true, createdAt: 2 });
    asks(host).create({ id: "a000003", captain: "thr_cap", kind: "question", text: "Later?", options: opts, recommended: 0, defaultAt: Date.now() + 3_600_000, createdAt: 3 });
    await captainIdle(host);
    await captainIdle(host);
    const steers = host.harness.sdk.callsTo("threads.send")
      .map((c) => c[0] as { threadId: string; input: Array<{ text: string; visibility?: string }> })
      .filter((a) => /No answer to ask/.test(a.input[0]?.text ?? ""));
    assert.equal(steers.length, 1);
    assert.equal(steers[0]!.threadId, "thr_cap");
    assert.equal(steers[0]!.input[0]!.visibility, "agent-only");
    assert.equal(steers[0]!.input[0]!.text, 'No answer to ask a000001 by its deadline: go ahead with "Use Postgres" as recommended, and tell the captain in one short message that you did.');
    assert.equal(asks(host).get("a000001")?.state, "defaulted");
    assert.equal(asks(host).get("a000001")?.resolution, "Use Postgres");
    assert.equal(asks(host).get("a000002")?.state, "open");
    assert.equal(asks(host).get("a000003")?.state, "open");
    assert.equal(rpcCalls(host).filter((c) => c.method === "refreshBoard").length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

async function boardHost() {
  const host = await load();
  await telegramFlags(host);
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.list", async () => []);
  return host;
}
const board = (host: Host) => host.harness.behavior.callRpc("telegramCommand", { command: "board", threadId: "thr_cap" }) as Promise<{ text: string; away?: boolean }>;

test("telegramCommand board says nothing needs the owner and reports the captain is not away", async () => {
  const host = await boardHost();
  try {
    assert.deepEqual(await board(host), { text: "📌 Needs you: nothing right now.\n\n✅ Done since you last looked: nothing new.\n\n🔧 In progress: nothing open.", away: false });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("telegramCommand board lists open asks then crew items, and reports /afk as away", async () => {
  const host = await boardHost();
  try {
    await host.bb.storage.kv.set("afk:cap-thr_cap", { on: true, words: "", since: "2026-10-07T00:00:00.000Z", held: [] });
    await host.bb.storage.kv.set("telegram-threading", { mismatch: true, since: 1 });
    const created = Date.now() - 5 * 60_000;
    const at = Date.UTC(2026, 9, 7, 14, 30);
    asks(host).create({ id: "a000001", captain: "thr_cap", kind: "blocker", text: "Need the Stripe key.", options: [], createdAt: created });
    asks(host).create({ id: "a000002", captain: "thr_cap", kind: "question", text: "Dark mode?", options: [{ label: "Yes", value: "y" }], recommended: 0, defaultAt: at, createdAt: created + 1 });
    asks(host).create({ id: "a000003", captain: "thr_other", kind: "question", text: "Not mine", options: [], createdAt: created });
    assert.deepEqual(await board(host), {
      away: true,
      text: [
        "📌 Needs you (3)",
        "1. ⛔ Need the Stripe key. (5 min, ask a000001)",
        "2. ❓ Dark mode? (5 min, ask a000002) Recommended: Yes. Auto at 14:30 UTC.",
        "3. Needs captain: Telegram threaded replies are off in the Telegram connector, but Firstmate's telegramThreading flag is on, so replies arrive unthreaded. Turn th…",
        "Tap a question's button or reply with just its letter.",
        "",
        "✅ Done since you last looked: nothing new.",
        "",
        "🔧 In progress: nothing open.",
      ].join("\n"),
    });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("telegramCommand board caps the list at 15 lines", async () => {
  const host = await boardHost();
  try {
    const created = Date.now() - 5 * 60_000;
    for (let i = 1; i <= 17; i++) {
      asks(host).create({ id: `a0000${String(i).padStart(2, "0")}`, captain: "thr_cap", kind: "question", text: `Question ${i}?`, options: [], createdAt: created + i });
    }
    assert.deepEqual(await board(host), {
      away: false,
      text: [
        "📌 Needs you (17)",
        ...Array.from({ length: 15 }, (_, i) => `${i + 1}. ❓ Question ${i + 1}? (5 min, ask a0000${String(i + 1).padStart(2, "0")})`),
        "…and 2 more",
        "Tap a question's button or reply with just its letter.",
        "",
        "✅ Done since you last looked: nothing new.",
        "",
        "🔧 In progress: nothing open.",
      ].join("\n"),
    });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("telegramCommand board keeps decisions, drops launch bookkeeping, and lists this captain's open pull requests", async () => {
  const host = await boardHost();
  try {
    const db = host.bb.storage.database();
    createLaunches(db).save({ key: "k1", taskId: "rebase-2118-2129", projectId: "proj_1", owner: "thr_cap", home: "", generation: 1, shape: "ship", state: "uncertain", threadId: null, error: "Error: reply lost", updatedAt: 1 } as never);
    createLaunches(db).save({ key: "k2", taskId: "runants-playbook-ui-polish", projectId: "proj_1", owner: "thr_cap", home: "", generation: 2, shape: "ship", state: "reserved", threadId: null, updatedAt: 2 } as never);
    await host.bb.storage.kv.set("decisions", [{ id: "d1", question: "Use Postgres?", options: ["yes", "no"], crewId: null, parentThreadId: "thr_cap", status: "open", createdAt: "2026-10-07T00:00:00.000Z" }]);
    const store = createDeliveries(db);
    store.register({ url: "https://github.com/acme/repo/pull/7", taskId: "c1", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_c1", title: "Fix the login form", openedAt: 1 });
    store.register({ url: "https://github.com/acme/repo/pull/8", taskId: "c2", projectId: "proj_1", owner: "thr_other", home: "", worker: "thr_c2", title: "Not mine" });
    const merged = store.register({ url: "https://github.com/acme/repo/pull/9", taskId: "c3", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_c3" });
    store.save({ ...merged, status: "complete" });
    assert.deepEqual(await board(host), {
      away: false,
      text: [
        "📌 Needs you (1)",
        '1. ? d1 :: Use Postgres? (yes / no) — answer: decide answer d1 -- "<answer>"',
        "",
        "✅ Done since you last looked: nothing new.",
        "",
        "🔧 In progress: nothing open.",
        "Other PRs: [repo#7](https://github.com/acme/repo/pull/7) checks running",
      ].join("\n"),
    });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});


test("long option text stays whole and defaults to a short letter value", async () => {
  const host = await captainHost();
  try {
    connectorOk(host);
    const label = "Find and verify the addresses the business uses to reach its servers before changing the production setting.";
    const result = await askTool(host, { impact: "New customers can start their agents again.", question: "How should we repair access?", kind: "question", options: [{ label }] });
    assert.equal(isError(result), false);
    const sent = rpcCalls(host).find((call) => call.method === "ask")!;
    assert.deepEqual(sent.input.options, [{ label, value: "A" }]);
    assert.equal(sent.input.text, `New customers can start their agents again.\n\n❓ Question\n\nHow should we repair access?\nA. ${label}`);
  } finally { await host.harness.lifecycle.dispose(); }
});

const jobState = (host: Host, id: string) => createDispatchJobs(host.bb.storage.database()).get(id)?.state;
const captainSends = (host: Host) => host.harness.sdk.callsTo("threads.send")
  .filter((c) => (c[0] as { threadId?: string }).threadId === "thr_cap").map((c) => JSON.stringify(c[0]));

test("a background dispatch that fails tells the captain", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    stubSpawn(host);
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }));
    host.harness.sdk.stub("threads.spawn", async () => { throw new Error("Host is not connected"); });
    const reserved = await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", projectId: "proj_1", taskId: "job-fail" }, capCtx);
    assert.match(text(reserved), /Reserved crew job-fail/);
    await until(() => jobState(host, "job-fail") === "failed");
    await until(() => captainSends(host).some((sent) => /job-fail/.test(sent)));
    const [note] = captainSends(host).filter((sent) => /job-fail/.test(sent));
    assert.match(note!, /Dispatch failed/);
    assert.match(note!, /Host is not connected/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("two background dispatches for the last free slot start one crew now and the other when a slot opens", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    await host.bb.storage.kv.set("crews", Array.from({ length: 9 }, (_, i) => crewRow(`c${i + 1}`, `thr_c${i + 1}`)));
    let busy = true;
    stubSpawn(host, (threadId) => (threadId === "thr_cap" || (!busy && threadId === "thr_c1") ? "idle" : "active"));
    const dispatch = tool(host, "firstmate_dispatch");
    const results = await Promise.all([
      dispatch.execute({ task: "fix flaky login", projectId: "proj_1", taskId: "job-a" }, capCtx),
      dispatch.execute({ task: "fix slow search", projectId: "proj_1", taskId: "job-b" }, capCtx),
    ]);
    for (const result of results) assert.ok(!isError(result), text(result));
    await until(() => host.harness.sdk.callsTo("threads.spawn").length === 1);
    await until(() => ["job-a", "job-b"].some((id) => jobState(host, id) === "queued"));
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 1, "the cap holds");
    const waiting = ["job-a", "job-b"].find((id) => jobState(host, id) === "queued")!;
    assert.deepEqual(captainSends(host).filter((sent) => /Dispatch failed/.test(sent)), []);
    busy = false;
    await host.harness.behavior.runSchedule("pr-delivery-follow-up");
    await until(() => jobState(host, waiting) === "started");
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 2);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a held crew doorbell that fails to send on release is kept for the next release", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    host.harness.sdk.stub("threads.list", async () => []);
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "idle" }));
    const store = createDoorbellHold(host.bb.storage.database());
    for (const crewId of ["c1", "c2"]) {
      store.enqueue({ captainThreadId: "thr_cap", text: `🔔 crew ${crewId} idle [ship] :: fix login`, crewId, urgent: false, createdAt: 1 });
    }
    const doorbells = () => captainSends(host).filter((sent) => /crew c[12] idle/.test(sent));

    host.harness.sdk.stub("threads.send", async () => { throw new Error("Server session is not open"); });
    await captainIdle(host);
    assert.equal(store.pending("thr_cap"), 2, "a failed send must not drop the held doorbells");

    const refused = doorbells().length;
    host.harness.sdk.stub("threads.send", async () => ({}));
    await captainIdle(host);
    assert.equal(store.pending("thr_cap"), 0);
    const delivered = doorbells().slice(refused);
    assert.equal(delivered.filter((sent) => /crew c1 idle/.test(sent)).length, 1);
    assert.equal(delivered.filter((sent) => /crew c2 idle/.test(sent)).length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an over-cap dispatch starts within a minute when a slot opens without a crew turn ending", async () => {
  const host = await knownCaptainHost();
  try {
    await asyncOn(host);
    await host.bb.storage.kv.set("crews", Array.from({ length: 10 }, (_, i) => crewRow(`c${i + 1}`, `thr_c${i + 1}`)));
    let failed = false;
    stubSpawn(host, (threadId) => (threadId === "thr_cap" ? "idle" : failed && threadId === "thr_c1" ? "error" : "active"));
    const queued = await tool(host, "firstmate_dispatch").execute({ task: "fix flaky login", projectId: "proj_1" }, capCtx);
    assert.match(text(queued), /Queued as/);
    failed = true;
    await host.harness.behavior.runSchedule("pr-delivery-follow-up");
    await until(() => host.harness.sdk.callsTo("threads.spawn").length === 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
