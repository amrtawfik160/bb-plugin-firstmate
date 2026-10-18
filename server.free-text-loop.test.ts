import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { manifestSkillIds } from "./scripts/plugin-skill-fixture.mjs";
import { stubProviderCatalog } from "./test/provider-catalog.mjs";

// Live 18 Oct 14:16 UTC: 39 reminder turns in an hour, every 6-12 s at peak. Each captain idle steered a
// reminder of the untold free texts at once; the reminder turn had to end with visible text, and that
// closing text was a new free text, so the next idle reminded again (agent:i660 -> i662 -> i664 -> ...).

type Host = ReturnType<typeof createFakePluginHost>;
type Rpc = { pluginId: string; method: string; input: Record<string, unknown> };

const capCtx = { threadId: "thr_cap", projectId: "proj_cyndra" } as never;
const envelope = readFileSync(new URL("./test/fixtures/envelopes/live-owner.txt", import.meta.url), "utf8");

async function captainHost() {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: manifestSkillIds(new URL(".", import.meta.url).pathname) });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_cyndra");
  await plugin(host.bb); stubProviderCatalog(host);
  await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on", asyncDispatch: "on" }) });
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_cyndra", status: "starting" }));
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("environments.list", async () => []);
  host.harness.sdk.stub("projects.get", async ({ projectId }: { projectId: string }) => ({ id: projectId, name: projectId, kind: "repo" }));
  const reminders: string[] = [];
  host.harness.sdk.stub("threads.send", async (args: { input?: Array<{ text?: string }> }) => {
    const text = args.input?.[0]?.text ?? "";
    if (text.includes("written outside a tool")) reminders.push(text);
    return {};
  });
  return { host, reminders };
}

/**
 * The captain thread's event log and a connector holding free-text obligations (untold until acked, open
 * until resolved). A text is written in the running turn (its item event); the connector reads it later,
 * stamping `at` at that read, as its enqueueAgent does.
 */
function connector(host: Host) {
  const rows: Array<{ ref: string; text: string; at: number; told: boolean; disposition?: string }> = [];
  const resolves: Array<{ refs: string[]; disposition: string }> = [];
  const events: Array<{ seq: number; type: string; scope: { kind: "turn"; turnId: string }; data: unknown }> = [];
  let turn = 0;
  const push = (type: string, data: unknown = {}) => events.push({ seq: events.length + 1, type, scope: { kind: "turn", turnId: `turn-${turn}` }, data });
  host.harness.sdk.stub("threads.events.list", async (args: { types?: string[]; order?: string; limit?: string }) => {
    let found = events.filter((row) => !args.types || args.types.includes(row.type));
    if (args.order === "desc") found = [...found].reverse();
    return found.slice(0, Number(args.limit ?? 100));
  });
  host.harness.sdk.stub("plugins.callRpc", async (args: Rpc) => {
    switch (args.method) {
      case "freeText": return { obligations: rows.filter((row) => !row.told && !row.disposition).map(({ ref, text, at }) => ({ ref, text, at })), captainThreadId: "thr_cap" };
      case "ackFreeText": for (const row of rows) if ((args.input.refs as string[]).includes(row.ref)) row.told = true; return { told: 1 };
      case "resolveFreeText": {
        const refs = args.input.refs as string[];
        resolves.push({ refs, disposition: String(args.input.disposition) });
        let resolved = 0;
        for (const row of rows) if (refs.includes(row.ref) && !row.disposition) { row.disposition = String(args.input.disposition); resolved++; }
        return { resolved };
      }
      case "undelivered": return { undelivered: [] };
      case "replied": return { replied: [] };
      default: return { ok: true, queued: 1, duplicate: false, mode: "on" };
    }
  });
  const written = new Map<string, string>();
  return {
    resolves,
    events,
    open: () => rows.filter((row) => !row.disposition).map((row) => row.ref),
    /** A captain turn starts (its turn/started event), then BB reports the thread active. */
    async active() { turn += 1; push("turn/started"); await active(host); },
    /** The running turn ends (turn/completed), then BB reports the thread idle. */
    async idle() { push("turn/completed"); await idle(host); },
    /** The captain writes a text outside a tool, in the running turn. */
    write(ref: string, text: string) { push("item/completed", { item: { type: "agentMessage", id: ref.slice("agent:".length), text } }); written.set(ref, text); },
    /** The connector reads a written text, now. */
    read(ref: string) { rows.push({ ref, text: written.get(ref) ?? "", at: Date.now(), told: false }); },
    /** Written and read at once. */
    freeText(ref: string, text: string) { this.write(ref, text); this.read(ref); },
  };
}

const active = (host: Host) => host.harness.behavior.emitThreadEvent("thread.active", { thread: makeThreadResponse({ id: "thr_cap", status: "active" }) });
const idle = (host: Host) => host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
const tool = (host: Host, name: string) => host.harness.inspection.registrations.agentTools.find((t) => t.name === name)!;
const ownerSays = (host: Host, messageId: string, words: string) => host.harness.inspection.registrations.hooks["message.dispatch"]!({
  thread: makeThreadResponse({ id: "thr_cap", status: "active" }),
  attempt: "join-turn", initiator: "user", senderThreadId: null, queuedMessages: [],
  input: { blocks: [], text: envelope.replace("telegram_message_id: 1669", `telegram_message_id: ${messageId}`).replace("Status?", words) },
} as never);

test("free-text loop: the live reminder loop stops after one round", async () => {
  const { host, reminders } = await captainHost();
  try {
    const tg = connector(host);
    // Turn A: a free text, then idle. No reminder is steered on idle: that steer started the loop.
    await tg.active();
    tg.freeText("agent:i660", "Checked the crews; nothing new.");
    await tg.idle();
    assert.deepEqual(reminders, [], "no reminder turn of its own on idle");
    // A real wake: the reminder rides on it.
    await tg.active();
    assert.equal(reminders.length, 1);
    assert.match(reminders[0]!, /agent:i660/);
    // The reminder turn resolves it, then must close with visible text: that text is the next free text.
    await tool(host, "firstmate_free_text").execute({ refs: ["agent:i660"], disposition: "no-send" }, capCtx);
    tg.freeText("agent:i662", "Resolved agent:i660 as no-send.");
    await tg.idle();
    assert.deepEqual(tg.open(), [], "the closing text is resolved no-send automatically");
    assert.deepEqual(tg.resolves.at(-1), { refs: ["agent:i662"], disposition: "no-send" });
    // Later wakes and idles: no reminder again.
    await tg.active();
    await tg.idle();
    await tg.active();
    assert.equal(reminders.length, 1, reminders.join("\n---\n"));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("free-text loop: a turn's last free text gets exactly one reminder on the next real wake; earlier ones close no-send", async () => {
  const { host, reminders } = await captainHost();
  try {
    const tg = connector(host);
    await tg.active();
    tg.freeText("agent:i1", "Looking at the Safi build.");
    tg.freeText("agent:i2", "Safi is down: Convex disabled the account.");
    await tg.idle();
    assert.deepEqual(reminders, [], "nothing steered on idle");
    assert.deepEqual(tg.open(), ["agent:i2"], "the earlier text closes no-send");
    await tg.active();
    assert.equal(reminders.length, 1);
    assert.match(reminders[0]!, /agent:i2/);
    assert.doesNotMatch(reminders[0]!, /agent:i1\b/);
    await tg.idle();
    await tg.active();
    assert.equal(reminders.length, 1, "told once");
    assert.deepEqual(tg.open(), ["agent:i2"], "still open until the captain resolves it");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("free-text loop: a turn that sent a typed message gets no reminder for its free text", async () => {
  const { host, reminders } = await captainHost();
  try {
    const tg = connector(host);
    await tg.active();
    await ownerSays(host, "7100", "Status?");
    await tool(host, "firstmate_reply").execute({ ref: "tg:200:7100", text: "All green." }, capCtx);
    tg.freeText("agent:i30", "Replied with the status.");
    await tg.idle();
    await tg.active();
    assert.deepEqual(reminders, []);
    assert.deepEqual(tg.open(), []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("free-text loop: a text whose turn is not in the thread's events is still reminded, on a real wake only", async () => {
  const { host, reminders } = await captainHost();
  try {
    const tg = connector(host);
    // Read with no item event: a turn this load cannot find.
    tg.read("agent:i40");
    await tg.idle();
    assert.deepEqual(reminders, []);
    await tg.active();
    assert.equal(reminders.length, 1);
    assert.match(reminders[0]!, /agent:i40/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Check of #157 (d03b70aa): the connector reads a turn's events later, so a text read during the next turn
// was keyed to that turn. Each case writes the text in turn A and has the connector read it in turn B.

test("free-text loop: a text read late is not closed by the next turn's typed reply", async () => {
  const { host, reminders } = await captainHost();
  try {
    const tg = connector(host);
    await tg.active();
    tg.write("agent:delayed-owner", "The production migration failed.");
    await tg.idle();
    await tg.active();
    tg.read("agent:delayed-owner");
    await ownerSays(host, "7900", "Status?");
    await tool(host, "firstmate_reply").execute({ ref: "tg:200:7900", text: "Checking." }, capCtx);
    await tg.idle();
    await tg.active();
    assert.deepEqual(tg.open(), ["agent:delayed-owner"], "turn B's typed reply cannot resolve turn A's text");
    assert.equal(reminders.filter((line) => line.includes("agent:delayed-owner")).length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("free-text loop: a resolve turn's closing text read late still closes no-send", async () => {
  const { host, reminders } = await captainHost();
  try {
    const tg = connector(host);
    await tg.active();
    await tool(host, "firstmate_free_text").execute({ refs: ["agent:i660"], disposition: "no-send" }, capCtx);
    tg.write("agent:i662", "Resolved.");
    await tg.idle();
    await tg.active();
    tg.read("agent:i662");
    await tg.idle();
    assert.deepEqual(tg.open(), [], "the resolve turn's closing text closes no-send");
    await tg.active();
    assert.deepEqual(reminders, []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("free-text loop: a text read while its turn still runs waits for the turn to end", async () => {
  const { host, reminders } = await captainHost();
  try {
    const tg = connector(host);
    await tg.active();
    tg.freeText("agent:i70", "Working on it.");
    await tool(host, "firstmate_free_text").execute({ refs: ["agent:i69"], disposition: "no-send" }, capCtx);
    // A sweep drains mid-turn: nothing is decided yet.
    await tg.active();
    assert.deepEqual(reminders, []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

/** The connector's real engine and store behind Firstmate's RPC calls; skipped without a connector checkout. */
const telegram = path.resolve(process.env.TELEGRAM_CHECKOUT ?? new URL("../bb-plugin-telegram", import.meta.url).pathname);
const present = existsSync(path.join(telegram, "test", "support.ts"));
const load = (file: string) => import(pathToFileURL(path.join(telegram, file)).href);

async function jointHost() {
  await load("test/register.mjs");
  const { baseConfig, cycle, makeHarness, openStore } = await load("test/support.ts");
  const { host, reminders } = await captainHost();
  const log = connector(host);
  const { store } = openStore();
  const clock = { offset: 0 };
  const tg = makeHarness({ store, now: () => Date.now() + clock.offset, config: baseConfig({ captainThreadId: "thr_cap", pinnedBoard: false, threadedReplies: "on", topics: false, richMessages: false }) });
  await cycle(tg.engine);
  const binding = store.activeBinding()!;
  assert.equal(binding.captain_thread_id, "thr_cap");
  const engine = tg.engine as unknown as Record<string, (...input: unknown[]) => unknown>;
  host.harness.sdk.stub("plugins.callRpc", async (args: Rpc) => {
    switch (args.method) {
      case "freeText": return { obligations: tg.engine.freeTextObligations(), captainThreadId: binding.captain_thread_id };
      case "replied": return { replied: [] };
      case "undelivered": return { undelivered: [] };
      default: return engine[args.method] ? engine[args.method]!(args.input) : { ok: true };
    }
  });
  const pause = () => new Promise((resolve) => setTimeout(resolve, 3));
  return {
    host, reminders, log, store, binding, clock, cycle: () => cycle(tg.engine),
    notices: () => tg.telegram.sent.filter((row: { text: string }) => /has not sent/i.test(row.text)).length,
    /** The connector reads a written text through its own enqueueAgent, stamping it now. */
    async read(ref: string, text: string) { await pause(); await engine.enqueueAgent!(binding, ref, text); await pause(); },
  };
}

test("joint free-text loop: the 15-minute notice counts the unresolved real text only", { skip: present ? false : `no Telegram connector checkout at ${telegram}` }, async () => {
  const j = await jointHost();
  try {
    // Turn A: two free texts, no typed message. Turn B (a real wake): the reminder, an unrelated resolve, a closing text.
    await j.log.active();
    j.log.write("agent:j1", "Looking at the deploy.");
    await j.read("agent:j1", "Looking at the deploy.");
    j.log.write("agent:j2", "The deploy failed: the migration is stuck.");
    await j.read("agent:j2", "The deploy failed: the migration is stuck.");
    await j.log.idle();
    await j.log.active();
    assert.equal(j.reminders.length, 1);
    await tool(j.host, "firstmate_free_text").execute({ refs: ["agent:other"], disposition: "no-send" }, capCtx);
    j.log.write("agent:j3", "Noted the reminder.");
    await j.read("agent:j3", "Noted the reminder.");
    await j.log.idle();
    assert.equal(j.store.overdueObligations(j.binding.generation, Date.now() + 16 * 60_000).count, 1, "only the real one waits");
    j.clock.offset = 16 * 60_000;
    await j.cycle();
    await j.cycle();
    assert.equal(j.notices(), 1, "one owner notice, for the real text");
  } finally {
    await j.host.harness.lifecycle.dispose();
  }
});

test("joint free-text loop: a resolve turn's closing text read late sends the owner no notice", { skip: present ? false : `no Telegram connector checkout at ${telegram}` }, async () => {
  const j = await jointHost();
  try {
    await j.log.active();
    await tool(j.host, "firstmate_free_text").execute({ refs: ["agent:i660"], disposition: "no-send" }, capCtx);
    j.log.write("agent:i662", "Resolved agent:i660 as no-send.");
    await j.log.idle();
    await j.log.active();
    // The connector reads turn A's closing text only after the next real wake started.
    await j.read("agent:i662", "Resolved agent:i660 as no-send.");
    await j.log.idle();
    j.clock.offset = 16 * 60_000;
    await j.cycle();
    await j.cycle();
    assert.equal(j.notices(), 0, "no waiting-message notice for a resolve turn's closing text");
  } finally {
    await j.host.harness.lifecycle.dispose();
  }
});
