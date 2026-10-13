import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createLaunches } from "./lib/launch.ts";
import * as queueStoreModule from "./lib/queue-store.ts";
const { createQueueStore } = queueStoreModule;

// 13 Oct: an owner-ordered job waited 58 minutes in the queue unseen. Its start by
// hand was then refused by the away catch-up after the backlog row was added, and
// the launch stayed "uncertain" with a crew slot although no thread existed.

type Host = ReturnType<typeof createFakePluginHost>;
const capCtx = { projectId: "proj_1", threadId: "thr_cap" } as never;
const REFUSAL = [
  "WARNING: queued wakes pending - drain them with bin/fm-wake-drain.sh before anything else.",
  "=== Return brief ===",
  "Waiting on you:",
  `  held in the backlog: ${"x".repeat(2000)}`,
  "fm-afk-return: catch-up must finish before the captain request",
  "firstmate-actionable blocker: repair [key=auth] fixture credential needed",
  "fm-afk-return: handle each blocker now, or close it with resolved [key=...] and append a durable reclassification reason, then run bin/fm-afk-return.sh check",
].join("\n");

function tool(host: Host, name: string) {
  const found = host.harness.inspection.registrations.agentTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not registered`);
  return found!;
}
function text(result: unknown): string {
  if (typeof result === "string") return result;
  return (result as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("\n");
}
const isError = (result: unknown) => typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;
const rc = (payload: string, code = 0) => ({ nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${payload}\n__FM_HOST_RC:${code}\n`).toString("base64") }] });
const crewRow = (id: string, threadId: string, title: string) => ({
  id, title, task: "fix login", projectId: "proj_1", threadId, parentThreadId: "thr_cap", providerId: null, model: null,
  reasoningLevel: null, worktree: true, shape: "ship", posture: "direct-PR", createdAt: "2026-09-18T00:00:00.000Z",
});
const captainSends = (host: Host) => host.harness.sdk.callsTo("threads.send")
  .filter((c) => (c[0] as { threadId?: string }).threadId === "thr_cap").map((c) => JSON.stringify(c[0]));
const queue = (host: Host, args: Record<string, unknown>) => tool(host, "firstmate_queue").execute(args as never, capCtx);
const dispatch = (host: Host, args: Record<string, unknown>) => tool(host, "firstmate_dispatch").execute({ projectId: "proj_1", ...args } as never, capCtx);
const launchOf = (host: Host, id: string) => createLaunches(host.bb.storage.database()).forTask("proj_1", "thr_cap", id);
const heldSlots = (host: Host) => createLaunches(host.bb.storage.database()).heldTaskIds("thr_cap");
const queueRow = (host: Host, id: string) => createQueueStore(host.bb.storage.database(), async () => []).get({ id, projectId: "proj_1", parentThreadId: "thr_cap" });

/** A captain on the real transport with a cap of one crew, and one crew holding that slot. */
async function realCaptain() {
  const host = createFakePluginHost({
    pluginId: "firstmate", agentSkillIds: ["captain", "firstmate"],
    settings: { fmHome: "/tmp/fm-home", transport: "real", queueOwner: "real", maxActiveCrews: 1, fmReliability: JSON.stringify({ asyncDispatch: "on" }) },
  });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await host.bb.storage.kv.set("crews", [crewRow("busy1", "thr_busy", "Fix the checkout total")]);
  await plugin(host.bb);
  const state = { busy: true, catchupPending: false, spawnExit: 0, spawnOutput: "", spawned: false };
  const native = new Map<string, { title: string; kind: string }>();
  const seen: string[] = [];
  const cmds = new Map<string, string>();
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({ captain: "true" }));
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("environments.get", async () => ({ id: "env_wt", hostId: "host_1", path: "/wt", isWorktree: true, status: "ready" }));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({
    id: threadId, environmentId: "env_wt",
    status: threadId === "thr_cap" ? "idle" : threadId === "thr_busy" ? (state.busy ? "active" : "idle") : "starting",
  }));
  host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
    const id = `term_${cmds.size + 1}`;
    cmds.set(id, args.start?.command ?? "");
    seen.push(args.start?.command ?? "");
    return { id };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
    const cmd = cmds.get(args.terminalId) ?? "";
    if (cmd.includes('fm-afk-return.sh" check')) return state.catchupPending ? rc(REFUSAL, 3) : rc("");
    // The host wrapper quotes the whole script once more, so each quote arrives as '\''.
    const backlog = /fm-tasks-axi\.sh" '(add|rm|show|start|done)' '([^']+)'(?: '([^']*)')?(?:.* '--kind' '(\w+)')?/.exec(cmd.replaceAll(`'\\''`, "'"));
    if (backlog) {
      const [, verb, id, title, kind] = backlog;
      if (verb === "add") { if (!native.has(id!)) native.set(id!, { title: title ?? "", kind: kind ?? "ship" }); return rc("ok"); }
      const row = native.get(id!);
      if (!row) return rc(`error: NOT_FOUND no task ${id}`, 1);
      if (verb === "rm") native.delete(id!);
      return rc(verb === "show" ? `id: ${id}\nstate: queued\ntitle: ${JSON.stringify(row.title)}\nkind: ${row.kind}` : "ok");
    }
    if (cmd.includes("fm-spawn.sh")) { state.spawned = state.spawnExit === 0; return rc(state.spawnOutput, state.spawnExit); }
    if (cmd.includes("bb_thread_id")) return rc(state.spawned ? "thr_new" : "FM_META_ABSENT");
    return rc("");
  });
  return { host, state, native, seen };
}

const ownerJob = { task: "Investigate why the agent never started", title: "Investigate the missed start", taskId: "job-1", sourceRefs: ["bb:thr_cap:m1"] };

test("a job queued for lack of a slot tells the captain to tell the owner now, with the crews that hold the slots", async () => {
  const { host } = await realCaptain();
  try {
    const queued = text(await dispatch(host, ownerJob));
    assert.match(queued, /^Queued as job-1 \(crew cap 1; will dispatch when a slot opens\)\./);
    assert.match(queued, /has NOT started/);
    assert.match(queued, /Tell the owner now/);
    assert.match(queued, /busy1 \(Fix the checkout total\)/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("a start the away catch-up refuses creates nothing, holds no slot and can be started again", async () => {
  const { host, state, native, seen } = await realCaptain();
  try {
    await dispatch(host, ownerJob);
    state.busy = false;
    state.catchupPending = true;
    const refused = await queue(host, { action: "dispatch", queueId: "job-1" });
    assert.ok(isError(refused), text(refused));
    assert.match(text(refused), /Nothing was created/);
    assert.match(text(refused), /bb firstmate fm afk-return -- check/);
    assert.match(text(refused), /fixture credential needed/, "the blocker is named, not only the head of the return brief");
    assert.doesNotMatch(text(refused), /queued wakes pending/, "the wake warning is not the cause");
    assert.equal(native.size, 0, "no native backlog row was added");
    assert.ok(!seen.some((c) => c.includes("fm-spawn.sh")), "fm-spawn never ran");
    assert.equal(launchOf(host, "job-1")?.state, "failed");
    assert.deepEqual(heldSlots(host), [], "the refused start holds no crew slot");
    assert.equal(queueRow(host, "job-1")?.status, "queued");

    state.catchupPending = false;
    const started = await queue(host, { action: "dispatch", queueId: "job-1" });
    assert.match(text(started), /Dispatched queue job-1 as ship crew job-1/);
    assert.equal(queueRow(host, "job-1")?.status, "dispatched");
  } finally { await host.harness.lifecycle.dispose(); }
});

test("a native start that exits with a refusal before any thread exists ends failed, and the queued job can be reconciled and dropped", async () => {
  const { host, state, native } = await realCaptain();
  try {
    await dispatch(host, ownerJob);
    state.busy = false;
    state.spawnExit = 4;
    state.spawnOutput = "fm-spawn: away posture holds new work";
    const refused = await queue(host, { action: "dispatch", queueId: "job-1" });
    assert.ok(isError(refused), text(refused));
    assert.equal(launchOf(host, "job-1")?.state, "failed", text(refused));
    assert.deepEqual(heldSlots(host), []);
    assert.equal(queueRow(host, "job-1")?.status, "queued");
    assert.ok(native.has("job-1"), "the native row this start added stays for the next start");

    const reconciled = await queue(host, { action: "reconcile", queueId: "job-1" });
    assert.ok(!isError(reconciled), text(reconciled));
    assert.match(text(reconciled), /Reconciled queue job-1 \[queued\]/);

    const dropped = await queue(host, { action: "drop", queueId: "job-1" });
    assert.ok(!isError(dropped), text(dropped));
    assert.match(text(dropped), /Queue job-1 dropped/);
    assert.ok(!native.has("job-1"), "drop removed the native row");
    assert.equal(queueRow(host, "job-1")?.status, "dropped");
  } finally { await host.harness.lifecycle.dispose(); }
});

test("a job the plugin queued by itself reconciles and drops while it has no native row", async () => {
  const { host } = await realCaptain();
  try {
    await dispatch(host, ownerJob);
    const reconciled = await queue(host, { action: "reconcile", queueId: "job-1" });
    assert.ok(!isError(reconciled), text(reconciled));
    assert.match(text(reconciled), /Reconciled queue job-1 \[queued\]/);
    const dropped = await queue(host, { action: "drop", queueId: "job-1" });
    assert.ok(!isError(dropped), text(dropped));
    assert.equal(queueRow(host, "job-1")?.status, "dropped");
  } finally { await host.harness.lifecycle.dispose(); }
});

test("dispatching again with the id of a queued job returns a plain message", async () => {
  const { host, state } = await realCaptain();
  try {
    await dispatch(host, ownerJob);
    for (const busy of [true, false]) {
      state.busy = busy;
      const again = text(await dispatch(host, ownerJob));
      assert.doesNotMatch(again, /SqliteError|UNIQUE constraint/);
      assert.match(again, /job-1 is already queued/);
      assert.match(again, /firstmate_queue action=dispatch queueId=job-1/);
    }
    assert.equal(launchOf(host, "job-1"), undefined, "the repeat started nothing");
  } finally { await host.harness.lifecycle.dispose(); }
});

/** The plain transport with a cap of one crew and one crew holding that slot. */
async function plainCaptain() {
  const host = createFakePluginHost({
    pluginId: "firstmate", agentSkillIds: ["captain", "firstmate"],
    settings: { maxActiveCrews: 1, fmReliability: JSON.stringify({ asyncDispatch: "on" }) },
  });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await host.bb.storage.kv.set("crews", [crewRow("busy1", "thr_busy", "Fix the checkout total")]);
  await plugin(host.bb);
  const state = { busy: true };
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.events.list", async () => []);
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({ captain: "true" }));
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_new" }));
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({
    id: threadId, status: threadId === "thr_cap" ? "idle" : threadId === "thr_busy" ? (state.busy ? "active" : "idle") : "starting",
  }));
  const age = (id: string, minutes: number) => {
    const store = createQueueStore(host.bb.storage.database(), async () => []);
    store.patch(store.get({ id, projectId: "proj_1", parentThreadId: "thr_cap" })!, { createdAt: new Date(Date.now() - minutes * 60_000).toISOString() });
  };
  return { host, state, age };
}
const minutePass = (host: Host) => host.harness.behavior.runSchedule("pr-delivery-follow-up");
async function until(check: () => boolean, ms = 4000) {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(check(), "condition not reached in time");
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

test("an owner job that has waited 15 minutes brings the captain one notice with the slot holders and the options", async () => {
  const { host, age } = await plainCaptain();
  try {
    await dispatch(host, ownerJob);
    await dispatch(host, { task: "tidy the docs", taskId: "job-own", title: "Tidy the docs" });
    const notices = () => captainSends(host).filter((sent) => /has waited/.test(sent));
    age("job-1", 14);
    age("job-own", 40);
    await minutePass(host);
    await settle();
    assert.equal(notices().length, 0, "not before 15 minutes, and never for a job without an owner message");

    age("job-1", 16);
    await minutePass(host);
    await until(() => notices().length === 1);
    const notice = notices()[0]!;
    assert.match(notice, /job-1 \(Investigate the missed start\) has waited 16 minutes/);
    assert.match(notice, /busy1 \(Fix the checkout total\)/);
    assert.match(notice, /wait/i);
    assert.match(notice, /raise the crew cap/);
    assert.match(notice, /stop/);
    for (let pass = 0; pass < 3; pass++) { await minutePass(host); await settle(); }
    assert.equal(notices().length, 1, "one notice per job");
  } finally { await host.harness.lifecycle.dispose(); }
});

test("when a slot opens, jobs with an owner message start before jobs without, oldest first", async () => {
  const { host, state, age } = await plainCaptain();
  try {
    await dispatch(host, { task: "captain chore", taskId: "job-own", title: "Captain chore" });
    await dispatch(host, { task: "owner job, older", taskId: "job-a", title: "Owner job A", sourceRefs: ["bb:thr_cap:m1"] });
    await dispatch(host, { task: "owner job, newer", taskId: "job-b", title: "Owner job B", sourceRefs: ["bb:thr_cap:m2"] });
    age("job-own", 30);
    age("job-a", 20);
    age("job-b", 10);
    state.busy = false;
    await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
    const spawns = host.harness.sdk.callsTo("threads.spawn").map((c) => JSON.stringify(c[0]));
    assert.equal(spawns.length, 1, "one slot, one start");
    assert.match(spawns[0]!, /owner job, older/);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("startOrder puts owner jobs first and the oldest first inside each group", () => {
  const row = (id: string, createdAt: string, sourceRefs?: string[]) => ({ id, createdAt, sourceRefs });
  const startOrder = (queueStoreModule as unknown as { startOrder: <T extends { createdAt: string; sourceRefs?: string[] }>(rows: T[]) => T[] }).startOrder;
  const ordered = startOrder([
    row("own-new", "2026-10-13T16:00:00.000Z"), row("owner-new", "2026-10-13T15:58:00.000Z", ["bb:c:2"]),
    row("own-old", "2026-10-13T15:00:00.000Z"), row("owner-old", "2026-10-13T15:50:00.000Z", ["bb:c:1"]), row("empty-refs", "2026-10-13T14:00:00.000Z", []),
  ]);
  assert.deepEqual(ordered.map((r) => r.id), ["owner-old", "owner-new", "empty-refs", "own-old", "own-new"]);
});
