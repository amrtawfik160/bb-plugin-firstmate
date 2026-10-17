// Durable events for the weekly scorecard (owner decisions Q16, Q21). One row per distinct
// event: its key makes a repeated note a no-op, so a retried command never counts twice.
// Nothing here is capped or pruned, so a whole reporting week is always present.
import type { DatabaseSync } from "node:sqlite";

type Db = Pick<DatabaseSync, "exec" | "prepare">;

export type RedoEvent = { task: string; title: string; crew: string; role: string; shape: string; after: string[]; reason: string };
export type UnprovenEvent = { crew: string; run: string; pr: string | null; gap: string };
export type CheckEvent = { pr: string; commitSha: string; crew: string; model: string; verdict: "pass" | "fail"; findings: number | null; notes: string };
type TaskCrew = { task: string; crew: string; role: string; shape: string };

export function createQualityEvents(db: Db) {
  db.exec("CREATE TABLE IF NOT EXISTS quality_events (key TEXT PRIMARY KEY, kind TEXT NOT NULL, captain TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS quality_events_week ON quality_events (kind, captain, at);");
  const insert = db.prepare("INSERT OR IGNORE INTO quality_events (key, kind, captain, at, data) VALUES (?, ?, ?, ?, ?)");
  const note = (key: string, kind: string, captain: string, at: number, data: unknown) => Number(insert.run(key, kind, captain, at, JSON.stringify(data)).changes) > 0;
  const rows = <T>(kind: string, captain: string, since: number, until: number) =>
    (db.prepare("SELECT at, data FROM quality_events WHERE kind = ? AND captain = ? AND at >= ? AND at < ? ORDER BY at, key").all(kind, captain, since, until) as { at: number; data: string }[])
      .map((row) => ({ ...(JSON.parse(row.data) as T), at: row.at }));

  return {
    /** Records that a crew works on an owner task. Returns the redo it is, or null: the same
     * task already had a crew of the same role and shape. Checkers check; they redo nothing. */
    noteTaskCrew(input: TaskCrew & { captain: string; title: string; at: number }): RedoEvent | null {
      const before = db.prepare("SELECT data FROM quality_events WHERE kind = 'task-crew' AND captain = ? AND key LIKE ?").all(input.captain, `task-crew:${input.task}:%`) as { data: string }[];
      const fresh = note(`task-crew:${input.task}:${input.crew}`, "task-crew", input.captain, input.at, { task: input.task, crew: input.crew, role: input.role, shape: input.shape });
      if (!fresh || input.role === "checker") return null;
      const after = before.map((row) => JSON.parse(row.data) as TaskCrew).filter((c) => c.role === input.role && c.shape === input.shape).map((c) => c.crew);
      if (after.length === 0) return null;
      const redo: RedoEvent = { task: input.task, title: input.title, crew: input.crew, role: input.role, shape: input.shape, after, reason: `another ${input.role} ${input.shape} crew on owner task ${input.task} after ${after.join(", ")}` };
      note(`redo:${input.crew}`, "redo", input.captain, input.at, redo);
      return redo;
    },
    /** A crew's done claim without its proof step. One per crew run (thread). */
    noteUnproven(input: UnprovenEvent & { captain: string; at: number }): boolean {
      return note(`unproven:${input.crew}:${input.run}`, "unproven", input.captain, input.at, { crew: input.crew, run: input.run, pr: input.pr, gap: input.gap });
    },
    /** A checker crew's verdict. One per PR, head and checker crew. */
    noteCheck(input: CheckEvent & { captain: string; at: number }): boolean {
      const { captain, at, ...data } = input;
      return note(`check:${input.pr}:${input.commitSha}:${input.crew}`, "check", captain, at, data);
    },
    week(since: number, until: number, captain: string) {
      return {
        redone: rows<RedoEvent>("redo", captain, since, until),
        unproven: rows<UnprovenEvent>("unproven", captain, since, until),
        checks: rows<CheckEvent>("check", captain, since, until),
      };
    },
  };
}

export type QualityEvents = ReturnType<typeof createQualityEvents>;
