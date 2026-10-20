// Checker probes from check round 1 of PR #179 (D179-check-1), kept as regression tests.
// Each showed a defect; its result assertion is flipped to the safe outcome.
import assert from "node:assert/strict";
import test from "node:test";
import type { OwnerTask } from "./owner-tasks.ts";
import {
  KEPT_UNSAVED,
  runTaskWorktreeCleanup,
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
  unarchived: string[];
};

function world(over: Partial<World> = {}): World {
  const threads: Record<string, CleanupThread> = { thr_cap: { id: "thr_cap", status: "idle", archivedAt: null } };
  return { tasks: [], crews: [], threads, envs: {}, occupants: {}, dirty: {}, captains: new Set(["thr_cap"]), archived: [], keptNotes: [], reports: 0, reported: new Set(), unsavedChecks: 0, unarchived: [], ...over };
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
    descendants: async () => 0,
    archive: async (id) => {
      w.archived.push(id);
      const row = w.threads[id];
      if (row) row.archivedAt = 1;
      return [id];
    },
    unarchive: async (id) => { w.unarchived.push(id); const row = w.threads[id]; if (row) row.archivedAt = null; },
    recordKept: (taskId, note) => { w.keptNotes.push(`${taskId}:${note ?? "cleared"}`); },
    alreadyReported: async (taskId) => w.reported.has(taskId),
    reportKept: async (taskId) => { w.reports += 1; w.reported.add(taskId); return true; },
    isCaptain: async (id) => w.captains.has(id),
    ...extra,
  });
}


test('probe: request can archive an active thread after the final idle response', async () => {
  const w = world(); w.tasks=[task({id:'T1',state:'live'})]; putCrew(w,'c1','thr_c1');
  let reads=0;
  // The read right before the archive: the 4th, now that the fix reads again under the crew lock.
  const out=await run(w,{thread:async id=>{
    const response={...w.threads[id]!};
    if(id==='thr_c1' && ++reads===4) w.threads[id]!.status='active';
    return response;
  },archive:async id=>{ assert.equal(w.threads[id]!.status,'active'); w.archived.push(id); return [id]; }});
  // Flipped to the safe outcome: the archive is read back, seen running and undone.
  assert.deepEqual(w.archived,['thr_c1']); assert.equal(out.rows[0]?.action,'kept'); assert.deepEqual(w.unarchived,['thr_c1']);
});

test('probe: an open task attached during the git check is invisible to the archive decision',async()=>{
  const w=world(); w.tasks=[task({id:'T1',state:'live'})]; putCrew(w,'c1','thr_c1');
  const currentTasks=[...w.tasks];
  await run(w,{tasksNow:()=>currentTasks,unsaved:async()=>{currentTasks.push(task({id:'T2',state:'working',crewIds:['c1']}));return [];}});
  // Flipped to the safe outcome: the task records are read again after the check.
  assert.equal(currentTasks[1]!.state,'working'); assert.deepEqual(w.archived,[]);
});

test('probe: a parent starts using the crew during the git check, but is not read again',async()=>{
  const w=world(); w.tasks=[task({id:'T1',state:'live'})]; putCrew(w,'c1','thr_c1');
  await run(w,{unsaved:async()=>{w.threads.thr_cap!.status='active';return [];}});
  // Flipped to the safe outcome: the parent is read again after the check.
  assert.deepEqual(w.archived,[]);
});

