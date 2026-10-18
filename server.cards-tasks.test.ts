import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
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
    const payload = crew !== undefined && status[crew] !== undefined ? status[crew] : "";
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
    const out = text(await tool(host, "firstmate_ask").execute({ question: "Johan draft: send v2 in the Jess group?", kind: "approval", options: [{ label: "Send" }, { label: "Wait" }], task: task.id }, ctx));
    const id = /Ask (a[0-9a-z]{6}) is open/.exec(out)![1]!;
    assert.match(out, new RegExp(`It replaces card ${old.id}, now marked replaced`));
    assert.deepEqual([asks.get(old.id)!.state, asks.get(old.id)!.resolution], ["cancelled", `Replaced by card ${id}`]);
    assert.deepEqual(rpc.filter((call) => call.method === "editAsk").map((call) => [call.input.askId, call.input.resolution]), [[old.id, `Replaced by card ${id}`]]);
    const pack = text(await tool(host, "firstmate_ask").execute({ question: "Johan draft: attach the deck too?", kind: "question", options: [{ label: "Yes" }, { label: "No" }], task: task.id }, ctx));
    assert.doesNotMatch(pack, /replaces card/);
    assert.equal(asks.get(id)!.state, "open");
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

test("the task sweep moves done reports to the captain's check, opens a card for a crew that waits on the owner, and flags a task with no crew once", async () => {
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
    const card = asks.listOpen("thr_cap").find((ask) => ask.task === tWait.id)!;
    assert.match(card.text, /waiting for owner answers to N4-N7/);
    assert.equal(card.project, "Cyndra");
    assert.equal(rpc.filter((call) => call.method === "ask" && call.input.askId === card.id).length, 1);
    const flags = () => host.harness.sdk.callsTo("threads.send").map((call) => JSON.stringify(call[0])).filter((m) => m.includes("TASK WITHOUT CREW"));
    assert.equal(flags().length, 1);
    assert.match(flags()[0]!, new RegExp(`task ${t200.id} \\(Fix Humza's 4 Cyndra bugs\\)`));
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.equal(flags().length, 1, "flagged once");
    assert.equal(asks.listOpen("thr_cap").filter((ask) => ask.task === tWait.id).length, 1, "one card per crew question");
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
    asks.create({ captain: "thr_cap", kind: "question", text: "PR #6: the repo is gone. What should we do?", options: [], createdAt: at * 1000 + 60_000, project: "Cyndra", task: task.id });
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.equal(asks.listOpen("thr_cap").length, 1, "no second card");
    assert.equal(rpc.filter((call) => call.method === "ask").length, 0);
    assert.equal(tasks.get(task.id)!.state, "needs_you", "the task still shows it waits on the owner");
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

// Checker FF2-verdict-1, #145 finding 1: a newer card about other work does not stand for the crew's question.
test("a newer card on another task or project does not stop the crew's own question card", async () => {
  const at = Math.floor(Date.now() / 1000) - 600;
  const { host, tasks, asks, restore } = await captainHost({ wait1: `blocked [at=${at}]: need owner to restore the repo\n` });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_w1")]);
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Slug max", sourceRefs: ["tg:1:1"], crewId: "wait1", at: Date.now() });
    asks.create({ captain: "thr_cap", kind: "question", text: "Safi icon: blue or green?", options: [], createdAt: at * 1000 + 60_000, project: "Safi" });
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.equal(asks.listOpen("thr_cap").filter((ask) => ask.task === task.id).length, 1, "exactly one card for the Cyndra question");
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
test("a newer standalone card on the same project does not suppress a crew's question card", async () => {
  const at = Math.floor(Date.now() / 1000) - 600;
  const { host, tasks, asks, restore } = await captainHost({ wait1: `blocked [at=${at}]: need owner to restore its repo\n` });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_w1")]);
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Slug max", sourceRefs: ["tg:1:1"], crewId: "wait1", at: Date.now() });
    asks.create({ captain: "thr_cap", kind: "question", text: "Cyndra icons: outline or filled?", options: [], createdAt: at * 1000 + 60_000, project: "Cyndra" });
    await host.harness.behavior.runSchedule("task-lifecycle");
    assert.equal(asks.listOpen("thr_cap").filter((ask) => ask.task === task.id).length, 1, "the crew's own card goes out");
    assert.equal(asks.listOpen("thr_cap").length, 2, "both cards stay open");
  } finally { restore(); await host.harness.lifecycle.dispose(); }
});

test("closeAsk releases only its crew's native captain hold without changing the task", async () => {
  const at = Math.floor(Date.now() / 1000) - 60;
  const { host, tasks, asks, commands, restore } = await captainHost({ wait1: `needs-decision [key=pick-one] [at=${at}]: Choose a database?\n` });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_w1")]);
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Database", sourceRefs: [], crewId: "wait1", at: Date.now() });
    await host.harness.behavior.runSchedule("task-lifecycle");
    const card = asks.listOpen("thr_cap")[0]!;
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
    tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Choose", sourceRefs: [], crewId: "wait1", at: Date.now() });
    await host.harness.behavior.runSchedule("task-lifecycle");
    const card = asks.listOpen("thr_cap")[0]!;
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
    tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Choose", sourceRefs: [], crewId: "wait1", at: Date.now() });
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
