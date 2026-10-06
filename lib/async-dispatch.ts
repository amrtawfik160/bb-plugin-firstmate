import { countsTowardActiveCap } from "./honest-status.ts";

export type AdmissionAction = "admit" | "queue" | "refuse";

export type AdmissionDecision = {
  action: AdmissionAction;
  activeCount: number;
  cap: number;
  reason: string | null;
};

export function admissionDecision(input: {
  cap: number;
  statuses: readonly string[];
  waitingCount?: number;
  flagOn: boolean;
  adding?: number;
}): AdmissionDecision {
  const adding = input.adding ?? 1;
  const active = input.statuses.filter((status) => countsTowardActiveCap(status)).length + (input.waitingCount ?? 0);
  if (input.cap <= 0) return { action: "admit", activeCount: active, cap: input.cap, reason: null };
  if (active + adding <= input.cap) return { action: "admit", activeCount: active, cap: input.cap, reason: null };
  const reason = `Crew cap reached: ${active} crews running (cap ${input.cap}).`;
  if (input.flagOn) return { action: "queue", activeCount: active, cap: input.cap, reason: `${reason} Queued until a slot opens.` };
  return { action: "refuse", activeCount: active, cap: input.cap, reason: `${reason} Queue this with firstmate_queue and dispatch when a crew finishes, or ask the captain to raise the cap.` };
}

export const QUOTA_BACKOFF_MS = 30_000;
export const QUOTA_BACKOFF_MAX_MS = 10 * 60_000;

export function spawnBackoffMs(input: {
  rateLimited: boolean;
  resetsAt: number | null;
  now: number;
  attempt?: number;
}): number {
  if (!input.rateLimited) return 0;
  if (input.resetsAt !== null && input.resetsAt > input.now) return Math.min(QUOTA_BACKOFF_MAX_MS, input.resetsAt - input.now);
  const attempt = Math.max(0, input.attempt ?? 0);
  return Math.min(QUOTA_BACKOFF_MAX_MS, QUOTA_BACKOFF_MS * 2 ** attempt);
}

export type DispatchJobState = "reserved" | "queued" | "spawning" | "started" | "failed";

export type DispatchJob = {
  crewId: string;
  captainThreadId: string;
  payload: string;
  state: DispatchJobState;
  createdAt: number;
  startedAt: number | null;
  error: string | null;
  backoffUntil: number | null;
};

type Database = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

export function createDispatchJobs(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS dispatch_jobs (
    crew_id TEXT PRIMARY KEY, captain TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS dispatch_jobs_state ON dispatch_jobs(state, created_at);`);
  function get(crewId: string): DispatchJob | undefined {
    const found = db.prepare("SELECT record FROM dispatch_jobs WHERE crew_id=?").get(crewId) as { record: string } | undefined;
    return found ? JSON.parse(found.record) as DispatchJob : undefined;
  }
  function save(job: DispatchJob) {
    db.prepare("INSERT INTO dispatch_jobs VALUES (?,?,?,?,?) ON CONFLICT(crew_id) DO UPDATE SET captain=excluded.captain,state=excluded.state,record=excluded.record")
      .run(job.crewId, job.captainThreadId, job.state, job.createdAt, JSON.stringify(job));
    return job;
  }
  function due(now: number, limit = 20): DispatchJob[] {
    const rows = db.prepare("SELECT record FROM dispatch_jobs WHERE state IN ('reserved','queued') ORDER BY created_at LIMIT ?").all(limit) as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as DispatchJob).filter((job) => job.backoffUntil == null || job.backoffUntil <= now);
  }
  return { get, save, due };
}
