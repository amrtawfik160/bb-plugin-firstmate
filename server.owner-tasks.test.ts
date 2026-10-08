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
      "- T1 Areliaa · Metricool fix · 30 h · [app#1759](https://github.com/acme/app/pull/1759) on hold (do not merge) · stale 30 h",
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
