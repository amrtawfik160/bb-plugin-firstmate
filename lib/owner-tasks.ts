import { formatAge } from "./owner-asks.ts";
import type { DeliveryRecord } from "./pr-delivery.ts";

/** One piece of work the owner asked for, tracked until it closes. A reply to the owner
 * never closes it: replying and finishing are separate facts. */
export type TaskState = "working" | "needs_you" | "ready" | "merged" | "live" | "done" | "dropped";

export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  working: ["needs_you", "ready", "merged", "live", "done", "dropped"],
  needs_you: ["working", "ready", "merged", "live", "done", "dropped"],
  ready: ["working", "needs_you", "merged", "live", "done", "dropped"],
  merged: ["live", "done"],
  live: [],
  done: [],
  dropped: [],
};

export const OPEN_TASK_STATES: readonly TaskState[] = ["working", "needs_you", "ready"];
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

const OPEN_PR_READY = new Set<DeliveryRecord["status"]>(["ready-to-merge", "waiting-approval", "pr-delivered"]);

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
  merged: "merged",
  live: "live",
  done: "done",
  dropped: "dropped",
};

export const BOARD_MAX_TASKS = 15;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

export function taskLine(task: OwnerTask, now: number): string {
  const stale = now - task.updatedAt >= STALE_TASK_MS ? ` · stale, no update for ${formatAge(now - task.updatedAt)}` : "";
  const project = task.project ? ` · ${task.project}` : "";
  return `- ${task.id}${project} · ${clip(task.title, 70)} — ${STATE_WORDS[task.state]}, ${formatAge(now - task.createdAt)}${stale}${task.backfilled ? " · backfilled" : ""}`;
}

/** The board's "Your tasks in progress" section; empty when nothing is open. */
export function taskSection(tasks: readonly OwnerTask[], now: number): string {
  const open = tasks.filter(isOpenTask).sort((a, b) => a.createdAt - b.createdAt || taskNumber(a.id) - taskNumber(b.id));
  if (open.length === 0) return "";
  const lines = open.slice(0, BOARD_MAX_TASKS).map((task) => taskLine(task, now));
  if (open.length > BOARD_MAX_TASKS) lines.push(`…and ${open.length - BOARD_MAX_TASKS} more`);
  return [`Your tasks in progress (${open.length}):`, ...lines].join("\n");
}

function taskNumber(id: string): number {
  return Number(id.slice(1)) || 0;
}

export type OwnerTasks = {
  /** Open a task for these owner messages, or add the crew to the open task that already has one of them. */
  open(input: NewOwnerTask): OwnerTask;
  get(id: string): OwnerTask | undefined;
  list(captain: string, scope?: { includeClosed?: boolean }): OwnerTask[];
  findOpenByRef(captain: string, ref: string): OwnerTask | undefined;
  move(id: string, captain: string, move: TaskMove, at: number): OwnerTask;
  linkPr(id: string, captain: string, pr: string, at: number): OwnerTask;
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

  function findOpenByRef(captain: string, ref: string): OwnerTask | undefined {
    return list(captain).find((task) => task.sourceRefs.includes(ref));
  }

  function owned(id: string, captain: string): OwnerTask {
    const task = get(id);
    if (!task || task.captain !== captain) throw new Error(`No task ${id} for this captain.`);
    return task;
  }

  return {
    open(input) {
      return db.transaction(() => {
        const existing = input.sourceRefs.map((ref) => findOpenByRef(input.captain, ref)).find(Boolean);
        if (existing) {
          const crewIds = input.crewId && !existing.crewIds.includes(input.crewId) ? [...existing.crewIds, input.crewId] : existing.crewIds;
          const sourceRefs = [...new Set([...existing.sourceRefs, ...input.sourceRefs])];
          const prs = [...new Set([...existing.prs, ...(input.prs ?? [])])];
          if (crewIds === existing.crewIds && sourceRefs.length === existing.sourceRefs.length && prs.length === existing.prs.length) return existing;
          return save({ ...existing, crewIds, sourceRefs, prs, state: existing.state === "ready" ? "working" : existing.state, updatedAt: input.at });
        }
        const last = db.prepare("SELECT max(seq) AS seq FROM owner_task").get() as { seq: number | null };
        const seq = (last.seq ?? 0) + 1;
        const task: OwnerTask = {
          id: `T${seq}`,
          captain: input.captain,
          project: input.project,
          title: input.title.replace(/\s+/g, " ").trim().slice(0, 200),
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
    findOpenByRef,
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
