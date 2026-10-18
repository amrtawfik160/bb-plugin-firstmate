import assert from "node:assert/strict";
import { stubProviderCatalog } from "./test/provider-catalog.mjs";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFakePluginHost, makePluginAgentConfigurationContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { manifestSkillIds } from "./scripts/plugin-skill-fixture.mjs";
import { createInboundLedger } from "./lib/inbound-ledger.ts";
import { createOwnerTasks } from "./lib/owner-tasks.ts";
import { createDeliveries } from "./lib/pr-delivery.ts";
import { createQualityEvents } from "./lib/quality-events.ts";

type Host = ReturnType<typeof createFakePluginHost>;

const MIN = 60_000;
const HOUR = 60 * MIN;
const capCtx = { threadId: "thr_cap", projectId: "proj_1" } as never;
const envelope = readFileSync(new URL("./test/fixtures/envelopes/live-owner.txt", import.meta.url), "utf8");

async function captainHost() {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: manifestSkillIds(new URL(".", import.meta.url).pathname) });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await plugin(host.bb); stubProviderCatalog(host);
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
    const replied = await tool(host, "firstmate_reply").execute({ noWork: true, ref: "tg:200:2201", text: "Started the Metricool fix." }, capCtx);
    assert.ok(!isError(replied), text(replied));
    // The reply is a fact about the message: it counts as answered and leaves the inbox.
    assert.equal(createInboundLedger(host.bb.storage.database()).get({ source: "telegram", chatId: "200", messageId: "2201" })?.state, "answered");
    assert.equal(text(await tool(host, "firstmate_inbox").execute({}, capCtx)), "No owner message is waiting.");
    assert.match(text(replied), /\nTask T1 stays open \(working\): a reply does not close it\./);
    // The task is a separate fact: it is still open.
    assert.equal(await board(host), [
      "📌 Needs you: nothing right now.",
      "",
      "✅ Finished since you last looked: nothing new.",
      "",
      "🚀 Not live yet: nothing merged waits to go live.",
      "",
      "🔧 In progress (1)",
      "- T1 Areliaa · Fix the Metricool sync · 0 min",
    ].join("\n"));
    // The connector's per-project board counts the crews working on each project.
    assert.deepEqual((await host.harness.behavior.callRpc("telegramCommand", { command: "board", threadId: "thr_cap" }) as { projects?: unknown }).projects, [{ name: "Areliaa", working: 1 }]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a dispatch in an owner-started turn without the owner's ref or another origin opens a task linked to that turn's message", async () => {
  const host = await captainHost();
  try {
    await ownerSays(host, "2202", "Run the Brands audit");
    const untagged = await dispatch(host, { task: "Run the Brands audit", taskId: "brands-audit" });
    assert.ok(!isError(untagged), text(untagged));
    assert.equal(text(untagged), "Reserved crew brands-audit. Spawn continues in the background. Owner task T1 tracks it until it is merged, live, done, or dropped; a reply does not close it. It is linked to this turn's owner message tg:200:2202; pass sourceRefs, taskRef or origin to say otherwise.");
    assert.deepEqual(createOwnerTasks(host.bb.storage.database()).list("thr_cap").map((task) => task.sourceRefs), [["tg:200:2202"]]);
    await crewPings(host);
    const after = await dispatch(host, { task: "Rebase the docs branch", taskId: "docs-rebase" });
    assert.equal(text(after), "Reserved crew docs-rebase. Spawn continues in the background. Owner task T2 tracks it until it is merged, live, done, or dropped; a reply does not close it.", "a turn a crew started needs no owner ref, and its crew is still on a task");
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
      "✅ Finished since you last looked: nothing new.",
      "",
      "🚀 Not live yet: nothing merged waits to go live.",
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

test("Oct 7 repro: in an owner turn, a job another thread asked for names its origin and opens its own task, not linked to the owner's message", async () => {
  const host = await captainHost();
  try {
    await ownerSays(host, "2215", "Five Safi jobs: debts in Arrange home, the glass glitch, ...");
    const deploy = await dispatch(host, { task: "Deploy and merge #2155 then #2156", taskId: "deploy-2155-2156", title: "Deploy + merge #2155 then #2156", origin: { kind: "thread", threadId: "thr_u6n35axzg5" } });
    assert.equal(text(deploy), "Reserved crew deploy-2155-2156. Spawn continues in the background. Owner task T1 tracks it until it is merged, live, done, or dropped; a reply does not close it.");
    await dispatch(host, { task: "Show debts in Arrange home items", taskId: "safi-arrange-debts", title: "Safi: debts in Arrange home items", sourceRefs: ["tg:200:2215"] });
    assert.equal(await board(host), [
      "📌 Needs you: nothing right now.",
      "",
      "✅ Finished since you last looked: nothing new.",
      "",
      "🚀 Not live yet: nothing merged waits to go live.",
      "",
      "🔧 In progress (2)",
      "- T1 Areliaa · Deploy + merge #2155 then #2156 · 0 min",
      "- T2 Areliaa · Safi: debts in Arrange home items · 0 min",
    ].join("\n"));
    const captainOwn = await dispatch(host, { task: "Clean the host disk", taskId: "disk-clean", origin: { kind: "captain", reason: "routine upkeep" } });
    assert.equal(text(captainOwn), "Reserved crew disk-clean. Spawn continues in the background. Owner task T3 tracks it until it is merged, live, done, or dropped; a reply does not close it.");
    assert.deepEqual(createOwnerTasks(host.bb.storage.database()).list("thr_cap").map((task) => [task.id, task.sourceRefs]), [["T1", []], ["T2", ["tg:200:2215"]], ["T3", []]], "an origin job never takes the owner's message");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("the task follows its crew's PR: ready to merge needs the owner, then merged moves it to Not live yet, never to Finished", async () => {
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
      "✅ Finished since you last looked: nothing new.",
      "",
      "🚀 Not live yet: nothing merged waits to go live.",
      "",
      "🔧 In progress: nothing open.",
    ].join("\n"));
    store.save({ ...store.get("acme/app#2091")!, status: "complete", forgeState: "merged", mergeCommitSha: "m1" });
    assert.equal(await board(host), [
      "📌 Needs you: nothing right now.",
      "",
      "✅ Finished since you last looked: nothing new.",
      "",
      "🚀 Not live yet (1)",
      "- T1 Areliaa · Memory screen · merged 0 min ago · next: deploy it with Coolify · the captain",
      "",
      "🔧 In progress: nothing open.",
    ].join("\n"));
    const task = createOwnerTasks(host.bb.storage.database()).get("T1")!;
    assert.deepEqual([task.state, task.prs], ["merged", ["acme/app#2091"]]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("recorded merge verification is not production: the task stays merged until its project's live check", async () => {
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
    assert.equal(createOwnerTasks(host.bb.storage.database()).get("T1")?.state, "merged");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_task drops a task only with the owner's words and ref, makes it live only with evidence, and never reopens a finished one by hand", async () => {
  const host = await captainHost();
  try {
    const task = tool(host, "firstmate_task");
    assert.equal(text(await task.execute({ action: "open", title: "Check the Brands audit", refs: ["tg:200:2206"] }, capCtx)), "Task T1 is open (working).");
    const noReason = await task.execute({ action: "close", id: "T1", state: "dropped" }, capCtx);
    assert.ok(isError(noReason));
    assert.equal(text(noReason), "Dropping task T1 needs a reason.");
    assert.equal(text(await task.execute({ action: "close", id: "T1", state: "dropped", reason: "Owner moved the audit to next week" }, capCtx)), "Dropping task T1 needs the owner's message ref: only the owner drops work, in his own words.");
    assert.equal(text(await task.execute({ action: "close", id: "T1", state: "dropped", reason: "Owner moved the audit to next week", ref: "tg:200:2207" }, capCtx)), "Task T1 is dropped (Owner moved the audit to next week).");
    const reopen = await task.execute({ action: "set", id: "T1", state: "working" }, capCtx);
    assert.match(text(reopen), /^Task T1 is dropped; it reopens only when new work arrives on it/);
    assert.equal(text(await task.execute({ action: "open", title: "Publish the OTA", refs: ["tg:200:2208"] }, capCtx)), "Task T2 is open (working).");
    assert.equal(text(await task.execute({ action: "close", id: "T2", state: "live" }, capCtx)), "Task T2 becomes live only with evidence: what production runs and how it was checked.");
    assert.match(text(await task.execute({ action: "close", id: "T2", state: "done" as never }, capCtx)), /Invalid|live|dropped/);
    assert.equal(text(await task.execute({ action: "close", id: "T2", state: "live", reason: "production OTA a7021b2c is built from aa40ebbe" }, capCtx)), "Task T2 is live.");
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
      "✅ Finished since you last looked: nothing new.",
      "",
      "🚀 Not live yet: nothing merged waits to go live.",
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
    tasks.move("T2", "thr_cap", { to: "dropped", reason: "Owner moved it to next week", ref: "tg:200:2303" }, Date.now() - HOUR);
    const held = store.register({ url: "https://github.com/acme/app/pull/1759", taskId: "metricool-fix", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_new" });
    store.save({ ...held, status: "on-hold" });
    const unlinked = store.register({ url: "https://github.com/acme/app/pull/283", taskId: "c9", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_c9", title: "Bump the email template" });
    store.save({ ...unlinked, status: "complete", forgeState: "merged", mergeCommitSha: "m9", updatedAt: Date.now() - 2 * HOUR });
    const old = store.register({ url: "https://github.com/acme/app/pull/270", taskId: "c8", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_c8" });
    store.save({ ...old, status: "complete", forgeState: "merged", mergeCommitSha: "m8", updatedAt: Date.now() - 26 * HOUR });
    const text = await board(host);
    assert.deepEqual(text.split("\n\n").map((section) => section.split("\n")[0]), ["📌 Needs you: nothing right now.", "✅ Finished since you last looked (1)", "🚀 Not live yet (1)", "🔧 In progress (1)"]);
    assert.equal(text, [
      "📌 Needs you: nothing right now.",
      "",
      "✅ Finished since you last looked (1)",
      "- T2 Brands audit · dropped: Owner moved it to next week",
      "",
      "🚀 Not live yet (1)",
      "- PR [app#283](https://github.com/acme/app/pull/283) Bump the email template · merged, no task",
      "",
      "🔧 In progress (1)",
      "- T1 Areliaa · Metricool fix · 30 h · [app#1759](https://github.com/acme/app/pull/1759) on hold · stale 30 h",
    ].join("\n"));
    assert.match(await command(host, { command: "board", since: Date.now() - 30 * HOUR }), /\n- PR \[app#270\]\(https:\/\/github\.com\/acme\/app\/pull\/270\) /, "an older since brings back older merges");
    assert.equal(await command(host, { command: "digest" }), [
      "Finished (1)",
      "- T2 Brands audit · dropped: Owner moved it to next week",
      "",
      "Not live yet (1)",
      "- PR app#283 Bump the email template · merged, no task",
      "",
      "Stale (1): T1",
    ].join("\n"));
    tasks.move("T1", "thr_cap", { to: "live", reason: "Coolify deploy holds it" }, Date.now() - 20 * HOUR);
    assert.equal(await command(host, { command: "digest", since: Date.now() - 10 * MIN }), "");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

/** A crew row the captain registered, and the thread state forget reads. */
async function seedCrew(host: Host, id: string, output: string) {
  const crews = ((await host.bb.storage.kv.get("crews")) as unknown[] | undefined) ?? [];
  await host.bb.storage.kv.set("crews", [...crews, { id, task: id, projectId: "proj_1", threadId: `thr_${id}`, parentThreadId: "thr_cap", providerId: null, model: null, reasoningLevel: null, worktree: false, shape: "scout", posture: "direct-PR", createdAt: "2026-10-07T20:00:00.000Z" }]);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_1", status: "idle", environmentId: null }));
  host.harness.sdk.stub("threads.output", async () => ({ output }));
  host.harness.sdk.stub("threads.stop", async () => ({}));
  host.harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
}

const forget = async (host: Host, crewId: string) => {
  const result = await host.harness.behavior.runCli(["forget", crewId], { threadId: "thr_cap" });
  assert.equal(result.exitCode, 0, result.stderr);
};

test("a crew's done never closes its task: done and retired without a report both ask the captain to check", async () => {
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
      "📌 Needs you (2)",
      "1. T1 Cyndra · Partner onboarding guide (PDF) · finished, check · 4 h",
      "2. T2 Areliaa · Deploy + verify the offers live · finished, check · 2 h",
      "",
      "✅ Finished since you last looked: nothing new.",
      "",
      "🚀 Not live yet: nothing merged waits to go live.",
      "",
      "🔧 In progress: nothing open.",
    ].join("\n"));
    assert.equal(tasks.get("T1")!.outcome, "DONE: sent cyndra-partner-onboarding-guide.pdf to the owner. Next: check the work, then make it live with evidence or drop it with the owner's words");
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
      "✅ Finished since you last looked: nothing new.",
      "",
      "🚀 Not live yet (1)",
      "- T1 Cyndra · QA fixes: about 12 small polish items · merged 0 min ago · next: deploy to production in a release window and check it there (live check missing: no record says which commit Cyndra pro… · the captain",
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
      "✅ Finished since you last looked: nothing new.",
      "",
      "🚀 Not live yet: nothing merged waits to go live.",
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
      "✅ Finished since you last looked: nothing new.",
      "",
      "🚀 Not live yet: nothing merged waits to go live.",
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

test("Oct 8 repro: a research crew that ends its turn with DONE moves its task to the captain's check before anyone retires it", async () => {
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
      "📌 Needs you (1)",
      "1. T1 Cyndra · Performance research (Astra) · finished, check · 1 h",
      "",
      "✅ Finished since you last looked: nothing new.",
      "",
      "🚀 Not live yet: nothing merged waits to go live.",
      "",
      "🔧 In progress: nothing open.",
    ].join("\n"));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a dispatch mentioning an open task in title or task opens a new task unless taskRef is explicit", async () => {
  for (const field of ["title", "task"] as const) {
    const host = await captainHost();
    try {
      const tasks = createOwnerTasks(host.bb.storage.database());
      tasks.open({ captain: "thr_cap", project: "Areliaa", title: "Brand audit", sourceRefs: ["tg:200:1"], at: 1 });
      tasks.open({ captain: "thr_cap", project: "Areliaa", title: "Group chats", sourceRefs: ["tg:200:2"], at: 2 });
      await dispatch(host, { task: "Continue the work", title: "Follow-up", taskId: "restart-named", origin: { kind: "thread", threadId: "thr_repair" }, [field]: "Firstmate adopted open PRs as tasks T1 onward" });
      assert.deepEqual(tasks.get("T1")?.crewIds, []);
      assert.deepEqual(tasks.get("T3")?.crewIds, ["restart-named"]);
      assert.equal(tasks.list("thr_cap").length, 3);
      await dispatch(host, { task: "Restart T1", taskId: "explicit-ref", taskRef: "T2", origin: { kind: "captain", reason: "Use the correct task" } });
      assert.deepEqual(tasks.get("T2")?.crewIds, ["explicit-ref"]);
      assert.equal(tasks.list("thr_cap").length, 3);
    } finally { await host.harness.lifecycle.dispose(); }
  }
});

test("a dispatch whose title names a held PR joins that task despite an incidental task number", async () => {
  const host = await captainHost();
  try {
    const tasks = createOwnerTasks(host.bb.storage.database());
    tasks.open({ captain: "thr_cap", project: "Areliaa", title: "Unrelated task", sourceRefs: [], at: 1 });
    tasks.open({ captain: "thr_cap", project: "Areliaa", title: "Login fix", sourceRefs: [], prs: ["acme/app#2562"], at: 2 });
    const result = await dispatch(host, {
      task: "Check the adopted PR; the adoption report listed tasks T1 onward",
      title: "Check #2562", taskId: "check-held-pr", origin: { kind: "thread", threadId: "thr_repair" },
    });
    assert.ok(!isError(result), text(result));
    assert.deepEqual(tasks.get("T1")?.crewIds, []);
    assert.deepEqual(tasks.get("T2")?.crewIds, ["check-held-pr"]);
    assert.equal(tasks.list("thr_cap").length, 2);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("Oct 8 repro: a captain that receives Telegram messages is told to re-read the Telegram reference after each compaction", async () => {
  const host = await captainHost();
  try {
    const instructions = async () => (await host.harness.behavior.resolveAgentConfiguration(
      makePluginAgentConfigurationContext({ pluginMetadata: { captain: "true" }, thread: { id: "thr_cap" } }))).instructions ?? "";
    const rule = "After each context compaction, re-read the captain skill's Telegram reference before you answer the owner.";
    assert.equal((await instructions()).includes(rule), false, "a captain with no Telegram messages gets no Telegram rule");
    await ownerSays(host, "2230", "Status?");
    assert.equal((await instructions()).includes(rule), true);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("Oct 12 repro: the digest lists a finished item once and an unchanged stale list once per day", async () => {
  const host = await captainHost();
  try {
    const tasks = createOwnerTasks(host.bb.storage.database());
    const store = createDeliveries(host.bb.storage.database());
    tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Quiet task", sourceRefs: ["tg:200:2401"], at: Date.now() - 30 * HOUR });
    const record = store.register({ url: "https://github.com/cyndra-ai/cyndra-saas/pull/2146", taskId: "c1", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_c1", title: "StraightLine recording fix" });
    const observe = () => store.save({ ...store.get(record.id)!, status: "merged-needs-verification", forgeState: "merged", mergeCommitSha: "m1", updatedAt: Date.now() });
    observe();
    assert.equal(await command(host, { command: "digest", since: Date.now() - HOUR }), "Not live yet (1)\n- PR cyndra-saas#2146 StraightLine recording fix · merged, no task\n\nStale (1): T1");
    for (const since of [Date.now() - 30 * MIN, Date.now() - 20 * MIN]) {
      observe();
      assert.equal(await command(host, { command: "digest", since }), "", "the next digests repeat nothing");
    }
    assert.match(await command(host, { command: "board" }), /Not live yet \(1\)\n- PR \[cyndra-saas#2146\]/, "the board still shows it");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an open card is on the board, and firstmate_ask reports it as before", async () => {
  const host = await captainHost();
  try {
    const result = text(await tool(host, "firstmate_ask").execute({ question: "Release #2284?", kind: "question", options: [{ label: "No" }, { label: "Yes" }], recommended: 0, project: "Cyndra" }, { threadId: "thr_cap", projectId: "proj_1" } as never));
    assert.match(result, /^Question card (a[0-9a-z]{6}) sent\. Ask \1 is open and on the captain's board\. If no answer by \d\d:\d\d UTC, it proceeds with "No" and you are told to go ahead\. Keep working on other things; the answer arrives as an owner message that replies to ask \1\.$/);
    assert.match(await board(host), /^📌 Needs you \(1\)\n1\. ❓ Release #2284\? \(0 min, ask a[0-9a-z]{6}\) Recommended: No\. Auto at \d\d:\d\d UTC\.\nTap a question's button or reply with just its letter\./);
    assert.match(await command(host, { command: "digest" }), /^Needs you \(1\)\n1\. ❓ Release #2284\?/);
    assert.match(await command(host, { command: "digest" }), /^Needs you \(1\)\n1\. ❓ Release #2284\?/, "an open card is in every digest until it is answered");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a builder started on an owner task after its earlier builder ended is redone work; a parallel builder, a lookup then a builder, or a checker is not", async () => {
  const host = await captainHost();
  try {
    const tasks = createOwnerTasks(host.bb.storage.database());
    const quality = createQualityEvents(host.bb.storage.database());
    tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Login fix", sourceRefs: ["tg:200:1838"], at: Date.now() - HOUR });
    await dispatch(host, { task: "Find why login fails", taskId: "look-1", taskRef: "T1", role: "lookup", shape: "scout" });
    quality.noteCrewEnded({ captain: "thr_cap", crew: "look-1", outcome: "DONE", at: Date.now() });
    await dispatch(host, { task: "Fix login web", taskId: "build-1", taskRef: "T1" });
    await dispatch(host, { task: "Fix login API", taskId: "build-api", taskRef: "T1" });
    await dispatch(host, { task: "Check the login PR", taskId: "check-1", taskRef: "T1", role: "checker" });
    const quiet = await host.harness.behavior.runCli(["scorecard", "--json"], capCtx);
    assert.deepEqual(JSON.parse(quiet.stdout).redone, []);
    quality.noteCrewEnded({ captain: "thr_cap", crew: "build-1", outcome: "FAILED: tests red", at: Date.now() });
    await dispatch(host, { task: "Fix login again", taskId: "build-2", taskRef: "T1" });
    const card = await host.harness.behavior.runCli(["scorecard", "--json"], capCtx);
    assert.deepEqual(JSON.parse(card.stdout).redone.map((r: { task: string; crew: string; after: string[] }) => [r.task, r.crew, r.after]), [["T1", "build-2", ["build-1"]]]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

/** Every call Firstmate makes to the Telegram connector; the reply answers as `answer` says. */
function connector(host: Host, answer: (method: string, input: Record<string, unknown>) => unknown = () => ({ ok: true, queued: 1, duplicate: false, mode: "on" })) {
  const calls: Array<{ method: string; input: Record<string, unknown> }> = [];
  host.harness.sdk.stub("plugins.callRpc", async ({ method, input }: { method: string; input: Record<string, unknown> }) => {
    calls.push({ method, input });
    return answer(method, input);
  });
  return calls;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));
const tasksRpc = async (host: Host, since?: number) =>
  (await host.harness.behavior.callRpc("telegramCommand", { command: "tasks", threadId: "thr_cap", ...(since === undefined ? {} : { since }) }) as { tasks: Array<Record<string, unknown>> }).tasks;

test("the connector reads every open task, and each closed one since it last looked, with its crews, what it waits on and the owner's refs", async () => {
  const host = await captainHost();
  try {
    await ownerSays(host, "2301", "Fix the legend dashes");
    await dispatch(host, { task: "Fix the legend dashes", taskId: "legend", title: "Legend dashes", sourceRefs: ["tg:200:2301"] });
    const start = Date.now();
    // The crew's reservation finishes in the background; until then no crew of the task runs.
    for (let tries = 0; tries < 50 && (await tasksRpc(host, start))[0]?.crews !== 1; tries += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const [open] = await tasksRpc(host, start);
    assert.deepEqual({ ...open, createdAt: typeof open!.createdAt, updatedAt: typeof open!.updatedAt }, {
      id: "T1", project: "Areliaa", projectId: "proj_1", title: "Legend dashes", state: "working", crews: 1, waitsOn: "1 crew", refs: ["tg:200:2301"], createdAt: "number", updatedAt: "number",
    });
    await tool(host, "firstmate_task").execute({ action: "set", id: "T1", state: "needs_you" }, capCtx);
    assert.equal((await tasksRpc(host, start))[0]!.waitsOn, "you");
    await tool(host, "firstmate_task").execute({ action: "close", id: "T1", state: "live", reason: "Dots now in the production OTA" }, capCtx);
    assert.deepEqual((await tasksRpc(host, start)).map((task) => [task.id, task.state, task.waitsOn]), [["T1", "live", null]], "closed since the connector last looked: still read once");
    assert.deepEqual(await tasksRpc(host, Date.now() + 1), [], "closed before: not read again");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("every task change tells the connector to redraw the task's status line", async () => {
  const host = await captainHost();
  const calls = connector(host);
  try {
    await ownerSays(host, "2302", "Rename the export button");
    await dispatch(host, { task: "Rename the export button", taskId: "export", title: "Export button", sourceRefs: ["tg:200:2302"] });
    await settle();
    const refreshes = () => calls.filter((call) => call.method === "refreshBoard").length;
    const opened = refreshes();
    assert.ok(opened >= 1, "opening the task");
    await tool(host, "firstmate_task").execute({ action: "set", id: "T1", state: "needs_you" }, capCtx);
    await settle();
    assert.ok(refreshes() > opened, "a state change");
    // A PR that becomes ready to merge moves the task when Firstmate next reads it, with no tool call.
    const store = createDeliveries(host.bb.storage.database());
    const pr = store.register({ url: "https://github.com/acme/app/pull/2092", taskId: "export", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_new", title: "Export button" });
    store.save({ ...pr, status: "ready-to-merge" });
    const moved = refreshes();
    await tasksRpc(host);
    await settle();
    assert.equal(createOwnerTasks(host.bb.storage.database()).get("T1")!.state, "ready");
    assert.ok(refreshes() > moved, "a move its PR proves");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_reply names the task of the owner message; more=true is progress; only result=true makes the task's result", async () => {
  const host = await captainHost();
  const calls = connector(host);
  try {
    await ownerSays(host, "2303", "Fix the legend dashes");
    await dispatch(host, { task: "Fix the legend dashes", taskId: "legend", title: "Legend dashes", sourceRefs: ["tg:200:2303"] });
    // An "ack" reply sets 👀 when the message reaches the captain; it carries no text.
    const replies = () => calls.filter((call) => call.method === "reply" && call.input.kind !== "ack").map((call) => ({ kind: call.input.kind, task: call.input.task, result: call.input.result }));
    await tool(host, "firstmate_reply").execute({ noWork: true, ref: "tg:200:2303", text: "The dashes come from the legend.", more: true }, capCtx);
    await tool(host, "firstmate_reply").execute({ noWork: true, ref: "tg:200:2303", text: "Should the forecast use dots?" }, capCtx);
    await tool(host, "firstmate_task").execute({ action: "close", id: "T1", state: "done", reason: "Dots now" }, capCtx);
    await ownerSays(host, "2304", "Status?");
    await tool(host, "firstmate_reply").execute({ noWork: true, ref: "tg:200:2303", text: "Done: the forecast uses dots, live.", result: true }, capCtx);
    await tool(host, "firstmate_reply").execute({ noWork: true, ref: "tg:200:2303", text: "The old chart is archived." }, capCtx);
    await tool(host, "firstmate_reply").execute({ noWork: true, ref: "tg:200:2304", text: "All quiet." }, capCtx);
    assert.deepEqual(replies(), [
      { kind: "progress", task: "T1", result: undefined },
      { kind: "reply", task: "T1", result: undefined },
      { kind: "final", task: "T1", result: true },
      { kind: "reply", task: "T1", result: undefined },
      { kind: "reply", task: undefined, result: undefined },
    ], "a later answer about the closed task is an answer, not a second result");
    assert.ok(isError(await tool(host, "firstmate_reply").execute({ ref: "tg:200:2304", text: "Other.", task: "T9" }, capCtx)), "an unknown task is refused");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a reply the connector drops as only saying the work started is not sent, and the owner message stays open", async () => {
  const host = await captainHost();
  connector(host, (method) => method === "reply" ? { queued: 0, duplicate: false, mode: "on", dropped: "started" } : { ok: true, queued: 1, duplicate: false, mode: "on" });
  try {
    await ownerSays(host, "2305", "Fix the legend dashes");
    const replied = await tool(host, "firstmate_reply").execute({ noWork: true, ref: "tg:200:2305", text: "On it." }, capCtx);
    assert.ok(isError(replied));
    assert.match(text(replied), /^Not sent to Telegram: it only says the work started, and the owner already sees 👀 on the message\. tg:200:2305 stays open\./);
    assert.notEqual(createInboundLedger(host.bb.storage.database()).get({ source: "telegram", chatId: "200", messageId: "2305" })?.state, "answered");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("firstmate_ask names the open task this turn's owner message started, or the task it is given", async () => {
  const host = await captainHost();
  const calls = connector(host);
  try {
    await ownerSays(host, "2306", "Fix the legend dashes");
    await dispatch(host, { task: "Fix the legend dashes", taskId: "legend", title: "Legend dashes", sourceRefs: ["tg:200:2306"] });
    const asks = () => calls.filter((call) => call.method === "ask").map((call) => call.input.task);
    await tool(host, "firstmate_ask").execute({ question: "Dots or dashes?", kind: "question", options: [{ label: "Dots" }, { label: "Dashes" }], project: "Safi" }, capCtx);
    await tool(host, "firstmate_ask").execute({ question: "Which colour?", kind: "question", options: [{ label: "Blue" }], task: "T1", project: "Safi" }, capCtx);
    assert.deepEqual(asks(), ["T1", "T1"]);
    assert.ok(isError(await tool(host, "firstmate_ask").execute({ question: "Which?", kind: "question", task: "T5" }, capCtx)));
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Owner decisions Q1, Q5, Q9 (18 Oct): the captain's reliability pass reads what production runs, moves
// merged work it holds to live with that evidence, and raises one alert per stalled project.
test("the hourly pass makes a merged Firstmate PR live from the loaded commit, and alerts the stalled Cyndra task once", async () => {
  const host = await captainHost();
  const calls = connector(host);
  try {
    const { execFileSync } = await import("node:child_process");
    const loaded = execFileSync("git", ["-C", new URL(".", import.meta.url).pathname, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const tasks = createOwnerTasks(host.bb.storage.database());
    const store = createDeliveries(host.bb.storage.database());
    tasks.open({ captain: "thr_cap", project: "bb-plugin-firstmate", title: "Live is the only finish", sourceRefs: ["tg:200:3001"], crewId: "fm1", at: Date.now() - 2 * HOUR });
    tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Maintenance banner", sourceRefs: ["tg:200:3002"], crewId: "cy1", at: Date.now() - 40 * HOUR });
    const fm = store.register({ url: "https://github.com/amrtawfik160/bb-plugin-firstmate/pull/159", taskId: "fm1", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_fm1" });
    store.save({ ...fm, status: "complete", forgeState: "merged", mergeCommitSha: loaded });
    const cy = store.register({ url: "https://github.com/cyndra-ai/cyndra-saas/pull/2535", taskId: "cy1", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_cy1" });
    store.save({ ...cy, status: "complete", forgeState: "merged", mergeCommitSha: "c0ffee" });
    tasks.reconcile("thr_cap", (task) => store.forTasks(task.crewIds, task.prs), Date.now() - 30 * HOUR);
    assert.deepEqual(tasks.list("thr_cap").map((task) => [task.id, task.state]), [["T1", "merged"], ["T2", "merged"]]);
    const idle = () => host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle", projectId: "proj_1" }), lastAssistantText: "" });
    assert.deepEqual((await idle()).errors, []);
    assert.equal(tasks.get("T1")!.state, "live");
    assert.match(tasks.get("T1")!.evidence!, new RegExp(`^Live check: Firstmate loaded on this host at .* \\(${loaded.slice(0, 8)}\\) holds amrtawfik160/bb-plugin-firstmate#159`));
    assert.equal(tasks.get("T2")!.state, "merged");
    const alerts = () => calls.filter((call) => call.method === "alert");
    assert.equal(alerts().length, 1);
    assert.equal(alerts()[0]!.input.project, "Cyndra");
    assert.equal(alerts()[0]!.input.level, "warning");
    assert.match(String(alerts()[0]!.input.text), /^1 task has had no next step for more than 24 hours in Cyndra:\n- T2 Maintenance banner \(merged, not live, no step for 30 h\): the captain must deploy to production in a release window and check it there \(live check missing: no record says which commit Cyndra production runs/);
    await idle();
    assert.equal(alerts().length, 1, "one alert per stall");
    const notLive = (await host.harness.behavior.callRpc("telegramCommand", { command: "board", threadId: "thr_cap" }) as { notLive: Array<Record<string, unknown>> }).notLive;
    assert.deepEqual(notLive.map((item) => [item.id, item.who, item.missing]), [["T2", "the captain", "no record says which commit Cyndra production runs: GitHub's last Production deployment is from 4 Oct, and the daily production drift check stopped on 27 Sep"]]);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

// Repair thread, 18 Oct: T203 listed a read-only scout as a crew; T204's drop reason named PR 2487, which now belongs to T247.
test("firstmate_task corrects a task record: remove-crew and amend-drop need a reason and are kept in the task's history", async () => {
  const host = await captainHost();
  try {
    const tasks = createOwnerTasks(host.bb.storage.database());
    tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Humza bugs", sourceRefs: ["tg:200:4001"], crewId: "0bd8dda8", at: Date.now() });
    tasks.attach("T1", "thr_cap", { crewId: "406628f1", sourceRefs: [], at: Date.now() });
    const task = tool(host, "firstmate_task");
    assert.equal(text(await task.execute({ action: "remove-crew", id: "T1", crewId: "406628f1" }, capCtx)), "remove-crew needs reason: why the record is wrong.");
    assert.equal(text(await task.execute({ action: "remove-crew", id: "T1", crewId: "406628f1", reason: "read-only scout" }, capCtx)),
      'Task T1 corrected (remove-crew): 406628f1 removed. Recorded with reason "read-only scout"; 1 correction(s) in its history.');
    assert.deepEqual(tasks.get("T1")!.crewIds, ["0bd8dda8"]);
    tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Provisioner", sourceRefs: ["tg:200:4002"], at: Date.now() });
    tasks.move("T2", "thr_cap", { to: "dropped", reason: "Owner: stop; drop PR 2487", ref: "tg:200:4003" }, Date.now());
    assert.equal(text(await task.execute({ action: "amend-drop", id: "T2", text: "Owner: stop the provisioner", reason: "PR 2487 now belongs to T247" }, capCtx)),
      'Task T2 corrected (amend-drop-reason): Owner: stop; drop PR 2487 -> Owner: stop the provisioner. Recorded with reason "PR 2487 now belongs to T247"; 1 correction(s) in its history.');
    assert.deepEqual(tasks.get("T2")!.history!.map((h) => h.actor), ["thr_cap"]);
    assert.match(text(await task.execute({ action: "amend-drop", id: "T1", text: "x", reason: "y" }, capCtx)), /only a dropped task has a drop reason/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});
