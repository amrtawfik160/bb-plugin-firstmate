import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createOwnerAsks, formatAskCard } from "./lib/owner-asks.ts";
import { createInboundLedger } from "./lib/inbound-ledger.ts";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInboundTelegram } from "./lib/telegram-envelope.ts";
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
      "✅ Finished since you last looked: nothing new.",
      "",
      "🚀 Not live yet: nothing merged waits to go live.",
      "",
      "🔧 In progress: nothing open.",
    ].join("\n"));
    let tap = "Publish";
    host.harness.sdk.stub("plugins.callRpc", async (call: { method?: string }) => {
      if (call.method === "ownerAnswer") return { answer: tap, ok: true };
      return { ok: true, queued: 1, duplicate: false, mode: "on" };
    });
    assert.deepEqual(await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_other", id: "aexisting", resolution: "Publish" }), { ok: false });
    assert.deepEqual(await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: "aexisting", resolution: "Publish" }), { ok: true });
    assert.equal(asks.get("aexisting")?.resolution, "Publish");
    tap = "Owner approved the address repair at 12:00 Cairo.";
    assert.deepEqual(await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: "aexisting", resolution: "Owner approved the address repair at 12:00 Cairo." }), { ok: true });
    assert.equal(asks.get("aexisting")?.resolution, "Owner approved the address repair at 12:00 Cairo.");
    assert.deepEqual(await host.harness.behavior.callRpc("telegramCommand", { threadId: "thr_cap", command: "board" }), { text: "📌 Needs you: nothing right now.\n\n✅ Finished since you last looked: nothing new.\n\n🚀 Not live yet: nothing merged waits to go live.\n\n🔧 In progress: nothing open.", away: false, projects: [], notLive: [] }, "no crew runs: zero crews, so Telegram does not count task lines");

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
    const result = await host.harness.behavior.callAgentTool("firstmate_ask", { question: "Decision 12: switch the brands audit to weekly?", kind: "question", options: [{ label: "Weekly" }, { label: "Keep daily" }], project: "Areliaa" }, { threadId: "thr_cap" });
    assert.equal(typeof result === "object" && result !== null && "isError" in result, false);
    const [ask] = createOwnerAsks(host.bb.storage.database()).listOpen("thr_cap");
    assert.equal(formatAskCard(ask!), "❓ Decision 12: switch the brands audit to weekly?");
  } finally { await host.harness.lifecycle.dispose(); }
});

// 15 Oct, chat @meraaiagentbot. 08:54 UTC a card "may we add its first idea to our CI?" went out with "Yes, build it"
// recommended and a 12:54 UTC default, and the owner had to ask "Show me the idea lol" to see the crew's report.
const AGENT_NATIVE_REF = "tg:985604794:4498";
const AGENT_NATIVE_CARD = {
  question: "agent-native: may we add its first idea to our CI, so a check that could not run is reported separately from one that passed (1 to 2 days)?",
  kind: "question", options: [{ label: "Yes, build it" }, { label: "No" }], recommended: 0, defaultAfterMinutes: 240, project: "Cyndra",
};

async function agentNativeCase() {
  const host = await captainHost();
  const db = host.bb.storage.database();
  const body = [
    "The following is an owner message from the private Telegram connector.",
    "correlation: tgref:9b068a6f", "binding: 3", "telegram_user_id: 985604794", "telegram_chat_id: 985604794",
    "telegram_message_id: 4498", "reply_target: none", "project: none", "",
    "Check https://github.com/builderio/agent-native and see how it can help us in the platform",
  ].join("\n");
  createInboundLedger(db).record({ captainThreadId: "thr_cap", text: body, receivedAt: Date.now() - 4 * 60_000, bbThreadId: "thr_cap", initiator: "user", telegram: parseInboundTelegram(body) });
  const call = (name: string, input: Record<string, unknown>) => host.harness.behavior.callAgentTool(name, input, { threadId: "thr_cap", projectId: "proj_1" });
  const rpc = () => host.harness.sdk.callsTo("plugins.callRpc").map((c) => c[0] as { method: string; input: Record<string, unknown> });
  return { host, db, call, rpc };
}

const failed = (result: unknown) => typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;
const textOf = (result: unknown) => typeof result === "string" ? result : (result as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("\n");

test("15 Oct agent-native: a card that starts new work has no default and says it waits for the owner", async () => {
  const { host, db, call, rpc } = await agentNativeCase();
  try {
    const card = await call("firstmate_ask", { ...AGENT_NATIVE_CARD, startsNewWork: true });
    assert.equal(failed(card), false, textOf(card));
    const [ask] = createOwnerAsks(db).listOpen("thr_cap");
    assert.equal(ask?.defaultAt, null, "a card that starts new work never defaults");
    assert.match(textOf(card), /waits for the owner's answer/);
    const askCall = rpc().find((c) => c.method === "ask")!;
    assert.equal(askCall.input.text, `❓ ${AGENT_NATIVE_CARD.question}\n\nThis starts new work, so I wait for your answer.`);
    assert.equal((askCall.input.card as { gated: boolean }).gated, true);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("15 Oct agent-native: firstmate_reply links each attached file and refuses a path with no file", async () => {
  const { host, call, rpc } = await agentNativeCase();
  try {
    const report = join(mkdtempSync(join(tmpdir(), "fm-report-")), "report.md");
    const missing = await call("firstmate_reply", { noWork: true, ref: AGENT_NATIVE_REF, text: "agent-native: skip adoption, copy a few ideas.", files: [report] });
    assert.equal(failed(missing), true, textOf(missing));
    assert.match(textOf(missing), new RegExp(`^Not sent: no file at ${report}\\. ${AGENT_NATIVE_REF} stays open\\.`));
    assert.equal(rpc().filter((c) => c.method === "reply").length, 0);

    writeFileSync(report, "# agent-native\nSkip adoption; copy a few ideas with credit.\n");
    const sent = await call("firstmate_reply", { noWork: true, ref: AGENT_NATIVE_REF, text: "agent-native: skip adoption, copy a few ideas.", files: [report] });
    assert.equal(failed(sent), false, textOf(sent));
    const reply = rpc().filter((c) => c.method === "reply").at(-1)!;
    assert.ok(String(reply.input.text).endsWith(`\n\n[report.md](${report})`), String(reply.input.text));
  } finally { await host.harness.lifecycle.dispose(); }
});

test("PR 132 round 2: firstmate_reply refuses a directory or a relative path before anything is sent", async () => {
  const { host, call, rpc } = await agentNativeCase();
  try {
    const folder = mkdtempSync(join(tmpdir(), "fm-report-"));
    const directory = await call("firstmate_reply", { noWork: true, ref: AGENT_NATIVE_REF, text: "Here are the findings.", files: [folder] });
    assert.equal(failed(directory), true, textOf(directory));
    assert.match(textOf(directory), new RegExp(`^Not sent: ${folder} is not a regular file\\. ${AGENT_NATIVE_REF} stays open\\.`));
    await assert.rejects(call("firstmate_reply", { noWork: true, ref: AGENT_NATIVE_REF, text: "Here are the findings.", files: ["report.md"] }), /must start with "\/"/);
    assert.equal(rpc().filter((c) => c.method === "reply").length, 0, "nothing reached the connector");
  } finally { await host.harness.lifecycle.dispose(); }
});

test("PR 132 round 3: a file name ending in :<number> is refused before anything is sent, because the connector reads that ending as a line number", async () => {
  const { host, call, rpc } = await agentNativeCase();
  try {
    const dir = mkdtempSync(join(tmpdir(), "fm-report-"));
    writeFileSync(join(dir, "report.md"), "# a different file\n");
    const colon = join(dir, "report.md:123");
    writeFileSync(colon, "# the attached file\n");
    const refused = await call("firstmate_reply", { noWork: true, ref: AGENT_NATIVE_REF, text: "Here are the findings.", files: [colon] });
    assert.equal(failed(refused), true, textOf(refused));
    assert.match(textOf(refused), new RegExp(`^Not sent: ${colon} ends in :<number>, which Telegram reads as a line number\\. Rename or copy the file\\. ${AGENT_NATIVE_REF} stays open\\.`));
    assert.equal(rpc().filter((c) => c.method === "reply").length, 0, "nothing reached the connector");
  } finally { await host.harness.lifecycle.dispose(); }
});

test("PR 132 round 2: an attached path with spaces or brackets reaches the connector as a link that decodes to the exact path", async () => {
  const { host, call, rpc } = await agentNativeCase();
  try {
    const report = join(mkdtempSync(join(tmpdir(), "fm report [r2] ")), "report with spaces (final).md");
    writeFileSync(report, "# findings\n");
    const sent = await call("firstmate_reply", { noWork: true, ref: AGENT_NATIVE_REF, text: "Here are the findings.", files: [report] });
    assert.equal(failed(sent), false, textOf(sent));
    const reply = String(rpc().filter((c) => c.method === "reply").at(-1)!.input.text);
    const link = /\n\n\[([^\]\n]*)\]\(([^\s)]+)\)$/.exec(reply);
    assert.ok(link, reply);
    assert.equal(link[1], "report with spaces (final).md");
    assert.equal(decodeURIComponent(link[2]!), report);
  } finally { await host.harness.lifecycle.dispose(); }
});

// 15 Oct 18:02 UTC: the captain attached /root/tg-share/jess-leads-openleads.csv and .md. Firstmate said sent;
// the connector refused both (only the captain workspace, /tmp, captain data and BB worktrees), so the owner got no files.
test("15 Oct jess-leads: firstmate_reply refuses a file Telegram will not send, before anything is sent or reserved, and says to copy it to /tmp", async () => {
  const { host, db, call, rpc } = await agentNativeCase();
  const outside = mkdtempSync("/var/tmp/fm-tg-share-");
  try {
    const csv = join(outside, "jess-leads-openleads.csv");
    const md = join(outside, "jess-leads-openleads.md");
    writeFileSync(csv, "name,email\n");
    writeFileSync(md, "# leads\n");
    const args = { noWork: true, ref: AGENT_NATIVE_REF, text: "Here are the open leads.", files: [csv, md] };
    const refused = await call("firstmate_reply", args);
    assert.equal(failed(refused), true, textOf(refused));
    assert.equal(textOf(refused).split("\n").slice(0, 3).join("\n"), [
      `Not sent: Telegram will not send ${csv}: only files in the captain's workspace, /tmp, the captain's data folder or a BB worktree are sent.`,
      `Not sent: Telegram will not send ${md}: only files in the captain's workspace, /tmp, the captain's data folder or a BB worktree are sent.`,
      `Copy each file to /tmp under a name that does not start with "." and attach the copy. ${AGENT_NATIVE_REF} stays open.`,
    ].join("\n"));
    assert.equal(rpc().filter((c) => c.method === "reply").length, 0, "nothing reached the connector");
    const ledger = createInboundLedger(db);
    assert.equal(ledger.get({ source: "telegram", chatId: "985604794", messageId: "4498" })?.state, "received", "the item stays open");
    assert.equal(ledger.outboxGet({ source: "telegram", chatId: "985604794", messageId: "4498" }, "reply"), undefined, "nothing is reserved");

    const tmp = mkdtempSync(join("/tmp", "fm-tg-share-"));
    const copies = [csv, md].map((file) => { const copy = join(tmp, file.split("/").at(-1)!); writeFileSync(copy, "x"); return copy; });
    const sent = await call("firstmate_reply", { noWork: true, ...args, files: copies });
    assert.equal(failed(sent), false, textOf(sent));
    assert.equal(rpc().filter((c) => c.method === "reply").length, 1);
  } finally {
    rmSync(outside, { recursive: true, force: true });
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_reply sends a file from the captain's workspace, which the connector allows", async () => {
  const { host, call, rpc } = await agentNativeCase();
  const workspace = mkdtempSync("/var/tmp/fm-captain-ws-");
  try {
    host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_1", status: "active", environmentId: threadId === "thr_cap" ? "env_cap" : null }));
    host.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: "host_1", status: "ready", path: workspace }));
    const build = join(workspace, "build.zip");
    writeFileSync(build, "zip");
    const sent = await call("firstmate_reply", { noWork: true, ref: AGENT_NATIVE_REF, text: "The build.", files: [build] });
    assert.equal(failed(sent), false, textOf(sent));
    assert.equal(rpc().filter((c) => c.method === "reply").length, 1);
    const hidden = join(workspace, ".env");
    writeFileSync(hidden, "TOKEN=x");
    const refused = await call("firstmate_reply", { noWork: true, ref: AGENT_NATIVE_REF, text: "The env.", files: [hidden] });
    assert.match(textOf(refused), new RegExp(`^Not sent: Telegram will not send ${hidden}: hidden files, hidden folders and \\.env files are never sent\\.`));
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    await host.harness.lifecycle.dispose();
  }
});

test("16 Oct project topics: a card and a reply carry the project the captain names, so Telegram puts them in its topic", async () => {
  const { host, call, rpc } = await agentNativeCase();
  try {
    const card = await call("firstmate_ask", { ...AGENT_NATIVE_CARD, project: "Cyndra" });
    assert.equal(failed(card), false, textOf(card));
    assert.equal(rpc().find((c) => c.method === "ask")!.input.project, "Cyndra");
    const reply = await call("firstmate_reply", { noWork: true, ref: AGENT_NATIVE_REF, text: "agent-native: skip adoption, copy a few ideas.", project: "Cyndra" });
    assert.equal(failed(reply), false, textOf(reply));
    assert.equal(rpc().find((c) => c.method === "reply")!.input.project, "Cyndra");
    // Owner decision Q7 (17 Oct): a card with no project is refused, not routed by Decisions.
    const plain = await call("firstmate_ask", { ...AGENT_NATIVE_CARD, project: undefined, question: "Another question with no project?" });
    assert.equal(failed(plain), true, textOf(plain));
    assert.match(textOf(plain), /Refusing: a card names its project/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("16 Oct project topics: a reply held back as a card repeat says what really happened, with more=true too", async () => {
  for (const more of [false, true]) {
    const { host, call } = await agentNativeCase();
    try {
      host.harness.sdk.stub("plugins.callRpc", async (args: { method: string }) => (args.method === "reply" ? { queued: 0, duplicate: false, mode: "on", cardRepeat: true } : { ok: true, queued: 1, duplicate: false, mode: "on" }));
      const reply = await call("firstmate_reply", { noWork: true, ref: AGENT_NATIVE_REF, text: "I sent a card about it.", ...(more ? { more: true } : {}) });
      assert.equal(failed(reply), false, textOf(reply));
      const open = createInboundLedger(host.bb.storage.database()).listPending("thr_cap").some((row) => `tg:${row.chatId}:${row.messageId}` === AGENT_NATIVE_REF);
      assert.equal(open, more, more ? "more=true keeps the message open" : "the card answers it");
      assert.match(textOf(reply), more ? new RegExp(`${AGENT_NATIVE_REF} stays open \\(more=true\\)`) : new RegExp(`answers ${AGENT_NATIVE_REF}\\. It is closed\\.`));
      assert.doesNotMatch(textOf(reply), more ? /It is closed/ : /stays open/);
    } finally { await host.harness.lifecycle.dispose(); }
  }
});

// 18 Oct, owner: "add skip button also in the waiting for you section". The Board's Skip defers the card
// ("decide later") and the captain is told once, so it neither waits on the card nor acts on it.
test("deferAsk skips the owner's open cards until a time, tells the captain once, and takes them off Needs you", async () => {
  const host = await captainHost();
  try {
    const asks = createOwnerAsks(host.bb.storage.database());
    const options = [{ label: "Publish", value: "publish" }, { label: "Wait", value: "wait" }];
    asks.create({ id: "askip1", captain: "thr_cap", kind: "question", text: "Publish Safi?", options, createdAt: Date.now() });
    asks.create({ id: "askip2", captain: "thr_cap", kind: "question", text: "Rename the app?", options, createdAt: Date.now() });
    const until = Date.UTC(2030, 0, 2, 7, 0);

    assert.deepEqual(await host.harness.behavior.callRpc("deferAsk", { threadId: "thr_other", ids: ["askip1"], until }), { ok: false, deferred: [], already: [], refused: ["askip1"], until: null });
    assert.deepEqual(await host.harness.behavior.callRpc("deferAsk", { threadId: "thr_cap", ids: ["askip1"], until }), { ok: true, deferred: ["askip1"], already: [], refused: [], until });
    assert.equal(asks.get("askip1")?.deferredUntil, until);

    const told = host.harness.sdk.callsTo("threads.send").map((call) => call[0] as { threadId: string; mode: string; input: Array<{ text: string; visibility?: string }> });
    assert.equal(told.length, 1);
    assert.equal(told[0]!.threadId, "thr_cap");
    assert.equal(told[0]!.mode, "steer");
    assert.equal(told[0]!.input[0]!.visibility, "agent-only");
    assert.match(told[0]!.input[0]!.text, /askip1/);
    assert.match(told[0]!.input[0]!.text, /2030-01-02 07:00 UTC/);
    assert.match(told[0]!.input[0]!.text, /do not act on it/i);

    assert.deepEqual(await host.harness.behavior.callRpc("deferAsk", { threadId: "thr_cap", ids: ["askip1"], until: until + 60_000 }), { ok: true, deferred: [], already: ["askip1"], refused: [], until }, "a repeat is a no-op and keeps the first time");
    assert.equal(host.harness.sdk.callsTo("threads.send").length, 1, "the captain is told once");

    const board = await host.harness.behavior.callRpc("telegramCommand", { threadId: "thr_cap", command: "board" }) as { text: string };
    assert.match(board.text, /Rename the app\?/);
    assert.doesNotMatch(board.text, /Publish Safi\?/, "a skipped card is not in Needs you");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Checker 159 finding 2: a card answered elsewhere is refused, so the Board can refuse its Skip.
test("deferAsk refuses a card that is no longer open and skips nothing", async () => {
  const host = await captainHost();
  try {
    const asks = createOwnerAsks(host.bb.storage.database());
    const options = [{ label: "Yes", value: "yes" }];
    asks.create({ id: "aopen", captain: "thr_cap", kind: "question", text: "Ship?", options, createdAt: Date.now() });
    asks.create({ id: "adone", captain: "thr_cap", kind: "question", text: "Ship?", options, createdAt: Date.now() });
    asks.resolve("adone", "thr_cap", "answered", "Yes", Date.now());
    assert.deepEqual(await host.harness.behavior.callRpc("deferAsk", { threadId: "thr_cap", ids: ["aopen", "adone"], until: Date.now() + 3_600_000 }), { ok: false, deferred: [], already: [], refused: ["adone"], until: null });
    assert.equal(asks.get("aopen")?.deferredUntil, undefined);
    assert.equal(host.harness.sdk.callsTo("threads.send").length, 0, "nothing to tell the captain");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Checker 159 finding 1 (their reproduction): the captain notice survives a failed send.
test("a captain notice whose send failed is sent on the next Skip request, once", async () => {
  const host = await captainHost();
  try {
    const asks = createOwnerAsks(host.bb.storage.database());
    asks.create({ id: "lost", captain: "thr_cap", kind: "question", text: "Ship?", options: [{ label: "Yes", value: "yes" }], createdAt: Date.now() });
    let attempts = 0, delivered = 0;
    host.harness.sdk.stub("threads.send", async () => { attempts++; if (attempts === 1) throw new Error("temporary BB send failure"); delivered++; return {}; });
    const input = { threadId: "thr_cap", ids: ["lost"], until: Date.now() + 3_600_000 };
    await host.harness.behavior.callRpc("deferAsk", input);
    await host.harness.behavior.callRpc("deferAsk", input);
    await host.harness.behavior.callRpc("deferAsk", input);
    assert.equal(delivered, 1, "captain must receive exactly one skip notice after retry");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Checker 159 finding 3 (their reproduction): at its time a skipped overdue question waits for the owner.
test("decide-later expiry returns an overdue question for owner review", async () => {
  const host = await captainHost();
  try {
    const asks = createOwnerAsks(host.bb.storage.database());
    const now = Date.now();
    const until = now + 3_600_000;
    asks.create({ id: "due", captain: "thr_cap", kind: "question", text: "Ship?", options: [{ label: "Yes", value: "yes" }], recommended: 0, defaultAt: now - 1, createdAt: now - 60_000 });
    await host.harness.behavior.callRpc("deferAsk", { threadId: "thr_cap", ids: ["due"], until });
    assert.deepEqual(asks.takeDue("thr_cap", until - 1), []);
    assert.deepEqual(asks.takeDue("thr_cap", until), []);
    assert.equal(asks.get("due")?.state, "open", "09:00 should return the question for the owner, not decide it automatically");
    assert.deepEqual(asks.listWaiting("thr_cap", until).map((ask) => ask.id), ["due"]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Checker round 2 (159-TG68-verdict-2.md), their reproduction: two overlapping Skip requests for one card
// make one captain notice, even while the first send is still in flight.
test("overlapping defer retries tell the captain once", { timeout: 15_000 }, async () => {
  const host = await captainHost();
  try {
    const asks = createOwnerAsks(host.bb.storage.database());
    const now = Date.now();
    asks.create({ id: "race", captain: "thr_cap", kind: "question", text: "Ship?", options: [{ label: "Yes", value: "yes" }], createdAt: now });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { entered = resolve; });
    let notices = 0;
    host.harness.sdk.stub("threads.send", async () => { notices++; entered(); await gate; return {}; });
    const input = { threadId: "thr_cap", ids: ["race"], until: now + 3_600_000 };
    const first = host.harness.behavior.callRpc("deferAsk", input);
    const second = host.harness.behavior.callRpc("deferAsk", input);
    await firstEntered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    release();
    await Promise.all([first, second]);
    assert.equal(notices, 1, "overlapping RPC/retry must not send the same skip notice twice");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("closeAsk closes one card without answering, removes it from Needs you, and tells the captain once", async () => {
  const host = await captainHost();
  try {
    const asks = createOwnerAsks(host.bb.storage.database());
    const now = Date.now();
    asks.create({ id: "close1", captain: "thr_cap", kind: "question", text: "Publish Safi?", options: [{ label: "Yes", value: "yes" }], recommended: 0, defaultAt: now + 1000, createdAt: now });
    const input = { threadId: "thr_cap", ids: ["close1"] };
    assert.deepEqual(await host.harness.behavior.callRpc("closeAsk", input), { ok: true, closed: ["close1"], already: [], refused: [] });
    assert.equal(asks.get("close1")?.resolution, "closed by owner, no action");
    assert.ok(asks.get("close1")!.resolvedAt! >= now);
    assert.deepEqual(asks.listOpen("thr_cap"), []);
    assert.deepEqual(asks.takeDue("thr_cap", now + 2000), []);
    const board = await host.harness.behavior.callRpc("telegramCommand", { threadId: "thr_cap", command: "board" }) as { text: string };
    assert.doesNotMatch(board.text, /Publish Safi/);
    assert.deepEqual(await host.harness.behavior.callRpc("closeAsk", input), { ok: true, closed: [], already: ["close1"], refused: [] });
    const notices = host.harness.sdk.callsTo("threads.send");
    assert.equal(notices.length, 1);
    assert.deepEqual(notices[0]![0], { threadId: "thr_cap", mode: "steer", input: [{ type: "text", text: "Owner closed card close1 (Publish Safi?) with no answer: take no action on it; if a crew waits on it, tell the crew the owner closed it.", mentions: [], visibility: "agent-only" }] });
  } finally { await host.harness.lifecycle.dispose(); }
});

test("closeAsk closes only named cards in a pack and preserves their task", async () => {
  const host = await captainHost();
  try {
    const { createOwnerTasks } = await import("./lib/owner-tasks.ts");
    const tasks = createOwnerTasks(host.bb.storage.database());
    const task = tasks.open({ captain: "thr_cap", project: "Safi", title: "Publish", sourceRefs: [], at: Date.now() });
    const asks = createOwnerAsks(host.bb.storage.database());
    for (const id of ["pack1", "pack2"]) asks.create({ id, captain: "thr_cap", kind: "question", text: id, options: [], task: task.id, createdAt: Date.now() });
    const before = tasks.get(task.id);
    await host.harness.behavior.callRpc("closeAsk", { threadId: "thr_cap", ids: ["pack1", "pack1"] });
    assert.deepEqual(asks.listWaiting("thr_cap", Date.now()).map((ask) => ask.id), ["pack2"]);
    assert.deepEqual(tasks.get(task.id), before);
    assert.deepEqual(await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: "pack1", resolution: "Yes" }), { ok: false });
    assert.equal(asks.resolve("pack1", "thr_cap", "open", "Reopen", Date.now()), undefined);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("closeAsk refuses all cards when one belongs to another captain, is missing, or is already answered", async () => {
  const host = await captainHost();
  try {
    const asks = createOwnerAsks(host.bb.storage.database());
    for (const [id, captain] of [["own", "thr_cap"], ["foreign", "thr_other"], ["answered", "thr_cap"]]) asks.create({ id, captain, kind: "question", text: id, options: [], createdAt: Date.now() });
    asks.resolve("answered", "thr_cap", "answered", "Yes", Date.now());
    for (const id of ["foreign", "missing", "answered"]) {
      assert.deepEqual(await host.harness.behavior.callRpc("closeAsk", { threadId: "thr_cap", ids: ["own", id] }), { ok: false, closed: [], already: [], refused: [id] });
      assert.equal(asks.get("own")?.state, "open");
    }
    assert.deepEqual(await host.harness.behavior.callRpc("closeAsk", { threadId: "thr_other", ids: ["own"] }), { ok: false, closed: [], already: [], refused: ["own"] });
    assert.equal(host.harness.sdk.callsTo("threads.send").length, 0);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("closeAsk retries a failed notice and overlapping repeats deliver once", async () => {
  const host = await captainHost();
  try {
    const asks = createOwnerAsks(host.bb.storage.database());
    asks.create({ id: "retryclose", captain: "thr_cap", kind: "question", text: "Ship?", options: [], createdAt: Date.now() });
    let attempts = 0;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    host.harness.sdk.stub("threads.send", async () => {
      attempts++;
      if (attempts === 1) throw new Error("temporary failure");
      entered(); await gate; return {};
    });
    const input = { threadId: "thr_cap", ids: ["retryclose"] };
    await host.harness.behavior.callRpc("closeAsk", input);
    const first = host.harness.behavior.callRpc("closeAsk", input);
    await started;
    const second = host.harness.behavior.callRpc("closeAsk", input);
    release();
    await Promise.all([first, second]);
    await host.harness.behavior.callRpc("closeAsk", input);
    assert.equal(attempts, 2);
    assert.equal(asks.get("retryclose")?.resolution, "closed by owner, no action");
  } finally { await host.harness.lifecycle.dispose(); }
});

test("closeAsk is published for RPC discovery with the same bounded ids input as deferAsk", async () => {
  const host = await captainHost();
  try {
    const published = host.harness.registrations.experimental_publishedRpcMethods;
    const close = published.find((method) => method.method === "closeAsk");
    const defer = published.find((method) => method.method === "deferAsk");
    assert.ok(close, "Telegram must discover closeAsk before offering Close");
    assert.ok(defer);
    assert.deepEqual(close.inputSchema.properties?.ids, defer.inputSchema.properties?.ids);
    assert.deepEqual(close.inputSchema.required, ["threadId", "ids"]);
    assert.match(close.methodDescription!, /no answer and no action/);
    for (const ids of [[], Array(21).fill("a"), [""], ["a".repeat(65)]]) {
      await assert.rejects(host.harness.behavior.callRpc("closeAsk", { threadId: "thr_cap", ids }), /input/i);
    }
  } finally { await host.harness.lifecycle.dispose(); }
});
