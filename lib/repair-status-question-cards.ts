import { createOwnerAsks } from "./owner-asks.ts";
import { createOwnerTasks, isOpenTask } from "./owner-tasks.ts";

/** Resolution written on a question that was a status record, not an owner choice. */
export const STATUS_RECORD_RESOLUTION = "Status record, not an owner question.";

type Database = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
};

export type StatusQuestionRepair = {
  id: string;
  captain: string;
  task?: string;
  cancelled: boolean;
  noted: boolean;
};

/**
 * Cancel open question cards that have no options, and copy their text onto the
 * bound task when that task is still open. Safe to run more than once.
 */
export function repairStatusQuestionCards(db: Database, now = Date.now()): StatusQuestionRepair[] {
  const asks = createOwnerAsks(db);
  const tasks = createOwnerTasks(db);
  const out: StatusQuestionRepair[] = [];
  const captains = [...new Set((db.prepare("SELECT DISTINCT captain FROM owner_ask").all() as { captain: string }[]).map((row) => row.captain))];
  for (const captain of captains) {
    for (const ask of asks.listOpen(captain)) {
      if (ask.kind !== "question" || ask.options.length > 0) continue;
      let noted = false;
      if (ask.task) {
        const task = tasks.get(ask.task);
        if (task && task.captain === captain && isOpenTask(task)) {
          tasks.move(task.id, captain, { to: "needs_you", reason: ask.text }, now);
          noted = true;
        }
      }
      const cancelled = asks.resolve(ask.id, captain, "cancelled", STATUS_RECORD_RESOLUTION, now) !== undefined;
      out.push({ id: ask.id, captain, ...(ask.task ? { task: ask.task } : {}), cancelled, noted });
    }
  }
  return out;
}
