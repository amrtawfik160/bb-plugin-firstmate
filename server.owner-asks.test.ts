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
      "✅ Done since you last looked: nothing new.",
      "",
      "🔧 In progress: nothing open.",
    ].join("\n"));
    assert.deepEqual(await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_other", id: "aexisting", resolution: "Publish" }), { ok: false });
    assert.deepEqual(await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: "aexisting", resolution: "Publish" }), { ok: true });
    assert.equal(asks.get("aexisting")?.resolution, "Publish");
    assert.deepEqual(await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: "aexisting", resolution: "Owner approved the address repair at 12:00 Cairo." }), { ok: true });
    assert.equal(asks.get("aexisting")?.resolution, "Owner approved the address repair at 12:00 Cairo.");
    assert.deepEqual(await host.harness.behavior.callRpc("telegramCommand", { threadId: "thr_cap", command: "board" }), { text: "📌 Needs you: nothing right now.\n\n✅ Done since you last looked: nothing new.\n\n🔧 In progress: nothing open.", away: false, projects: [] }, "no crew runs: zero crews, so Telegram does not count task lines");

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
    const missing = await call("firstmate_reply", { ref: AGENT_NATIVE_REF, text: "agent-native: skip adoption, copy a few ideas.", files: [report] });
    assert.equal(failed(missing), true, textOf(missing));
    assert.match(textOf(missing), new RegExp(`^Not sent: no file at ${report}\\. ${AGENT_NATIVE_REF} stays open\\.`));
    assert.equal(rpc().filter((c) => c.method === "reply").length, 0);

    writeFileSync(report, "# agent-native\nSkip adoption; copy a few ideas with credit.\n");
    const sent = await call("firstmate_reply", { ref: AGENT_NATIVE_REF, text: "agent-native: skip adoption, copy a few ideas.", files: [report] });
    assert.equal(failed(sent), false, textOf(sent));
    const reply = rpc().filter((c) => c.method === "reply").at(-1)!;
    assert.ok(String(reply.input.text).endsWith(`\n\n[report.md](${report})`), String(reply.input.text));
  } finally { await host.harness.lifecycle.dispose(); }
});

test("PR 132 round 2: firstmate_reply refuses a directory or a relative path before anything is sent", async () => {
  const { host, call, rpc } = await agentNativeCase();
  try {
    const folder = mkdtempSync(join(tmpdir(), "fm-report-"));
    const directory = await call("firstmate_reply", { ref: AGENT_NATIVE_REF, text: "Here are the findings.", files: [folder] });
    assert.equal(failed(directory), true, textOf(directory));
    assert.match(textOf(directory), new RegExp(`^Not sent: ${folder} is not a regular file\\. ${AGENT_NATIVE_REF} stays open\\.`));
    await assert.rejects(call("firstmate_reply", { ref: AGENT_NATIVE_REF, text: "Here are the findings.", files: ["report.md"] }), /must start with "\/"/);
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
    const refused = await call("firstmate_reply", { ref: AGENT_NATIVE_REF, text: "Here are the findings.", files: [colon] });
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
    const sent = await call("firstmate_reply", { ref: AGENT_NATIVE_REF, text: "Here are the findings.", files: [report] });
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
    const args = { ref: AGENT_NATIVE_REF, text: "Here are the open leads.", files: [csv, md] };
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
    const sent = await call("firstmate_reply", { ...args, files: copies });
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
    const sent = await call("firstmate_reply", { ref: AGENT_NATIVE_REF, text: "The build.", files: [build] });
    assert.equal(failed(sent), false, textOf(sent));
    assert.equal(rpc().filter((c) => c.method === "reply").length, 1);
    const hidden = join(workspace, ".env");
    writeFileSync(hidden, "TOKEN=x");
    const refused = await call("firstmate_reply", { ref: AGENT_NATIVE_REF, text: "The env.", files: [hidden] });
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
    const reply = await call("firstmate_reply", { ref: AGENT_NATIVE_REF, text: "agent-native: skip adoption, copy a few ideas.", project: "Cyndra" });
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
      const reply = await call("firstmate_reply", { ref: AGENT_NATIVE_REF, text: "I sent a card about it.", ...(more ? { more: true } : {}) });
      assert.equal(failed(reply), false, textOf(reply));
      const open = createInboundLedger(host.bb.storage.database()).listPending("thr_cap").some((row) => `tg:${row.chatId}:${row.messageId}` === AGENT_NATIVE_REF);
      assert.equal(open, more, more ? "more=true keeps the message open" : "the card answers it");
      assert.match(textOf(reply), more ? new RegExp(`${AGENT_NATIVE_REF} stays open \\(more=true\\)`) : new RegExp(`answers ${AGENT_NATIVE_REF}\\. It is closed\\.`));
      assert.doesNotMatch(textOf(reply), more ? /It is closed/ : /stays open/);
    } finally { await host.harness.lifecycle.dispose(); }
  }
});
