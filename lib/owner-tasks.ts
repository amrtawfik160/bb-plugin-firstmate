import { clip, formatAge } from "./owner-asks.ts";
import type { DeliveryRecord } from "./pr-delivery.ts";

/** One piece of work the owner asked for, tracked until it closes. A reply to the owner
 * never closes it: replying and finishing are separate facts. */
export type TaskState = "working" | "needs_you" | "ready" | "check" | "merged" | "live" | "done" | "dropped";

export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  working: ["needs_you", "ready", "check", "merged", "live", "done", "dropped"],
  needs_you: ["working", "ready", "check", "merged", "live", "done", "dropped"],
  ready: ["working", "needs_you", "check", "merged", "live", "done", "dropped"],
  // Every crew finished without proving a delivery: the captain checks the work, then closes or restarts it.
  check: ["working", "needs_you", "ready", "merged", "live", "done", "dropped"],
  merged: ["live", "done"],
  live: [],
  done: [],
  dropped: [],
};

export const OPEN_TASK_STATES: readonly TaskState[] = ["working", "needs_you", "ready", "check"];
// Merged is closed for the owner but still waits for deploy evidence to become live.
const RECONCILED: readonly TaskState[] = [...OPEN_TASK_STATES, "merged"];
export const STALE_TASK_MS = 24 * 60 * 60_000;

export interface OwnerTask {
  id: string;
  captain: string;
  project: string | null;
  title: string;
  sourceRefs: string[];
  state: TaskState;
  prs: string[];
  crewIds: string[];
  dropReason?: string;
  outcome?: string;
  /** Created after the fact from an owner request that had no closure. */
  backfilled: boolean;
  createdAt: number;
  updatedAt: number;
}

export type TaskMove = { to: "dropped"; reason: string } | { to: Exclude<TaskState, "dropped">; reason?: string };

export type NewOwnerTask = Pick<OwnerTask, "captain" | "project" | "title" | "sourceRefs"> & {
  crewId?: string;
  prs?: string[];
  backfilled?: boolean;
  at: number;
};

type Database = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
};

export function isOpenTask(task: Pick<OwnerTask, "state">): boolean {
  return OPEN_TASK_STATES.includes(task.state);
}

/** Apply one move, or explain why the state machine refuses it. */
export function moveTask(task: OwnerTask, move: TaskMove, at: number): OwnerTask {
  if (task.state === move.to) return task;
  if (!TASK_TRANSITIONS[task.state].includes(move.to)) throw new Error(`Task ${task.id} is ${task.state}; it cannot become ${move.to}.`);
  if (move.to === "dropped") {
    const reason = move.reason.trim();
    if (reason === "") throw new Error(`Dropping task ${task.id} needs a reason.`);
    return { ...task, state: "dropped", dropReason: reason, updatedAt: at };
  }
  const outcome = move.reason?.trim();
  return { ...task, state: move.to, ...(outcome ? { outcome } : {}), updatedAt: at };
}

// Same words as the board's PR line: only "ready to merge" is ready for the owner.
const OPEN_PR_READY = new Set<DeliveryRecord["status"]>(["ready-to-merge", "waiting-approval"]);

/** The task state its pull requests prove, or null when they prove nothing yet.
 * Merged needs every linked PR off the open list; live needs the agreed merge verification. */
export function stateFromPrs(records: readonly DeliveryRecord[]): "working" | "ready" | "merged" | "live" | null {
  if (records.length === 0) return null;
  const merged = (r: DeliveryRecord) => r.forgeState === "merged" || r.status === "merged-needs-verification" || (r.status === "complete" && r.mergeCommitSha !== null);
  const closed = (r: DeliveryRecord) => merged(r) || r.forgeState === "closed" || r.status === "explicitly-abandoned" || r.status === "closed-needs-disposition";
  const open = records.filter((r) => !closed(r));
  if (open.length > 0) return open.every((r) => OPEN_PR_READY.has(r.status)) ? "ready" : "working";
  const landed = records.filter(merged);
  if (landed.length === 0) return null;
  return landed.every((r) => r.status === "complete" && r.requirement === "merged-and-verified" && r.verifiedCommitSha !== null) ? "live" : "merged";
}

export function linkedPrs(task: Pick<OwnerTask, "crewIds" | "prs">, records: readonly DeliveryRecord[]): DeliveryRecord[] {
  return records.filter((r) => task.prs.includes(r.id) || task.crewIds.includes(r.taskId));
}

const STATE_WORDS: Record<TaskState, string> = {
  working: "working",
  needs_you: "needs you",
  ready: "ready for you",
  check: "finished, check",
  merged: "merged",
  live: "live",
  done: "done",
  dropped: "dropped",
};

export function taskLine(task: OwnerTask, now: number): string {
  const stale = now - task.updatedAt >= STALE_TASK_MS ? ` · stale, no update for ${formatAge(now - task.updatedAt)}` : "";
  const project = task.project ? ` · ${task.project}` : "";
  return `- ${task.id}${project} · ${clip(task.title, 70)} — ${STATE_WORDS[task.state]}, ${formatAge(now - task.createdAt)}${stale}${task.backfilled ? " · backfilled" : ""}`;
}

/** One spelling per project: the first word, matched without case. "Cyndra SaaS" and "Cyndra" are one project. */
const projectKey = (label: string) => label.trim().split(/\s+/)[0]!.toLowerCase();

export function sameProject(a: string | null, b: string | null): boolean {
  return a !== null && b !== null && projectKey(a) === projectKey(b);
}

export function projectName(label: string | null, known: readonly (string | null)[]): string | null {
  const name = label?.trim().split(/\s+/)[0];
  if (!name) return null;
  return known.find((other) => other !== null && projectKey(other) === name.toLowerCase()) ?? name;
}

/** "Safi: legend dashes" under project Safi reads "Legend dashes". */
export function taskTitle(title: string, project: string | null): string {
  const clean = title.replace(/\s+/g, " ").trim().slice(0, 200);
  if (!project) return clean;
  const word = new RegExp(`^${projectKey(project).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b[\\s:·—-]*`, "i");
  const rest = clean.replace(word, "");
  return rest === "" || rest === clean ? clean : rest[0]!.toUpperCase() + rest.slice(1);
}

/** How a crew left: delivered means it reported DONE or its work landed. */
export type CrewFinish = { delivered: boolean; outcome: string };

/** The state a task takes when its last crew finishes, or null to leave it. Pull requests decide
 * when the task has any; without one, a delivered crew closes it and any other end needs a check. */
export function finishedState(task: OwnerTask, records: readonly DeliveryRecord[], finish: CrewFinish): TaskMove | null {
  if (!isOpenTask(task)) return null;
  const proved = stateFromPrs(linkedPrs(task, records));
  if (proved === "merged" || proved === "live") return { to: proved, reason: finish.outcome };
  if (proved !== null) return null;
  return finish.delivered
    ? { to: "done", reason: finish.outcome || "Crew reported done" }
    : { to: "check", reason: finish.outcome || "Crew retired without reporting done" };
}

export type OwnerTasks = {
  /** Open one task per job. Several tasks may share an owner message; a retried dispatch
   * (same crew) or a repeated open (same title and message) returns the task it already has. */
  open(input: NewOwnerTask): OwnerTask;
  get(id: string): OwnerTask | undefined;
  list(captain: string, scope?: { includeClosed?: boolean }): OwnerTask[];
  openByRef(captain: string, ref: string): OwnerTask[];
  move(id: string, captain: string, move: TaskMove, at: number): OwnerTask;
  linkPr(id: string, captain: string, pr: string, at: number): OwnerTask;
  /** Put another crew on an existing task. Work restarts, so an open task goes back to working. */
  attach(id: string, captain: string, input: { crewId: string; sourceRefs: readonly string[]; at: number }): OwnerTask;
  /** The task, open or closed, that already holds one of these PRs. */
  holding(captain: string, prs: (pr: string, task: OwnerTask) => boolean): OwnerTask | undefined;
  /** A crew finished. When no other crew of its task still runs, settle the task. */
  finishCrew(captain: string, crewId: string, finish: CrewFinish, running: (crewId: string) => boolean,
    recordsFor: (task: OwnerTask) => readonly DeliveryRecord[], at: number): OwnerTask | undefined;
  /** Move each open task to the state its pull requests prove. Returns the tasks that changed. */
  reconcile(captain: string, recordsFor: (task: OwnerTask) => readonly DeliveryRecord[], at: number): OwnerTask[];
};

export function createOwnerTasks(db: Database): OwnerTasks {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_task (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, captain TEXT NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS owner_task_captain ON owner_task(captain, state);`);

  function get(id: string): OwnerTask | undefined {
    const row = db.prepare("SELECT record FROM owner_task WHERE id=?").get(id) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as OwnerTask : undefined;
  }

  function save(task: OwnerTask): OwnerTask {
    db.prepare("UPDATE owner_task SET state=?, record=? WHERE id=?").run(task.state, JSON.stringify(task), task.id);
    return task;
  }

  function list(captain: string, scope: { includeClosed?: boolean } = {}): OwnerTask[] {
    const rows = (scope.includeClosed
      ? db.prepare("SELECT record FROM owner_task WHERE captain=? ORDER BY seq").all(captain)
      : db.prepare(`SELECT record FROM owner_task WHERE captain=? AND state IN (${OPEN_TASK_STATES.map(() => "?").join(",")}) ORDER BY seq`).all(captain, ...OPEN_TASK_STATES)) as { record: string }[];
    return rows.map((row) => JSON.parse(row.record) as OwnerTask);
  }

  function openByRef(captain: string, ref: string): OwnerTask[] {
    return list(captain).filter((task) => task.sourceRefs.includes(ref));
  }

  function owned(id: string, captain: string): OwnerTask {
    const task = get(id);
    if (!task || task.captain !== captain) throw new Error(`No task ${id} for this captain.`);
    return task;
  }

  return {
    open(input) {
      return db.transaction(() => {
        const project = projectName(input.project, list(input.captain, { includeClosed: true }).map((task) => task.project));
        const title = taskTitle(input.title, project);
        const existing = input.crewId
          ? list(input.captain, { includeClosed: true }).find((task) => task.crewIds.includes(input.crewId!))
          : list(input.captain).find((task) => task.crewIds.length === 0 && task.title === title && task.sourceRefs.some((ref) => input.sourceRefs.includes(ref)));
        if (existing) {
          const sourceRefs = [...new Set([...existing.sourceRefs, ...input.sourceRefs])];
          const prs = [...new Set([...existing.prs, ...(input.prs ?? [])])];
          if (sourceRefs.length === existing.sourceRefs.length && prs.length === existing.prs.length) return existing;
          return save({ ...existing, sourceRefs, prs, updatedAt: input.at });
        }
        const last = db.prepare("SELECT max(seq) AS seq FROM owner_task").get() as { seq: number | null };
        const seq = (last.seq ?? 0) + 1;
        const task: OwnerTask = {
          id: `T${seq}`,
          captain: input.captain,
          project,
          title,
          sourceRefs: [...new Set(input.sourceRefs)],
          state: "working",
          prs: [...new Set(input.prs ?? [])],
          crewIds: input.crewId ? [input.crewId] : [],
          backfilled: input.backfilled === true,
          createdAt: input.at,
          updatedAt: input.at,
        };
        db.prepare("INSERT INTO owner_task VALUES (?,?,?,?,?)").run(task.id, seq, task.captain, task.state, JSON.stringify(task));
        return task;
      })();
    },
    get,
    list,
    openByRef,
    move(id, captain, move, at) {
      return db.transaction(() => {
        const task = owned(id, captain);
        const next = moveTask(task, move, at);
        return next === task ? task : save(next);
      })();
    },
    linkPr(id, captain, pr, at) {
      return db.transaction(() => {
        const task = owned(id, captain);
        if (task.prs.includes(pr)) return task;
        return save({ ...task, prs: [...task.prs, pr], updatedAt: at });
      })();
    },
    attach(id, captain, input) {
      return db.transaction(() => {
        const task = owned(id, captain);
        const crewIds = task.crewIds.includes(input.crewId) ? task.crewIds : [...task.crewIds, input.crewId];
        const sourceRefs = [...new Set([...task.sourceRefs, ...input.sourceRefs])];
        const restarted = isOpenTask(task) && task.state !== "working" ? moveTask(task, { to: "working" }, input.at) : task;
        if (restarted === task && crewIds === task.crewIds && sourceRefs.length === task.sourceRefs.length) return task;
        return save({ ...restarted, crewIds, sourceRefs, updatedAt: input.at });
      })();
    },
    holding(captain, prs) {
      const tasks = list(captain, { includeClosed: true });
      return tasks.find((task) => isOpenTask(task) && task.prs.some((pr) => prs(pr, task))) ?? tasks.find((task) => task.prs.some((pr) => prs(pr, task)));
    },
    finishCrew(captain, crewId, finish, running, recordsFor, at) {
      return db.transaction(() => {
        const task = list(captain, { includeClosed: true }).find((item) => item.crewIds.includes(crewId));
        if (!task || task.crewIds.some((other) => other !== crewId && running(other))) return task;
        const move = finishedState(task, recordsFor(task), finish);
        return move === null ? task : save(moveTask(task, move, at));
      })();
    },
    reconcile(captain, recordsFor, at) {
      return db.transaction(() => {
        const changed: OwnerTask[] = [];
        const rows = db.prepare(`SELECT record FROM owner_task WHERE captain=? AND state IN (${RECONCILED.map(() => "?").join(",")}) ORDER BY seq`).all(captain, ...RECONCILED) as { record: string }[];
        for (const task of rows.map((row) => JSON.parse(row.record) as OwnerTask)) {
          const linked = linkedPrs(task, recordsFor(task));
          const prs = [...new Set([...task.prs, ...linked.map((r) => r.id)])];
          const proved = stateFromPrs(linked);
          let next = prs.length === task.prs.length ? task : { ...task, prs, updatedAt: at };
          // A PR proves progress, never a step back to a state the captain set by hand.
          if (proved !== null && proved !== next.state && TASK_TRANSITIONS[next.state].includes(proved)
            && !(proved === "working" && next.state === "needs_you")) {
            next = moveTask(next, { to: proved }, at);
          }
          if (next !== task) changed.push(save(next));
        }
        return changed;
      })();
    },
  };
}
