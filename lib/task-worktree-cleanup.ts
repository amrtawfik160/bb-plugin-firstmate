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
  if (live.some((row) => isRunningStatus(row.status))) return "running";
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
  thread: (id: string) => Promise<CleanupThread>;
  environment: (id: string) => Promise<CleanupEnvironment>;
  occupants: (environmentId: string) => Promise<readonly Occupant[]>;
  unsaved: (path: string, crewId: string) => Promise<readonly string[] | null>;
  archive: (threadId: string) => Promise<void>;
  recordKept: (taskId: string, note: typeof KEPT_UNSAVED) => void;
  alreadyReported: (taskId: string) => Promise<boolean>;
  reportKept: (taskId: string, path: string, findings: readonly string[]) => Promise<boolean>;
  isCaptain: (threadId: string) => Promise<boolean>;
};

export type CleanupRow = { taskId: string; action: "archived" | "kept"; detail: string; threadId?: string };

export async function runTaskWorktreeCleanup(deps: CleanupDeps): Promise<{ rows: CleanupRow[]; nextCursor: number }> {
  const eligible = deps.tasks.filter((task) => taskCleanupTrigger(task, deps.workstreamTaskIds).trigger !== null);
  const { slice, nextCursor } = rotateSlice(eligible, deps.cursor ?? 0, deps.maxTasks ?? CLEANUP_MAX_TASKS);
  const rows: CleanupRow[] = [];
  const crewsOf = (task: OwnerTask) => deps.crews.filter((crew) => task.crewIds.includes(crew.id) && crew.worktree && !crew.workstreamId && crew.threadId);
  const openTasksHolding = (crewId: string, exceptTaskId: string) =>
    deps.tasks.filter((task) => task.id !== exceptTaskId && isOpenTask(task) && task.crewIds.includes(crewId)).map((task) => task.id);

  for (const task of slice) {
    if (deps.signal.aborted) break;
    const trigger = taskCleanupTrigger(task, deps.workstreamTaskIds);
    if (trigger.trigger === null) continue;
    const own = crewsOf(task);
    if (own.length === 0) {
      rows.push({ taskId: task.id, action: "kept", detail: "no managed worktree crew" });
      continue;
    }
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
      if (thread.archivedAt != null) continue;
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
      const unsaved = env.isWorktree ? await unsavedIn(deps, env.path ?? "", envCrews) : [];
      if (deps.signal.aborted) break;
      const keep = environmentKeepReason({ isWorktree: env.isWorktree, occupants, unsaved }, taskThreadIds);
      if (keep === "unsaved") {
        const findings = unsaved ?? ["worktree unreadable"];
        const path = env.path || "its worktree";
        deps.recordKept(task.id, KEPT_UNSAVED);
        try {
          if (!(await deps.alreadyReported(task.id))) await deps.reportKept(task.id, path, findings);
        } catch (error) {
          if (isAbort(error) || deps.signal.aborted) break;
        }
        rows.push({ taskId: task.id, action: "kept", detail: `${KEPT_UNSAVED} in ${path}: ${findings.join(", ")}` });
        continue;
      }
      if (keep !== null) {
        rows.push({ taskId: task.id, action: "kept", detail: keep });
        continue;
      }

      for (const crew of envCrews) {
        if (deps.signal.aborted) break;
        let thread: CleanupThread;
        try { thread = await deps.thread(crew.threadId); }
        catch (error) {
          if (isAbort(error) || deps.signal.aborted) break;
          rows.push({ taskId: task.id, action: "kept", detail: `thread unreadable (${message(error)})`, threadId: crew.threadId });
          continue;
        }
        let parentRunning = false;
        if (crew.parentThreadId) {
          try {
            const parent = await deps.thread(crew.parentThreadId);
            parentRunning = parent.archivedAt == null && isRunningStatus(parent.status);
          } catch (error) {
            if (isAbort(error) || deps.signal.aborted) break;
            parentRunning = true;
          }
        }
        let captain = false;
        try { captain = await deps.isCaptain(crew.threadId); }
        catch (error) {
          if (isAbort(error) || deps.signal.aborted) break;
          captain = true;
        }
        const decision = threadArchiveDecision({
          belongsToFinishedTask: task.crewIds.includes(crew.id),
          otherOpenTaskIds: openTasksHolding(crew.id, task.id),
          isCaptain: captain,
          parentRunning,
          alreadyArchived: thread.archivedAt != null,
        });
        if (!decision.archive) {
          rows.push({ taskId: task.id, action: "kept", detail: decision.reason, threadId: crew.threadId });
          continue;
        }
        try {
          await deps.archive(crew.threadId);
          rows.push({ taskId: task.id, action: "archived", detail: trigger.trigger, threadId: crew.threadId });
        } catch (error) {
          if (isAbort(error) || deps.signal.aborted) break;
          rows.push({ taskId: task.id, action: "kept", detail: `archive refused (${message(error)})`, threadId: crew.threadId });
        }
      }
    }
  }
  return { rows, nextCursor };
}

async function unsavedIn(deps: CleanupDeps, path: string, crews: readonly CleanupCrew[]): Promise<readonly string[] | null> {
  if (path === "") return null;
  const findings: string[] = [];
  for (const crew of crews) {
    if (deps.signal.aborted) return null;
    const got = await deps.unsaved(path, crew.id);
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
