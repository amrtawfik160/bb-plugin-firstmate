import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse, makeQueueEntry } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createOwnerAsks } from "./lib/owner-asks.ts";
import { createOwnerTasks } from "./lib/owner-tasks.ts";
import { createDeliveries } from "./lib/pr-delivery.ts";

// Owner decisions Q7 and Q8 (17 Oct). The 15-17 Oct audit: 95 cards in 48 h, 32 without a project,
// about 14 asking what captain.md settles, topics re-asked 2-3 times; T194, T196 and T197 "working"
// 35 h after their crews wrote done, T200 working with no crew, crew b08649c2 waiting on questions
// nobody asked.
const CAPTAIN_MD = [
  "# Owner instructions",
  "## Work",
  "1. Crews do the work: code, commits, pushes, merges, deploys, Safi publishes.",
  "## Project facts",
  "- Safi: publish every app update to both preview and production.",
].join("\n");
const ctx = { threadId: "thr_cap", projectId: "proj_1" };
type Call = { method: string; input: Record<string, unknown> };

function crewRow(id: string, threadId: string, extra: Record<string, unknown> = {}) {
  return { id, task: "x", title: id, projectId: "proj_1", threadId, parentThreadId: "thr_cap", nativeHome: "/native", worktree: true, shape: "ship", posture: "direct-PR", createdAt: "2026-10-17T00:00:00.000Z", providerId: null, model: null, reasoningLevel: null, ...extra };
}

async function captainHost(status: Record<string, string> = {}, options: { decisions?: () => Promise<Response>; nativeAnswer?: () => number } = {}) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["captain", "firstmate"], settings: { fmHome: "/native", fmHostId: "host_1" } });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await plugin(host.bb);
  const keyDir = mkdtempSync(join(tmpdir(), "fm-decisions-"));
  writeFileSync(join(keyDir, "decisions.env"), "OPENAI_API_KEY=test-key\n");
  await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on" }), ...(options.decisions ? { decisionsKeyFile: join(keyDir, "decisions.env") } : {}) });
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_1", status: "idle" }));
  host.harness.sdk.stub("threads.send", async () => ({ delivery: "queued" }));
  host.harness.sdk.stub("threads.output", async () => ({ output: "" }));
  host.harness.sdk.stub("environments.list", async () => [{ id: "env_source", hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("projects.get", async () => ({ id: "proj_1", name: "Cyndra", kind: "repo" }));
  host.harness.sdk.stub("files.read", async ({ path }: { path: string }) => {
    if (path === "/native/data/captain.md") return { content: CAPTAIN_MD, sizeBytes: CAPTAIN_MD.length };
    throw new Error("ENOENT");
  });
  const rpc: Call[] = [];
  host.harness.sdk.stub("plugins.callRpc", async (call: Call) => { rpc.push(call); return { ok: true, queued: 1, duplicate: false }; });
  const commands: string[] = [];
  const byId = new Map<string, string>();
  let n = 0;
  host.harness.sdk.stub("terminals.create", async (args: { start: { command: string } }) => { const id = `term${++n}`; byId.set(id, args.start.command); commands.push(args.start.command); return { id }; });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => {
    const command = byId.get(terminalId) ?? "";
    const crew = /\/native\/state\/([\w-]+)\.status/.exec(command)?.[1];
    const payload = command.includes("fm-bearings-snapshot.sh")
      ? JSON.stringify({ schema: "fm-bearings.v1", home: "/native", in_flight: [], decisions_open: [], landed: [], gates: [], omitted: [] })
      : crew !== undefined && status[crew] !== undefined ? status[crew] : "";
    const code = command.includes("fm-captain-hold.sh") && command.includes("'open'") && command.includes("'wait1'") ? 1
      : command.includes("fm-captain-hold.sh") && command.includes("'answer'") && options.nativeAnswer
        ? options.nativeAnswer() : crew !== undefined && status[crew] === undefined ? 3 : 0;
    const captured = command.includes("FM_HOST_CAPTURE_V1");
    const out = captured ? JSON.stringify({ protocol: "FM_HOST_CAPTURE_V1", exitCode: code, stdout: payload, stderr: "" }) : payload;
    return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${out}\n__FM_HOST_RC:${captured ? 0 : code}\n`).toString("base64") }] };
  });
  const realFetch = globalThis.fetch;
  if (options.decisions) globalThis.fetch = (async () => options.decisions!()) as typeof fetch;
  const tasks = createOwnerTasks(host.bb.storage.database());
  return { host, rpc, tasks, commands, asks: createOwnerAsks(host.bb.storage.database()), restore: () => { globalThis.fetch = realFetch; } };
}
const tool = (host: Awaited<ReturnType<typeof captainHost>>["host"], name: string) => host.harness.inspection.registrations.agentTools.find((t) => t.name === name)!;
const text = (out: unknown) => typeof out === "string" ? out : (out as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? JSON.stringify(out);
const askCards = (rpc: Call[]) => rpc.filter((call) => call.method === "ask");
const decided = (choice: string, confidence: number) => async () => new Response(JSON.stringify({ answers: [{ name: "answered_by_rule", choice, confidence }] }), { status: 200 });

test("firstmate_ask refuses a question with no options", async () => {
  const { host, rpc, asks, restore } = await captainHost();
  try {
    const refused = text(await tool(host, "firstmate_ask").execute({ question: "waiting for owner answers to N4-N7", kind: "question", project: "Cyndra" }, ctx));
    assert.match(refused, /Refusing: a question card needs options\. Status belongs on the task, not as an open card/);
    assert.equal(askCards(rpc).length, 0);
    assert.equal(asks.listOpen("thr_cap").length, 0);
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

test("a card without a project is refused; a card for a task takes the task's project", async () => {
  const { host, rpc, tasks, restore } = await captainHost();
  try {
    const refused = text(await tool(host, "firstmate_ask").execute({ question: "Which draft should go out?", kind: "question", options: [{ label: "A" }, { label: "B" }] }, ctx));
    assert.match(refused, /Refusing: a card names its project/);
    assert.equal(askCards(rpc).length, 0);
    const task = tasks.open({ captain: "thr_cap", project: "Safi", title: "Ship build 21", sourceRefs: ["tg:1:5"], at: Date.now() });
    text(await tool(host, "firstmate_ask").execute({ question: "Which build number should ship?", kind: "question", options: [{ label: "21" }, { label: "22" }], task: task.id }, ctx));
    assert.equal(askCards(rpc)[0]!.input.project, "Safi");
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

test("a card the owner's rules surely answer is refused with the rule; an unsure answer or a Decisions failure sends it", async () => {
  const sure = await captainHost({}, { decisions: decided("r2", 0.95) });
  try {
    const refused = text(await tool(sure.host, "firstmate_ask").execute({ question: "Safi build 21: how should it ship, preview only or both channels?", kind: "question", project: "Safi", options: [{ label: "Preview only" }, { label: "Both" }] }, ctx));
    assert.match(refused, /Refusing: the owner's rules already answer this card, so it was not sent\. Rule: "Project facts: Safi: publish every app update to both preview and production\."/);
    assert.equal(askCards(sure.rpc).length, 0);
  } finally { sure.restore(); await sure.host.harness.lifecycle.dispose(); }
  const unsure = await captainHost({}, { decisions: decided("r2", 0.6) });
  try {
    text(await tool(unsure.host, "firstmate_ask").execute({ question: "Safi build 21: which testers get it first?", kind: "question", project: "Safi", options: [{ label: "Beta" }, { label: "Team" }] }, ctx));
    assert.equal(askCards(unsure.rpc).length, 1);
  } finally { unsure.restore(); await unsure.host.harness.lifecycle.dispose(); }
  const down = await captainHost({}, { decisions: async () => { throw new Error("network down"); } });
  try {
    text(await tool(down.host, "firstmate_ask").execute({ question: "Cyndra: rotate the staging key now?", kind: "question", project: "Cyndra", options: [{ label: "Yes" }, { label: "No" }] }, ctx));
    assert.equal(askCards(down.rpc).length, 1, "a Decisions failure never stops a card");
  } finally { down.restore(); await down.host.harness.lifecycle.dispose(); }
});

test("a new card on the same task and subject replaces the open one, which Telegram marks replaced; a card of the same pack does not", async () => {
  const { host, rpc, tasks, asks, restore } = await captainHost();
  try {
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Johan draft", sourceRefs: ["tg:1:4831"], at: Date.now() });
    const old = asks.create({ captain: "thr_cap", kind: "approval", text: "Johan draft: send v1 in the Jess group?", options: [{ label: "Send", value: "A" }, { label: "Wait", value: "B" }], createdAt: Date.now() - 10 * 60_000, project: "Cyndra", task: task.id, subject: "johan draft" });
    const out = text(await tool(host, "firstmate_ask").execute({ question: "Johan draft: send v2 in the Jess group?", kind: "approval", task: task.id }, ctx));
    const id = /Ask (a[0-9a-z]{6}) is open/.exec(out)![1]!;
    assert.match(out, new RegExp(`It replaces card ${old.id}, now marked replaced`));
    assert.deepEqual([asks.get(old.id)!.state, asks.get(old.id)!.resolution], ["cancelled", `Replaced by card ${id}`]);
    assert.deepEqual(rpc.filter((call) => call.method === "editAsk").map((call) => [call.input.askId, call.input.resolution]), [[old.id, `Replaced by card ${id}`]]);
    const pack = text(await tool(host, "firstmate_ask").execute({ question: "Johan draft: attach the deck too?", kind: "question", options: [{ label: "Yes" }, { label: "No" }], task: task.id }, ctx));
    assert.doesNotMatch(pack, /replaces card/);
    assert.equal(asks.get(id)!.state, "open");
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

test("the task sweep moves done reports to the captain's check, puts a crew wait on the task, and flags a task with no crew once", async () => {
  const at = 1792142546;
  const { host, rpc, tasks, asks, restore } = await captainHost({
    scout1: `working [at=${at - 600}]: reading\ndone [at=${at}]: final plan at data/scout1/plan.md\n`,
    ship1: `done [at=${at}]: PR https://github.com/Cyndra-AI/cyndra-saas/pull/2487\n`,
    wait1: `done [at=${at - 60}]: plan v1\npaused [at=${at}]: waiting for owner answers to N4-N7 via steering inbox\n`,
  });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("scout1", "thr_s1", { shape: "scout" }), crewRow("ship1", "thr_p1"), crewRow("wait1", "thr_w1", { shape: "scout" })]);
    const store = createDeliveries(host.bb.storage.database());
    const pr = store.register({ url: "https://github.com/Cyndra-AI/cyndra-saas/pull/2487", taskId: "ship1", projectId: "proj_1", owner: "thr_cap", home: "/native", worker: "thr_p1", requirement: "pr" });
    store.observe(pr.id, { headSha: "a".repeat(40), state: "open", draft: false, checks: "passing", review: "approved", reviewHeadSha: "a".repeat(40), mergeCommitSha: null, mergeable: "mergeable" }, true);
    const now = Date.now();
    const t194 = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Scout: design research", sourceRefs: ["tg:1:4785"], crewId: "scout1", at: now });
    const t204 = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Configure dropped", sourceRefs: ["tg:1:5010"], crewId: "ship1", prs: [pr.id], at: now });
    const tWait = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Reachloop plan", sourceRefs: ["tg:1:4786"], crewId: "wait1", at: now });
    const t200 = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Fix Humza's 4 Cyndra bugs", sourceRefs: ["tg:1:4939"], at: now - 3 * 60 * 60_000 });
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.equal(tasks.get(t194.id)!.state, "check", "a crew's done never closes a task: the captain checks it");
    assert.equal(tasks.get(t204.id)!.state, "check", "an open PR not verified at its head: the next step is verify");
    assert.match(tasks.get(t204.id)!.outcome ?? "", /Next: verify cyndra-ai\/cyndra-saas#2487/);
    assert.equal(tasks.get(tWait.id)!.state, "needs_you");
    assert.match(tasks.get(tWait.id)!.outcome ?? "", /waiting for owner answers to N4-N7/);
    assert.equal(asks.listOpen("thr_cap").filter((ask) => ask.task === tWait.id).length, 0, "status belongs on the task, not as an open card");
    assert.equal(rpc.filter((call) => call.method === "ask").length, 0);
    const flags = () => host.harness.sdk.callsTo("threads.send").map((call) => JSON.stringify(call[0])).filter((m) => m.includes("TASK WITHOUT CREW"));
    assert.equal(flags().length, 1);
    assert.match(flags()[0]!, new RegExp(`task ${t200.id} \\(Fix Humza's 4 Cyndra bugs\\)`));
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.equal(flags().length, 1, "flagged once");
    assert.equal(asks.listOpen("thr_cap").filter((ask) => ask.task === tWait.id).length, 0, "a second sweep still opens no card");
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

// Isolated-server run (17 Oct): the captain had already sent its own card about crew B's wait, and
// the sweep opened a second one.
test("the sweep opens no crew card when the captain already sent a card bound to that task", async () => {
  const at = Math.floor(Date.now() / 1000) - 600;
  const { host, rpc, tasks, asks, restore } = await captainHost({ wait1: `blocked [at=${at}]: need owner to restore the repo\n` });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_w1")]);
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Slug max", sourceRefs: ["tg:1:1"], crewId: "wait1", at: Date.now() });
    asks.create({ captain: "thr_cap", kind: "question", text: "PR #6: the repo is gone. What should we do?", options: [{ label: "Restore it", value: "A" }, { label: "Drop the task", value: "B" }], createdAt: at * 1000 + 60_000, project: "Cyndra", task: task.id });
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.equal(asks.listOpen("thr_cap").length, 1, "no second card");
    assert.equal(rpc.filter((call) => call.method === "ask").length, 0);
    assert.equal(tasks.get(task.id)!.state, "needs_you", "the task still shows it waits on the owner");
    assert.match(tasks.get(task.id)!.outcome ?? "", /need owner to restore the repo/);
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

// Checker FF2-verdict-1, #145 finding 1: a newer card about other work does not stand for the crew's question.
test("a newer card on another task or project does not stand in for the crew wait; the wait is on the task", async () => {
  const at = Math.floor(Date.now() / 1000) - 600;
  const { host, tasks, asks, restore } = await captainHost({ wait1: `blocked [at=${at}]: need owner to restore the repo\n` });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_w1")]);
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Slug max", sourceRefs: ["tg:1:1"], crewId: "wait1", at: Date.now() });
    asks.create({ captain: "thr_cap", kind: "question", text: "Safi icon: blue or green?", options: [{ label: "Blue", value: "A" }, { label: "Green", value: "B" }], createdAt: at * 1000 + 60_000, project: "Safi" });
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.equal(asks.listOpen("thr_cap").filter((ask) => ask.task === task.id).length, 0, "the crew wait is not a card");
    assert.equal(tasks.get(task.id)!.state, "needs_you");
    assert.match(tasks.get(task.id)!.outcome ?? "", /need owner to restore the repo/);
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

// #145 finding 2: a done line is not used up while another crew of the task still works.
test("a task with two crews advances once both have reported done, after one crew is retired", async () => {
  const at = Math.floor(Date.now() / 1000) - 600;
  const { host, tasks, restore } = await captainHost({ c1: `done [at=${at}]: part one\n`, c2: `done [at=${at}]: part two\n` });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("c1", "thr_c1", { shape: "scout" }), crewRow("c2", "thr_c2", { shape: "scout" })]);
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Two parts", sourceRefs: ["tg:1:2"], crewId: "c1", at: Date.now() });
    tasks.attach(task.id, "thr_cap", { crewId: "c2", sourceRefs: [], at: Date.now() });
    await host.bb.storage.kv.set("crews", [crewRow("c2", "thr_c2", { shape: "scout" })]);
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.equal(tasks.get(task.id)!.state, "check");
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

// #145 finding 3: an owner answer that lands while the replacement edits Telegram is kept.
test("a card the owner answers while an older card is being replaced keeps his answer", async () => {
  const { host, tasks, asks, restore } = await captainHost();
  try {
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Johan draft", sourceRefs: ["tg:1:4831"], crewId: undefined, at: Date.now() });
    const old = (text: string) => asks.create({ captain: "thr_cap", kind: "question", text, options: [{ label: "Send", value: "A" }, { label: "Wait", value: "B" }], createdAt: Date.now() - 10 * 60_000, project: "Cyndra", task: task.id, subject: "johan draft" });
    const first = old("Johan draft: send v1?");
    const second = old("Johan draft: send v1 to Jess too?");
    host.harness.sdk.stub("plugins.callRpc", async (call: Call) => {
      if (call.method === "editAsk" && call.input.askId === first.id) asks.resolve(second.id, "thr_cap", "answered", "Wait: do not send", Date.now());
      return { ok: true, queued: 1, duplicate: false };
    });
    text(await tool(host, "firstmate_ask").execute({ question: "Johan draft: send v2?", kind: "question", options: [{ label: "Send" }, { label: "Wait" }], task: task.id }, ctx));
    assert.deepEqual([asks.get(second.id)!.state, asks.get(second.id)!.resolution], ["answered", "Wait: do not send"]);
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

// Checker round 2: both crews of a task are still registered and both reported done. The task advances on one
// sweep: a crew counts as still working from its own latest report, not from being registered.
test("a task whose two registered crews both reported done advances; one still working holds it", async () => {
  const at = Math.floor(Date.now() / 1000) - 600;
  const both = await captainHost({ c1: `done [at=${at}]: part one\n`, c2: `done [at=${at}]: part two\n` });
  try {
    await both.host.bb.storage.kv.set("crews", [crewRow("c1", "thr_c1", { shape: "scout" }), crewRow("c2", "thr_c2", { shape: "scout" })]);
    const task = both.tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Two parts", sourceRefs: ["tg:1:3"], crewId: "c1", at: Date.now() });
    both.tasks.attach(task.id, "thr_cap", { crewId: "c2", sourceRefs: [], at: Date.now() });
    await both.host.harness.behavior.runSchedule("task-lifecycle");
    assert.equal(both.tasks.get(task.id)!.state, "check");
  } finally { both.restore(); await both.host.harness.lifecycle.dispose(); }
  const one = await captainHost({ c1: `done [at=${at}]: part one\n`, c2: `working [at=${at}]: still on part two\n` });
  try {
    await one.host.bb.storage.kv.set("crews", [crewRow("c1", "thr_c1", { shape: "scout" }), crewRow("c2", "thr_c2", { shape: "scout" })]);
    const task = one.tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Two parts", sourceRefs: ["tg:1:3"], crewId: "c1", at: Date.now() });
    one.tasks.attach(task.id, "thr_cap", { crewId: "c2", sourceRefs: [], at: Date.now() });
    await one.host.harness.behavior.runSchedule("task-lifecycle");
    assert.equal(one.tasks.get(task.id)!.state, "working", "c2 still works");
  } finally { one.restore(); await one.host.harness.lifecycle.dispose(); }
});


// Checker round 2: a newer standalone card on the same project (Cyndra icons) is about other work. Only a card
// bound to the crew's task suppresses its question; otherwise both cards go out.
test("a newer standalone card on the same project does not suppress the crew wait on the task", async () => {
  const at = Math.floor(Date.now() / 1000) - 600;
  const { host, tasks, asks, restore } = await captainHost({ wait1: `blocked [at=${at}]: need owner to restore its repo\n` });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_w1")]);
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Slug max", sourceRefs: ["tg:1:1"], crewId: "wait1", at: Date.now() });
    asks.create({ captain: "thr_cap", kind: "question", text: "Cyndra icons: outline or filled?", options: [{ label: "Outline", value: "A" }, { label: "Filled", value: "B" }], createdAt: at * 1000 + 60_000, project: "Cyndra" });
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.equal(asks.listOpen("thr_cap").filter((ask) => ask.task === task.id).length, 0, "the crew wait is not a card");
    assert.equal(asks.listOpen("thr_cap").length, 1, "the standalone card stays open");
    assert.equal(tasks.get(task.id)!.state, "needs_you");
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

test("closeAsk releases only its crew's native captain hold without changing the task", async () => {
  const at = Math.floor(Date.now() / 1000) - 60;
  const { host, tasks, asks, commands, restore } = await captainHost({ wait1: `needs-decision [key=pick-one] [at=${at}]: Choose a database?\n` });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_w1")]);
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Database", sourceRefs: [], crewId: "wait1", at: Date.now() });
    const note = "Choose a database?";
    const card = asks.create({
      captain: "thr_cap", kind: "question", text: note,
      options: [{ label: "Postgres", value: "A" }, { label: "SQLite", value: "B" }],
      sourceRef: `crew-wait:wait1:${createHash("sha256").update(note).digest("hex").slice(0, 16)}`,
      createdAt: Date.now(), project: "Cyndra", task: task.id,
    });
    await host.harness.behavior.runSchedule("task-lifecycle");
    const before = tasks.get(task.id);
    const input = { threadId: "thr_cap", ids: [card.id] };
    await host.harness.behavior.callRpc("closeAsk", input);
    const answers = () => commands.filter((c) => c.includes("fm-captain-hold.sh") && c.includes("'answer'"));
    assert.equal(answers().length, 1);
    assert.match(answers()[0]!, /'pick-one'.*'--decision-file'.*'--release'/);
    assert.ok(commands.some((c) => c.includes("resolved [key=pick-one]: closed by owner, no action")));
    assert.deepEqual(tasks.get(task.id), before);
    await host.harness.behavior.callRpc("closeAsk", input);
    assert.equal(answers().length, 1);
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

test("closeAsk retries a failed native release after its captain notice succeeded", async () => {
  let attempts = 0;
  const { host, tasks, asks, restore } = await captainHost({ wait1: "needs-decision [key=choose]: Choose?\n" }, { nativeAnswer: () => ++attempts === 1 ? 1 : 0 });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_w1")]);
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Choose", sourceRefs: [], crewId: "wait1", at: Date.now() });
    const note = "Choose?";
    const card = asks.create({
      captain: "thr_cap", kind: "question", text: note,
      options: [{ label: "A", value: "A" }, { label: "B", value: "B" }],
      sourceRef: `crew-wait:wait1:${createHash("sha256").update(note).digest("hex").slice(0, 16)}`,
      createdAt: Date.now(), project: "Cyndra", task: task.id,
    });
    await host.harness.behavior.runSchedule("task-lifecycle");
    const input = { threadId: "thr_cap", ids: [card.id] };
    const count = () => host.harness.sdk.callsTo("threads.send").filter((call) => JSON.stringify(call).includes("Owner closed card")).length;
    await host.harness.behavior.callRpc("closeAsk", input);
    assert.equal(attempts, 1);
    assert.equal(count(), 1);
    await host.harness.behavior.callRpc("closeAsk", input);
    await host.harness.behavior.callRpc("closeAsk", input);
    assert.equal(attempts, 2);
    assert.equal(count(), 1);
    assert.equal(asks.get(card.id)?.resolution, "closed by owner, no action");
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

test("closeAsk releases a crew work row held for its sole keyed question", async () => {
  const { host, tasks, asks, restore } = await captainHost({ wait1: "needs-decision [key=choice]: Choose?\n" });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_w1")]);
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Choose", sourceRefs: [], crewId: "wait1", at: Date.now() });
    const note = "Choose?";
    asks.create({
      captain: "thr_cap", kind: "question", text: note,
      options: [{ label: "A", value: "A" }, { label: "B", value: "B" }],
      sourceRef: `crew-wait:wait1:${createHash("sha256").update(note).digest("hex").slice(0, 16)}`,
      createdAt: Date.now(), project: "Cyndra", task: task.id,
    });
    await host.harness.behavior.runSchedule("task-lifecycle");
    const byId = new Map<string, string>();
    let n = 0;
    const answers: string[] = [];
    let resolved = false;
    host.harness.sdk.stub("terminals.create", async (args: { start: { command: string } }) => {
      const id = `close-native-${++n}`; byId.set(id, args.start.command); return { id };
    });
    host.harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => {
      const command = byId.get(terminalId) ?? "";
      const code = (command.includes("'open'") && command.includes("'choice'")) ? 1 : 0;
      if (command.includes("'answer'")) answers.push(command);
      if (command.includes("resolved [key=choice]: closed by owner, no action")) resolved = true;
      const payload = command.includes("/native/state/wait1.status") ? `needs-decision [key=choice]: Choose?\n${resolved ? "resolved [key=choice]: closed by owner, no action\n" : ""}` : "";
      const captured = command.includes("FM_HOST_CAPTURE_V1");
      const out = captured ? JSON.stringify({ protocol: "FM_HOST_CAPTURE_V1", exitCode: code, stdout: payload, stderr: "" }) : payload;
      return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${out}\n__FM_HOST_RC:${captured ? 0 : code}\n`).toString("base64") }] };
    });
    await host.harness.behavior.callRpc("closeAsk", { threadId: "thr_cap", ids: [asks.listOpen("thr_cap")[0]!.id] });
    assert.equal(answers.length, 1);
    assert.ok(answers[0]!.includes("'wait1'"));
    assert.ok(!answers[0]!.includes("'choice'"));
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

test("checker 169: a new native owner decision reaches the owner as an actionable card", async () => {
  const { host, tasks, asks, commands, restore } = await captainHost({ wait1: "needs-decision [key=choice]: Choose Postgres or SQLite? {\"choices\":[\"Postgres\",\"SQLite\"]}\n" });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_w1")]);
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Database", sourceRefs: [], crewId: "wait1", at: Date.now() });
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.ok(asks.listOpen("thr_cap").some(ask => ask.task === task.id && ask.options.length > 0 && ask.sourceRef?.startsWith("crew-wait:wait1:")), "native owner decision must have an actionable card linked to its hold");
    const card = asks.listOpen("thr_cap").find((ask) => ask.task === task.id)!;
    await host.harness.behavior.callRpc("closeAsk", { threadId: "thr_cap", ids: [card.id] });
    assert.equal(asks.get(card.id)?.resolution, "closed by owner, no action");
    const answers = commands.filter((c) => c.includes("fm-captain-hold.sh") && c.includes("'answer'"));
    assert.equal(answers.length, 1, "Close must release the native hold bound to the card");
    assert.match(answers[0]!, /'choice'.*'--decision-file'.*'--release'/);
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

test("checker round2: answering a generated native card releases its question hold", async () => {
  const { host, tasks, asks, commands, restore } = await captainHost({ wait1:"needs-decision [key=choice]: Choose Postgres or SQLite? {\"choices\":[\"Postgres\",\"SQLite\"]}\n" });
  try {
    await host.bb.storage.kv.set("crews",[crewRow("wait1","thr_w1")]);
    const task=tasks.open({captain:"thr_cap",project:"Cyndra",title:"Database",sourceRefs:[],crewId:"wait1",at:Date.now()});
    await host.harness.behavior.runSchedule("task-lifecycle");
    const card=asks.listOpen("thr_cap").find(ask=>ask.task===task.id)!;
    const result=await host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:"Postgres"});
    assert.equal(result.ok,true);
    await host.harness.behavior.runSchedule("task-lifecycle");
    const answers=commands.filter(c=>c.includes("fm-captain-hold.sh")&&c.includes("'answer'"));
    console.log("CHECKER R2 answer hold",JSON.stringify({resolution:asks.get(card.id)?.resolution,answers}));
    assert.ok(answers.some(c=>c.includes("'choice'")&&c.includes("'--release'")),"owner answer must release the native question, as Close does");
  } finally {restore();await host.harness.lifecycle.dispose();}
});

test("a prose native question does not invent buttons", async () => {
  const { host, tasks, asks, restore } = await captainHost({ wait1: "needs-decision [key=choice]: Choose Postgres, MySQL or SQLite?\n" });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_w1")]);
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Database", sourceRefs: [], crewId: "wait1", at: Date.now() });
    await host.harness.behavior.runSchedule("task-lifecycle");
    const cards = asks.listOpen("thr_cap").filter((ask) => ask.task === task.id);
    assert.equal(cards.length, 0, "prose must not become a card with invented or composite buttons");
    const notices = host.harness.sdk.callsTo("threads.send").map((call) => JSON.stringify(call));
    assert.ok(notices.some((message) => message.includes("firstmate_ask") && message.includes("bind=wait1:choice")), "the captain is told to bind a card to the native question");
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

test("firstmate_ask bind attaches a captain card to the native question", async () => {
  const { host, tasks, asks, commands, restore } = await captainHost({ wait1: "needs-decision [key=choice]: Choose Postgres, MySQL or SQLite?\n" });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_w1")]);
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Database", sourceRefs: [], crewId: "wait1", at: Date.now() });
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.equal(asks.listOpen("thr_cap").filter((ask) => ask.task === task.id).length, 0);
    const out = text(await tool(host, "firstmate_ask").execute({
      question: "Which database?", kind: "question",
      options: [{ label: "Postgres" }, { label: "MySQL" }, { label: "SQLite" }],
      project: "Cyndra", task: task.id, bind: "wait1:choice",
    }, ctx));
    assert.match(out, /Ask |Question card /);
    const card = asks.listOpen("thr_cap").find((ask) => ask.task === task.id)!;
    assert.ok(card.sourceRef?.startsWith("crew-wait:wait1:"));
    assert.deepEqual(card.options.map((option) => option.label), ["Postgres", "MySQL", "SQLite"]);
    const result = await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: card.id, resolution: "Postgres" });
    assert.equal(result.ok, true);
    await host.harness.behavior.runSchedule("task-lifecycle");
    const answers = commands.filter((c) => c.includes("fm-captain-hold.sh") && c.includes("'answer'"));
    assert.ok(answers.some((c) => c.includes("'choice'") && c.includes("'--release'")), "owner answer must release the native question, as Close does");
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

test("a follow-up that fails 8 times becomes failed and tells the captain once", async () => {
  const { host, tasks, asks, restore } = await captainHost(
    { wait1: "needs-decision [key=choice]: Choose Postgres or SQLite? {\"choices\":[\"Postgres\",\"SQLite\"]}\n" },
    { nativeAnswer: () => 2 },
  );
  try {
    await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_w1")]);
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Database", sourceRefs: [], crewId: "wait1", at: Date.now() });
    await host.harness.behavior.runSchedule("task-lifecycle");
    const card = asks.listOpen("thr_cap").find((ask) => ask.task === task.id)!;
    await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: card.id, resolution: "Postgres" });
    for (let i = 0; i < 7; i++) await host.harness.behavior.runSchedule("task-lifecycle");
    const row = host.bb.storage.database().prepare("SELECT state, attempts FROM owner_ask_followup WHERE ask_id=? AND effect='owner-answered'").get(card.id) as { state: string; attempts: number };
    assert.equal(row.state, "failed");
    assert.equal(row.attempts, 8);
    const delivered = () => host.harness.sdk.callsTo("threads.send")
      .map((call) => JSON.stringify(call[0]))
      .filter((text) => text.includes("was not delivered to crew wait1"));
    assert.equal(delivered().length, 1);
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.equal(delivered().length, 1, "the captain is told once");
    const board = await host.harness.behavior.callRpc("telegramCommand", { threadId: "thr_cap", command: "board" }) as { text: string };
    assert.match(board.text, /answer not delivered to crew wait1/);
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

test("an owner answer on a workstream crew's card reaches that crew", async () => {
  const { host, asks, restore } = await captainHost();
  try {
    await host.bb.storage.kv.set("crews", [crewRow("ws1", "thr_ws", { workstreamId: "ws-1" })]);
    asks.create({
      id: "a000001", captain: "thr_cap", kind: "question", text: "Which database?",
      options: [{ label: "Postgres", value: "a" }, { label: "SQLite", value: "b" }],
      sourceRef: "crew-wait:ws1:deadbeefdeadbeef", createdAt: 1,
    });
    const result = await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: "a000001", resolution: "Postgres" });
    assert.equal(result.ok, true);
    const toCrew = host.harness.sdk.callsTo("threads.send")
      .map((call) => call[0] as { threadId: string; mode?: string; input: Array<{ text: string }> })
      .filter((send) => send.threadId === "thr_ws");
    assert.ok(toCrew.some((send) => send.input[0]?.text.includes("Postgres")), "the workstream crew must receive the owner's answer");
    assert.ok(toCrew.some((send) => send.mode === "queue-if-active"));
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

for(const route of ["secondmate","workstream"])test(`checker round5 P3: ${route} send fails once then delivers once`,async()=>{
 const {host,asks,restore}=await captainHost();let attempts=0;try{
  await host.bb.storage.kv.set("crews",[crewRow("target","thr_target",route==="secondmate"?{posture:"secondmate:domain"}:{workstreamId:"ws-1"})]);
  const card=asks.create({captain:"thr_cap",kind:"question",text:"Choose?",options:[{label:"Yes",value:"yes"}],sourceRef:"crew-wait:target:question",createdAt:1});
  host.harness.sdk.stub("threads.events.list",async()=>[]);host.harness.sdk.stub("threads.queuedMessages.list",async()=>[]);
  host.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_target"&&++attempts===1)throw new Error("crew queue down");return {delivery:"queued"};});
  await host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:"Yes"});assert.ok(asks.pendingFollowUps().some(job=>job.askId===card.id&&job.effect==="owner-answered"));
  await host.harness.behavior.runSchedule("task-lifecycle");assert.equal(attempts,2);assert.equal(asks.pendingFollowUps().filter(job=>job.askId===card.id).length,0);
  await host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:"Yes"});assert.equal(attempts,2);
 }finally{restore();await host.harness.lifecycle.dispose();}
});

test("reopen then owner re-answer releases the hold with the new answer", async () => {
  const status = { wait1: "needs-decision [key=choice]: Choose Postgres or SQLite? {\"choices\":[\"Postgres\",\"SQLite\"]}\n" };
  const { host, tasks, asks, commands, restore } = await captainHost(status);
  let held = true;
  host.harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => {
    const command = commands[Number(terminalId.replace("term", "")) - 1] ?? "";
    let code = 0;
    if (command.includes("fm-captain-hold.sh") && command.includes("'open'")) code = command.includes("'choice'") && held ? 0 : 1;
    if (command.includes("fm-captain-hold.sh") && command.includes("'answer'") && command.includes("'choice'")) held = false;
    const payload = command.includes("fm-bearings-snapshot.sh")
      ? JSON.stringify({ schema: "fm-bearings.v1", home: "/native", in_flight: [], decisions_open: [], landed: [], gates: [], omitted: [] })
      : command.includes("/native/state/wait1.status") ? status.wait1 : "";
    const captured = command.includes("FM_HOST_CAPTURE_V1");
    const out = captured ? JSON.stringify({ protocol: "FM_HOST_CAPTURE_V1", exitCode: code, stdout: payload, stderr: "" }) : payload;
    return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${out}\n__FM_HOST_RC:${captured ? 0 : code}\n`).toString("base64") }] };
  });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_w1")]);
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Database", sourceRefs: [], crewId: "wait1", at: Date.now() });
    await host.harness.behavior.runSchedule("task-lifecycle");
    const card = asks.listOpen("thr_cap").find((ask) => ask.task === task.id)!;
    assert.equal((await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: card.id, resolution: "Postgres" })).ok, true);
    assert.equal(held, false);
    status.wait1 += "resolved [key=choice]: Postgres\n";
    const first = commands.filter((c) => c.includes("fm-captain-hold.sh") && c.includes("'answer'")).length;
    assert.ok(first > 0);
    const sendsBefore = host.harness.sdk.callsTo("threads.send").length;
    await tool(host, "firstmate_resolve_ask").execute({ id: card.id, resolution: "Recorded by mistake", reopen: true }, ctx);
    assert.equal(asks.get(card.id)?.state, "open");
    assert.equal((await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: card.id, resolution: "SQLite" })).ok, true);
    const answers = commands.filter((c) => c.includes("fm-captain-hold.sh") && c.includes("'answer'"));
    assert.equal(answers.length, first, "a closed native hold is not released again");
    const steers = host.harness.sdk.callsTo("threads.send").slice(sendsBefore)
      .map((call) => call[0] as { threadId: string; mode?: string; input: Array<{ text: string }> })
      .filter((send) => send.threadId === "thr_w1");
    assert.ok(steers.some((send) => send.mode === "queue-if-active" && send.input[0]?.text.includes("choice") && send.input[0]?.text.includes("Postgres") && send.input[0]?.text.includes("SQLite")), "the crew is told the question key, the old answer and the new answer");
    assert.deepEqual(asks.pendingFollowUps(), []);
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

test("checker round5 P5: a resolved native question receives the reopened card's new answer",async()=>{
 const status={wait1:'needs-decision [key=choice]: Choose? {"choices":["Postgres","SQLite"]}\n'};
 const {host,tasks,asks,commands,restore}=await captainHost(status);let held=true;
 host.harness.sdk.stub("terminals.output",async({terminalId}:{terminalId:string})=>{
  const command=commands[Number(terminalId.replace("term",""))-1]??"";
  let code=0;
  if(command.includes("fm-captain-hold.sh")&&command.includes("'open'"))code=command.includes("'choice'")&&held?0:1;
  if(command.includes("fm-captain-hold.sh")&&command.includes("'answer'")&&command.includes("'choice'"))held=false;
  const payload=command.includes("fm-bearings-snapshot.sh")?JSON.stringify({schema:"fm-bearings.v1",home:"/native",in_flight:[],decisions_open:[],landed:[],gates:[],omitted:[]}):command.includes("/native/state/wait1.status")?status.wait1:"";
  const captured=command.includes("FM_HOST_CAPTURE_V1");const out=captured?JSON.stringify({protocol:"FM_HOST_CAPTURE_V1",exitCode:code,stdout:payload,stderr:""}):payload;
  return {nextSeq:1,chunks:[{dataBase64:Buffer.from(`${out}\n__FM_HOST_RC:${captured?0:code}\n`).toString("base64")}]};
 });
 try{
  await host.bb.storage.kv.set("crews",[crewRow("wait1","thr_w1")]);const task=tasks.open({captain:"thr_cap",project:"Cyndra",title:"Database",sourceRefs:[],crewId:"wait1",at:Date.now()});
  await host.harness.behavior.runSchedule("task-lifecycle");const card=asks.listOpen("thr_cap").find(ask=>ask.task===task.id)!;
  await host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:"Postgres"});assert.equal(held,false);
  status.wait1+='resolved [key=choice]: Postgres\n';
  const before=commands.length;const sendsBefore=host.harness.sdk.callsTo("threads.send").length;
  await tool(host,"firstmate_resolve_ask").execute({id:card.id,reopen:true,resolution:"Correct the answer"},ctx);
  await host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:"SQLite"});
  const nativeNew=commands.slice(before).filter(command=>command.includes("fm-captain-hold.sh")&&command.includes("'answer'"));
  const newSteers=host.harness.sdk.callsTo("threads.send").slice(sendsBefore).filter(call=>JSON.stringify(call).includes("thr_w1")&&JSON.stringify(call).includes("SQLite"));
  console.log("CHECKER R5 real native reopen",JSON.stringify({stored:asks.get(card.id)?.resolution,nativeNew:nativeNew.length,newSteers:newSteers.length,pending:asks.pendingFollowUps()}));
  assert.ok(nativeNew.length>0||newSteers.length>0,"a second answer must reach the crew after the first native decision and hold are resolved");
 }finally{restore();await host.harness.lifecycle.dispose();}
});

test("a correction to a resolved native question stays pending until the crew queue accepts it", async () => {
  const status = { wait1: "needs-decision [key=choice]: Choose? {\"choices\":[\"Postgres\",\"SQLite\"]}\n" };
  const { host, tasks, asks, commands, restore } = await captainHost(status);
  let held = true;
  host.harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => {
    const command = commands[Number(terminalId.replace("term", "")) - 1] ?? "";
    let code = 0;
    if (command.includes("fm-captain-hold.sh") && command.includes("'open'")) code = command.includes("'choice'") && held ? 0 : 1;
    if (command.includes("fm-captain-hold.sh") && command.includes("'answer'") && command.includes("'choice'")) held = false;
    const payload = command.includes("fm-bearings-snapshot.sh")
      ? JSON.stringify({ schema: "fm-bearings.v1", home: "/native", in_flight: [], decisions_open: [], landed: [], gates: [], omitted: [] })
      : command.includes("/native/state/wait1.status") ? status.wait1 : "";
    const captured = command.includes("FM_HOST_CAPTURE_V1");
    const out = captured ? JSON.stringify({ protocol: "FM_HOST_CAPTURE_V1", exitCode: code, stdout: payload, stderr: "" }) : payload;
    return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${out}\n__FM_HOST_RC:${captured ? 0 : code}\n`).toString("base64") }] };
  });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_w1")]);
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Database", sourceRefs: [], crewId: "wait1", at: Date.now() });
    await host.harness.behavior.runSchedule("task-lifecycle");
    const card = asks.listOpen("thr_cap").find((ask) => ask.task === task.id)!;
    await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: card.id, resolution: "Postgres" });
    status.wait1 += "resolved [key=choice]: Postgres\n";
    let failSteer = true;
    const realSend = async () => ({ delivery: "queued" as const });
    host.harness.sdk.stub("threads.events.list", async () => []);
    host.harness.sdk.stub("threads.queuedMessages.list", async () => []);
    host.harness.sdk.stub("threads.send", async (input: { threadId: string; input: Array<{ text: string }> }) => {
      if (failSteer && input.threadId === "thr_w1" && JSON.stringify(input).includes("SQLite")) throw new Error("queue down");
      return realSend();
    });
    await tool(host, "firstmate_resolve_ask").execute({ id: card.id, reopen: true, resolution: "Correct the answer" }, ctx);
    await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: card.id, resolution: "SQLite" });
    assert.ok(asks.pendingFollowUps().some((job) => job.askId === card.id && job.effect === "owner-answered"), "a failed correction stays pending");
    failSteer = false;
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.deepEqual(asks.pendingFollowUps(), []);
    const steers = host.harness.sdk.callsTo("threads.send")
      .map((call) => call[0] as { threadId: string; input: Array<{ text: string }> })
      .filter((send) => send.threadId === "thr_w1" && send.input[0]?.text.includes("SQLite"));
    assert.ok(steers.length >= 1);
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

async function checkerCorrectionFixture() {
 const state={text:'needs-decision [key=choice]: Choose? {"choices":["Postgres","SQLite"]}\n',held:true,shared:false};
 const result=await captainHost({wait1:state.text});const {host,commands}=result;
 host.harness.sdk.stub("terminals.output",async({terminalId}:{terminalId:string})=>{
  const command=commands[Number(terminalId.replace("term",""))-1]??"";let code=0;
  if(command.includes("fm-captain-hold.sh")&&command.includes("'open'"))code=(command.includes("'choice'")?state.held:command.includes("'wait1'")?state.shared:false)?0:1;
  if(command.includes("fm-captain-hold.sh")&&command.includes("'answer'")&&command.includes("'choice'"))state.held=false;
  const payload=command.includes("fm-bearings-snapshot.sh")?JSON.stringify({schema:"fm-bearings.v1",home:"/native",in_flight:[],decisions_open:[],landed:[],gates:[],omitted:[]}):command.includes("/native/state/wait1.status")?state.text:"";
  const captured=command.includes("FM_HOST_CAPTURE_V1");const out=captured?JSON.stringify({protocol:"FM_HOST_CAPTURE_V1",exitCode:code,stdout:payload,stderr:""}):payload;
  return {nextSeq:1,chunks:[{dataBase64:Buffer.from(`${out}\n__FM_HOST_RC:${captured?0:code}\n`).toString("base64")}]};
 });
 await host.bb.storage.kv.set("crews",[crewRow("wait1","thr_w1")]);
 const task=result.tasks.open({captain:"thr_cap",project:"Cyndra",title:"Database",sourceRefs:[],crewId:"wait1",at:Date.now()});
 await host.harness.behavior.runSchedule("task-lifecycle");const card=result.asks.listOpen("thr_cap").find(ask=>ask.task===task.id)!;
 await host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:"Postgres"});assert.equal(state.held,false);state.text+='resolved [key=choice]: Postgres\n';
 return {...result,state,card};
}

test("checker round6: correction retries, names both answers, and does not duplicate across restart",async()=>{
 const {host,asks,state,card,restore}=await checkerCorrectionFixture();let next;let attempts=0;let deliveries=0;
 try{
  host.harness.sdk.stub("threads.events.list",async()=>[]);host.harness.sdk.stub("threads.queuedMessages.list",async()=>[]);
  host.harness.sdk.stub("threads.send",async(input:{threadId:string;mode:string;input:Array<{text:string}>})=>{if(input.threadId==="thr_w1"){attempts++;if(attempts===1)throw new Error("crew queue down");deliveries++;assert.equal(input.mode,"queue-if-active");assert.match(input.input[0].text,/question choice: was Postgres, now SQLite/);}return {delivery:"queued"};});
  await tool(host,"firstmate_resolve_ask").execute({id:card.id,reopen:true,resolution:"Correction"},ctx);
  await host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:"SQLite"});assert.ok(asks.pendingFollowUps().some(job=>job.askId===card.id&&job.effect==="owner-answered"));assert.equal(deliveries,0);
  await host.harness.behavior.runSchedule("task-lifecycle");assert.equal(attempts,2);assert.equal(deliveries,1);assert.equal(asks.pendingFollowUps().length,0);
  await host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:"SQLite"});assert.equal(deliveries,1);
  next=await host.harness.lifecycle.reload(plugin);for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));
  assert.equal(next.harness.sdk.callsTo("threads.send").filter(call=>JSON.stringify(call).includes("thr_w1")).length,0,"completed correction must not be delivered again at startup");
  assert.equal(createOwnerAsks(next.bb.storage.database()).pendingFollowUps().length,0);
 }finally{if(next)await next.harness.lifecycle.dispose();await host.harness.lifecycle.dispose();restore();}
});

test("checker round6: correction that fails eight sends fails in view once",async()=>{
 const {host,asks,card,restore}=await checkerCorrectionFixture();let attempts=0;try{
  host.harness.sdk.stub("threads.events.list",async()=>[]);host.harness.sdk.stub("threads.queuedMessages.list",async()=>[]);
  host.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_w1"){attempts++;throw new Error("crew queue down");}return {delivery:"queued"};});
  await tool(host,"firstmate_resolve_ask").execute({id:card.id,reopen:true,resolution:"Correction"},ctx);await host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:"SQLite"});
  for(let i=0;i<7;i++)await host.harness.behavior.runSchedule("task-lifecycle");assert.equal(attempts,8);assert.ok(asks.failedFollowUps().some(job=>job.askId===card.id&&job.attempts===8));
  const count=()=>host.harness.sdk.callsTo("threads.send").filter(call=>JSON.stringify(call).includes(`card ${card.id} was not delivered to crew wait1`)).length;assert.equal(count(),1);await host.harness.behavior.runSchedule("task-lifecycle");assert.equal(count(),1);assert.equal(attempts,8);
  const board=await host.harness.behavior.callRpc("telegramCommand",{threadId:"thr_cap",command:"board"});assert.match(JSON.stringify(board),/answer not delivered to crew wait1/);
 }finally{await host.harness.lifecycle.dispose();restore();}
});

test("checker round6: a correction steers while a newer question owns the shared crew hold",async()=>{
 const {host,asks,state,card,commands,restore}=await checkerCorrectionFixture();try{
  state.text+='needs-decision [key=newer]: Which backup? {"choices":["Cloud","Disk"]}\n';state.shared=true;
  const before=commands.length;const sends=host.harness.sdk.callsTo("threads.send").length;
  await tool(host,"firstmate_resolve_ask").execute({id:card.id,reopen:true,resolution:"Correction"},ctx);await host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:"SQLite"});
  const mutations=commands.slice(before).filter(command=>command.includes("fm-captain-hold.sh")&&command.includes("'answer'"));
  assert.equal(mutations.length,0,"a correction must not release a newer or unrelated hold");
  const corrections=host.harness.sdk.callsTo("threads.send").slice(sends).filter(call=>JSON.stringify(call).includes("thr_w1")&&JSON.stringify(call).includes("now SQLite"));
  console.log("CHECKER R6 newer hold",JSON.stringify({corrections:corrections.length,holdMutations:mutations.length,pending:asks.pendingFollowUps()}));
  assert.equal(corrections.length,1,"the correction must reach the crew while its newer question remains open");
 }finally{await host.harness.lifecycle.dispose();restore();}
});

test("an open question that shares the crew hold still applies native and leaves the other question held", async () => {
  const choiceNote = 'Choose? {"choices":["Postgres","SQLite"]}';
  const newerNote = 'Which backup? {"choices":["Cloud","Disk"]}';
  const state = {
    text: `needs-decision [key=choice]: ${choiceNote}\nneeds-decision [key=newer]: ${newerNote}\n`,
    choiceHeld: true,
    newerHeld: true,
    shared: true,
  };
  const { host, asks, commands, restore } = await captainHost({ wait1: state.text });
  host.harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => {
    const command = commands[Number(terminalId.replace("term", "")) - 1] ?? "";
    let code = 0;
    if (command.includes("fm-captain-hold.sh") && command.includes("'open'")) {
      code = (command.includes("'choice'") ? state.choiceHeld : command.includes("'newer'") ? state.newerHeld : command.includes("'wait1'") ? state.shared : false) ? 0 : 1;
    }
    if (command.includes("fm-captain-hold.sh") && command.includes("'answer'") && command.includes("'choice'")) state.choiceHeld = false;
    if (command.includes("fm-captain-hold.sh") && command.includes("'answer'") && command.includes("'wait1'")) state.shared = false;
    if (command.includes("fm-captain-hold.sh") && command.includes("'answer'") && command.includes("'newer'")) state.newerHeld = false;
    const payload = command.includes("fm-bearings-snapshot.sh")
      ? JSON.stringify({ schema: "fm-bearings.v1", home: "/native", in_flight: [], decisions_open: [], landed: [], gates: [], omitted: [] })
      : command.includes("/native/state/wait1.status") ? state.text : "";
    const captured = command.includes("FM_HOST_CAPTURE_V1");
    const out = captured ? JSON.stringify({ protocol: "FM_HOST_CAPTURE_V1", exitCode: code, stdout: payload, stderr: "" }) : payload;
    return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${out}\n__FM_HOST_RC:${captured ? 0 : code}\n`).toString("base64") }] };
  });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_w1")]);
    const choice = asks.create({
      captain: "thr_cap", kind: "question", text: "Choose?",
      options: [{ label: "Postgres", value: "a" }, { label: "SQLite", value: "b" }],
      sourceRef: `crew-wait:wait1:${createHash("sha256").update(choiceNote).digest("hex").slice(0, 16)}`,
      createdAt: 1, project: "Cyndra",
    });
    asks.create({
      captain: "thr_cap", kind: "question", text: "Which backup?",
      options: [{ label: "Cloud", value: "a" }, { label: "Disk", value: "b" }],
      sourceRef: `crew-wait:wait1:${createHash("sha256").update(newerNote).digest("hex").slice(0, 16)}`,
      createdAt: 2, project: "Cyndra",
    });
    const before = commands.length;
    const sends = host.harness.sdk.callsTo("threads.send").length;
    assert.equal((await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: choice.id, resolution: "Postgres" })).ok, true);
    const answers = commands.slice(before).filter((command) => command.includes("fm-captain-hold.sh") && command.includes("'answer'"));
    assert.ok(answers.some((command) => command.includes("'choice'")), "the still-open question is applied natively");
    assert.equal(answers.filter((command) => command.includes("'wait1'") || command.includes("'newer'")).length, 0, "the shared crew hold and the other question stay held");
    assert.equal(state.shared, true);
    assert.equal(state.newerHeld, true);
    const steers = host.harness.sdk.callsTo("threads.send").slice(sends).filter((call) => JSON.stringify(call).includes("thr_w1") && JSON.stringify(call).includes("corrected"));
    assert.equal(steers.length, 0, "an open shared-hold question does not take the resolved-question steering path");
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

test("checker round7: consecutive delivered corrections name the actual previous answer",async()=>{
 const {host,state,card,commands,restore}=await checkerCorrectionFixture();try{
  const before=commands.length;const sends=host.harness.sdk.callsTo("threads.send").length;
  for(const answer of ["SQLite","Postgres"]){await tool(host,"firstmate_resolve_ask").execute({id:card.id,reopen:true,resolution:"Correction"},ctx);await host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:answer});await host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:answer});}
  const messages=host.harness.sdk.callsTo("threads.send").slice(sends).map(call=>call[0] as {threadId:string;input:Array<{text:string}>}).filter(call=>call.threadId==="thr_w1");
  assert.equal(messages.length,2,"each accepted correction is delivered once");
  assert.equal(commands.slice(before).filter(command=>command.includes("fm-captain-hold.sh")&&command.includes("'answer'")).length,0);
  console.log("CHECKER R7 consecutive",JSON.stringify(messages.map(message=>message.input[0].text)));
  assert.match(messages[0].input[0].text,/was Postgres, now SQLite/);assert.match(messages[1].input[0].text,/was SQLite, now Postgres/,"the second correction must name the last delivered answer");
 }finally{await host.harness.lifecycle.dispose();restore();}
});

test("checker round7: a slow first correction cannot consume a newer correction's delivery",async()=>{
 const {host,asks,card,restore}=await checkerCorrectionFixture();let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let first:Promise<unknown>|undefined;const accepted:string[]=[];let started=0;
 try{
  host.harness.sdk.stub("threads.send",async(input:{threadId:string;input:Array<{text:string}>})=>{if(input.threadId==="thr_w1"){started++;if(started===1)await gate;accepted.push(input.input[0].text);}return {delivery:"queued"};});
  await tool(host,"firstmate_resolve_ask").execute({id:card.id,reopen:true,resolution:"Correction one"},ctx);
  first=host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:"SQLite"});
  for(let i=0;i<30&&started===0;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(started,1);
  await tool(host,"firstmate_resolve_ask").execute({id:card.id,reopen:true,resolution:"Correction two"},ctx);
  assert.equal((await host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:"Postgres"})).ok,true);
  release();await first;
  await host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:"Postgres"});
  console.log("CHECKER R7 slow correction",JSON.stringify({accepted,stored:asks.get(card.id)?.resolution,pending:asks.pendingFollowUps()}));
  assert.equal(accepted.filter(text=>text.includes("now SQLite")).length,1);
  assert.equal(accepted.filter(text=>text.includes("now Postgres")).length,1,"completion of the old send must not mark the new answer delivered");
 }finally{release();if(first)await first.catch(()=>{});await host.harness.lifecycle.dispose();restore();}
});

test("checker round7: a restart between two corrections delivers both in order once each", async () => {
  const { host, state, card, commands, restore } = await checkerCorrectionFixture();
  let next: Awaited<ReturnType<typeof host.harness.lifecycle.reload>> | undefined;
  try {
    const firstSends = host.harness.sdk.callsTo("threads.send").length;
    const before = commands.length;
    await tool(host, "firstmate_resolve_ask").execute({ id: card.id, reopen: true, resolution: "Correction" }, ctx);
    await host.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: card.id, resolution: "SQLite" });
    const first = host.harness.sdk.callsTo("threads.send").slice(firstSends)
      .map((call) => call[0] as { threadId: string; input: Array<{ text: string }> })
      .filter((call) => call.threadId === "thr_w1");
    assert.equal(first.length, 1);
    assert.match(first[0]!.input[0]!.text, /was Postgres, now SQLite/);
    next = await host.harness.lifecycle.reload(plugin);
    const nextCommands: string[] = [];
    let n = 0;
    next.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
    next.harness.sdk.stub("threads.list", async () => []);
    next.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_1", status: "idle" }));
    next.harness.sdk.stub("threads.send", async () => ({ delivery: "queued" }));
    next.harness.sdk.stub("threads.output", async () => ({ output: "" }));
    next.harness.sdk.stub("environments.list", async () => [{ id: "env_source", hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
    next.harness.sdk.stub("projects.get", async () => ({ id: "proj_1", name: "Cyndra", kind: "repo" }));
    next.harness.sdk.stub("files.read", async ({ path }: { path: string }) => {
      if (path === "/native/data/captain.md") return { content: CAPTAIN_MD, sizeBytes: CAPTAIN_MD.length };
      throw new Error("ENOENT");
    });
    next.harness.sdk.stub("plugins.callRpc", async () => ({ ok: true, queued: 1, duplicate: false }));
    next.harness.sdk.stub("terminals.create", async (args: { start: { command: string } }) => {
      const id = `term${++n}`;
      nextCommands.push(args.start.command);
      return { id };
    });
    next.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
    next.harness.sdk.stub("terminals.close", async () => ({}));
    next.harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => {
      const command = nextCommands[Number(terminalId.replace("term", "")) - 1] ?? "";
      let code = 0;
      if (command.includes("fm-captain-hold.sh") && command.includes("'open'")) {
        code = (command.includes("'choice'") ? state.held : command.includes("'wait1'") ? state.shared : false) ? 0 : 1;
      }
      const payload = command.includes("fm-bearings-snapshot.sh")
        ? JSON.stringify({ schema: "fm-bearings.v1", home: "/native", in_flight: [], decisions_open: [], landed: [], gates: [], omitted: [] })
        : command.includes("/native/state/wait1.status") ? state.text : "";
      const captured = command.includes("FM_HOST_CAPTURE_V1");
      const out = captured ? JSON.stringify({ protocol: "FM_HOST_CAPTURE_V1", exitCode: code, stdout: payload, stderr: "" }) : payload;
      return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${out}\n__FM_HOST_RC:${captured ? 0 : code}\n`).toString("base64") }] };
    });
    await tool(next, "firstmate_resolve_ask").execute({ id: card.id, reopen: true, resolution: "Correction" }, ctx);
    await next.harness.behavior.callRpc("resolveAsk", { threadId: "thr_cap", id: card.id, resolution: "Postgres" });
    const second = next.harness.sdk.callsTo("threads.send")
      .map((call) => call[0] as { threadId: string; input: Array<{ text: string }> })
      .filter((call) => call.threadId === "thr_w1");
    assert.equal(second.length, 1, "the second correction is delivered once after restart");
    assert.match(second[0]!.input[0]!.text, /was SQLite, now Postgres/);
    assert.equal(commands.slice(before).filter((command) => command.includes("fm-captain-hold.sh") && command.includes("'answer'")).length, 0);
    assert.equal(nextCommands.filter((command) => command.includes("fm-captain-hold.sh") && command.includes("'answer'")).length, 0);
    assert.equal(createOwnerAsks(next.bb.storage.database()).pendingFollowUps().length, 0);
  } finally {
    if (next) await next.harness.lifecycle.dispose();
    await host.harness.lifecycle.dispose();
    restore();
  }
});

async function checkerReload(previous: Awaited<ReturnType<typeof captainHost>>["host"], statusText="needs-decision [key=choice]: Choose Postgres, MySQL or SQLite?\n") {
  const next=await previous.harness.lifecycle.reload(plugin);
  next.harness.sdk.stub("threads.getPluginMetadata",async({threadId}: {threadId:string})=>threadId==="thr_cap"?{captain:"true"}:{});
  next.harness.sdk.stub("threads.list",async()=>[]);
  next.harness.sdk.stub("threads.get",async({threadId}: {threadId:string})=>makeThreadResponse({id:threadId,projectId:"proj_1",status:"idle"}));
  next.harness.sdk.stub("threads.output",async()=>({output:""}));
  next.harness.sdk.stub("environments.list",async()=>[{id:"env_source",hostId:"host_1",status:"ready",isWorktree:false,path:"/repo"}]);
  next.harness.sdk.stub("projects.get",async()=>({id:"proj_1",name:"Cyndra",kind:"repo"}));
  next.harness.sdk.stub("files.read",async({path}: {path:string})=>{if(path==="/native/data/captain.md")return {content:CAPTAIN_MD,sizeBytes:CAPTAIN_MD.length};throw new Error("ENOENT");});
  next.harness.sdk.stub("plugins.callRpc",async()=>({ok:true,queued:1,duplicate:false}));
  const byId=new Map<string,string>();let seq=0;
  next.harness.sdk.stub("terminals.create",async(args: {start:{command:string}})=>{const id=`reload-${++seq}`;byId.set(id,args.start.command);return {id};});
  next.harness.sdk.stub("terminals.get",async()=>({status:"running"}));
  next.harness.sdk.stub("terminals.close",async()=>({}));
  next.harness.sdk.stub("terminals.output",async({terminalId}: {terminalId:string})=>{
    const command=byId.get(terminalId)??"";
    const payload=command.includes("fm-bearings-snapshot.sh")?JSON.stringify({schema:"fm-bearings.v1",home:"/native",in_flight:[],decisions_open:[],landed:[],gates:[],omitted:[]}):command.includes("/native/state/wait1.status")?statusText:"";
    const code=command.includes("fm-captain-hold.sh")&&command.includes("'open'")&&command.includes("'wait1'")?1:0;
    const captured=command.includes("FM_HOST_CAPTURE_V1");
    const out=captured?JSON.stringify({protocol:"FM_HOST_CAPTURE_V1",exitCode:code,stdout:payload,stderr:""}):payload;
    return {nextSeq:1,chunks:[{dataBase64:Buffer.from(`${out}\n__FM_HOST_RC:${captured?0:code}\n`).toString("base64")}]};
  });
  return next;
}

async function checkerAcceptCorrection(host:Awaited<ReturnType<typeof captainHost>>["host"],id:string,answer:string){
 await tool(host,"firstmate_resolve_ask").execute({id,reopen:true,resolution:"Correction"},ctx);
 return host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id,resolution:answer});
}

test("checker round8: three corrections with a slow first send stay in answer order",async()=>{
 const {host,asks,card,restore}=await checkerCorrectionFixture();let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let first:Promise<unknown>|undefined;let started=0;const accepted:string[]=[];
 try{
  host.harness.sdk.stub("threads.send",async(input:{threadId:string;input:Array<{text:string}>})=>{if(input.threadId==="thr_w1"){started++;if(started===1)await gate;accepted.push(input.input[0].text);}return {delivery:"queued"};});
  first=checkerAcceptCorrection(host,card.id,"SQLite");for(let i=0;i<30&&started===0;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(started,1);
  // Let a correct implementation leave these RPCs pending behind the first answer.
  const second=checkerAcceptCorrection(host,card.id,"Postgres");for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));
  const third=checkerAcceptCorrection(host,card.id,"SQLite");for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));
  release();await Promise.all([first,second,third]);await host.harness.behavior.runSchedule("task-lifecycle");
  console.log("CHECKER R8 order",JSON.stringify(accepted));assert.equal(accepted.length,3);
  assert.deepEqual(accepted.map(text=>text.split(": was ")[1]),["Postgres, now SQLite","SQLite, now Postgres","Postgres, now SQLite"],"corrections must be accepted by the crew queue in owner-answer order");
  assert.equal(asks.pendingFollowUps().length,0);
 }finally{release();if(first)await first.catch(()=>{});await host.harness.lifecycle.dispose();restore();}
});

function checkerLegacyTable(host:Awaited<ReturnType<typeof captainHost>>["host"]){
 const db=host.bb.storage.database();db.exec(`ALTER TABLE owner_ask_followup RENAME TO owner_ask_followup_v8;
 CREATE TABLE owner_ask_followup (ask_id TEXT NOT NULL,effect TEXT NOT NULL,state TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,first_failed_at INTEGER,noticed INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(ask_id,effect));
 INSERT INTO owner_ask_followup SELECT ask_id,effect,state,error,created_at,attempts,first_failed_at,noticed FROM owner_ask_followup_v8;
 DROP TABLE owner_ask_followup_v8;`);
 return createOwnerAsks(db);
}

test("checker round8: a legacy pending row migrates and delivers once",async()=>{
 const {host,asks,restore}=await captainHost();try{
  await host.bb.storage.kv.set("crews",[crewRow("target","thr_target",{workstreamId:"ws-1"})]);
  const card=asks.create({captain:"thr_cap",kind:"question",text:"Choose?",options:[{label:"A",value:"a"}],sourceRef:"crew-wait:target:question",createdAt:1});asks.resolve(card.id,"thr_cap","answered","A",2,"owner");
  const migrated=checkerLegacyTable(host);assert.equal(migrated.pendingFollowUps()[0].answerSeq,1);
  await host.harness.behavior.runSchedule("task-lifecycle");await host.harness.behavior.runSchedule("task-lifecycle");await host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:"A"});
  assert.equal(host.harness.sdk.callsTo("threads.send").filter(call=>JSON.stringify(call).includes("thr_target")).length,1);assert.equal(migrated.pendingFollowUps().length,0);
 }finally{await host.harness.lifecycle.dispose();restore();}
});

test("checker round8: reopening a migrated delivered card retains its actual previous answer",async()=>{
 const {host,card,restore}=await checkerCorrectionFixture();try{
  checkerLegacyTable(host);const before=host.harness.sdk.callsTo("threads.send").length;
  await checkerAcceptCorrection(host,card.id,"SQLite");const messages=host.harness.sdk.callsTo("threads.send").slice(before).map(call=>call[0] as {threadId:string;input:Array<{text:string}>}).filter(call=>call.threadId==="thr_w1");
  console.log("CHECKER R8 legacy pair",JSON.stringify(messages.map(message=>message.input[0].text)));
  assert.equal(messages.length,1);assert.match(messages[0].input[0].text,/was Postgres, now SQLite/,"upgrade must retain the previous owner answer before reopening clears the card");
 }finally{await host.harness.lifecycle.dispose();restore();}
});

test("checker round8: an earlier native completion plan cannot consume the corrected answer",async()=>{
 const state={text:'needs-decision [key=choice]: Choose? {"choices":["Postgres","SQLite"]}\n',held:true,attempts:0};
 const {host,tasks,asks,commands,restore}=await captainHost({wait1:state.text});
 host.harness.sdk.stub("terminals.output",async({terminalId}:{terminalId:string})=>{
  const command=commands[Number(terminalId.replace("term",""))-1]??"";let code=0;
  if(command.includes("fm-captain-hold.sh")&&command.includes("'open'"))code=command.includes("'choice'")&&state.held?0:1;
  if(command.includes("fm-captain-hold.sh")&&command.includes("'answer'")&&command.includes("'choice'")){state.attempts++;code=state.attempts===1?2:0;if(code===0)state.held=false;}
  if(command.includes("resolved [key=choice]: Postgres")&&command.includes(">>"))state.text+='resolved [key=choice]: Postgres\n';
  const payload=command.includes("fm-bearings-snapshot.sh")?JSON.stringify({schema:"fm-bearings.v1",home:"/native",in_flight:[],decisions_open:[],landed:[],gates:[],omitted:[]}):command.includes("/native/state/wait1.status")?state.text:"";
  const captured=command.includes("FM_HOST_CAPTURE_V1");const out=captured?JSON.stringify({protocol:"FM_HOST_CAPTURE_V1",exitCode:code,stdout:payload,stderr:""}):payload;
  return {nextSeq:1,chunks:[{dataBase64:Buffer.from(`${out}\n__FM_HOST_RC:${captured?0:code}\n`).toString("base64")}]};
 });
 try{
  await host.bb.storage.kv.set("crews",[crewRow("wait1","thr_w1")]);const task=tasks.open({captain:"thr_cap",project:"Cyndra",title:"Database",sourceRefs:[],crewId:"wait1",at:Date.now()});await host.harness.behavior.runSchedule("task-lifecycle");const card=asks.listOpen("thr_cap").find(ask=>ask.task===task.id)!;
  await host.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:"Postgres"});assert.ok(asks.pendingFollowUps().some(job=>job.effect==="owner-answered"));
  const sends=host.harness.sdk.callsTo("threads.send").length;await checkerAcceptCorrection(host,card.id,"SQLite");
  const corrected=host.harness.sdk.callsTo("threads.send").slice(sends).filter(call=>JSON.stringify(call).includes("thr_w1")&&JSON.stringify(call).includes("now SQLite"));
  console.log("CHECKER R8 native plan",JSON.stringify({attempts:state.attempts,corrections:corrected.length,pending:asks.pendingFollowUps(),stored:asks.get(card.id)?.resolution}));
  assert.equal(state.attempts,2);assert.equal(corrected.length,1,"the completed plan for the old native answer must not complete the new correction");
 }finally{await host.harness.lifecycle.dispose();restore();}
});


test("checker round8: three sequential corrections survive restart between answers",async()=>{
 const fixture=await checkerCorrectionFixture();const {card,state,restore}=fixture;let active=fixture.host;const hosts=[active];const received:string[]=[];
 const sending=async(input:{threadId:string;input:Array<{text:string}>})=>{if(input.threadId==="thr_w1")received.push(input.input[0].text);return {delivery:"queued"};};
 try{
  for(const answer of ["SQLite","Postgres","SQLite"]){active.harness.sdk.stub("threads.send",sending);await checkerAcceptCorrection(active,card.id,answer);await active.harness.behavior.callRpc("resolveAsk",{threadId:"thr_cap",id:card.id,resolution:answer});active=await checkerReload(active,state.text);hosts.push(active);for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));}
  assert.deepEqual(received.map(text=>text.split(": was ")[1]),["Postgres, now SQLite","SQLite, now Postgres","Postgres, now SQLite"]);assert.equal(createOwnerAsks(active.bb.storage.database()).pendingFollowUps().length,0);
 }finally{for(const h of hosts)await h.harness.lifecycle.dispose();restore();}
});

test("checker round8: restart after queue acceptance before send response does not enqueue twice",async()=>{
 const {host,card,state,restore}=await checkerCorrectionFixture();let next;let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let accepted=0;let first:Promise<unknown>|undefined;
 try{
  host.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_w1"){accepted++;await gate;}return {delivery:"queued"};});
  first=checkerAcceptCorrection(host,card.id,"SQLite").catch(()=>{});for(let i=0;i<30&&accepted===0;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(accepted,1);
  next=await checkerReload(host,state.text);next.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_w1")accepted++;return {delivery:"queued"};});
  for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));await next.harness.behavior.runSchedule("task-lifecycle");
  const newCalls=next.harness.sdk.callsTo("threads.send").filter(call=>JSON.stringify(call).includes("thr_w1"));console.log("CHECKER R8 in-flight restart",JSON.stringify({accepted,newCalls:newCalls.length,pending:createOwnerAsks(next.bb.storage.database()).pendingFollowUps()}));
  assert.equal(newCalls.length,0,"a correction already accepted by the queue before restart must not be queued again");
 }finally{release();if(first)await first;if(next)await next.harness.lifecycle.dispose();await host.harness.lifecycle.dispose();restore();}
});

test("checker round8: a migrated pending answer keeps its value when the owner corrects before retry",async()=>{
 const {host,asks,restore}=await captainHost();const received:string[]=[];
 try{
  await host.bb.storage.kv.set("crews",[crewRow("target","thr_target",{workstreamId:"ws-1"})]);
  const card=asks.create({captain:"thr_cap",kind:"question",text:"Choose?",options:[{label:"A",value:"a"},{label:"B",value:"b"}],sourceRef:"crew-wait:target:question",createdAt:1});asks.resolve(card.id,"thr_cap","answered","A",2,"owner");
  checkerLegacyTable(host);host.harness.sdk.stub("threads.send",async(input:{threadId:string;input:Array<{text:string}>})=>{if(input.threadId==="thr_target")received.push(input.input[0].text);return {delivery:"queued"};});
  await checkerAcceptCorrection(host,card.id,"B");await host.harness.behavior.runSchedule("task-lifecycle");console.log("CHECKER R8 legacy pending correction",JSON.stringify(received));
  assert.deepEqual(received,[`The owner answered card ${card.id}: A`,`The owner answered card ${card.id}: B`],"each accepted answer must retain its own value across upgrade and correction");
 }finally{await host.harness.lifecycle.dispose();restore();}
});

const checkerCrewSends=(host:Awaited<ReturnType<typeof captainHost>>["host"],target="thr_w1")=>host.harness.sdk.callsTo("threads.send").map(call=>call[0] as {threadId:string;input:Array<{text:string}>}).filter(call=>call.threadId===target);

test("checker round9: restart after recording identity but before sending cannot silently lose the correction",async()=>{
 const {host,asks,card,state,restore}=await checkerCorrectionFixture();let next;let release=()=>{};const gate=new Promise<void>(resolve=>{release=resolve;});let recorded=false;let first:Promise<unknown>|undefined;
 const originalSet=host.bb.storage.kv.set.bind(host.bb.storage.kv);
 try{
  host.bb.storage.kv.set=async(key,value)=>{await originalSet(key,value);if(key===`owner-answer-sent:${card.id}:2`){recorded=true;await gate;}};
  first=checkerAcceptCorrection(host,card.id,"SQLite").catch(()=>{});for(let i=0;i<40&&!recorded;i++)await new Promise(resolve=>setImmediate(resolve));assert.equal(recorded,true);assert.equal(checkerCrewSends(host).length,0,"crash boundary is before the queue call");assert.ok(asks.pendingFollowUps().some(job=>job.answerSeq===2&&job.effect==="owner-answered"));
  next=await checkerReload(host,state.text);next.harness.sdk.stub("threads.send",async()=>({delivery:"queued"}));for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));await next.harness.behavior.runSchedule("task-lifecycle");
  const store=createOwnerAsks(next.bb.storage.database());const board=await next.harness.behavior.callRpc("telegramCommand",{threadId:"thr_cap",command:"board"});const captain=checkerCrewSends(next,"thr_cap").map(send=>send.input[0].text).join("\n");const delivered=checkerCrewSends(next).length;const unknown=/answer.*(?:unknown|uncertain|not delivered)|(?:unknown|uncertain).*delivery|could not confirm.*(?:answer|correction)/i;
  console.log("CHECKER R9 before send",JSON.stringify({recorded,delivered,pending:store.pendingFollowUps(),failed:store.failedFollowUps(),captain,board}));
  assert.ok(delivered===1||(unknown.test(captain)&&unknown.test(JSON.stringify(board))),"a recorded-but-unsent identity must recover delivery or expose uncertainty to both captain and owner");
 }finally{release();if(first)await first;if(next)await next.harness.lifecycle.dispose();await host.harness.lifecycle.dispose();restore();}
});

test("checker round9: queue acceptance followed by a lost response cannot duplicate on retry",async()=>{
 const {host,asks,card,restore}=await checkerCorrectionFixture();const accepted:string[]=[];
 try{
  host.harness.sdk.stub("threads.send",async(input:{threadId:string;input:Array<{text:string}>})=>{if(input.threadId==="thr_w1"){accepted.push(input.input[0].text);if(accepted.length===1)throw new Error("transport lost the response after queue acceptance");}return {delivery:"queued"};});
  await checkerAcceptCorrection(host,card.id,"SQLite");assert.equal(accepted.length,1);assert.ok(asks.pendingFollowUps().some(job=>job.answerSeq===2&&job.effect==="owner-answered"));await host.harness.behavior.runSchedule("task-lifecycle");
  console.log("CHECKER R9 lost response",JSON.stringify({accepted,pending:asks.pendingFollowUps(),failed:asks.failedFollowUps()}));assert.equal(accepted.length,1,"uncertain send result must be reconciled or reported, not blindly retried");
 }finally{await host.harness.lifecycle.dispose();restore();}
});

test("checker round9: restart after send response before closing its row does not duplicate",async()=>{
 const {host,asks,card,state,restore}=await checkerCorrectionFixture();let next;let accepted=0;const db=host.bb.storage.database();const originalPrepare=db.prepare.bind(db);let blocked=0;
 try{
  host.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_w1")accepted++;return {delivery:"queued"};});
  db.prepare=(sql)=>{const stmt=originalPrepare(sql);if(sql.startsWith("UPDATE owner_ask_followup SET state='done'")){const run=stmt.run.bind(stmt);stmt.run=(...params)=>{if(params[0]===card.id&&params[1]===2&&params[2]==="owner-answered"){blocked++;throw new Error("crash boundary before closing the delivered row");}return run(...params);};}return stmt;};
  await checkerAcceptCorrection(host,card.id,"SQLite");db.prepare=originalPrepare;assert.equal(accepted,1);assert.equal(blocked,1);assert.ok(asks.pendingFollowUps().some(job=>job.answerSeq===2&&job.effect==="owner-answered"));
  next=await checkerReload(host,state.text);next.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_w1")accepted++;return {delivery:"queued"};});for(let i=0;i<12;i++)await new Promise(resolve=>setImmediate(resolve));await next.harness.behavior.runSchedule("task-lifecycle");
  assert.equal(accepted,1);assert.equal(checkerCrewSends(next).length,0);assert.equal(createOwnerAsks(next.bb.storage.database()).pendingFollowUps().length,0);
 }finally{db.prepare=originalPrepare;if(next)await next.harness.lifecycle.dispose();await host.harness.lifecycle.dispose();restore();}
});

test("checker round9: terminal failure of an earlier answer releases the next with visible failure",async()=>{
 const {host,asks,card,restore}=await checkerCorrectionFixture();let attempts=0;const delivered:string[]=[];
 try{
  host.harness.sdk.stub("threads.events.list",async()=>[]);host.harness.sdk.stub("threads.queuedMessages.list",async()=>[]);
  host.harness.sdk.stub("threads.send",async(input:{threadId:string;input:Array<{text:string}>})=>{if(input.threadId==="thr_w1"){if(input.input[0].text.includes("now SQLite")){attempts++;throw new Error("queue refuses first correction");}delivered.push(input.input[0].text);}return {delivery:"queued"};});
  await checkerAcceptCorrection(host,card.id,"SQLite");assert.equal(attempts,1);await checkerAcceptCorrection(host,card.id,"Postgres");assert.equal(delivered.length,0,"newer answer must wait while older remains retryable");
  for(let i=0;i<8&&attempts<8;i++)await host.harness.behavior.runSchedule("task-lifecycle");await host.harness.behavior.runSchedule("task-lifecycle");assert.equal(attempts,8);assert.equal(delivered.length,1);assert.match(delivered[0],/was SQLite, now Postgres/);assert.ok(asks.failedFollowUps().some(job=>job.answerSeq===2&&job.effect==="owner-answered"));
  const notices=()=>checkerCrewSends(host,"thr_cap").filter(send=>send.input[0].text.includes(`card ${card.id} was not delivered to crew wait1`));assert.equal(notices().length,1);const board=await host.harness.behavior.callRpc("telegramCommand",{threadId:"thr_cap",command:"board"});assert.match(JSON.stringify(board),/answer not delivered to crew wait1/);await host.harness.behavior.runSchedule("task-lifecycle");assert.equal(notices().length,1);assert.equal(delivered.length,1);console.log("CHECKER R9 terminal failure",JSON.stringify({attempts,delivered,captainNotices:notices().length,board}));
 }finally{await host.harness.lifecycle.dispose();restore();}
});

async function checkerPendingIntent(){
 const fixture=await checkerCorrectionFixture();const {host,asks,card}=fixture;
 asks.resolve(card.id,"thr_cap","open","Correction",Date.now());asks.resolve(card.id,"thr_cap","answered","SQLite",Date.now(),"owner");
 const marker=`askref:${card.id}:2`;const key=`owner-answer-sent:${card.id}:2`;
 const input=[{type:"text" as const,text:"The owner corrected the answer."},{type:"text" as const,text:marker}];
 await host.bb.storage.kv.set(key,{state:"sending",marker,markers:[marker],threadId:"thr_w1",at:Date.now(),senderThreadId:"thr_cap",input,inputs:[input]}); // real journal receipt, FIX-169-13
 return {...fixture,marker,key};
}
function checkerEvent(seq:number,body:string){return {id:`event-${seq}`,scope:{kind:"thread"},threadId:"thr_w1",seq,createdAt:Date.now(),type:"item/completed",data:{providerThreadId:"provider-w1",item:{id:`input-${seq}`,type:"userMessage",content:[{type:"text",text:body}]}}};}
function checkerQueue(body:string){return {id:"queue-1",threadId:"thr_w1",failureReason:null,content:[{type:"text",text:body}]};}
function checkerRequested(seq:number,marker:string,requestId="req-1",sender="thr_cap"){return {id:`event-${seq}`,scope:{kind:"thread" as const},threadId:"thr_w1",seq,createdAt:Date.now(),type:"client/turn/requested",data:{direction:"outbound",source:"tell",initiator:"agent",senderThreadId:sender,requestId,request:{method:"turn/start",params:{}},input:[{type:"text",text:`[bb message from thread:${sender}]\n\nThe owner corrected the answer.`},{type:"text",text:marker}],target:{kind:"new-turn"}}};}
function checkerAccepted(seq:number,requestId="req-1"){return {id:`accept-${seq}`,scope:{kind:"thread" as const},threadId:"thr_w1",seq,createdAt:Date.now(),type:"turn/input/accepted",data:{clientRequestId:requestId,providerThreadId:"provider-w1",threadId:"thr_w1",scope:{kind:"thread"}}};}

test("checker round10: a delivered marker beyond the first 100 events is found",async()=>{
 const f=await checkerPendingIntent();const journal=r13Journal(r13Input(await f.host.bb.storage.kv.get(f.key)));const history=Array.from({length:101},(_,i)=>{const seq=101-i;if(seq===101)return {...journal[0],seq:101};if(seq===1)return {...journal[1],seq:1};return checkerEvent(seq,`ordinary event ${seq}`);});const reads:Array<{beforeSeq?:string;limit?:string}>=[]; // real journal receipt, FIX-169-13
 try{
  f.host.harness.sdk.stub("threads.events.list",async(args:{threadId:string;beforeSeq?:string;limit?:string})=>{if(args.threadId!=="thr_w1")return [];reads.push(args);assert.ok(Number(args.limit??100)<=100);return history.filter(row=>!args.beforeSeq||row.seq<Number(args.beforeSeq)).slice(0,Number(args.limit??100));});f.host.harness.sdk.stub("threads.queuedMessages.list",async()=>[]);
  await f.host.harness.behavior.runSchedule("task-lifecycle");const record=await f.host.bb.storage.kv.get(f.key);console.log("CHECKER R10 pagination",JSON.stringify({reads,record,pending:f.asks.pendingFollowUps()}));
  assert.equal((record as {state?:string})?.state,"delivered","the retained older event must confirm delivery rather than become an unknown failure");assert.equal(f.asks.pendingFollowUps().length,0);assert.ok(reads.length>=2);assert.equal(checkerCrewSends(f.host).length,0);
 }finally{await f.host.harness.lifecycle.dispose();f.restore();}
});

test("checker round10: marker-like text inside another owner answer cannot fake delivery",async()=>{
 const f=await checkerPendingIntent();let accepted=0;
 try{
  f.host.harness.sdk.stub("threads.events.list",async()=>[]);f.host.harness.sdk.stub("threads.queuedMessages.list",async()=>[{...checkerQueue(`The owner answered card ${f.card.id}: Example text ${f.marker} is documentation, not a receipt.`),pluginSubmission:{pluginId:"firstmate",data:{correlation:`askref:${f.card.id}:1`,askId:f.card.id,answerSeq:1}}}]);
  f.host.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_w1")accepted++;return {delivery:"queued"};});for(let i=0;i<3;i++)await f.host.harness.behavior.runSchedule("task-lifecycle");console.log("CHECKER R10 marker text",JSON.stringify({accepted,record:await f.host.bb.storage.kv.get(f.key),pending:f.asks.pendingFollowUps()}));
  assert.equal(accepted,0,"an older answer's ordinary text must not stand in for the newer correction's delivery identity");assert.equal((await f.host.bb.storage.kv.get<{state:string}>(f.key))?.state,"unknown");
 }finally{await f.host.harness.lifecycle.dispose();f.restore();}
});

test("checker round10: a queue item moving into events during discovery cannot cause duplicate delivery",async()=>{
 const f=await checkerPendingIntent();let accepted=1;let moved=false;const events:ReturnType<typeof checkerEvent>[]=[];let queued=[checkerQueue(f.marker)];let discoveries=0;
 try{
  f.host.harness.sdk.stub("threads.events.list",async(args:{threadId:string})=>{if(args.threadId!=="thr_w1")return [];discoveries++;const snapshot=[...events];if(!moved){moved=true;queued=[];events.push(checkerEvent(1,f.marker));}return snapshot;});f.host.harness.sdk.stub("threads.queuedMessages.list",async()=>queued);
  f.host.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_w1")accepted++;return {delivery:"queued"};});for(let i=0;i<3;i++)await f.host.harness.behavior.runSchedule("task-lifecycle");console.log("CHECKER R10 queue transition",JSON.stringify({accepted,discoveries,record:await f.host.bb.storage.kv.get(f.key),pending:f.asks.pendingFollowUps()}));assert.equal(accepted,1,"queue consumption between the event snapshot and queue snapshot must not look like non-acceptance");
 }finally{await f.host.harness.lifecycle.dispose();f.restore();}
});

test("checker round10: unreadable reconciliation blocks one card only and ends visibly failed once",async()=>{
 const f=await checkerPendingIntent();const others:string[]=[];
 try{
  const crews=await f.host.bb.storage.kv.get<ReturnType<typeof crewRow>[]>("crews");await f.host.bb.storage.kv.set("crews",[...(crews??[]),crewRow("other","thr_other",{workstreamId:"ws-other"})]);
  f.asks.resolve(f.card.id,"thr_cap","open","Correction",Date.now());f.asks.resolve(f.card.id,"thr_cap","answered","Postgres",Date.now(),"owner");const other=f.asks.create({captain:"thr_cap",kind:"question",text:"Other choice?",options:[{label:"Yes",value:"yes"}],sourceRef:"crew-wait:other:question",createdAt:Date.now()});f.asks.resolve(other.id,"thr_cap","answered","Yes",Date.now(),"owner");
  f.host.harness.sdk.stub("threads.events.list",async(args:{threadId:string})=>{if(args.threadId==="thr_w1")throw new Error("crew event read unavailable");return [];});f.host.harness.sdk.stub("threads.queuedMessages.list",async()=>{throw new Error("crew queue read unavailable");});f.host.harness.sdk.stub("threads.send",async(input:{threadId:string;input:Array<{text:string}>})=>{if(input.threadId==="thr_other")others.push(input.input[0].text);return {delivery:"queued"};});
  await f.host.harness.behavior.runSchedule("task-lifecycle");assert.equal(others.length,1);assert.equal(checkerCrewSends(f.host).length,0);assert.ok(f.asks.pendingFollowUps().some(job=>job.answerSeq===3));assert.equal((await f.host.bb.storage.kv.get<{state:string}>(f.key))?.state,"unknown");
  const unconfirmed=()=>checkerCrewSends(f.host,"thr_cap").filter(send=>send.input[0].text.includes(`Could not confirm the owner's answer on card ${f.card.id}`));assert.equal(unconfirmed().length,1);await f.host.harness.behavior.runSchedule("task-lifecycle");assert.equal(unconfirmed().length,1);
  for(let i=0;i<8&&!f.asks.failedFollowUps().some(job=>job.askId===f.card.id&&job.answerSeq===2);i++)await f.host.harness.behavior.runSchedule("task-lifecycle");assert.ok(f.asks.failedFollowUps().some(job=>job.askId===f.card.id&&job.answerSeq===2&&job.attempts===8));const board=await f.host.harness.behavior.callRpc("telegramCommand",{threadId:"thr_cap",command:"board"});assert.match(JSON.stringify(board),/answer not delivered to crew wait1/);const failed=()=>checkerCrewSends(f.host,"thr_cap").filter(send=>send.input[0].text.includes(`card ${f.card.id} was not delivered to crew wait1`));assert.equal(failed().length,1);await f.host.harness.behavior.runSchedule("task-lifecycle");assert.equal(failed().length,1);
 }finally{await f.host.harness.lifecycle.dispose();f.restore();}
});

async function checkerActualUnknown(){
 const f=await checkerCorrectionFixture();let marker="";
 f.host.harness.sdk.stub("threads.events.list",async()=>{throw new Error("event read unavailable during interrupted send");});f.host.harness.sdk.stub("threads.queuedMessages.list",async()=>{throw new Error("queue read unavailable during interrupted send");});
 f.host.harness.sdk.stub("threads.send",async(input:{threadId:string;input:Array<{text:string}>})=>{if(input.threadId==="thr_w1"){marker=input.input.at(-1)?.text??"";throw new Error("send result unavailable");}return {delivery:"queued"};});
 await checkerAcceptCorrection(f.host,f.card.id,"SQLite");assert.match(marker,/^askref:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
 const key=`owner-answer-sent:${f.card.id}:2`;const record=await f.host.bb.storage.kv.get<{state:string;marker:string;threadId:string;at:number}>(key);assert.equal(record?.marker,marker);assert.equal(record?.state,"unknown");return {...f,marker,key,record:record!};
}

for(const place of ["queue","event"])for(const shape of ["contains nonce","marker line in answer","near match","exact nonce from owner"]){
 test(`checker round11: ${shape} in ${place} cannot authenticate a Firstmate answer`,async()=>{
  const f=await checkerActualUnknown();let accepted=0;
  try{
   const quoted=shape==="contains nonce"?`The owner quoted ${f.marker} in an answer.`:shape==="marker line in answer"?`Owner example:\n${f.marker}\nEnd example.`:shape==="near match"?`${f.marker}-other`:f.marker;
   const userQueue=makeQueueEntry({threadId:"thr_w1",origin:"app",originPluginId:null,initiator:"user",senderThreadId:null,content:[{type:"text",text:quoted}]});
   const failedOriginal=makeQueueEntry({threadId:"thr_w1",origin:"plugin",originPluginId:"firstmate",initiator:"agent",senderThreadId:"thr_cap",failureReason:"original answer was not delivered",content:[{type:"text",text:"The owner corrected the answer."},{type:"text",text:f.marker}]});
   f.host.harness.sdk.stub("threads.queuedMessages.list",async()=>place==="queue"?[failedOriginal,userQueue]:[failedOriginal]);f.host.harness.sdk.stub("threads.events.list",async()=>place==="event"?[checkerEvent(1,quoted)]:[]);f.host.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_w1")accepted++;return {delivery:"queued"};});
   for(let i=0;i<3;i++)await f.host.harness.behavior.runSchedule("task-lifecycle");console.log("CHECKER R11 owner marker",JSON.stringify({place,shape,accepted,record:await f.host.bb.storage.kv.get(f.key),pending:f.asks.pendingFollowUps()}));assert.equal(accepted,0,"owner-controlled text without a Firstmate owner-answer identity cannot complete the real answer's pending delivery");assert.equal((await f.host.bb.storage.kv.get<{state:string}>(f.key))?.state,"unknown");
  }finally{await f.host.harness.lifecycle.dispose();f.restore();}
 });
}

test("checker round11: actual random nonce survives restart and differs for the next answer",async()=>{
 const f=await checkerActualUnknown();let next;let nextMarker="";
 try{
  next=await checkerReload(f.host,f.state.text);next.harness.sdk.stub("threads.queuedMessages.list",async()=>[]);next.harness.sdk.stub("threads.events.list",async()=>r13Journal(r13Input(await next.bb.storage.kv.get(f.key))));next.harness.sdk.stub("threads.send",async(input:{threadId:string;input:Array<{text:string}>})=>{if(input.threadId==="thr_w1")nextMarker=input.input.at(-1)?.text??"";return {delivery:"queued"};}); // real journal receipt, FIX-169-13
  await next.harness.behavior.runSchedule("task-lifecycle");assert.equal(nextMarker,"");assert.equal((await next.bb.storage.kv.get<{marker:string}>(f.key))?.marker,f.marker);assert.equal(createOwnerAsks(next.bb.storage.database()).pendingFollowUps().length,0);
  await checkerAcceptCorrection(next,f.card.id,"Postgres");assert.match(nextMarker,/^askref:[0-9a-f-]{36}$/i);assert.notEqual(nextMarker,f.marker);assert.equal((await next.bb.storage.kv.get<{marker:string}>(`owner-answer-sent:${f.card.id}:3`))?.marker,nextMarker);
 }finally{if(next)await next.harness.lifecycle.dispose();await f.host.harness.lifecycle.dispose();f.restore();}
});

test("checker round11: several pages are read at 100 each until the real nonce is found",async()=>{
 const f=await checkerActualUnknown();const journal=r13Journal(r13Input(await f.host.bb.storage.kv.get(f.key)));const history=Array.from({length:350},(_,i)=>{const seq=350-i;const createdAt=f.record.at+seq;if(seq===350)return {...journal[0],seq,createdAt};if(seq===1)return {...journal[1],seq,createdAt};return {...checkerEvent(seq,`later event ${seq}`),createdAt};});const reads:Array<{beforeSeq?:string;limit?:string}>=[]; // real journal receipt, FIX-169-13
 try{
  f.host.harness.sdk.stub("threads.queuedMessages.list",async()=>[]);f.host.harness.sdk.stub("threads.events.list",async(args:{threadId:string;beforeSeq?:string;limit?:string})=>{if(args.threadId!=="thr_w1")return [];reads.push(args);assert.ok(Number(args.limit)<=100);return history.filter(row=>args.beforeSeq===undefined||row.seq<Number(args.beforeSeq)).slice(0,Number(args.limit));});
  await f.host.harness.behavior.runSchedule("task-lifecycle");assert.equal(reads.length,4);assert.deepEqual(reads.map(row=>row.beforeSeq),[undefined,"251","151","51"]);assert.equal((await f.host.bb.storage.kv.get<{state:string}>(f.key))?.state,"delivered");assert.equal(f.asks.pendingFollowUps().length,0);
 }finally{await f.host.harness.lifecycle.dispose();f.restore();}
});

test("checker round11: absence stops at the original intent time",async()=>{
 const f=await checkerActualUnknown();const reads:string[]=[];const history=Array.from({length:250},(_,i)=>({...checkerEvent(250-i,`older event ${250-i}`),createdAt:f.record.at+250-i-101}));let accepted=0;
 try{
  f.host.harness.sdk.stub("threads.queuedMessages.list",async()=>[]);f.host.harness.sdk.stub("threads.events.list",async(args:{beforeSeq?:string;limit?:string})=>{reads.push(args.beforeSeq??"first");assert.ok(Number(args.limit)<=100);return history.filter(row=>!args.beforeSeq||row.seq<Number(args.beforeSeq)).slice(0,Number(args.limit));});f.host.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_w1")accepted++;return {delivery:"queued"};});
  await f.host.harness.behavior.runSchedule("task-lifecycle");assert.deepEqual(reads,["first","151"]);const kept=await f.host.bb.storage.kv.get<{at:number}>(f.key);assert.equal(kept?.at,f.record.at);assert.equal(accepted,1);
 }finally{await f.host.harness.lifecycle.dispose();f.restore();}
});

test("checker round11: a later page read failure keeps the nonce unknown",async()=>{
 const f=await checkerActualUnknown();let reads=0;
 try{
  f.host.harness.sdk.stub("threads.queuedMessages.list",async()=>[]);f.host.harness.sdk.stub("threads.events.list",async(args:{beforeSeq?:string;limit?:string})=>{reads++;assert.ok(Number(args.limit)<=100);if(args.beforeSeq)throw new Error("second page unavailable");return Array.from({length:100},(_,i)=>({...checkerEvent(300-i,`recent event ${300-i}`),createdAt:f.record.at+300-i}));});
  await f.host.harness.behavior.runSchedule("task-lifecycle");assert.equal(reads,2);assert.equal((await f.host.bb.storage.kv.get<{state:string;marker:string}>(f.key))?.state,"unknown");assert.equal((await f.host.bb.storage.kv.get<{marker:string}>(f.key))?.marker,f.marker);assert.ok(f.asks.pendingFollowUps().some(job=>job.answerSeq===2&&job.effect==="owner-answered"));
 }finally{await f.host.harness.lifecycle.dispose();f.restore();}
});

for(const restart of [false,true])test(`checker round11: slow send failure preserves the original intent time, restart=${restart}`,async()=>{
 const f=await checkerCorrectionFixture();const realNow=Date.now;let now=realNow();const originalIntentAt=now;Date.now=()=>now;let next;let active=f.host;let accepted=0;let marker="";const history:ReturnType<typeof checkerEvent>[]=[];const reads:Array<{beforeSeq?:string}>=[];const key=`owner-answer-sent:${f.card.id}:2`;
 try{
  f.host.harness.sdk.stub("threads.queuedMessages.list",async()=>{throw new Error("read unavailable at send failure");});f.host.harness.sdk.stub("threads.events.list",async()=>{throw new Error("read unavailable at send failure");});
  f.host.harness.sdk.stub("threads.send",async(input:{threadId:string;input:Array<{text:string}>})=>{if(input.threadId==="thr_w1"){accepted++;marker=input.input.at(-1)?.text??"";history.push(...Array.from({length:221},(_,i)=>({...checkerEvent(221-i,i===220?marker:`crew work event ${221-i}`),createdAt:originalIntentAt+(221-i)*1000})));now=originalIntentAt+10*60_000;throw new Error("response lost after a slow accepted send");}return {delivery:"queued"};});
  await checkerAcceptCorrection(f.host,f.card.id,"SQLite");const afterError=await f.host.bb.storage.kv.get<{at:number;state:string}>(key);assert.equal(accepted,1);
  if(restart){next=await checkerReload(f.host,f.state.text);active=next;}
  active.harness.sdk.stub("threads.queuedMessages.list",async()=>[]);active.harness.sdk.stub("threads.events.list",async(args:{threadId:string;beforeSeq?:string;limit?:string})=>{if(args.threadId!=="thr_w1")return [];reads.push(args);assert.ok(Number(args.limit)<=100);return history.filter(row=>!args.beforeSeq||row.seq<Number(args.beforeSeq)).slice(0,Number(args.limit));});active.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_w1")accepted++;return {delivery:"queued"};});
  for(let i=0;i<3;i++)await active.harness.behavior.runSchedule("task-lifecycle");console.log("CHECKER R11 intent time",JSON.stringify({restart,originalIntentAt,afterError,reads,accepted,record:await active.bb.storage.kv.get(key),pending:createOwnerAsks(active.bb.storage.database()).pendingFollowUps()}));assert.equal(accepted,1,"changing sending to unknown must not move the time cutoff past an accepted receipt and authorize a duplicate");assert.equal(afterError?.at,originalIntentAt);
 }finally{Date.now=realNow;if(next)await next.harness.lifecycle.dispose();await f.host.harness.lifecycle.dispose();f.restore();}
});

test("checker round11: queue-to-event transition is found in the required read order",async()=>{
 const f=await checkerActualUnknown();const order:string[]=[];const events:object[]=[];
 try{
  f.host.harness.sdk.stub("threads.queuedMessages.list",async()=>{order.push("queue");events.push(...r13Journal(r13Input(await f.host.bb.storage.kv.get(f.key))));return [];});f.host.harness.sdk.stub("threads.events.list",async()=>{order.push("events");return events;});await f.host.harness.behavior.runSchedule("task-lifecycle");assert.deepEqual(order,["queue","events"]);assert.equal((await f.host.bb.storage.kv.get<{state:string}>(f.key))?.state,"delivered");assert.equal(f.asks.pendingFollowUps().length,0); // real journal receipt, FIX-169-13
 }finally{await f.host.harness.lifecycle.dispose();f.restore();}
});

for(const kind of ["originless completed event","queue without plugin identity","Firstmate queue without correlation","owner queue without a failed original"]){
 test(`checker round12: ${kind} carrying the nonce stays unknown without resend`,async()=>{
  const f=await checkerActualUnknown();let accepted=0;
  try{
   const queued=kind==="queue without plugin identity" ? [makeQueueEntry({threadId:"thr_w1",origin:"sdk",originPluginId:null,initiator:"agent",senderThreadId:"thr_cap",content:[{type:"text",text:f.marker}]})] : kind==="Firstmate queue without correlation" ? [makeQueueEntry({threadId:"thr_w1",origin:"plugin",originPluginId:"firstmate",initiator:"agent",senderThreadId:"thr_cap",content:[{type:"text",text:f.marker}]})] : kind==="owner queue without a failed original" ? [makeQueueEntry({threadId:"thr_w1",origin:"app",originPluginId:null,initiator:"user",senderThreadId:null,content:[{type:"text",text:f.marker}]})] : [];
   f.host.harness.sdk.stub("threads.queuedMessages.list",async()=>queued);f.host.harness.sdk.stub("threads.events.list",async()=>kind==="originless completed event" ? [checkerEvent(1,f.marker)] : []);f.host.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_w1")accepted++;return {delivery:"queued"};});
   for(let i=0;i<3;i++)await f.host.harness.behavior.runSchedule("task-lifecycle");const record=await f.host.bb.storage.kv.get<{state:string}>(f.key);console.log("CHECKER R12 unproved nonce",JSON.stringify({kind,accepted,record,pending:f.asks.pendingFollowUps(),failed:f.asks.failedFollowUps()}));assert.equal(record?.state,"unknown","a nonce without the required provenance is not proof of delivery or proof of absence");assert.equal(accepted,0,"recovery must not resend an unconfirmed accepted answer merely because the receipt lacks provenance");
   for(let i=0;i<5;i++)await f.host.harness.behavior.runSchedule("task-lifecycle");assert.ok(f.asks.failedFollowUps().some(job=>job.answerSeq===2&&job.attempts===8));const board=await f.host.harness.behavior.callRpc("telegramCommand",{threadId:"thr_cap",command:"board"});assert.match(JSON.stringify(board),/answer not delivered to crew wait1/);const failed=()=>checkerCrewSends(f.host,"thr_cap").filter(send=>send.input[0].text.includes(`card ${f.card.id} was not delivered to crew wait1`));assert.equal(failed().length,1);await f.host.harness.behavior.runSchedule("task-lifecycle");assert.equal(failed().length,1);
  }finally{await f.host.harness.lifecycle.dispose();f.restore();}
 });
}

for(const failedCopy of [false,true])test(`checker round12: actual Firstmate send found only in completed events, failed copy=${failedCopy}`,async()=>{
 const f=await checkerCorrectionFixture();let accepted=0;let marker="";let content:Array<{type:"text";text:string}>=[];const key=`owner-answer-sent:${f.card.id}:2`;
 try{
  f.host.harness.sdk.stub("threads.queuedMessages.list",async()=>{throw new Error("queue read unavailable with lost response");});f.host.harness.sdk.stub("threads.events.list",async()=>{throw new Error("event read unavailable with lost response");});f.host.harness.sdk.stub("threads.send",async(input:{threadId:string;input:Array<{type:"text";text:string}>})=>{if(input.threadId==="thr_w1"){accepted++;content=input.input.map(part=>({type:"text",text:part.text}));marker=content.at(-1)!.text;throw new Error("response lost after the real send reached the crew");}return {delivery:"queued"};});
  await checkerAcceptCorrection(f.host,f.card.id,"SQLite");assert.equal(accepted,1);const event=r13Journal(content, "thr_cap", "agent", true); // real journal receipt, FIX-169-13
  f.host.harness.sdk.stub("threads.queuedMessages.list",async()=>failedCopy ? [makeQueueEntry({threadId:"thr_w1",origin:"plugin",originPluginId:"firstmate",initiator:"agent",senderThreadId:"thr_cap",failureReason:"an earlier queued attempt failed",content})] : []);f.host.harness.sdk.stub("threads.events.list",async()=>event);f.host.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_w1")accepted++;return {delivery:"queued"};});for(let i=0;i<3;i++)await f.host.harness.behavior.runSchedule("task-lifecycle");console.log("CHECKER R12 completed receipt",JSON.stringify({failedCopy,accepted,event,record:await f.host.bb.storage.kv.get(key),pending:f.asks.pendingFollowUps()}));assert.equal(accepted,1,"a retained failed queue entry must not make recovery ignore the actual completed Firstmate input and send it twice");assert.equal((await f.host.bb.storage.kv.get<{state:string}>(key))?.state,"delivered");
 }finally{await f.host.harness.lifecycle.dispose();f.restore();}
});

for(const restart of [false,true])test(`checker round12: confirmed-absence retry retains original intent time, restart=${restart}`,async()=>{
 const f=await checkerActualUnknown();const originalAt=f.record.at;const realNow=Date.now;let now=originalAt+60_000;Date.now=()=>now;let next;let active=f.host;let accepted=0;
 try{
  if(restart){next=await checkerReload(f.host,f.state.text);active=next;}active.harness.sdk.stub("threads.queuedMessages.list",async()=>[]);active.harness.sdk.stub("threads.events.list",async()=>[]);active.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_w1")accepted++;return {delivery:"queued"};});
  await active.harness.behavior.runSchedule("task-lifecycle");const afterAbsent=await active.bb.storage.kv.get(f.key);now+=60_000;await active.harness.behavior.runSchedule("task-lifecycle");const delivered=await active.bb.storage.kv.get<{at:number;state:string;marker:string}>(f.key);console.log("CHECKER R12 retry intent",JSON.stringify({restart,originalAt,afterAbsent,delivered,accepted}));assert.equal(accepted,1);assert.equal(delivered?.at,originalAt,"the original intent time must survive retry as required, rather than being discarded with the absent marker");
 }finally{Date.now=realNow;if(next)await next.harness.lifecycle.dispose();await f.host.harness.lifecycle.dispose();f.restore();}
});

// Round 13 journal shapes follow the installed BB server's persisted dispatch events.
function r13Input(record:unknown){return (record as {input:Array<{type:"text";text:string}>}).input;}
function r13Journal(content:Array<{type:"text";text:string}>,sender="thr_cap",initiator="agent",completed=false){
 const id="request-r13";
 const request={...checkerEvent(1,""),type:"client/turn/requested",data:{input:content.map((p,i)=>({...p,text:i===0?`[bb message from thread:${sender}]\n\n${p.text}`:p.text})),senderThreadId:sender,initiator,requestId:id}};
 const receipt=completed?{...checkerEvent(2,""),data:{providerThreadId:"provider-w1",item:{id:"r13-item",type:"userMessage",clientRequestId:id,content:request.data.input}}}:{...checkerEvent(2,""),type:"turn/input/accepted",scope:{kind:"turn",turnId:"turn-r13"},data:{clientRequestId:id,threadId:"thr_w1",providerThreadId:"provider-w1",scope:{kind:"turn",turnId:"turn-r13"}}};
 return [receipt,request];
}
for(const mode of ["genuine accepted","genuine completed","failed queue plus genuine accepted","owner nonce queue","owner nonce completed","owner quoted nonce queue","owner quoted nonce completed","other agent nonce","captain nonce only","owner copied full completed","other agent copied full completed","genuine raw queue"]){
 test(`checker round13: ${mode}`,async()=>{
 const f=await checkerActualUnknown();let sends=0;
 try{
  const record=await f.host.bb.storage.kv.get(f.key);const content=r13Input(record);let queue:unknown[]=[];let events:unknown[]=[];
  const nonce=[{type:"text" as const,text:f.marker}];
  if(mode.startsWith("genuine")&&mode!=="genuine raw queue")events=r13Journal(content,"thr_cap","agent",mode==="genuine completed");
  if(mode==="failed queue plus genuine accepted"){queue=[makeQueueEntry({threadId:"thr_w1",senderThreadId:"thr_cap",initiator:"agent",content,failureReason:"failed original queue"})];events=r13Journal(content);}
  if(mode==="owner nonce queue")queue=[makeQueueEntry({threadId:"thr_w1",senderThreadId:null,initiator:"user",origin:"app",originPluginId:null,content:nonce})];
  if(mode==="owner nonce completed")events=[checkerEvent(1,f.marker)];
  if(mode==="owner quoted nonce queue")queue=[makeQueueEntry({threadId:"thr_w1",senderThreadId:null,initiator:"user",content:[{type:"text",text:`Please inspect ${f.marker} before trying again.`}]})];
  if(mode==="owner quoted nonce completed")events=[checkerEvent(1,`Please inspect ${f.marker} before trying again.`)];
  if(mode==="other agent nonce")events=r13Journal([{type:"text",text:"Please inspect this delivery reference."},...nonce],"thr_other","agent");
  if(mode==="captain nonce only")events=r13Journal([{type:"text",text:"Please inspect this delivery reference."},...nonce]);
  if(mode==="owner copied full completed")events=[{...checkerEvent(2,""),data:{providerThreadId:"provider-w1",item:{id:"owner-input",type:"userMessage",clientRequestId:"owner-request",content}}},{...checkerEvent(1,""),type:"client/turn/requested",data:{initiator:"user",senderThreadId:null,requestId:"owner-request",input:content}}];
  if(mode==="other agent copied full completed")events=r13Journal(content,"thr_other","agent",true);
  if(mode==="genuine raw queue")queue=[makeQueueEntry({threadId:"thr_w1",senderThreadId:"thr_cap",initiator:"agent",origin:null,originPluginId:null,content})];
  f.host.harness.sdk.stub("threads.queuedMessages.list",async()=>queue);f.host.harness.sdk.stub("threads.events.list",async()=>events);f.host.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_w1")sends++;return {delivery:"queued"};});
  await f.host.harness.behavior.runSchedule("task-lifecycle");const actual=await f.host.bb.storage.kv.get<{state:string}>(f.key);const genuine=mode.startsWith("genuine")||mode==="failed queue plus genuine accepted";console.log("CHECKER R13",JSON.stringify({mode,actual,sends,pending:f.asks.pendingFollowUps().length}));assert.equal(sends,0);assert.equal(actual?.state,genuine?"delivered":"unknown",`only the genuine Firstmate answer can be confirmed: ${mode}`);
  if(!genuine){for(let i=0;i<7;i++)await f.host.harness.behavior.runSchedule("task-lifecycle");assert.ok(f.asks.failedFollowUps().some(j=>j.answerSeq===2&&j.attempts===8));assert.equal(checkerCrewSends(f.host).length,1);}
 }finally{await f.host.harness.lifecycle.dispose();f.restore();}
 });
}
for(const restart of [false,true])test(`checker round13: old nonce proves delivery after absent retry error and restart=${restart}`,async()=>{
 const f=await checkerActualUnknown();let next;let active=f.host;const original=await active.bb.storage.kv.get(f.key);const oldInput=r13Input(original);let sends=0;
 try{
  active.harness.sdk.stub("threads.queuedMessages.list",async()=>[]);active.harness.sdk.stub("threads.events.list",async()=>[]);active.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_w1"){sends++;throw new Error("retry response lost");}return {delivery:"queued"};});
  await active.harness.behavior.runSchedule("task-lifecycle");let after=await active.bb.storage.kv.get<{at:number;markers:string[];marker:string}>(f.key);assert.equal(sends,1);assert.equal(after?.at,f.record.at);assert.ok(after?.markers.includes(f.marker));assert.notEqual(after?.marker,f.marker);
  if(restart){next=await checkerReload(active,f.state.text);active=next;}
  active.harness.sdk.stub("threads.queuedMessages.list",async()=>[]);active.harness.sdk.stub("threads.events.list",async()=>r13Journal(oldInput));active.harness.sdk.stub("threads.send",async(input:{threadId:string})=>{if(input.threadId==="thr_w1")sends++;return {delivery:"queued"};});
  await active.harness.behavior.runSchedule("task-lifecycle");await active.harness.behavior.runSchedule("task-lifecycle");const final=await active.bb.storage.kv.get<{at:number;markers:string[];state:string}>(f.key);assert.equal(final?.state,"delivered");assert.equal(final?.at,f.record.at);assert.ok(final?.markers.includes(f.marker));assert.equal(sends,1);assert.equal(createOwnerAsks(active.bb.storage.database()).pendingFollowUps().length,0);
 }finally{if(next)await next.harness.lifecycle.dispose();await f.host.harness.lifecycle.dispose();f.restore();}
});

test("checker round3: failed prose-question notice is retried until a card can be made", async () => {
  const {host,tasks,asks,restore}=await captainHost({wait1:"needs-decision [key=choice]: Choose Postgres, MySQL or SQLite?\n"});
  let attempts=0;
  try {
    await host.bb.storage.kv.set("crews",[crewRow("wait1","thr_w1")]);
    const task=tasks.open({captain:"thr_cap",project:"Cyndra",title:"Database",sourceRefs:[],crewId:"wait1",at:Date.now()});
    host.harness.sdk.stub("threads.send",async (input: {input:unknown})=>{if(JSON.stringify(input).includes("CREW QUESTION:")){attempts++;throw new Error("temporary captain send failure");}return {delivery:"queued"};});
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.equal(attempts,1);
    host.harness.sdk.stub("threads.send",async (input: {input:unknown})=>{if(JSON.stringify(input).includes("CREW QUESTION:"))attempts++;return {delivery:"queued"};});
    await host.harness.behavior.runSchedule("task-lifecycle");
    console.log("CHECKER R3 prose handoff",JSON.stringify({attempts,cards:asks.listOpen("thr_cap").filter(ask=>ask.task===task.id).length,state:tasks.get(task.id)?.state}));
    assert.ok(attempts>=2,"a failed handoff must not consume the sole request to make the owner's card");
  } finally {restore();await host.harness.lifecycle.dispose();}
});
