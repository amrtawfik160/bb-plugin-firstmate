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

/** A connector holding free-text obligations: untold until acked, open until resolved. */
function connector(host: Host) {
  const rows: Array<{ ref: string; text: string; at: number; told: boolean; disposition?: string }> = [];
  const resolves: Array<{ refs: string[]; disposition: string }> = [];
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
  const pause = () => new Promise((resolve) => setTimeout(resolve, 3));
  return {
    resolves,
    open: () => rows.filter((row) => !row.disposition).map((row) => row.ref),
    /** The captain writes a text outside a tool; the connector records it as an obligation. */
    async freeText(ref: string, text: string) { await pause(); rows.push({ ref, text, at: Date.now(), told: false }); await pause(); },
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
    await active(host);
    await tg.freeText("agent:i660", "Checked the crews; nothing new.");
    await idle(host);
    assert.deepEqual(reminders, [], "no reminder turn of its own on idle");
    // A real wake: the reminder rides on it.
    await active(host);
    assert.equal(reminders.length, 1);
    assert.match(reminders[0]!, /agent:i660/);
    // The reminder turn resolves it, then must close with visible text: that text is the next free text.
    await tool(host, "firstmate_free_text").execute({ refs: ["agent:i660"], disposition: "no-send" }, capCtx);
    await tg.freeText("agent:i662", "Resolved agent:i660 as no-send.");
    await idle(host);
    assert.deepEqual(tg.open(), [], "the closing text is resolved no-send automatically");
    assert.deepEqual(tg.resolves.at(-1), { refs: ["agent:i662"], disposition: "no-send" });
    // Later wakes and idles: no reminder again.
    await active(host);
    await idle(host);
    await active(host);
    assert.equal(reminders.length, 1, reminders.join("\n---\n"));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("free-text loop: a turn's last free text gets exactly one reminder on the next real wake; earlier ones close no-send", async () => {
  const { host, reminders } = await captainHost();
  try {
    const tg = connector(host);
    await active(host);
    await tg.freeText("agent:i1", "Looking at the Safi build.");
    await tg.freeText("agent:i2", "Safi is down: Convex disabled the account.");
    await idle(host);
    assert.deepEqual(reminders, [], "nothing steered on idle");
    assert.deepEqual(tg.open(), ["agent:i2"], "the earlier text closes no-send");
    await active(host);
    assert.equal(reminders.length, 1);
    assert.match(reminders[0]!, /agent:i2/);
    assert.doesNotMatch(reminders[0]!, /agent:i1\b/);
    await idle(host);
    await active(host);
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
    await active(host);
    await ownerSays(host, "7100", "Status?");
    await tool(host, "firstmate_reply").execute({ ref: "tg:200:7100", text: "All green." }, capCtx);
    await tg.freeText("agent:i30", "Replied with the status.");
    await idle(host);
    await active(host);
    assert.deepEqual(reminders, []);
    assert.deepEqual(tg.open(), []);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("free-text loop: a text from a turn this load did not see is still reminded, on a real wake only", async () => {
  const { host, reminders } = await captainHost();
  try {
    const tg = connector(host);
    await tg.freeText("agent:i40", "Before the reload.");
    await idle(host);
    assert.deepEqual(reminders, []);
    await active(host);
    assert.equal(reminders.length, 1);
    assert.match(reminders[0]!, /agent:i40/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

/** The connector's real store behind Firstmate's RPC calls; skipped without a connector checkout. */
const telegram = path.resolve(process.env.TELEGRAM_CHECKOUT ?? new URL("../bb-plugin-telegram", import.meta.url).pathname);
const present = existsSync(path.join(telegram, "test", "support.ts"));
const load = (file: string) => import(pathToFileURL(path.join(telegram, file)).href);

test("joint free-text loop: the 15-minute notice counts the unresolved real text only", { skip: present ? false : `no Telegram connector checkout at ${telegram}` }, async () => {
  await load("test/register.mjs");
  const { baseConfig, cycle, makeHarness, openStore } = await load("test/support.ts");
  const { host, reminders } = await captainHost();
  try {
    const { store } = openStore();
    const tg = makeHarness({ store, now: () => Date.now(), config: baseConfig({ captainThreadId: "thr_cap", pinnedBoard: false, threadedReplies: "on", topics: false, richMessages: false }) });
    await cycle(tg.engine);
    const binding = store.activeBinding()!;
    assert.equal(binding.captain_thread_id, "thr_cap");
    const engine = tg.engine as unknown as Record<string, (input?: unknown) => unknown>;
    host.harness.sdk.stub("plugins.callRpc", async (args: Rpc) => {
      switch (args.method) {
        case "freeText": return { obligations: tg.engine.freeTextObligations(), captainThreadId: binding.captain_thread_id };
        case "replied": return { replied: [] };
        case "undelivered": return { undelivered: [] };
        default: return engine[args.method] ? engine[args.method]!(args.input) : { ok: true };
      }
    });
    const pause = () => new Promise((resolve) => setTimeout(resolve, 3));
    const freeText = async (ref: string, text: string) => {
      await pause();
      store.dropFreeText({ botId: binding.bot_id, generation: binding.generation, sourceEventId: ref, text, at: Date.now(), obligation: true });
      await pause();
    };
    // Turn A: two free texts, no typed message. Turn B (a real wake): the reminder, an unrelated resolve, a closing text.
    await active(host);
    await freeText("agent:j1", "Looking at the deploy.");
    await freeText("agent:j2", "The deploy failed: the migration is stuck.");
    await idle(host);
    await active(host);
    assert.equal(reminders.length, 1);
    await tool(host, "firstmate_free_text").execute({ refs: ["agent:other"], disposition: "no-send" }, capCtx);
    await freeText("agent:j3", "Noted the reminder.");
    await idle(host);
    const due = store.overdueObligations(binding.generation, Date.now() + 16 * 60_000);
    assert.equal(due.count, 1, "only the real one waits");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
