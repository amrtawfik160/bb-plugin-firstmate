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
    const pings = host.harness.sdk.callsTo("threads.send").map((c) => JSON.stringify(c[0])).filter((t) => t.includes("thr_cap"));
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
