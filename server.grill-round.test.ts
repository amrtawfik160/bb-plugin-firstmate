import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createInboundLedger } from "./lib/inbound-ledger.ts";
import { createOwnerAsks } from "./lib/owner-asks.ts";
import { parseInboundTelegram } from "./lib/telegram-envelope.ts";
import { stubProviderCatalog } from "./test/provider-catalog.mjs";

type Host = ReturnType<typeof createFakePluginHost>;
type RpcCall = { pluginId: string; method: string; input: Record<string, unknown> };

async function load(seed: (host: Host) => Promise<void> = async () => {}) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["captain", "firstmate"] });
  await seed(host);
  await plugin(host.bb);
  stubProviderCatalog(host);
  return host;
}

function tool(host: Host, name: string) {
  const found = host.harness.inspection.registrations.agentTools.find((item) => item.name === name);
  assert.ok(found, `tool ${name} not registered`);
  return found!;
}

function text(result: unknown): string {
  if (typeof result === "string") return result;
  return (result as { content: Array<{ text?: string }> }).content.map((part) => part.text ?? "").join("\n");
}

function isError(result: unknown): boolean {
  return typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;
}

const rpcCalls = (host: Host) => host.harness.sdk.callsTo("plugins.callRpc").map((call) => call[0] as RpcCall);
const asks = (host: Host) => createOwnerAsks(host.bb.storage.database());

async function roundHost() {
  const host = await load(async (item) => { await item.bb.storage.kv.set("captain-project:thr_cap", "proj_1"); });
  await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on" }) });
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, status: "active" }));
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("plugins.callRpc", async (args: RpcCall) => (
    args.method === "refreshBoard" ? { ok: true } : { queued: 1, duplicate: false, mode: "on" }
  ));
  return host;
}

const ctx = { threadId: "thr_cap", projectId: "proj_1" } as never;
const askTool = (host: Host, params: Record<string, unknown>) => tool(host, "firstmate_ask").execute({ project: "Safi", ...params }, ctx);
const resolveTool = (host: Host, params: Record<string, unknown>) => tool(host, "firstmate_resolve_ask").execute(params, ctx);

const ROUND = [
  { question: "What is the goal of Reels?", options: [{ label: "Grow reach" }, { label: "Convert sales" }, { label: "Test ideas" }], recommended: 0 },
  { question: "Who is the audience?", options: [{ label: "Existing customers" }, { label: "New viewers" }, { label: "Both" }], recommended: 1 },
  { question: "How often should we post?", options: [{ label: "Daily" }, { label: "Three times a week" }, { label: "Weekly" }], recommended: 1 },
  { question: "What is the first series?", options: [{ label: "Product tips" }, { label: "Customer stories" }, { label: "Behind the scenes" }], recommended: 2 },
];

const ROUND_TEXT = [
  "1. What is the goal of Reels?",
  "✓ A. Grow reach",
  "B. Convert sales",
  "C. Test ideas",
  "",
  "2. Who is the audience?",
  "A. Existing customers",
  "✓ B. New viewers",
  "C. Both",
  "",
  "3. How often should we post?",
  "A. Daily",
  "✓ B. Three times a week",
  "C. Weekly",
  "",
  "4. What is the first series?",
  "A. Product tips",
  "B. Customer stories",
  "✓ C. Behind the scenes",
  "",
  "Answer like 1A 2C, or 'yes' to accept all recommended.",
].join("\n");

const envelope = (name: string) => readFileSync(new URL(`./test/fixtures/envelopes/${name}.txt`, import.meta.url), "utf8");
const askReply = (askId: string, body: string) => envelope("live-reply")
  .replace('"sourceEventId":"evt_1"', `"sourceEventId":"ask:${askId}"`)
  .replace(/Roll it back$/, body);

test("firstmate_ask and firstmate_reply describe a grilling round as one message", async () => {
  const host = await load();
  try {
    assert.match(tool(host, "firstmate_ask").description, /grilling question batch is one round/i);
    assert.match(tool(host, "firstmate_ask").description, /2 to 12 questions/);
    assert.match(tool(host, "firstmate_resolve_ask").description, /grilling round/);
    assert.match(tool(host, "firstmate_reply").description, /grilling question batch is one firstmate_ask round/);
    assert.match(tool(host, "firstmate_reply").description, /A text that asks the owner to decide/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a grilling round of 4 sends exactly one Telegram message with all 4 questions and no per-question cards", async () => {
  const host = await roundHost();
  try {
    const result = await askTool(host, { kind: "question", round: ROUND });
    assert.ok(!isError(result), text(result));
    const id = /ask (a[0-9a-z]{6})/.exec(text(result))?.[1];
    assert.ok(id, text(result));
    const stored = asks(host).get(id)!;
    assert.equal(stored.state, "open");
    assert.equal(stored.kind, "question");
    assert.equal(stored.round?.length, 4);
    assert.deepEqual(stored.options, []);
    const sent = rpcCalls(host).filter((call) => call.method === "ask");
    assert.equal(sent.length, 1, "one telegram.ask for the whole round");
    assert.equal(sent[0]!.pluginId, "telegram");
    assert.equal(sent[0]!.input.askId, id);
    assert.equal(sent[0]!.input.text, ROUND_TEXT);
    assert.deepEqual(sent[0]!.input.options, []);
    assert.equal("card" in sent[0]!.input, false, "a round does not join a pack");
    assert.equal("recommended" in sent[0]!.input, false);
    assert.equal(sent[0]!.input.project, "Safi");
    assert.equal(rpcCalls(host).filter((call) => call.method === "refreshBoard").length, 1);
    assert.equal(asks(host).listOpen("thr_cap").length, 1);
    assert.equal(asks(host).listWaiting("thr_cap", Date.now()).length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an approval or irreversible grilling round is refused and sends nothing", async () => {
  const host = await roundHost();
  try {
    const approval = await askTool(host, { kind: "approval", round: ROUND });
    assert.ok(isError(approval), text(approval));
    assert.match(text(approval), /reversible question/);
    const gated = await askTool(host, { kind: "question", round: ROUND, irreversible: true });
    assert.ok(isError(gated), text(gated));
    assert.match(text(gated), /must be reversible/);
    assert.deepEqual(asks(host).listOpen("thr_cap"), []);
    assert.equal(rpcCalls(host).filter((call) => call.method === "ask").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a single question ask still sends one card with options", async () => {
  const host = await roundHost();
  try {
    const result = await askTool(host, {
      kind: "question",
      question: "Dark mode by default?",
      options: [{ label: "Yes" }, { label: "No" }],
      recommended: 0,
    });
    assert.ok(!isError(result), text(result));
    const sent = rpcCalls(host).filter((call) => call.method === "ask");
    assert.equal(sent.length, 1);
    assert.deepEqual(sent[0]!.input.options, [{ label: "Yes", value: "A" }, { label: "No", value: "B" }]);
    assert.equal((sent[0]!.input.card as { kind: string }).kind, "question");
    assert.match(String(sent[0]!.input.text), /^❓ Dark mode by default\?/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("the board lists a grilling round as one Needs you item", async () => {
  const host = await roundHost();
  try {
    const result = await askTool(host, { kind: "question", round: ROUND });
    const id = /ask (a[0-9a-z]{6})/.exec(text(result))![1]!;
    const board = await host.harness.behavior.callRpc("telegramCommand", { command: "board", threadId: "thr_cap" }) as { text: string };
    assert.match(board.text, /^📌 Needs you \(1\)\n1\. ❓ /);
    assert.match(board.text, new RegExp(`ask ${id}`));
    assert.equal([...board.text.matchAll(/^📌 Needs you/gm)].length, 1);
    assert.match(board.text, /Answer a grilling round like 1A 2C/);
    assert.equal(asks(host).listWaiting("thr_cap", Date.now()).length, 1, "a reminder counts the round once");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("recording some round answers keeps the round open; recording all of them closes it", async () => {
  const host = await roundHost();
  try {
    const opened = await askTool(host, { kind: "question", round: ROUND });
    const id = /ask (a[0-9a-z]{6})/.exec(text(opened))![1]!;
    const partial = await resolveTool(host, { id, answers: [{ n: 1, choice: "A" }, { n: 3, choice: "B" }] });
    assert.ok(!isError(partial), text(partial));
    assert.equal(asks(host).get(id)?.state, "open");
    assert.deepEqual(asks(host).get(id)?.roundAnswers, { 1: "Grow reach", 3: "Three times a week" });
    assert.equal(asks(host).listWaiting("thr_cap", Date.now()).length, 1);
    const edits = rpcCalls(host).filter((call) => call.method === "editAsk");
    assert.equal(edits.length, 0, "a round has no card to edit");
    const full = await resolveTool(host, { id, answers: [{ n: 2, choice: "C" }, { n: 4, choice: "C" }] });
    assert.ok(!isError(full), text(full));
    const closed = asks(host).get(id)!;
    assert.equal(closed.state, "answered");
    assert.equal(closed.resolution, "1A 2C 3B 4C");
    assert.equal(asks(host).listOpen("thr_cap").length, 0);
    assert.equal(rpcCalls(host).filter((call) => call.method === "editAsk").length, 0);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an owner free-text reply to a grilling round reaches the captain and does not close the round", async () => {
  const host = await roundHost();
  try {
    const opened = await askTool(host, { kind: "question", round: ROUND });
    const id = /ask (a[0-9a-z]{6})/.exec(text(opened))![1]!;
    const hook = host.harness.inspection.registrations.hooks["message.dispatch"]!;
    const send = (body: string) => hook({
      thread: makeThreadResponse({ id: "thr_cap", status: "active" }),
      attempt: "join-turn", initiator: "user", senderThreadId: null, queuedMessages: [],
      input: { blocks: [], text: body },
    } as never);
    await send(askReply(id, "1A 2C 3B 4A"));
    assert.equal(asks(host).get(id)?.state, "open");
    await send(askReply(id, "yes"));
    assert.equal(asks(host).get(id)?.state, "open");
    const pending = createInboundLedger(host.bb.storage.database()).listPending("thr_cap");
    assert.equal(pending.length, 1, "the reply is one owner message, not four card answers");
    assert.equal(pending[0]!.state, "received");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
