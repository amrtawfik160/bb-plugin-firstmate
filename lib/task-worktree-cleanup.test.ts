import assert from "node:assert/strict";
import test from "node:test";
import type { OwnerTask } from "./owner-tasks.ts";
import {
  CLEANUP_MAX_TASKS,
  KEPT_UNSAVED,
  environmentKeepReason,
  rotateSlice,
  runTaskWorktreeCleanup,
  taskCleanupTrigger,
  threadArchiveDecision,
  type CleanupCrew,
  type CleanupDeps,
  type CleanupEnvironment,
  type CleanupThread,
  type Occupant,
} from "./task-worktree-cleanup.ts";

const task = (over: Partial<OwnerTask> & Pick<OwnerTask, "id" | "state">): OwnerTask => ({
  captain: "thr_cap", project: "Cyndra", title: over.title ?? over.id, sourceRefs: [], prs: [], crewIds: over.crewIds ?? ["c1"],
  backfilled: false, createdAt: 0, updatedAt: 1, finishedAt: over.state === "live" || over.state === "dropped" ? 1 : undefined, ...over,
});

test("only a Live or dropped normal task is cleaned; merged and workstream tasks are kept", () => {
  const empty = new Set<string>();
  assert.deepEqual(taskCleanupTrigger(task({ id: "T1", state: "live" }), empty), { trigger: "live" });
  assert.deepEqual(taskCleanupTrigger(task({ id: "T1", state: "dropped" }), empty), { trigger: "dropped" });
  assert.deepEqual(taskCleanupTrigger(task({ id: "T1", state: "merged" }), empty), { trigger: null, reason: "not-finished" });
  assert.deepEqual(taskCleanupTrigger(task({ id: "T1", state: "working" }), empty), { trigger: null, reason: "not-finished" });
  assert.deepEqual(taskCleanupTrigger(task({ id: "T1", state: "live" }), new Set(["T1"])), { trigger: null, reason: "workstream" });
});

test("a checkout, shared, running or dirty environment is left alone", () => {
  const own = new Set(["thr_c1"]);
  const idle = [{ id: "thr_c1", status: "idle" }];
  assert.equal(environmentKeepReason({ isWorktree: false, occupants: idle, unsaved: [] }, own), "checkout");
  assert.equal(environmentKeepReason({ isWorktree: true, occupants: [], unsaved: [] }, own), "already-clean");
  assert.equal(environmentKeepReason({ isWorktree: true, occupants: [...idle, { id: "thr_other", status: "idle" }], unsaved: [] }, own), "shared");
  assert.equal(environmentKeepReason({ isWorktree: true, occupants: [{ id: "thr_c1", status: "active" }], unsaved: [] }, own), "running");
  assert.equal(environmentKeepReason({ isWorktree: true, occupants: idle, unsaved: ["1 uncommitted file(s)"] }, own), "unsaved");
  assert.equal(environmentKeepReason({ isWorktree: true, occupants: idle, unsaved: null }, own), "unsaved");
  assert.equal(environmentKeepReason({ isWorktree: true, occupants: idle, unsaved: [] }, own), null);
  assert.equal(environmentKeepReason({ isWorktree: true, occupants: [{ id: "thr_c1", status: "idle", archivedAt: 9 }], unsaved: [] }, own), "already-clean");
});

test("a thread another open task or a running parent still uses is kept", () => {
  const ready = { belongsToFinishedTask: true, otherOpenTaskIds: [] as string[], isCaptain: false, parentRunning: false, alreadyArchived: false };
  assert.deepEqual(threadArchiveDecision(ready), { archive: true });
  assert.deepEqual(threadArchiveDecision({ ...ready, otherOpenTaskIds: ["T9"] }), { archive: false, reason: "still-used" });
  assert.deepEqual(threadArchiveDecision({ ...ready, parentRunning: true }), { archive: false, reason: "running-parent" });
  assert.deepEqual(threadArchiveDecision({ ...ready, isCaptain: true }), { archive: false, reason: "captain" });
  assert.deepEqual(threadArchiveDecision({ ...ready, belongsToFinishedTask: false }), { archive: false, reason: "foreign" });
  assert.deepEqual(threadArchiveDecision({ ...ready, alreadyArchived: true }), { archive: false, reason: "already-archived" });
});

test("rotation walks the whole list across passes and stays within the cap", () => {
  assert.deepEqual(rotateSlice(["a", "b", "c"], 0, 2), { slice: ["a", "b"], nextCursor: 2 });
  assert.deepEqual(rotateSlice(["a", "b", "c"], 2, 2), { slice: ["c", "a"], nextCursor: 1 });
  assert.deepEqual(rotateSlice(["a", "b"], 0, 20), { slice: ["a", "b"], nextCursor: 0 });
  assert.equal(CLEANUP_MAX_TASKS, 20);
});

type World = {
  tasks: OwnerTask[];
  crews: CleanupCrew[];
  threads: Record<string, CleanupThread>;
  envs: Record<string, CleanupEnvironment>;
  occupants: Record<string, Occupant[]>;
  dirty: Record<string, readonly string[] | null>;
  captains: Set<string>;
  archived: string[];
  keptNotes: string[];
  reports: number;
  reported: Set<string>;
};

function world(over: Partial<World> = {}): World {
  return { tasks: [], crews: [], threads: {}, envs: {}, occupants: {}, dirty: {}, captains: new Set(), archived: [], keptNotes: [], reports: 0, reported: new Set(), ...over };
}

function putCrew(w: World, crewId: string, threadId: string, envId = "env_1", extra: Partial<CleanupCrew & CleanupThread> = {}) {
  w.crews.push({ id: crewId, threadId, parentThreadId: extra.parentThreadId ?? "thr_cap", worktree: extra.worktree ?? true, workstreamId: extra.workstreamId });
  w.threads[threadId] = { id: threadId, status: extra.status ?? "idle", environmentId: extra.environmentId === undefined ? envId : extra.environmentId, archivedAt: extra.archivedAt ?? null, parentThreadId: extra.parentThreadId ?? "thr_cap" };
  w.envs[envId] ??= { id: envId, isWorktree: true, path: `/wt/${envId}` };
  const live = w.occupants[envId] ?? [];
  if (!live.some((row) => row.id === threadId)) live.push({ id: threadId, status: extra.status ?? "idle" });
  w.occupants[envId] = live;
}

async function run(w: World, extra: Partial<CleanupDeps> = {}) {
  return runTaskWorktreeCleanup({
    signal: extra.signal ?? new AbortController().signal,
    tasks: w.tasks,
    workstreamTaskIds: extra.workstreamTaskIds ?? new Set(),
    crews: w.crews,
    thread: async (id) => {
      const row = w.threads[id];
      if (!row) throw new Error(`no thread ${id}`);
      return row;
    },
    environment: async (id) => {
      const row = w.envs[id];
      if (!row) throw new Error(`no env ${id}`);
      return row;
    },
    occupants: async (id) => w.occupants[id] ?? [],
    unsaved: async (path) => (path in w.dirty ? w.dirty[path]! : []),
    archive: async (id) => {
      w.archived.push(id);
      const row = w.threads[id];
      if (row) row.archivedAt = 1;
    },
    recordKept: (taskId, note) => { w.keptNotes.push(`${taskId}:${note}`); },
    alreadyReported: async (taskId) => w.reported.has(taskId),
    reportKept: async (taskId) => { w.reports += 1; w.reported.add(taskId); return true; },
    isCaptain: async (id) => w.captains.has(id),
    ...extra,
  });
}

test("Live archives the task's idle worktree crew; merged-not-live is kept", async () => {
  const live = world();
  live.tasks = [task({ id: "T1", state: "live" })];
  putCrew(live, "c1", "thr_c1");
  assert.deepEqual((await run(live)).rows, [{ taskId: "T1", action: "archived", detail: "live", threadId: "thr_c1" }]);
  assert.deepEqual(live.archived, ["thr_c1"]);

  const merged = world();
  merged.tasks = [task({ id: "T1", state: "merged" })];
  putCrew(merged, "c1", "thr_c1");
  assert.deepEqual((await run(merged)).rows, []);
  assert.deepEqual(merged.archived, []);
});

test("dropped archives at once", async () => {
  const w = world();
  w.tasks = [task({ id: "T2", state: "dropped", dropReason: "stop", dropRef: "tg:1:1" })];
  putCrew(w, "c1", "thr_c1");
  assert.deepEqual((await run(w)).rows, [{ taskId: "T2", action: "archived", detail: "dropped", threadId: "thr_c1" }]);
  assert.deepEqual(w.archived, ["thr_c1"]);
});

test("unsaved work is kept, recorded on the task, and reported once", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live" })];
  putCrew(w, "c1", "thr_c1");
  w.dirty["/wt/env_1"] = ["1 uncommitted file(s)"];
  const first = await run(w);
  assert.equal(first.rows[0]?.action, "kept");
  assert.match(first.rows[0]?.detail ?? "", /kept: unsaved work/);
  assert.deepEqual(w.archived, []);
  assert.deepEqual(w.keptNotes, [`T1:${KEPT_UNSAVED}`]);
  assert.equal(w.reports, 1);
  await run(w);
  assert.equal(w.reports, 1, "the captain is told once");
});

test("a shared environment is kept", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live" })];
  putCrew(w, "c1", "thr_c1");
  w.occupants["env_1"]!.push({ id: "thr_stranger", status: "idle" });
  assert.deepEqual((await run(w)).rows, [{ taskId: "T1", action: "kept", detail: "shared" }]);
  assert.deepEqual(w.archived, []);
});

test("a checker another open task still uses is kept; the finished task's own builder is archived", async () => {
  const w = world();
  w.tasks = [
    task({ id: "T1", state: "live", crewIds: ["builder", "checker"] }),
    task({ id: "T2", state: "working", crewIds: ["checker"], title: "round 2" }),
  ];
  putCrew(w, "builder", "thr_b");
  putCrew(w, "checker", "thr_k");
  const out = await run(w);
  assert.deepEqual(w.archived, ["thr_b"]);
  assert.equal(out.rows.find((row) => row.threadId === "thr_k")?.detail, "still-used");
  assert.equal(out.rows.find((row) => row.threadId === "thr_b")?.action, "archived");
});

test("a thread whose parent is still running is kept", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live" })];
  putCrew(w, "c1", "thr_c1", "env_1", { parentThreadId: "thr_parent" });
  w.threads["thr_parent"] = { id: "thr_parent", status: "active", archivedAt: null };
  assert.equal((await run(w)).rows[0]?.detail, "running-parent");
  assert.deepEqual(w.archived, []);
});

test("a running occupant, a checkout, and a captain are kept", async () => {
  const running = world();
  running.tasks = [task({ id: "T1", state: "live" })];
  putCrew(running, "c1", "thr_c1", "env_1", { status: "active" });
  running.occupants["env_1"] = [{ id: "thr_c1", status: "active" }];
  assert.equal((await run(running)).rows[0]?.detail, "running");
  assert.deepEqual(running.archived, []);

  const checkout = world();
  checkout.tasks = [task({ id: "T1", state: "live" })];
  putCrew(checkout, "c1", "thr_c1");
  checkout.envs["env_1"] = { id: "env_1", isWorktree: false, path: "/repo" };
  assert.equal((await run(checkout)).rows[0]?.detail, "checkout");
  assert.deepEqual(checkout.archived, []);

  const captain = world();
  captain.tasks = [task({ id: "T1", state: "live" })];
  putCrew(captain, "c1", "thr_c1");
  captain.captains.add("thr_c1");
  assert.equal((await run(captain)).rows[0]?.detail, "captain");
  assert.deepEqual(captain.archived, []);
});

test("an abort mid-pass keeps later threads and a bound pass rotates", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live", crewIds: ["c1"] }), task({ id: "T2", state: "live", crewIds: ["c2"] })];
  putCrew(w, "c1", "thr_1", "env_1");
  putCrew(w, "c2", "thr_2", "env_2");
  const ac = new AbortController();
  let waiting: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => { waiting = resolve; });
  const pending = run(w, {
    signal: ac.signal,
    thread: async (id) => {
      if (id === "thr_2") {
        ac.abort();
        await gate;
      }
      return w.threads[id]!;
    },
  });
  await Promise.resolve();
  waiting?.();
  const out = await pending;
  assert.deepEqual(w.archived, ["thr_1"]);
  assert.equal(out.rows.some((row) => row.threadId === "thr_2" && row.action === "archived"), false);

  const bound = world();
  bound.tasks = [task({ id: "T1", state: "live", crewIds: ["a"] }), task({ id: "T2", state: "live", crewIds: ["b"] }), task({ id: "T3", state: "live", crewIds: ["c"] })];
  putCrew(bound, "a", "thr_a", "env_a");
  putCrew(bound, "b", "thr_b", "env_b");
  putCrew(bound, "c", "thr_c", "env_c");
  const first = await run(bound, { maxTasks: 1, cursor: 0 });
  assert.deepEqual(bound.archived, ["thr_a"]);
  assert.equal(first.nextCursor, 1);
});
