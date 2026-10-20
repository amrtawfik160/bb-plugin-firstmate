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
  unsavedChecks: number;
  /** BB's archive tree: children, hidden source threads and lifecycle dependents of each thread. */
  descendants: Record<string, string[]>;
  unarchived: string[];
  undone: string[];
};

function world(over: Partial<World> = {}): World {
  const threads: Record<string, CleanupThread> = { thr_cap: { id: "thr_cap", status: "idle", archivedAt: null } };
  return { tasks: [], crews: [], threads, envs: {}, occupants: {}, dirty: {}, captains: new Set(["thr_cap"]), archived: [], keptNotes: [], reports: 0, reported: new Set(), unsavedChecks: 0, descendants: {}, unarchived: [], undone: [], ...over };
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
    unsaved: async (path) => { w.unsavedChecks += 1; return path in w.dirty ? w.dirty[path]! : []; },
    descendants: async (id) => (w.descendants[id] ?? []).length,
    // Like BB: the thread and its whole tree.
    archive: async (id) => {
      const tree = (root: string): string[] => [root, ...(w.descendants[root] ?? []).flatMap(tree)];
      const taken = tree(id).filter((tid) => w.threads[tid]?.archivedAt == null);
      for (const tid of taken) {
        w.archived.push(tid);
        const row = w.threads[tid];
        if (row) row.archivedAt = 1;
      }
      return taken;
    },
    unarchive: async (id) => {
      w.unarchived.push(id);
      const row = w.threads[id];
      if (row) row.archivedAt = null;
    },
    undone: (id, detail) => { w.undone.push(`${id}: ${detail}`); },
    recordKept: (taskId, note) => { w.keptNotes.push(`${taskId}:${note ?? "cleared"}`); },
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

test("a crew is kept while its captain is in a turn, and archived once the captain is idle", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "dropped", dropReason: "stop", dropRef: "tg:1:1" })];
  putCrew(w, "c1", "thr_c1");
  w.threads["thr_cap"]!.status = "active";
  assert.equal((await run(w)).rows[0]?.detail, "running-parent");
  assert.deepEqual(w.archived, []);
  w.threads["thr_cap"] = { id: "thr_cap", status: "idle", busy: true, archivedAt: null };
  await run(w);
  assert.deepEqual(w.archived, ["thr_c1"], "a captain's background watcher is not a turn");
});

test("a background command in the worktree keeps it", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live" })];
  putCrew(w, "c1", "thr_c1");
  w.occupants["env_1"] = [{ id: "thr_c1", status: "idle", busy: true }];
  assert.equal((await run(w)).rows[0]?.detail, "running");
  assert.deepEqual(w.archived, []);
});

test("the worktree check runs only when a thread could be archived", async () => {
  const shared = world();
  shared.tasks = [task({ id: "T1", state: "live" })];
  putCrew(shared, "c1", "thr_c1");
  shared.occupants["env_1"]!.push({ id: "thr_stranger", status: "idle" });
  await run(shared);
  assert.equal(shared.unsavedChecks, 0);

  const used = world();
  used.tasks = [task({ id: "T1", state: "live" }), task({ id: "T2", state: "working" })];
  putCrew(used, "c1", "thr_c1");
  await run(used);
  assert.equal(used.unsavedChecks, 0, "c1 is still used by the open task T2");
  assert.deepEqual(used.archived, []);
});

test("a turn that starts during the worktree check keeps the thread", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live" })];
  putCrew(w, "c1", "thr_c1");
  const out = await run(w, {
    unsaved: async () => { w.threads["thr_c1"]!.status = "active"; return []; },
  });
  assert.deepEqual(w.archived, []);
  assert.equal(out.rows[0]?.detail, "running");
});

test("a worktree check that fails keeps the worktree as unsaved and the pass goes on", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live", crewIds: ["c1"] }), task({ id: "T2", state: "live", crewIds: ["c2"] })];
  putCrew(w, "c1", "thr_1", "env_1");
  putCrew(w, "c2", "thr_2", "env_2");
  await run(w, {
    unsaved: async (path) => { if (path === "/wt/env_1") throw new Error("host down"); return []; },
  });
  assert.deepEqual(w.archived, ["thr_2"]);
  assert.deepEqual(w.keptNotes, [`T1:${KEPT_UNSAVED}`]);
});

test("the note is cleared once the saved worktree is archived", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live", worktreeKept: KEPT_UNSAVED })];
  putCrew(w, "c1", "thr_c1");
  await run(w);
  assert.deepEqual(w.archived, ["thr_c1"]);
  assert.deepEqual(w.keptNotes, ["T1:cleared"]);
});

test("the moment a task finishes, only that task is cleaned; a task whose crews are retired takes no place", async () => {
  const w = world();
  w.tasks = [
    task({ id: "T1", state: "live", crewIds: ["gone"] }),
    task({ id: "T2", state: "live", crewIds: ["a"] }),
    task({ id: "T3", state: "dropped", crewIds: ["b"], dropReason: "stop", dropRef: "tg:1:1" }),
  ];
  putCrew(w, "a", "thr_a", "env_a");
  putCrew(w, "b", "thr_b", "env_b");
  await run(w, { only: "T3" });
  assert.deepEqual(w.archived, ["thr_b"]);
  const out = await run(w, { maxTasks: 1, cursor: 0 });
  assert.deepEqual(w.archived, ["thr_b", "thr_a"], "T1 has no crew left, so T2 is first");
  assert.equal(out.nextCursor, 1);
});

// Check round 1 (PR #179), finding 2: BB archives a thread's whole tree.
test("a crew with any child, hidden source or lifecycle thread is kept, and so is its child", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live" })];
  putCrew(w, "c1", "thr_c1");
  w.threads["thr_child"] = { id: "thr_child", status: "active", environmentId: "env_unsaved", archivedAt: null, parentThreadId: "thr_c1" };
  w.descendants["thr_c1"] = ["thr_child"];
  const out = await run(w);
  assert.deepEqual(w.archived, []);
  assert.equal(out.rows[0]?.detail, "has child threads");
  assert.equal(w.unsavedChecks, 0, "no worktree check for a crew that cannot be archived");

  const unknown = world();
  unknown.tasks = [task({ id: "T1", state: "live" })];
  putCrew(unknown, "c1", "thr_c1");
  await run(unknown, { descendants: async () => null });
  assert.deepEqual(unknown.archived, []);
});

test("a thread BB archived with the crew after the checks undoes the whole archive, owner first", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live" })];
  putCrew(w, "c1", "thr_c1");
  w.threads["thr_dep"] = { id: "thr_dep", status: "idle", archivedAt: null };
  let checks = 0;
  // A lifecycle dependent appears after the last check.
  const out = await run(w, { descendants: async () => { if (++checks === 2) w.descendants["thr_c1"] = ["thr_dep"]; return 0; } });
  assert.deepEqual(w.archived, ["thr_c1", "thr_dep"]);
  assert.deepEqual(w.unarchived, ["thr_c1", "thr_dep"]);
  assert.equal(w.threads["thr_c1"]!.archivedAt, null);
  assert.equal(w.threads["thr_dep"]!.archivedAt, null);
  assert.equal(out.rows[0]?.action, "kept");
  assert.match(out.rows[0]?.detail ?? "", /BB also archived thr_dep; archive undone/);
});

// Finding 1: BB's archive has no idle precondition.
test("work that starts between the last read and the archive survives: the archive is undone", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live" })];
  putCrew(w, "c1", "thr_c1");
  const out = await run(w, {
    archive: async (id) => {
      w.threads[id]!.status = "active";
      w.threads[id]!.archivedAt = 1;
      w.archived.push(id);
      return [id];
    },
  });
  assert.deepEqual(w.unarchived, ["thr_c1"]);
  assert.equal(w.threads["thr_c1"]!.archivedAt, null);
  assert.equal(w.threads["thr_c1"]!.status, "active", "the turn keeps running");
  assert.equal(out.rows[0]?.action, "kept");
  assert.match(out.rows[0]?.detail ?? "", /work started while archiving; archive undone/);
  assert.deepEqual(w.undone, ["thr_c1: work started while archiving; archive undone"]);
});

test("background work in the worktree seen right after the archive undoes it", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live" })];
  putCrew(w, "c1", "thr_c1");
  const out = await run(w, {
    archive: async (id) => {
      w.occupants["env_1"] = [{ id, status: "idle", busy: true, archivedAt: 1 }];
      w.threads[id]!.archivedAt = 1;
      return [id];
    },
  });
  assert.deepEqual(w.unarchived, ["thr_c1"]);
  assert.equal(out.rows[0]?.action, "kept");
});

test("an archive call that fails or times out is undone, since it may have reached BB", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live" })];
  putCrew(w, "c1", "thr_c1");
  const out = await run(w, { archive: async () => { throw new Error("Timed out."); } });
  assert.deepEqual(w.unarchived, ["thr_c1"]);
  assert.match(out.rows[0]?.detail ?? "", /archive failed \(Timed out\.\); archive undone/);
});

// Finding 3: the worktree check takes time; everything is read again after it.
test("the task reopening during the worktree check keeps the crew", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live" })];
  putCrew(w, "c1", "thr_c1");
  let now: OwnerTask[] = w.tasks;
  const out = await run(w, {
    tasksNow: () => now,
    unsaved: async () => { now = [task({ id: "T1", state: "working" })]; return []; },
  });
  assert.deepEqual(w.archived, []);
  assert.equal(out.rows[0]?.detail, "task reopened");
});

test("a crew that moved to another worktree during the check is kept", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live" })];
  putCrew(w, "c1", "thr_c1");
  const out = await run(w, { unsaved: async () => { w.threads["thr_c1"]!.environmentId = "env_other"; return []; } });
  assert.deepEqual(w.archived, []);
  assert.equal(out.rows[0]?.detail, "environment changed");
});

test("the worktree check and the archive run under the crews' lock, and the captain is told after it", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live", crewIds: ["b", "a"] })];
  putCrew(w, "b", "thr_b");
  putCrew(w, "a", "thr_a");
  const events: string[] = [];
  let held = false;
  await run(w, {
    locked: async (ids, operation) => { events.push(`lock ${ids.join(",")}`); held = true; try { return await operation(); } finally { held = false; events.push("unlock"); } },
    unsaved: async () => { events.push(`check held=${held}`); return []; },
    archive: async (id) => { events.push(`archive ${id} held=${held}`); w.threads[id]!.archivedAt = 1; return [id]; },
  });
  assert.deepEqual(events, ["lock b,a", "check held=true", "check held=true", "archive thr_b held=true", "archive thr_a held=true", "unlock"]);

  const dirty = world();
  dirty.tasks = [task({ id: "T1", state: "live" })];
  putCrew(dirty, "c1", "thr_c1");
  dirty.dirty["/wt/env_1"] = ["1 uncommitted file(s)"];
  let heldAtReport = true;
  await run(dirty, {
    locked: async (_ids, operation) => { held = true; try { return await operation(); } finally { held = false; } },
    reportKept: async () => { heldAtReport = held; return true; },
  });
  assert.equal(heldAtReport, false, "telling the captain may take the captain's wake lock, which comes before a crew lock");
});

// Check round 2 (PR #179), finding 1: the undo must start well inside BB's 30-second grace.
const quick = { verifyMs: 40, undoByMs: 120 };
const never = <T>() => new Promise<T>(() => {});

test("a read-back that does not answer in time goes straight to the reserved undo", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live" })];
  putCrew(w, "c1", "thr_c1");
  let sentAt = 0, undoAt = 0;
  const out = await run(w, {
    archiveTimings: quick,
    archive: async (id) => { sentAt = Date.now(); w.threads[id]!.archivedAt = 1; return [id]; },
    thread: async (id) => (id === "thr_c1" && w.threads[id]!.archivedAt != null ? never<CleanupThread>() : w.threads[id]!),
    unarchive: async (id) => { undoAt = Date.now(); w.unarchived.push(id); w.threads[id]!.archivedAt = null; },
  });
  assert.deepEqual(w.unarchived, ["thr_c1"]);
  assert.ok(undoAt - sentAt < quick.undoByMs, `undo ${undoAt - sentAt} ms after the archive was sent`);
  assert.match(out.rows[0]?.detail ?? "", /not verified after archiving \(read-back not answered in time\); archive undone/);
});

test("an archive call that does not answer in time is undone", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live" })];
  putCrew(w, "c1", "thr_c1");
  const out = await run(w, { archiveTimings: quick, archive: () => never<readonly string[]>() });
  assert.deepEqual(w.unarchived, ["thr_c1"]);
  assert.match(out.rows[0]?.detail ?? "", /archive failed \(archive not answered in time\); archive undone/);
});

test("when the read-back shows work, the undo does not wait for the worktree read", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live" })];
  putCrew(w, "c1", "thr_c1");
  let afterArchive = 0;
  await run(w, {
    archive: async (id) => { w.threads[id]!.status = "active"; w.threads[id]!.archivedAt = 1; return [id]; },
    occupants: async (id) => { if (w.threads["thr_c1"]!.archivedAt != null) afterArchive += 1; return w.occupants[id] ?? []; },
  });
  assert.deepEqual(w.unarchived, ["thr_c1"]);
  assert.equal(afterArchive, 0);
});

test("an undo call that does not answer stops being awaited at the undo deadline", async () => {
  const w = world();
  w.tasks = [task({ id: "T1", state: "live" })];
  putCrew(w, "c1", "thr_c1");
  const started = Date.now();
  const out = await run(w, {
    archiveTimings: quick,
    archive: async (id) => { w.threads[id]!.status = "active"; w.threads[id]!.archivedAt = 1; return [id]; },
    unarchive: () => never<void>(),
  });
  assert.ok(Date.now() - started < 1_000);
  assert.match(out.rows[0]?.detail ?? "", /undo failed for thr_c1 \(undo not answered in time\)/);
  assert.match(w.undone[0] ?? "", /undo failed/);
});
