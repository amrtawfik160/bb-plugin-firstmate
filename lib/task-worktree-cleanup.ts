// After a normal (non-workstream) task is Live or dropped, archive its crew threads so BB
// tears the managed worktree down. Checkout environments, shared environments, unsaved
// work, running threads, a thread another open task or running parent still uses, and a
// thread with descendants are kept. Branches stay.
//
// BB's archive has no idle precondition and takes the thread's whole tree: children,
// hidden source threads and lifecycle dependents. So the last checks, the worktree check
// and the archive run under Firstmate's crew lock, everything is read again after the
// worktree check, and the thread and its environment are read again right after the
// archive. Work that started meanwhile, or any other thread BB archived with it, undoes
// the archive inside BB's 30-second undo grace.

import { isOpenTask, type OwnerTask } from "./owner-tasks.ts";

export const CLEANUP_PASS_BUDGET_MS = 60_000;
export const CLEANUP_MAX_TASKS = 20;
export const KEPT_UNSAVED = "kept: unsaved work";

/** BB keeps an archived thread's turn and terminals for this long; an unarchive inside it loses nothing. */
export const ARCHIVE_UNDO_GRACE_MS = 30_000;
/** Counted from just before the archive is sent, so earlier than BB's grace, which starts when BB commits
 * it: the archive call and the read-back end by `verifyMs`, and every undo call is sent and awaited by
 * `undoByMs`. The time between is reserved for the undo. */
export const ARCHIVE_TIMINGS = { verifyMs: 12_000, undoByMs: 22_000 } as const;

const RUNNING = new Set(["active", "starting", "pending", "stopping", "running"]);

export function isRunningStatus(status: string): boolean {
  return RUNNING.has(status);
}

/** A turn, or a background agent, command or workflow the thread started, is still going. */
export function isRunning(row: { status: string; busy?: boolean }): boolean {
  return isRunningStatus(row.status) || row.busy === true;
}

export type CleanupTrigger = "live" | "dropped";

export function taskCleanupTrigger(
  task: Pick<OwnerTask, "id" | "state">,
  workstreamTaskIds: ReadonlySet<string>,
): { trigger: CleanupTrigger } | { trigger: null; reason: "workstream" | "not-finished" } {
  if (workstreamTaskIds.has(task.id)) return { trigger: null, reason: "workstream" };
  if (task.state === "live") return { trigger: "live" };
  if (task.state === "dropped") return { trigger: "dropped" };
  return { trigger: null, reason: "not-finished" };
}

export type Occupant = {
  id: string;
  status: string;
  /** Background agents, commands or workflows still run, even when the turn is idle. */
  busy?: boolean;
  archivedAt?: number | null;
  parentThreadId?: string | null;
};

export type EnvFacts = {
  isWorktree: boolean;
  occupants: readonly Occupant[];
  /** Empty = clean. Null = the check did not complete. */
  unsaved: readonly string[] | null;
};

export function liveOccupants(occupants: readonly Occupant[]): Occupant[] {
  return occupants.filter((row) => row.archivedAt == null);
}

/** Why the whole environment must be left alone; null means each of this task's threads can be considered. */
export function environmentKeepReason(env: EnvFacts, taskThreadIds: ReadonlySet<string>): "checkout" | "shared" | "running" | "unsaved" | "already-clean" | null {
  if (!env.isWorktree) return "checkout";
  const live = liveOccupants(env.occupants);
  if (live.length === 0) return "already-clean";
  if (live.some((row) => !taskThreadIds.has(row.id))) return "shared";
  if (live.some((row) => isRunning(row))) return "running";
  if (env.unsaved === null || env.unsaved.length > 0) return "unsaved";
  return null;
}

export type ThreadArchiveFacts = {
  belongsToFinishedTask: boolean;
  otherOpenTaskIds: readonly string[];
  isCaptain: boolean;
  parentRunning: boolean;
  alreadyArchived: boolean;
};

export function threadArchiveDecision(facts: ThreadArchiveFacts):
  | { archive: true }
  | { archive: false; reason: "foreign" | "still-used" | "running-parent" | "captain" | "already-archived" } {
  if (facts.alreadyArchived) return { archive: false, reason: "already-archived" };
  if (facts.isCaptain) return { archive: false, reason: "captain" };
  if (!facts.belongsToFinishedTask) return { archive: false, reason: "foreign" };
  if (facts.otherOpenTaskIds.length > 0) return { archive: false, reason: "still-used" };
  if (facts.parentRunning) return { archive: false, reason: "running-parent" };
  return { archive: true };
}

export function rotateSlice<T>(items: readonly T[], cursor: number, max: number): { slice: T[]; nextCursor: number } {
  if (items.length === 0 || max <= 0) return { slice: [], nextCursor: 0 };
  const start = ((cursor % items.length) + items.length) % items.length;
  const n = Math.min(max, items.length);
  const slice = Array.from({ length: n }, (_, i) => items[(start + i) % items.length]!);
  return { slice, nextCursor: items.length <= max ? 0 : (start + n) % items.length };
}

export type CleanupCrew = {
  id: string;
  threadId: string;
  parentThreadId: string | null;
  worktree: boolean;
  workstreamId?: string;
};

export type CleanupThread = {
  id: string;
  status: string;
  busy?: boolean;
  environmentId?: string | null;
  archivedAt?: number | null;
  parentThreadId?: string | null;
};

export type CleanupEnvironment = {
  id: string;
  isWorktree: boolean;
  path?: string;
};

export type CleanupDeps = {
  signal: AbortSignal;
  tasks: readonly OwnerTask[];
  workstreamTaskIds: ReadonlySet<string>;
  crews: readonly CleanupCrew[];
  maxTasks?: number;
  cursor?: number;
  /** Clean only this task now (the moment it became Live or dropped), outside the rotation. */
  only?: string;
  /** The task records as they are now, read again after the worktree check. Defaults to `tasks`. */
  tasksNow?: () => readonly OwnerTask[];
  thread: (id: string) => Promise<CleanupThread>;
  environment: (id: string) => Promise<CleanupEnvironment>;
  occupants: (environmentId: string) => Promise<readonly Occupant[]>;
  unsaved: (path: string, crewId: string) => Promise<readonly string[] | null>;
  /** How many threads BB's archive would take with this one (children, hidden source threads,
   * lifecycle dependents). Null when that could not be read. */
  descendants: (threadId: string) => Promise<number | null>;
  /** Archives the thread and, in BB, its whole tree. Returns every thread BB archived. */
  archive: (threadId: string) => Promise<readonly string[]>;
  unarchive: (threadId: string) => Promise<void>;
  /** Runs the operation under these crews' lifecycle lock, so no restart through Firstmate runs meanwhile. */
  locked?: <T>(crewIds: readonly string[], operation: () => Promise<T>) => Promise<T>;
  /** Null clears an earlier note once the task's worktrees were archived after all. */
  recordKept: (taskId: string, note: typeof KEPT_UNSAVED | null) => void;
  alreadyReported: (taskId: string) => Promise<boolean>;
  reportKept: (taskId: string, path: string, findings: readonly string[]) => Promise<boolean>;
  isCaptain: (threadId: string) => Promise<boolean>;
  /** An archive was undone (or the undo failed); the worktree is kept. */
  undone?: (threadId: string, detail: string) => void;
  /** An archive was read back and stands. */
  verified?: (threadId: string) => void;
  /** Tests shorten these; see ARCHIVE_TIMINGS. */
  archiveTimings?: { verifyMs: number; undoByMs: number };
};

export type CleanupRow = { taskId: string; action: "archived" | "kept"; detail: string; threadId?: string };

type Decision = { archive: true } | { archive: false; reason: string };

export async function runTaskWorktreeCleanup(deps: CleanupDeps): Promise<{ rows: CleanupRow[]; nextCursor: number }> {
  const crewsOf = (task: OwnerTask) => deps.crews.filter((crew) => task.crewIds.includes(crew.id) && crew.worktree && !crew.workstreamId && crew.threadId);
  // A task whose crews were all retired has nothing left to clean, so it never takes a place in the pass.
  const eligible = deps.tasks.filter((task) => (deps.only === undefined || task.id === deps.only)
    && taskCleanupTrigger(task, deps.workstreamTaskIds).trigger !== null && crewsOf(task).length > 0);
  const { slice, nextCursor } = rotateSlice(eligible, deps.cursor ?? 0, deps.maxTasks ?? CLEANUP_MAX_TASKS);
  const rows: CleanupRow[] = [];
  const locked = deps.locked ?? (<T>(_ids: readonly string[], operation: () => Promise<T>) => operation());

  for (const task of slice) {
    if (deps.signal.aborted) break;
    const trigger = taskCleanupTrigger(task, deps.workstreamTaskIds);
    if (trigger.trigger === null) continue;
    const own = crewsOf(task);
    let alreadyArchived = 0;
    const byEnv = new Map<string, CleanupCrew[]>();
    for (const crew of own) {
      if (deps.signal.aborted) break;
      let thread: CleanupThread;
      try { thread = await deps.thread(crew.threadId); }
      catch (error) {
        if (isAbort(error) || deps.signal.aborted) break;
        rows.push({ taskId: task.id, action: "kept", detail: `thread unreadable (${message(error)})`, threadId: crew.threadId });
        continue;
      }
      if (thread.archivedAt != null) { alreadyArchived += 1; continue; }
      const envId = thread.environmentId;
      if (!envId) {
        rows.push({ taskId: task.id, action: "kept", detail: "checkout", threadId: crew.threadId });
        continue;
      }
      const group = byEnv.get(envId) ?? [];
      group.push(crew);
      byEnv.set(envId, group);
    }
    if (deps.signal.aborted) break;

    let keptUnsaved = false;
    let archived = alreadyArchived;
    for (const [envId, envCrews] of byEnv) {
      if (deps.signal.aborted) break;
      const taskThreadIds = new Set(envCrews.map((crew) => crew.threadId));
      // Reads first; the lock and the host command for unsaved work only when a thread could be archived.
      const env = await environmentCheck(deps, envId, taskThreadIds);
      if (env === "aborted") break;
      if (typeof env === "string") {
        rows.push({ taskId: task.id, action: "kept", detail: env });
        continue;
      }
      const ready: CleanupCrew[] = [];
      let stopped = false;
      for (const crew of envCrews) {
        if (deps.signal.aborted) { stopped = true; break; }
        const decision = await archiveDecisionFor(deps, task, crew, envId, deps.tasks);
        if (decision === "aborted") { stopped = true; break; }
        if (!decision.archive) {
          rows.push({ taskId: task.id, action: "kept", detail: decision.reason, threadId: crew.threadId });
          continue;
        }
        ready.push(crew);
      }
      if (stopped || deps.signal.aborted) break;
      if (ready.length === 0) continue;

      let outcome: LockedOutcome;
      try {
        outcome = await locked(ready.map((crew) => crew.id), () => archiveUnderLock(deps, task.id, envId, env, envCrews, ready));
      } catch (error) {
        if (isAbort(error) || deps.signal.aborted) break;
        rows.push({ taskId: task.id, action: "kept", detail: `crew lock refused (${message(error)})` });
        continue;
      }
      rows.push(...outcome.rows.map((row) => ({ taskId: task.id, ...row })));
      archived += outcome.archived;
      if (outcome.unsaved !== undefined) {
        // Outside the crew lock: telling the captain may take the captain's wake lock, which comes first.
        const { path, findings } = outcome.unsaved;
        keptUnsaved = true;
        deps.recordKept(task.id, KEPT_UNSAVED);
        try {
          if (!(await deps.alreadyReported(task.id))) await deps.reportKept(task.id, path, findings);
        } catch (error) {
          if (isAbort(error) || deps.signal.aborted) break;
        }
        rows.push({ taskId: task.id, action: "kept", detail: `${KEPT_UNSAVED} in ${path}: ${findings.join(", ")}` });
      }
      if (outcome.aborted) break;
    }
    if (deps.signal.aborted) break;
    if (!keptUnsaved && archived === own.length && task.worktreeKept !== undefined) deps.recordKept(task.id, null);
  }
  return { rows, nextCursor };
}

type LockedOutcome = {
  rows: Array<Omit<CleanupRow, "taskId">>;
  archived: number;
  unsaved?: { path: string; findings: readonly string[] };
  aborted?: boolean;
};

/** The environment's own keep reason ("checkout", "shared", "running", ...), its facts, or "aborted". */
async function environmentCheck(deps: CleanupDeps, envId: string, taskThreadIds: ReadonlySet<string>):
  Promise<CleanupEnvironment | string | "aborted"> {
  let env: CleanupEnvironment;
  try { env = await deps.environment(envId); }
  catch (error) {
    if (isAbort(error) || deps.signal.aborted) return "aborted";
    return `environment unreadable (${message(error)})`;
  }
  let occupants: readonly Occupant[];
  try { occupants = await deps.occupants(envId); }
  catch (error) {
    if (isAbort(error) || deps.signal.aborted) return "aborted";
    return `occupants unreadable (${message(error)})`;
  }
  return environmentKeepReason({ isWorktree: env.isWorktree, occupants, unsaved: [] }, taskThreadIds) ?? env;
}

// Under the crews' lock: the worktree check, every fact read again after it, then each archive
// with a read right before and right after.
async function archiveUnderLock(deps: CleanupDeps, taskId: string, envId: string, env: CleanupEnvironment,
  envCrews: readonly CleanupCrew[], ready: readonly CleanupCrew[]): Promise<LockedOutcome> {
  const out: LockedOutcome = { rows: [], archived: 0 };
  const keepAll = (detail: string) => { for (const crew of ready) out.rows.push({ action: "kept", detail, threadId: crew.threadId }); return out; };
  // The lock may have been free only after a long wait.
  if (deps.signal.aborted) return { ...out, aborted: true };

  const unsaved = await unsavedIn(deps, env.path ?? "", envCrews);
  if (deps.signal.aborted) return { ...out, aborted: true };
  if (unsaved === null || unsaved.length > 0) {
    return { ...out, unsaved: { path: env.path || "its worktree", findings: unsaved ?? ["worktree unreadable"] } };
  }

  // The worktree check took time. Read the task, its holders, the environment and its threads again.
  const tasks = (deps.tasksNow ?? (() => deps.tasks))();
  const task = tasks.find((row) => row.id === taskId);
  const trigger = task === undefined ? null : taskCleanupTrigger(task, deps.workstreamTaskIds).trigger;
  if (task === undefined || trigger === null) return keepAll("task reopened");
  const again = await environmentCheck(deps, envId, new Set(envCrews.map((crew) => crew.threadId)));
  if (again === "aborted") return { ...out, aborted: true };
  if (typeof again === "string") return keepAll(again);
  if (again.isWorktree !== env.isWorktree || (again.path ?? "") !== (env.path ?? "")) return keepAll("environment changed");

  for (const crew of ready) {
    if (deps.signal.aborted) return { ...out, aborted: true };
    const decision = await archiveDecisionFor(deps, task, crew, envId, tasks);
    if (decision === "aborted") return { ...out, aborted: true };
    if (!decision.archive) {
      out.rows.push({ action: "kept", detail: decision.reason, threadId: crew.threadId });
      continue;
    }
    const result = await archiveChecked(deps, crew.threadId, envId);
    out.rows.push({ action: result.archived ? "archived" : "kept", detail: result.archived ? trigger : result.detail, threadId: crew.threadId });
    if (result.archived) out.archived += 1;
    if (result.aborted) return { ...out, aborted: true };
  }
  return out;
}

/** Every reason this crew's thread must stay, read now; "aborted" when the pass is stopping. */
async function archiveDecisionFor(deps: CleanupDeps, task: OwnerTask, crew: CleanupCrew, envId: string, tasks: readonly OwnerTask[]):
  Promise<Decision | "aborted"> {
  let thread: CleanupThread;
  try { thread = await deps.thread(crew.threadId); }
  catch (error) {
    if (isAbort(error) || deps.signal.aborted) return "aborted";
    return { archive: false, reason: `thread unreadable (${message(error)})` };
  }
  if (thread.archivedAt == null && isRunning(thread)) return { archive: false, reason: "running" };
  if (thread.archivedAt == null && thread.environmentId !== envId) return { archive: false, reason: "environment changed" };
  let parentRunning = false;
  const parentId = thread.parentThreadId ?? crew.parentThreadId;
  if (parentId) {
    try {
      const parent = await deps.thread(parentId);
      // Only a turn counts here: a captain may keep a background watcher running for hours.
      parentRunning = parent.archivedAt == null && isRunningStatus(parent.status);
    } catch (error) {
      if (isAbort(error) || deps.signal.aborted) return "aborted";
      parentRunning = true;
    }
  }
  let captain = false;
  try { captain = await deps.isCaptain(crew.threadId); }
  catch (error) {
    if (isAbort(error) || deps.signal.aborted) return "aborted";
    captain = true;
  }
  const decision = threadArchiveDecision({
    belongsToFinishedTask: task.crewIds.includes(crew.id),
    otherOpenTaskIds: tasks.filter((row) => row.id !== task.id && isOpenTask(row) && row.crewIds.includes(crew.id)).map((row) => row.id),
    isCaptain: captain,
    parentRunning,
    alreadyArchived: thread.archivedAt != null,
  });
  if (!decision.archive) return decision;
  // BB's archive takes the whole tree, which none of these checks covered.
  let descendants: number | null;
  try { descendants = await deps.descendants(crew.threadId); }
  catch (error) {
    if (isAbort(error) || deps.signal.aborted) return "aborted";
    descendants = null;
  }
  if (descendants === null) return { archive: false, reason: "child threads unreadable" };
  if (descendants > 0) return { archive: false, reason: "has child threads" };
  return decision;
}

/** Archive after one last read, read the thread and its environment again, and undo the archive
 * when work started meanwhile or BB archived any other thread with it. */
async function archiveChecked(deps: CleanupDeps, threadId: string, envId: string):
  Promise<{ archived: boolean; detail: string; aborted?: boolean }> {
  let before: CleanupThread;
  try { before = await deps.thread(threadId); }
  catch (error) {
    if (isAbort(error) || deps.signal.aborted) return { archived: false, detail: "stopping", aborted: true };
    return { archived: false, detail: `thread unreadable (${message(error)})` };
  }
  if (before.archivedAt != null) return { archived: false, detail: "already-archived" };
  if (isRunning(before)) return { archived: false, detail: "running" };
  if (before.environmentId !== envId) return { archived: false, detail: "environment changed" };

  const timings = deps.archiveTimings ?? ARCHIVE_TIMINGS;
  const sentAt = Date.now();
  const verifyBy = sentAt + timings.verifyMs, undoBy = sentAt + timings.undoByMs;
  let taken: readonly string[];
  try { taken = await byDeadline(deps.archive(threadId), verifyBy, "archive"); }
  catch (error) {
    // The request may still have reached BB (a timeout, a reload); nothing verified it, so undo it.
    const stopping = isAbort(error) || deps.signal.aborted;
    const undone = await undo(deps, threadId, [threadId], stopping ? "stopped while archiving" : `archive failed (${message(error)})`, undoBy);
    return stopping ? { ...undone, aborted: true } : undone;
  }

  // Read again right after: BB's archive has no idle check, so a turn or background work that
  // started after the last read is seen here, while BB's undo grace still keeps it running. Any
  // sign of work, a failed read or the end of the verify time goes straight to the reserved undo.
  let reason: string | null = null;
  const others = taken.filter((id) => id !== threadId);
  if (others.length > 0) reason = `BB also archived ${others.join(", ")}`;
  if (reason === null) {
    try {
      const after = await byDeadline(deps.thread(threadId), verifyBy, "read-back");
      // The thread itself shows work: undo now, without waiting for the worktree's threads. A read-back
      // without the archive verifies nothing either; unarchiving a thread that is not archived is harmless.
      if (after.archivedAt == null) reason = "read-back does not show the archive";
      else if (isRunning(after)) reason = "work started while archiving";
      else if ((await byDeadline(deps.occupants(envId), verifyBy, "worktree read-back")).some((row) => isRunning(row))) reason = "work started while archiving";
    } catch (error) {
      reason = isAbort(error) || deps.signal.aborted ? "stopped while archiving" : `not verified after archiving (${message(error)})`;
    }
  }
  if (reason === null) {
    deps.verified?.(threadId);
    return { archived: true, detail: "archived" };
  }
  const undone = await undo(deps, threadId, taken.includes(threadId) ? taken : [threadId, ...taken], reason, undoBy);
  return deps.signal.aborted ? { ...undone, aborted: true } : undone;
}

// The lifecycle owner first: BB refuses to unarchive a dependent before its owner. Each call is
// sent even when an earlier one ran out of time; waiting for it stops at the undo deadline.
async function undo(deps: CleanupDeps, threadId: string, taken: readonly string[], reason: string, undoBy: number):
  Promise<{ archived: false; detail: string }> {
  const order = [threadId, ...taken.filter((id) => id !== threadId)];
  const failed: string[] = [];
  for (const id of order) {
    try { await byDeadline(deps.unarchive(id), undoBy, "undo"); }
    catch (error) { failed.push(`${id} (${message(error)})`); }
  }
  const detail = failed.length === 0 ? `${reason}; archive undone` : `${reason}; undo failed for ${failed.join(", ")}`;
  deps.undone?.(threadId, detail);
  return { archived: false, detail };
}

/** Stops waiting for the call at the deadline; the call itself was already sent. */
function byDeadline<T>(call: Promise<T>, deadline: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} not answered in time`)), Math.max(0, deadline - Date.now()));
    call.then((value) => { clearTimeout(timer); resolve(value); }, (error: unknown) => { clearTimeout(timer); reject(error); });
  });
}

async function unsavedIn(deps: CleanupDeps, path: string, crews: readonly CleanupCrew[]): Promise<readonly string[] | null> {
  if (path === "") return null;
  const findings: string[] = [];
  for (const crew of crews) {
    if (deps.signal.aborted) return null;
    let got: readonly string[] | null;
    try { got = await deps.unsaved(path, crew.id); }
    catch (error) {
      if (isAbort(error) || deps.signal.aborted) return null;
      got = null;
    }
    if (got === null) return null;
    for (const line of got) if (!findings.includes(line)) findings.push(line);
  }
  return findings;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "Aborted.");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
