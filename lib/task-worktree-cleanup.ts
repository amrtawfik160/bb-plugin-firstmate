// After a normal (non-workstream) task is Live or dropped, archive its crew threads so BB
// tears the managed worktree down. Checkout environments, shared environments, unsaved
// work, running threads, and a thread another open task or running parent still uses
// are kept. Branches stay.

import { isOpenTask, type OwnerTask } from "./owner-tasks.ts";

export const CLEANUP_PASS_BUDGET_MS = 60_000;
export const CLEANUP_MAX_TASKS = 20;
export const KEPT_UNSAVED = "kept: unsaved work";

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
  thread: (id: string) => Promise<CleanupThread>;
  environment: (id: string) => Promise<CleanupEnvironment>;
  occupants: (environmentId: string) => Promise<readonly Occupant[]>;
  unsaved: (path: string, crewId: string) => Promise<readonly string[] | null>;
  archive: (threadId: string) => Promise<void>;
  /** Null clears an earlier note once the task's worktrees were archived after all. */
  recordKept: (taskId: string, note: typeof KEPT_UNSAVED | null) => void;
  alreadyReported: (taskId: string) => Promise<boolean>;
  reportKept: (taskId: string, path: string, findings: readonly string[]) => Promise<boolean>;
  isCaptain: (threadId: string) => Promise<boolean>;
};

export type CleanupRow = { taskId: string; action: "archived" | "kept"; detail: string; threadId?: string };

export async function runTaskWorktreeCleanup(deps: CleanupDeps): Promise<{ rows: CleanupRow[]; nextCursor: number }> {
  const crewsOf = (task: OwnerTask) => deps.crews.filter((crew) => task.crewIds.includes(crew.id) && crew.worktree && !crew.workstreamId && crew.threadId);
  // A task whose crews were all retired has nothing left to clean, so it never takes a place in the pass.
  const eligible = deps.tasks.filter((task) => (deps.only === undefined || task.id === deps.only)
    && taskCleanupTrigger(task, deps.workstreamTaskIds).trigger !== null && crewsOf(task).length > 0);
  const { slice, nextCursor } = rotateSlice(eligible, deps.cursor ?? 0, deps.maxTasks ?? CLEANUP_MAX_TASKS);
  const rows: CleanupRow[] = [];
  const openTasksHolding = (crewId: string, exceptTaskId: string) =>
    deps.tasks.filter((task) => task.id !== exceptTaskId && isOpenTask(task) && task.crewIds.includes(crewId)).map((task) => task.id);

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
      let env: CleanupEnvironment;
      try { env = await deps.environment(envId); }
      catch (error) {
        if (isAbort(error) || deps.signal.aborted) break;
        rows.push({ taskId: task.id, action: "kept", detail: `environment unreadable (${message(error)})` });
        continue;
      }
      let occupants: readonly Occupant[];
      try { occupants = await deps.occupants(envId); }
      catch (error) {
        if (isAbort(error) || deps.signal.aborted) break;
        rows.push({ taskId: task.id, action: "kept", detail: `occupants unreadable (${message(error)})` });
        continue;
      }
      const taskThreadIds = new Set(envCrews.map((crew) => crew.threadId));
      // Reads first; the host command for unsaved work runs only when a thread could be archived.
      const keep = environmentKeepReason({ isWorktree: env.isWorktree, occupants, unsaved: [] }, taskThreadIds);
      if (keep !== null) {
        rows.push({ taskId: task.id, action: "kept", detail: keep });
        continue;
      }

      const ready: CleanupCrew[] = [];
      for (const crew of envCrews) {
        if (deps.signal.aborted) break;
        const decision = await archiveDecisionFor(deps, task, crew, openTasksHolding(crew.id, task.id));
        if (decision === "aborted") break;
        if (!decision.archive) {
          rows.push({ taskId: task.id, action: "kept", detail: decision.reason, threadId: crew.threadId });
          continue;
        }
        ready.push(crew);
      }
      if (deps.signal.aborted) break;
      if (ready.length === 0) continue;

      const unsaved = await unsavedIn(deps, env.path ?? "", envCrews);
      if (deps.signal.aborted) break;
      if (unsaved === null || unsaved.length > 0) {
        const findings = unsaved ?? ["worktree unreadable"];
        const path = env.path || "its worktree";
        keptUnsaved = true;
        deps.recordKept(task.id, KEPT_UNSAVED);
        try {
          if (!(await deps.alreadyReported(task.id))) await deps.reportKept(task.id, path, findings);
        } catch (error) {
          if (isAbort(error) || deps.signal.aborted) break;
        }
        rows.push({ taskId: task.id, action: "kept", detail: `${KEPT_UNSAVED} in ${path}: ${findings.join(", ")}` });
        continue;
      }

      for (const crew of ready) {
        if (deps.signal.aborted) break;
        // Read again just before archiving: a turn may have started during the worktree check.
        let thread: CleanupThread;
        try { thread = await deps.thread(crew.threadId); }
        catch (error) {
          if (isAbort(error) || deps.signal.aborted) break;
          rows.push({ taskId: task.id, action: "kept", detail: `thread unreadable (${message(error)})`, threadId: crew.threadId });
          continue;
        }
        if (thread.archivedAt != null) { archived += 1; continue; }
        if (isRunning(thread)) {
          rows.push({ taskId: task.id, action: "kept", detail: "running", threadId: crew.threadId });
          continue;
        }
        try {
          await deps.archive(crew.threadId);
          archived += 1;
          rows.push({ taskId: task.id, action: "archived", detail: trigger.trigger, threadId: crew.threadId });
        } catch (error) {
          if (isAbort(error) || deps.signal.aborted) break;
          rows.push({ taskId: task.id, action: "kept", detail: `archive refused (${message(error)})`, threadId: crew.threadId });
        }
      }
    }
    if (deps.signal.aborted) break;
    if (!keptUnsaved && archived === own.length && task.worktreeKept !== undefined) deps.recordKept(task.id, null);
  }
  return { rows, nextCursor };
}

/** "aborted" when the pass is stopping; any thread read that fails keeps the thread. */
async function archiveDecisionFor(deps: CleanupDeps, task: OwnerTask, crew: CleanupCrew, otherOpenTaskIds: readonly string[]):
  Promise<{ archive: true } | { archive: false; reason: string } | "aborted"> {
  let thread: CleanupThread;
  try { thread = await deps.thread(crew.threadId); }
  catch (error) {
    if (isAbort(error) || deps.signal.aborted) return "aborted";
    return { archive: false, reason: `thread unreadable (${message(error)})` };
  }
  if (thread.archivedAt == null && isRunning(thread)) return { archive: false, reason: "running" };
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
  return threadArchiveDecision({
    belongsToFinishedTask: task.crewIds.includes(crew.id),
    otherOpenTaskIds,
    isCaptain: captain,
    parentRunning,
    alreadyArchived: thread.archivedAt != null,
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
