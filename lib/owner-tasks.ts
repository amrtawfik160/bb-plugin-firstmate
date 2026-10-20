import { clip, formatAge } from "./owner-asks.ts";
import type { DeliveryRecord } from "./pr-delivery.ts";

/** One piece of work the owner asked for, tracked until it is finished. A reply to the owner
 * never closes it: replying and finishing are separate facts. Words as in GLOSSARY.md. */
export type TaskState = "working" | "needs_you" | "ready" | "check" | "merged" | "live" | "done" | "dropped";

/**
 * Owner decision Q1 (18 Oct): a task is finished only when it is live or dropped. Merged is open until
 * its project's live check proves production runs it. "done" is the state of records from before that
 * rule: nothing moves a task into it any more, and a new PR or crew reopens it like any finished task.
 */
export const TASK_TRANSITIONS: Record<TaskState, readonly TaskState[]> = {
  working: ["needs_you", "ready", "check", "merged", "live", "dropped"],
  needs_you: ["working", "ready", "check", "merged", "live", "dropped"],
  ready: ["working", "needs_you", "check", "merged", "live", "dropped"],
  // Every crew finished without proving a delivery: the captain checks the work, then makes it live, drops or restarts it.
  check: ["working", "needs_you", "ready", "merged", "live", "dropped"],
  // Merged waits for its live check; new work on it (an open PR, a crew) takes it back.
  merged: ["working", "needs_you", "ready", "check", "live", "dropped"],
  // A finished task reopens only when new work arrives on it.
  live: ["working"],
  done: ["working", "merged", "live", "dropped"],
  dropped: ["working"],
};

/** Not finished: the board and the stall alarm keep each of these in view. */
export const OPEN_TASK_STATES: readonly TaskState[] = ["working", "needs_you", "ready", "check", "merged"];
export const FINISHED_TASK_STATES: readonly TaskState[] = ["live", "dropped", "done"];
export const STALE_TASK_MS = 24 * 60 * 60_000;

export interface OwnerTask {
  id: string;
  captain: string;
  project: string | null;
  /**
   * The BB project of the task's crews, recorded at dispatch (never the captain thread's project). The
   * Telegram connector puts the task's messages in this project's topic. Unset on records from before.
   */
  projectId?: string | null;
  title: string;
  sourceRefs: string[];
  state: TaskState;
  prs: string[];
  crewIds: string[];
  dropReason?: string;
  /** The owner message whose words dropped it (tg:<chat>:<msg> or bb:<thread>:<row>). */
  dropRef?: string;
  outcome?: string;
  /** What proved it live: the project's check, or the captain's evidence. */
  evidence?: string;
  /** When it became live or dropped; later edits never move it. */
  finishedAt?: number;
  /** Set when Live/dropped cleanup refused because the worktree still has uncommitted or unpushed work. */
  worktreeKept?: "kept: unsaved work";
  /** PRs the captain linked after it finished: new work, whenever the PR was opened. */
  lateLinks?: string[];
  /** Corrections of the record, oldest first. Entries are only ever added. */
  history?: TaskCorrection[];
  /** Created after the fact from an owner request that had no closure. */
  backfilled: boolean;
  /**
   * Open epoch. Starts at 1. Closing then reopening (attach, reconcile, or a move
   * from a finished state) increments it so a pre-approval bound to the old opening dies.
   */
  generation?: number;
  createdAt: number;
  updatedAt: number;
}

/**
 * dropped needs the owner's words and his message ref; live needs evidence of what production runs.
 * `checked` names the project live check that proved it (a hand move has none).
 */
/** One correction of a task record: who made it, why, and the value before and after. */
export type TaskCorrection = { at: number; actor: string; action: "remove-crew" | "amend-drop-reason"; before: string; after: string | null; reason: string };
export type Correction = { reason: string; actor: string };

export type TaskMove =
  | { to: "dropped"; reason: string; ref: string }
  | { to: "live"; reason: string; checked?: string }
  | { to: Exclude<TaskState, "dropped" | "live">; reason?: string };

export type NewOwnerTask = Pick<OwnerTask, "captain" | "project" | "title" | "sourceRefs"> & {
  projectId?: string | null;
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

export function isFinishedTask(task: Pick<OwnerTask, "state">): boolean {
  return FINISHED_TASK_STATES.includes(task.state);
}

export function taskOpenEpoch(task: Pick<OwnerTask, "generation">): number {
  return task.generation && task.generation > 0 ? task.generation : 1;
}

/** Apply one move, or explain why the state machine refuses it. */
export function moveTask(task: OwnerTask, move: TaskMove, at: number): OwnerTask {
  if (task.state === move.to) return task;
  if (move.to === "done") throw new Error(`Task ${task.id} cannot become done: only live or dropped finishes a task. Make it live with evidence, or drop it with the owner's words.`);
  if (!TASK_TRANSITIONS[task.state].includes(move.to)) throw new Error(`Task ${task.id} is ${task.state}; it cannot become ${move.to}.`);
  if (move.to === "dropped") {
    const reason = move.reason.trim();
    const ref = move.ref?.trim() ?? "";
    if (reason === "") throw new Error(`Dropping task ${task.id} needs a reason.`);
    if (ref === "") throw new Error(`Dropping task ${task.id} needs the owner's message ref: only the owner drops work, in his own words.`);
    return { ...task, state: "dropped", dropReason: reason, dropRef: ref, finishedAt: at, lateLinks: [], updatedAt: at };
  }
  if (move.to === "live") {
    const evidence = move.reason?.trim() ?? "";
    if (evidence === "") throw new Error(`Task ${task.id} becomes live only with evidence: what production runs and how it was checked.`);
    return { ...task, state: "live", evidence, outcome: evidence, finishedAt: at, lateLinks: [], updatedAt: at };
  }
  const outcome = move.reason?.trim();
  return { ...task, state: move.to, ...(outcome ? { outcome } : {}), updatedAt: at };
}

// Same words as the board's PR line: only "ready to merge" is ready for the owner.
const OPEN_PR_READY = new Set<DeliveryRecord["status"]>(["ready-to-merge", "waiting-approval"]);

/** The task state its pull requests prove, or null when they prove nothing yet. Merged needs every
 * linked PR off the open list. A PR never proves live: only the project's live check does. */
export function stateFromPrs(records: readonly DeliveryRecord[]): "working" | "ready" | "merged" | null {
  if (records.length === 0) return null;
  const merged = (r: DeliveryRecord) => r.forgeState === "merged" || r.status === "merged-needs-verification" || (r.status === "complete" && r.mergeCommitSha !== null);
  const closed = (r: DeliveryRecord) => merged(r) || r.forgeState === "closed" || r.status === "explicitly-abandoned" || r.status === "closed-needs-disposition";
  const open = records.filter((r) => !closed(r));
  if (open.length > 0) return open.every((r) => OPEN_PR_READY.has(r.status)) ? "ready" : "working";
  return records.some(merged) ? "merged" : null;
}

export function linkedPrs(task: Pick<OwnerTask, "crewIds" | "prs">, records: readonly DeliveryRecord[]): DeliveryRecord[] {
  return records.filter((r) => task.prs.includes(r.id) || task.crewIds.includes(r.taskId));
}

const STATE_WORDS: Record<TaskState, string> = {
  working: "working",
  needs_you: "needs you",
  ready: "ready for you",
  check: "finished, check",
  merged: "merged, not live yet",
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

/** One task as the Telegram connector reads it, for the task's status line and /tasks. */
export type TelegramTask = Pick<OwnerTask, "id" | "project" | "title" | "state" | "createdAt" | "updatedAt"> & {
  /** The BB project of the task's crews: the connector's topic for the task comes from this id only. */
  projectId: string | null;
  /** Crews of the task that are starting or run now. */
  crews: number;
  /** What the task waits on, in the owner's words. Null once it is closed. */
  waitsOn: string | null;
  /** The owner's Telegram messages that started it: tg:<chat>:<message>. */
  refs: string[];
};

function waitsOn(task: OwnerTask, crews: number): string | null {
  if (!isOpenTask(task)) return null;
  if (task.state === "needs_you" || task.state === "ready") return "you";
  if (task.state === "check") return "the captain's check";
  if (task.state === "merged" && crews === 0) return "going live";
  return crews > 0 ? `${crews} crew${crews === 1 ? "" : "s"}` : "the captain";
}

/**
 * Every open task, and each that changed at or after `since`, for the connector. `crewIds` are the crews
 * that start or run now: a crew still starting counts, so a status line never says 0 crews while one starts.
 */
export function telegramTasks(tasks: readonly OwnerTask[], crewIds: readonly string[], since: number): TelegramTask[] {
  const running = new Set(crewIds);
  return tasks.filter((task) => isOpenTask(task) || task.updatedAt >= since).map((task) => {
    const crews = task.crewIds.filter((id) => running.has(id)).length;
    return {
      id: task.id, project: task.project, projectId: task.projectId ?? null, title: task.title, state: task.state, createdAt: task.createdAt, updatedAt: task.updatedAt,
      crews, waitsOn: waitsOn(task, crews), refs: task.sourceRefs.filter((ref) => ref.startsWith("tg:")),
    };
  });
}

/** The task an owner message started: the newest open one that holds it, else the newest closed one. */
export function taskOfRef(tasks: readonly OwnerTask[], ref: string): OwnerTask | undefined {
  const holding = tasks.filter((task) => task.sourceRefs.includes(ref));
  return holding.filter(isOpenTask).at(-1) ?? holding.at(-1);
}

/** How a crew left: delivered means it reported DONE or its work landed. */
export type CrewFinish = { delivered: boolean; outcome: string };

/** A crew's "done" with no PR proves nothing: the captain checks, then makes the task live with evidence or drops it. */
const CHECK_DONE = "Next: check the work, then make it live with evidence or drop it with the owner's words";

/** The state a task takes when its last crew finishes, or null to leave it. Pull requests decide
 * when the task has any; without one, every end needs the captain's check (a crew's done closes nothing). */
export function finishedState(task: OwnerTask, records: readonly DeliveryRecord[], finish: CrewFinish): TaskMove | null {
  if (!isOpenTask(task) || task.state === "merged") return null;
  const proved = stateFromPrs(linkedPrs(task, records));
  if (proved === "merged") return { to: proved, reason: finish.outcome };
  if (proved !== null) return null;
  return finish.delivered
    ? { to: "check", reason: `${finish.outcome || "Crew reported done"}. ${CHECK_DONE}` }
    : { to: "check", reason: finish.outcome || "Crew retired without reporting done" };
}

/** Owner decision Q8: the step a task takes when a crew reports done. No PR: check (owner decision Q1,
 * 18 Oct: a crew's done never closes a task). A merged PR: merged. Open PRs: ready to merge when each is verified at its head, else check (verify first).
 * PRs closed without a merge: check. */
export function reportedDoneState(task: OwnerTask, records: readonly DeliveryRecord[], outcome: string): TaskMove | null {
  if (!isOpenTask(task) || task.state === "merged") return null;
  const linked = linkedPrs(task, records);
  const reason = outcome.trim() || "Crew reported done";
  if (linked.length === 0) return { to: "check", reason: `${reason}. ${CHECK_DONE}` };
  const proved = stateFromPrs(linked);
  if (proved === "merged") return { to: proved, reason };
  const open = linked.filter((r) => r.forgeState !== "merged" && r.forgeState !== "closed" && r.status !== "explicitly-abandoned" && r.status !== "closed-needs-disposition" && r.status !== "complete");
  if (open.length > 0 && open.every((r) => r.verifiedCommitSha !== null && r.verifiedCommitSha === r.headSha)) return { to: "ready", reason: `${reason}. Next: merge ${open.map((r) => r.id).join(", ")}` };
  if (open.length > 0) return { to: "check", reason: `${reason}. Next: verify ${open.map((r) => r.id).join(", ")} at its head` };
  return { to: "check", reason: `${reason}. Its PRs closed without a merge` };
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
  /**
   * Put another crew on an existing task. Work restarts, so the task goes back to working, a finished
   * one too (new work on it reopens it). A task with no project yet (opened by hand) takes the crew's project.
   */
  attach(id: string, captain: string, input: { crewId: string; sourceRefs: readonly string[]; project?: { id: string; label: string | null }; at: number }): OwnerTask;
  /** The task, open or closed, that already holds one of these PRs. */
  holding(captain: string, prs: (pr: string, task: OwnerTask) => boolean): OwnerTask | undefined;
  /** Correct the record: take a crew that never worked on the task off it. Moves no state. */
  removeCrew(id: string, captain: string, input: Correction & { crewId: string }, at: number): OwnerTask;
  /** Correct a dropped task's reason; the owner's message ref stays. Moves no state. */
  amendDropReason(id: string, captain: string, input: Correction & { text: string }, at: number): OwnerTask;
  /** Record that Live/dropped cleanup kept the worktree because it still has unsaved work. Moves no state. */
  keepWorktree(id: string, captain: string, note: "kept: unsaved work"): OwnerTask;
  /** A crew finished. When no other crew of its task still runs, settle the task. */
  finishCrew(captain: string, crewId: string, finish: CrewFinish, running: (crewId: string) => boolean,
    recordsFor: (task: OwnerTask) => readonly DeliveryRecord[], at: number): OwnerTask | undefined;
  /** A crew reported done (a DONE line or a native done status). When no other crew of its task runs, move the task to its next step. */
  crewReportedDone(captain: string, crewId: string, outcome: string, running: (crewId: string) => boolean,
    recordsFor: (task: OwnerTask) => readonly DeliveryRecord[], at: number): OwnerTask | undefined;
  /**
   * Move each task to the state its pull requests prove. Finished tasks are read too: an open PR on a
   * live or done task, or a PR it did not hold before, reopens it. A dropped task reopens only for a new
   * PR. Returns the tasks that changed.
   */
  reconcile(captain: string, recordsFor: (task: OwnerTask) => readonly DeliveryRecord[], at: number): OwnerTask[];
};

// Moves an open program (or a release with no read-back) may hold back.
const GUARDED = new Set<TaskState>(["merged", "live", "done", "dropped"]);

/** Why a task must stay open (an open program holds it, or a release has no read-back), or null when it
 * may take `move`. `move.checked` names the project live check that proved a live move. */
export type HeldOpen = (task: OwnerTask, to: TaskState, move?: TaskMove) => string | null;

const isOpenPr = (r: DeliveryRecord) => r.forgeState !== "merged" && r.forgeState !== "closed" && r.status !== "explicitly-abandoned"
  && r.status !== "closed-needs-disposition" && r.status !== "complete" && r.status !== "merged-needs-verification" && r.mergeCommitSha === null;

/**
 * `changed` runs after each write that changed a task, once its transaction is done: the Telegram
 * connector redraws that task's status line from it.
 */
export function createOwnerTasks(db: Database, heldOpen: HeldOpen = () => null, changed: (task: OwnerTask) => void = () => {}): OwnerTasks {
  const notify = (task: OwnerTask): OwnerTask => {
    queueMicrotask(() => changed(task));
    return task;
  };

  db.exec(`CREATE TABLE IF NOT EXISTS owner_task (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, captain TEXT NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS owner_task_captain ON owner_task(captain, state);`);

  function get(id: string): OwnerTask | undefined {
    const row = db.prepare("SELECT record FROM owner_task WHERE id=?").get(id) as { record: string } | undefined;
    if (!row) return undefined;
    const parsed = JSON.parse(row.record) as OwnerTask;
    return { generation: 1, ...parsed };
  }

  function save(task: OwnerTask): OwnerTask {
    db.prepare("UPDATE owner_task SET state=?, record=? WHERE id=?").run(task.state, JSON.stringify(task), task.id);
    return notify(task);
  }

  function list(captain: string, scope: { includeClosed?: boolean } = {}): OwnerTask[] {
    const rows = (scope.includeClosed
      ? db.prepare("SELECT record FROM owner_task WHERE captain=? ORDER BY seq").all(captain)
      : db.prepare(`SELECT record FROM owner_task WHERE captain=? AND state IN (${OPEN_TASK_STATES.map(() => "?").join(",")}) ORDER BY seq`).all(captain, ...OPEN_TASK_STATES)) as { record: string }[];
    return rows.map((row) => {
      const parsed = JSON.parse(row.record) as OwnerTask;
      return { generation: 1, ...parsed };
    });
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
          projectId: input.projectId ?? null,
          title,
          sourceRefs: [...new Set(input.sourceRefs)],
          state: "working",
          prs: [...new Set(input.prs ?? [])],
          crewIds: input.crewId ? [input.crewId] : [],
          backfilled: input.backfilled === true,
          generation: 1,
          createdAt: input.at,
          updatedAt: input.at,
        };
        db.prepare("INSERT INTO owner_task VALUES (?,?,?,?,?)").run(task.id, seq, task.captain, task.state, JSON.stringify(task));
        return notify(task);
      })();
    },
    get,
    list,
    openByRef,
    move(id, captain, move, at) {
      return db.transaction(() => {
        const task = owned(id, captain);
        const held = GUARDED.has(move.to) && task.state !== move.to ? heldOpen(task, move.to, move) : null;
        if (held !== null) throw new Error(held);
        if (task.state === move.to) {
          const outcome = "reason" in move ? move.reason?.trim() : "";
          if (!outcome || task.outcome === outcome) return task;
          return save({ ...task, outcome, updatedAt: at });
        }
        const next = moveTask(task, move, at);
        if (next === task) return task;
        if (isFinishedTask(task) && !isFinishedTask(next)) {
          return save({ ...next, generation: taskOpenEpoch(task) + 1 });
        }
        return save(next);
      })();
    },
    linkPr(id, captain, pr, at) {
      return db.transaction(() => {
        const task = owned(id, captain);
        if (task.prs.includes(pr)) return task;
        // On a finished task the link is new work: the next reconcile reopens it once the PR is open or merged.
        if (isFinishedTask(task)) return save({ ...task, prs: [...task.prs, pr], lateLinks: [...(task.lateLinks ?? []), pr] });
        return save({ ...task, prs: [...task.prs, pr], updatedAt: at });
      })();
    },
    attach(id, captain, input) {
      return db.transaction(() => {
        const task = owned(id, captain);
        const crewIds = task.crewIds.includes(input.crewId) ? task.crewIds : [...task.crewIds, input.crewId];
        const sourceRefs = [...new Set([...task.sourceRefs, ...input.sourceRefs])];
        const fresh = !task.crewIds.includes(input.crewId);
        const restarted = task.state !== "working" && (isOpenTask(task) || fresh) ? moveTask(task, { to: "working", reason: `Crew ${input.crewId} started on it` }, input.at) : task;
        // The label follows the crew only when the task had none, so an older task keeps its board label.
        const project = !task.projectId && input.project
          ? { projectId: input.project.id, project: task.project ?? projectName(input.project.label, list(captain, { includeClosed: true }).map((item) => item.project)) }
          : {};
        if (restarted === task && crewIds === task.crewIds && sourceRefs.length === task.sourceRefs.length && !("projectId" in project)) return task;
        const generation = isFinishedTask(task) && restarted.state !== task.state ? taskOpenEpoch(task) + 1 : taskOpenEpoch(restarted);
        return save({ ...restarted, ...project, crewIds, sourceRefs, generation, updatedAt: input.at });
      })();
    },
    removeCrew(id, captain, input, at) {
      return db.transaction(() => {
        const task = owned(id, captain);
        const reason = input.reason.trim();
        if (reason === "") throw new Error(`Removing a crew from task ${id} needs a reason.`);
        if (!task.crewIds.includes(input.crewId)) throw new Error(`Task ${id} has no crew ${input.crewId}.`);
        const entry: TaskCorrection = { at, actor: input.actor, action: "remove-crew", before: input.crewId, after: null, reason };
        return save({ ...task, crewIds: task.crewIds.filter((crew) => crew !== input.crewId), history: [...(task.history ?? []), entry] });
      })();
    },
    amendDropReason(id, captain, input, at) {
      return db.transaction(() => {
        const task = owned(id, captain);
        if (task.state !== "dropped") throw new Error(`Task ${id} is ${task.state}; only a dropped task has a drop reason.`);
        const reason = input.reason.trim(), text = input.text.trim();
        if (reason === "" || text === "") throw new Error(`Amending task ${id}'s drop reason needs a reason and the new words.`);
        const entry: TaskCorrection = { at, actor: input.actor, action: "amend-drop-reason", before: task.dropReason ?? "", after: text, reason };
        return save({ ...task, dropReason: text, history: [...(task.history ?? []), entry] });
      })();
    },
    keepWorktree(id, captain, note) {
      return db.transaction(() => {
        const task = owned(id, captain);
        if (task.worktreeKept === note) return task;
        return save({ ...task, worktreeKept: note });
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
        if (move === null || (GUARDED.has(move.to) && heldOpen(task, move.to, move) !== null)) return task;
        return save(moveTask(task, move, at));
      })();
    },
    crewReportedDone(captain, crewId, outcome, running, recordsFor, at) {
      return db.transaction(() => {
        const task = list(captain).find((item) => item.crewIds.includes(crewId));
        if (!task || task.crewIds.some((other) => other !== crewId && running(other))) return task;
        const move = reportedDoneState(task, recordsFor(task), outcome);
        if (move === null || move.to === task.state || (GUARDED.has(move.to) && heldOpen(task, move.to, move) !== null)) return task;
        return save(moveTask(task, move, at));
      })();
    },
    reconcile(captain, recordsFor, at) {
      return db.transaction(() => {
        const changed: OwnerTask[] = [];
        for (const task of list(captain, { includeClosed: true })) {
          const linked = linkedPrs(task, recordsFor(task));
          const added = linked.filter((r) => !task.prs.includes(r.id));
          const prs = [...task.prs, ...added.map((r) => r.id)];
          const proved = stateFromPrs(linked);
          const finished = isFinishedTask(task);
          // A PR from before a task finished only joins its record; new work is an open PR, or a merged one opened after it finished.
          // A PR closed without a merge is no work at all. The finish time is finishedAt; records from before it have updatedAt.
          const finishedAt = task.finishedAt ?? task.updatedAt;
          const late = new Set(task.lateLinks ?? []);
          const isNew = (r: DeliveryRecord) => late.has(r.id) || (r.openedAt ?? 0) > finishedAt || (added.includes(r) && isOpenPr(r));
          const fresh = finished ? linked.filter((r) => (isOpenPr(r) || r.forgeState === "merged" || r.mergeCommitSha !== null) && isNew(r)) : added;
          let next = added.length === 0 ? task : { ...task, prs, ...(finished ? {} : { updatedAt: at }) };
          // New work on a finished task reopens it; so does a PR still open on a live or done one. A dropped one reopens only for new work.
          const stillOpen = task.state !== "dropped" ? linked.filter(isOpenPr) : [];
          if (finished && (fresh.length > 0 || stillOpen.length > 0)) {
            const why = fresh.length > 0 ? `New PR ${fresh.map((r) => r.id).join(", ")} on a finished task` : `PR ${stillOpen.map((r) => r.id).join(", ")} is still open`;
            next = { ...moveTask(next, { to: "working", reason: why }, at), generation: taskOpenEpoch(task) + 1 };
          } else if (finished) {
            if (next !== task) changed.push(save(next));
            continue;
          }
          // A PR proves progress, never a step back to a state the captain set by hand.
          if (proved !== null && proved !== next.state && TASK_TRANSITIONS[next.state].includes(proved)
            && !(proved === "working" && (next.state === "needs_you" || next.state === "check")) && !(GUARDED.has(proved) && heldOpen(next, proved) !== null)) {
            next = moveTask(next, { to: proved }, at);
          }
          if (next !== task) changed.push(save(next));
        }
        return changed;
      })();
    },
  };
}
