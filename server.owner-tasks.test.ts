import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createInboundLedger } from "./lib/inbound-ledger.ts";
import { createOwnerTasks } from "./lib/owner-tasks.ts";
import { createDeliveries } from "./lib/pr-delivery.ts";

type Host = ReturnType<typeof createFakePluginHost>;

const MIN = 60_000;
const HOUR = 60 * MIN;
const capCtx = { threadId: "thr_cap", projectId: "proj_1" } as never;
const envelope = readFileSync(new URL("./test/fixtures/envelopes/live-owner.txt", import.meta.url), "utf8");

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

function tool(host: Host, name: string) {
  const found = host.harness.inspection.registrations.agentTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not registered`);
  return found!;
}

function text(result: unknown): string {
  const raw = typeof result === "string" ? result : (result as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("\n");
  // The host appends an invisible marker to tool results.
  return raw.replace(/[\s\u2061-\u2064]+$/u, "");
}

const isError = (result: unknown) => typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;

/** The Telegram connector hands an owner message to the captain thread. */
const ownerSays = (host: Host, messageId: string, words: string) => host.harness.inspection.registrations.hooks["message.dispatch"]!({
  thread: makeThreadResponse({ id: "thr_cap", status: "active" }),
  attempt: "join-turn", initiator: "user", senderThreadId: null, queuedMessages: [],
  input: { blocks: [], text: envelope.replace("telegram_message_id: 1669", `telegram_message_id: ${messageId}`).replace("Status?", words) },
} as never);

/** A crew's doorbell starts the next captain turn. */
const crewPings = (host: Host) => host.harness.inspection.registrations.hooks["message.dispatch"]!({
  thread: makeThreadResponse({ id: "thr_cap", status: "idle" }),
  attempt: "start-turn", initiator: "agent", senderThreadId: null, queuedMessages: [],
  input: { blocks: [], text: "crew c9 finished" },
} as never);

const dispatch = (host: Host, input: Record<string, unknown>) =>
  tool(host, "firstmate_dispatch").execute({ projectId: "proj_1", ...input }, capCtx);
const board = async (host: Host) => (await host.harness.behavior.callRpc("telegramCommand", { command: "board", threadId: "thr_cap" }) as { text: string }).text;

test("Oct 7 repro: a reply of only 'Started' answered the owner message, and now the task stays on the board until it closes", async () => {
  const host = await captainHost();
  try {
    await ownerSays(host, "2201", "Fix the Metricool sync, posts stopped publishing");
    const dispatched = await dispatch(host, { task: "Fix the Metricool sync", taskId: "metricool-fix", title: "Fix the Metricool sync", sourceRefs: ["tg:200:2201"] });
    assert.equal(text(dispatched), "Reserved crew metricool-fix. Spawn continues in the background. Owner task T1 tracks it until it is merged, live, done, or dropped; a reply does not close it.");
    const replied = await tool(host, "firstmate_reply").execute({ ref: "tg:200:2201", text: "Started the Metricool fix." }, capCtx);
    assert.ok(!isError(replied), text(replied));
    // The reply is a fact about the message: it counts as answered and leaves the inbox.
    assert.equal(createInboundLedger(host.bb.storage.database()).get({ source: "telegram", chatId: "200", messageId: "2201" })?.state, "answered");
    assert.equal(text(await tool(host, "firstmate_inbox").execute({}, capCtx)), "No owner message is waiting.");
    assert.match(text(replied), /\nTask T1 stays open \(working\): a reply does not close it\./);
    // The task is a separate fact: it is still open.
    assert.equal(await board(host), [
      "📌 Needs you: nothing right now.",
      "",
      "✅ Done since you last looked: nothing new.",
      "",
      "🔧 In progress (1)",
      "- T1 Areliaa · Fix the Metricool sync · 0 min",
    ].join("\n"));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a dispatch in a turn started by an owner message must carry that message's ref or name another origin", async () => {
  const host = await captainHost();
  try {
    await ownerSays(host, "2202", "Run the Brands audit");
    const refused = await dispatch(host, { task: "Run the Brands audit" });
    assert.ok(isError(refused));
    assert.equal(text(refused), 'This turn started from owner message tg:200:2202. If this job is the owner\'s, pass sourceRefs: ["tg:200:2202"]. If it came from elsewhere, pass origin: {"kind":"thread","threadId":"<thread>"} or {"kind":"captain","reason":"<why>"}.');
    assert.equal(host.harness.sdk.callsTo("threads.spawn").length, 0);
    await crewPings(host);
    const after = await dispatch(host, { task: "Rebase the docs branch", taskId: "docs-rebase" });
    assert.equal(text(after), "Reserved crew docs-rebase. Spawn continues in the background.", "a turn a crew started needs no owner ref");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("Oct 7 repro: one owner message with two jobs opens two tasks, each titled by its own dispatch", async () => {
  const host = await captainHost();
  try {
    await ownerSays(host, "2215", "Five Safi jobs: debts in Arrange home, the glass glitch, ...");
    const first = await dispatch(host, { task: "Show debts in Arrange home items", taskId: "safi-arrange-debts", title: "Safi: debts in Arrange home items", sourceRefs: ["tg:200:2215"] });
    const second = await dispatch(host, { task: "Research then fix the Apple glass glitch", taskId: "safi-glass-glitch", title: "Safi: Apple glass glitch", sourceRefs: ["tg:200:2215"] });
    assert.match(text(first), /Owner task T1 tracks it/);
    assert.match(text(second), /Owner task T2 tracks it/);
    assert.equal(await board(host), [
      "📌 Needs you: nothing right now.",
      "",
      "✅ Done since you last looked: nothing new.",
      "",
      "🔧 In progress (2)",
      "- T1 Areliaa · Safi: debts in Arrange home items · 0 min",
      "- T2 Areliaa · Safi: Apple glass glitch · 0 min",
    ].join("\n"));
    const tasks = createOwnerTasks(host.bb.storage.database());
    assert.equal(tasks.open({ captain: "thr_cap", project: "Areliaa", title: "Retry", sourceRefs: ["tg:200:2215"], crewId: "safi-glass-glitch", at: Date.now() }).id, "T2", "a retried dispatch keeps its task");
    assert.deepEqual(tasks.list("thr_cap").map((task) => [task.id, task.crewIds]), [["T1", ["safi-arrange-debts"]], ["T2", ["safi-glass-glitch"]]]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("Oct 7 repro: in an owner turn, a job another thread asked for names its origin and opens no owner task", async () => {
  const host = await captainHost();
  try {
    await ownerSays(host, "2215", "Five Safi jobs: debts in Arrange home, the glass glitch, ...");
    const deploy = await dispatch(host, { task: "Deploy and merge #2155 then #2156", taskId: "deploy-2155-2156", title: "Deploy + merge #2155 then #2156", origin: { kind: "thread", threadId: "thr_u6n35axzg5" } });
    assert.equal(text(deploy), "Reserved crew deploy-2155-2156. Spawn continues in the background.");
    assert.equal(await board(host), [
      "📌 Needs you: nothing right now.",
      "",
      "✅ Done since you last looked: nothing new.",
      "",
      "🔧 In progress: nothing open.",
    ].join("\n"));
    await dispatch(host, { task: "Show debts in Arrange home items", taskId: "safi-arrange-debts", title: "Safi: debts in Arrange home items", sourceRefs: ["tg:200:2215"] });
    assert.equal(await board(host), [
      "📌 Needs you: nothing right now.",
      "",
      "✅ Done since you last looked: nothing new.",
      "",
      "🔧 In progress (1)",
      "- T1 Areliaa · Safi: debts in Arrange home items · 0 min",
    ].join("\n"));
    const captainOwn = await dispatch(host, { task: "Clean the host disk", taskId: "disk-clean", origin: { kind: "captain", reason: "routine upkeep" } });
    assert.equal(text(captainOwn), "Reserved crew disk-clean. Spawn continues in the background.");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("the task follows its crew's PR: ready to merge needs the owner, then merged moves it to Done", async () => {
  const host = await captainHost();
  try {
    await ownerSays(host, "2204", "Add the memory screen");
    await dispatch(host, { task: "Add the memory screen", taskId: "memory-screen", title: "Memory screen", sourceRefs: ["tg:200:2204"] });
    const store = createDeliveries(host.bb.storage.database());
    const pr = store.register({ url: "https://github.com/acme/app/pull/2091", taskId: "memory-screen", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_new", title: "Memory screen" });
    store.save({ ...pr, status: "ready-to-merge" });
    assert.equal(await board(host), [
      "📌 Needs you (1)",
      "1. T1 Areliaa · Memory screen · ready for you · 0 min · [app#2091](https://github.com/acme/app/pull/2091) ready to merge",
      "",
      "✅ Done since you last looked: nothing new.",
      "",
      "🔧 In progress: nothing open.",
    ].join("\n"));
    store.save({ ...store.get("acme/app#2091")!, status: "complete", forgeState: "merged", mergeCommitSha: "m1" });
    assert.equal(await board(host), [
      "📌 Needs you: nothing right now.",
      "",
      "✅ Done since you last looked (1)",
      "- T1 Areliaa · Memory screen · merged",
      "",
      "🔧 In progress: nothing open.",
    ].join("\n"));
    const task = createOwnerTasks(host.bb.storage.database()).get("T1")!;
    assert.deepEqual([task.state, task.prs], ["merged", ["acme/app#2091"]]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("recorded merge verification moves a task to live", async () => {
  const host = await captainHost();
  try {
    await ownerSays(host, "2205", "Ship agent group chats part 2");
    await dispatch(host, { task: "Agent group chats part 2", taskId: "group-chats-2", sourceRefs: ["tg:200:2205"], deliveryRequirement: "merged-and-verified" });
    const store = createDeliveries(host.bb.storage.database());
    const pr = store.register({ url: "https://github.com/acme/app/pull/2116", taskId: "group-chats-2", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_new", requirement: "merged-and-verified" });
    store.save({ ...pr, status: "merged-needs-verification", forgeState: "merged", mergeCommitSha: "m2" });
    await board(host);
    assert.equal(createOwnerTasks(host.bb.storage.database()).get("T1")?.state, "merged");
    store.save({ ...store.get("acme/app#2116")!, status: "complete", verifiedCommitSha: "m2" });
    await board(host);
    assert.equal(createOwnerTasks(host.bb.storage.database()).get("T1")?.state, "live");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_task drops a task only with a reason, and a closed task never reopens", async () => {
  const host = await captainHost();
  try {
    const task = tool(host, "firstmate_task");
    assert.equal(text(await task.execute({ action: "open", title: "Check the Brands audit", refs: ["tg:200:2206"] }, capCtx)), "Task T1 is open (working).");
    const noReason = await task.execute({ action: "close", id: "T1", state: "dropped" }, capCtx);
    assert.ok(isError(noReason));
    assert.equal(text(noReason), "Dropping task T1 needs a reason.");
    assert.equal(text(await task.execute({ action: "close", id: "T1", state: "dropped", reason: "Owner moved the audit to next week" }, capCtx)), "Task T1 is dropped (Owner moved the audit to next week).");
    const reopen = await task.execute({ action: "set", id: "T1", state: "working" }, capCtx);
    assert.equal(text(reopen), "Task T1 is dropped; it cannot become working.");
    assert.equal(text(await task.execute({ action: "list" }, capCtx)), "No owner task is open.");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("the board flags a task with no update for 24 hours as stale", async () => {
  const host = await captainHost();
  try {
    const tasks = createOwnerTasks(host.bb.storage.database());
    tasks.open({ captain: "thr_cap", project: "Areliaa", title: "Metricool fix", sourceRefs: ["tg:200:2101"], backfilled: true, at: Date.now() - 30 * HOUR });
    tasks.open({ captain: "thr_cap", project: null, title: "Brands audit", sourceRefs: ["tg:200:2102"], at: Date.now() - 2 * HOUR });
    tasks.open({ captain: "thr_other", project: null, title: "Not mine", sourceRefs: ["tg:200:2103"], at: Date.now() });
    assert.equal(await board(host), [
      "📌 Needs you: nothing right now.",
      "",
      "✅ Done since you last looked: nothing new.",
      "",
      "🔧 In progress (2)",
      "- T1 Areliaa · Metricool fix · 30 h · stale 30 h",
      "- T2 Brands audit · 2 h",
    ].join("\n"));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

const command = async (host: Host, input: Record<string, unknown>) =>
  (await host.harness.behavior.callRpc("telegramCommand", { threadId: "thr_cap", ...input }) as { text: string }).text;

test("the board and the digest read closed tasks and PRs merged since the owner last looked", async () => {
  const host = await captainHost();
  try {
    const tasks = createOwnerTasks(host.bb.storage.database());
    const store = createDeliveries(host.bb.storage.database());
    tasks.open({ captain: "thr_cap", project: "Areliaa", title: "Metricool fix", sourceRefs: ["tg:200:2301"], crewId: "metricool-fix", prs: ["acme/app#1759"], at: Date.now() - 30 * HOUR });
    tasks.open({ captain: "thr_cap", project: null, title: "Brands audit", sourceRefs: ["tg:200:2302"], at: Date.now() - 2 * HOUR });
    tasks.move("T2", "thr_cap", { to: "dropped", reason: "Owner moved it to next week" }, Date.now() - HOUR);
    const held = store.register({ url: "https://github.com/acme/app/pull/1759", taskId: "metricool-fix", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_new" });
    store.save({ ...held, status: "on-hold" });
    const unlinked = store.register({ url: "https://github.com/acme/app/pull/283", taskId: "c9", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_c9", title: "Bump the email template" });
    store.save({ ...unlinked, status: "complete", forgeState: "merged", mergeCommitSha: "m9", updatedAt: Date.now() - 2 * HOUR });
    const old = store.register({ url: "https://github.com/acme/app/pull/270", taskId: "c8", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_c8" });
    store.save({ ...old, status: "complete", forgeState: "merged", mergeCommitSha: "m8", updatedAt: Date.now() - 26 * HOUR });
    const text = await board(host);
    assert.deepEqual(text.split("\n\n").map((section) => section.split("\n")[0]), ["📌 Needs you: nothing right now.", "✅ Done since you last looked (2)", "🔧 In progress (1)"]);
    assert.equal(text, [
      "📌 Needs you: nothing right now.",
      "",
      "✅ Done since you last looked (2)",
      "- T2 Brands audit · dropped: Owner moved it to next week",
      "- PR [app#283](https://github.com/acme/app/pull/283) Bump the email template · merged",
      "",
      "🔧 In progress (1)",
      "- T1 Areliaa · Metricool fix · 30 h · [app#1759](https://github.com/acme/app/pull/1759) on hold · stale 30 h",
    ].join("\n"));
    assert.match(await command(host, { command: "board", since: Date.now() - 30 * HOUR }), /\n- PR \[app#270\]\(https:\/\/github\.com\/acme\/app\/pull\/270\) /, "an older since brings back older merges");
    assert.equal(await command(host, { command: "digest" }), [
      "Done (2)",
      "- T2 Brands audit · dropped: Owner moved it to next week",
      "- PR app#283 Bump the email template · merged",
      "",
      "Stale (1): T1",
    ].join("\n"));
    tasks.move("T1", "thr_cap", { to: "done" }, Date.now() - 20 * HOUR);
    assert.equal(await command(host, { command: "digest", since: Date.now() - 10 * MIN }), "");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

/** A crew row the captain registered, and the thread state forget reads. */
async function seedCrew(host: Host, id: string, output: string) {
  const crews = ((await host.bb.storage.kv.get("crews")) as unknown[] | undefined) ?? [];
  await host.bb.storage.kv.set("crews", [...crews, { id, task: id, projectId: "proj_1", threadId: `thr_${id}`, parentThreadId: "thr_cap", providerId: null, model: null, reasoningLevel: null, worktree: true, shape: "scout", posture: "direct-PR", createdAt: "2026-10-07T20:00:00.000Z" }]);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_1", status: "idle", environmentId: null }));
  host.harness.sdk.stub("threads.output", async () => ({ output }));
  host.harness.sdk.stub("threads.stop", async () => ({}));
  host.harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
}

const forget = async (host: Host, crewId: string) => {
  const result = await host.harness.behavior.runCli(["forget", crewId], { threadId: "thr_cap" });
  assert.equal(result.exitCode, 0, result.stderr);
};

test("Oct 8 repro: a crew that reports done closes its task, and one retired without a report asks for a check", async () => {
  const host = await captainHost();
  try {
    const tasks = createOwnerTasks(host.bb.storage.database());
    tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Partner onboarding guide (PDF)", sourceRefs: ["tg:200:2192"], crewId: "partner-guide", at: Date.now() - 4 * HOUR });
    tasks.open({ captain: "thr_cap", project: "Areliaa", title: "Deploy + verify the offers live", sourceRefs: ["tg:200:2204"], crewId: "offers-verify", at: Date.now() - 2 * HOUR });
    await seedCrew(host, "partner-guide", "DONE: sent cyndra-partner-onboarding-guide.pdf to the owner");
    await forget(host, "partner-guide");
    host.harness.sdk.stub("threads.output", async () => ({ output: "Still reading the deploy logs" }));
    await seedCrew(host, "offers-verify", "Still reading the deploy logs");
    await forget(host, "offers-verify");
    assert.equal(await board(host), [
      "📌 Needs you (1)",
      "1. T2 Areliaa · Deploy + verify the offers live · finished, check · 2 h",
      "",
      "✅ Done since you last looked (1)",
      "- T1 Cyndra · Partner onboarding guide (PDF) · done",
      "",
      "🔧 In progress: nothing open.",
    ].join("\n"));
    assert.equal(tasks.get("T1")!.outcome, "DONE: sent cyndra-partner-onboarding-guide.pdf to the owner");
    assert.equal(tasks.get("T2")!.outcome, "Crew retired without reporting done");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("Oct 8 repro: a follow-up dispatch with taskRef continues T8, clears its needs-you, and opens no new task", async () => {
  const host = await captainHost();
  try {
    const tasks = createOwnerTasks(host.bb.storage.database());
    tasks.open({ captain: "thr_cap", project: "Cyndra", title: "QA fixes: about 12 small polish items", sourceRefs: ["tg:200:1838"], at: Date.now() - 15 * HOUR });
    tasks.move("T1", "thr_cap", { to: "needs_you", reason: "Asked for the polish list" }, Date.now() - 3 * HOUR);
    await ownerSays(host, "2221", "Find the polish items yourself and fix them");
    const missing = await dispatch(host, { task: "Find and fix the QA polish items", taskId: "t8-polish-qa", taskRef: "T9" });
    assert.equal(text(missing), "No owner task T9 for this captain. Check firstmate_task list.");
    const joined = await dispatch(host, { task: "Find and fix the QA polish items", taskId: "t8-polish-qa", title: "Cyndra T8: find + fix QA polish items", taskRef: "T1" });
    assert.equal(text(joined), "Reserved crew t8-polish-qa. Spawn continues in the background. Owner task T1 (working) tracks it; no new task was opened.");
    assert.deepEqual(tasks.list("thr_cap", { includeClosed: true }).map((task) => [task.id, task.state, task.crewIds, task.sourceRefs]), [["T1", "working", ["t8-polish-qa"], ["tg:200:1838", "tg:200:2221"]]]);
    const store = createDeliveries(host.bb.storage.database());
    const pr = store.register({ url: "https://github.com/cyndra-ai/cyndra-saas/pull/2159", taskId: "t8-polish-qa", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_new" });
    store.save({ ...pr, status: "complete", forgeState: "merged", mergeCommitSha: "m1" });
    assert.equal(await board(host), [
      "📌 Needs you: nothing right now.",
      "",
      "✅ Done since you last looked (1)",
      "- T1 Cyndra · QA fixes: about 12 small polish items · merged",
      "",
      "🔧 In progress: nothing open.",
    ].join("\n"));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("Oct 8 repro: a deploy dispatch for a PR another task holds joins that task instead of opening a second one", async () => {
  const host = await captainHost();
  try {
    const tasks = createOwnerTasks(host.bb.storage.database());
    const store = createDeliveries(host.bb.storage.database());
    tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Perf 4: billing contention", sourceRefs: ["tg:200:2235"], crewId: "perf-4-billing", prs: ["cyndra-ai/cyndra-saas#2162"], at: Date.now() - HOUR });
    const pr = store.register({ url: "https://github.com/cyndra-ai/cyndra-saas/pull/2162", taskId: "perf-4-billing", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_p4" });
    store.save({ ...pr, status: "waiting-native-gates" });
    await ownerSays(host, "2243", "Approved, deploy it");
    const deploy = await dispatch(host, {
      task: "Deploy https://github.com/Cyndra-AI/cyndra-saas/pull/2162 to production, then merge it", taskId: "deploy-2162-billing",
      title: "Deploy + merge #2162 billing (owner approved)", sourceRefs: ["tg:200:2243"],
    });
    assert.equal(text(deploy), "Reserved crew deploy-2162-billing. Spawn continues in the background. Owner task T1 (working) tracks it; no new task was opened.");
    assert.deepEqual(tasks.list("thr_cap").map((task) => [task.id, task.crewIds]), [["T1", ["perf-4-billing", "deploy-2162-billing"]]]);
    assert.equal(await board(host), [
      "📌 Needs you: nothing right now.",
      "",
      "✅ Done since you last looked: nothing new.",
      "",
      "🔧 In progress (1)",
      "- T1 Cyndra · Perf 4: billing contention · 1 h · [cyndra-saas#2162](https://github.com/cyndra-ai/cyndra-saas/pull/2162) ready to merge",
    ].join("\n"));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("Oct 8 repro: one project name per project, and a title does not repeat it", async () => {
  const host = await captainHost();
  try {
    host.harness.sdk.stub("projects.get", async () => ({ id: "proj_1", name: "Cyndra SaaS", kind: "repo" }));
    const tasks = createOwnerTasks(host.bb.storage.database());
    tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Audit the brands", sourceRefs: ["tg:200:1592"], at: Date.now() - HOUR });
    tasks.open({ captain: "thr_cap", project: "Safi", title: "Safi: legend dashes to the right", sourceRefs: ["tg:200:2249"], at: Date.now() - HOUR });
    tasks.open({ captain: "thr_cap", project: "Areliaa", title: "Areliaa fixes: order numbers, refund amount", sourceRefs: ["tg:200:1602"], at: Date.now() - HOUR });
    await ownerSays(host, "2192", "Write the partner onboarding guide as a PDF");
    await dispatch(host, { task: "Write the partner onboarding guide", taskId: "partner-guide", title: "Cyndra: partner onboarding guide (PDF)", sourceRefs: ["tg:200:2192"] });
    assert.equal(await board(host), [
      "📌 Needs you: nothing right now.",
      "",
      "✅ Done since you last looked: nothing new.",
      "",
      "🔧 In progress (4)",
      "- T1 Cyndra · Audit the brands · 1 h",
      "- T2 Safi · Legend dashes to the right · 1 h",
      "- T3 Areliaa · Fixes: order numbers, refund amount · 1 h",
      "- T4 Cyndra · Partner onboarding guide (PDF) · 0 min",
    ].join("\n"));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("Oct 8 repro: a research crew that ends its turn with DONE closes its task before anyone retires it", async () => {
  const host = await captainHost();
  try {
    const tasks = createOwnerTasks(host.bb.storage.database());
    tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Performance research (Astra)", sourceRefs: ["tg:200:2232"], crewId: "perf-research", at: Date.now() - HOUR });
    await seedCrew(host, "perf-research", "DONE: plan with 7 fixes sent to the captain");
    const emitted = await host.harness.behavior.emitThreadEvent("thread.idle", {
      thread: makeThreadResponse({ id: "thr_perf-research", status: "idle", projectId: "proj_1" }),
      lastAssistantText: "DONE: plan with 7 fixes sent to the captain",
    });
    assert.deepEqual(emitted.errors, []);
    assert.equal(await board(host), [
      "📌 Needs you: nothing right now.",
      "",
      "✅ Done since you last looked (1)",
      "- T1 Cyndra · Performance research (Astra) · done",
      "",
      "🔧 In progress: nothing open.",
    ].join("\n"));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a dispatch naming an open task in title or task joins it unless taskRef overrides it", async () => {
  for (const field of ["title", "task"] as const) {
    const host = await captainHost();
    try {
      const tasks = createOwnerTasks(host.bb.storage.database());
      tasks.open({ captain: "thr_cap", project: "Areliaa", title: "Brand audit", sourceRefs: ["tg:200:1"], at: 1 });
      tasks.open({ captain: "thr_cap", project: "Areliaa", title: "Group chats", sourceRefs: ["tg:200:2"], at: 2 });
      await dispatch(host, { task: "Continue the work", title: "Follow-up", taskId: "restart-named", origin: { kind: "captain", reason: "Restart stale work" }, [field]: "Restart T1" });
      assert.deepEqual(tasks.get("T1")?.crewIds, ["restart-named"]);
      assert.equal(tasks.list("thr_cap").length, 2);
      await dispatch(host, { task: "Restart T1", taskId: "explicit-ref", taskRef: "T2", origin: { kind: "captain", reason: "Use the correct task" } });
      assert.deepEqual(tasks.get("T2")?.crewIds, ["explicit-ref"]);
      assert.equal(tasks.list("thr_cap").length, 2);
    } finally { await host.harness.lifecycle.dispose(); }
  }
});
