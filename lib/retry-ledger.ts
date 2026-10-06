// A background loop that retries the same failing item every pass needs a terminal
// state, or it logs forever. Each item lives in one of two phases: "retrying"
// (backing off between attempts) and "needs-captain" (background retries stopped,
// the owning captain is told once). Nothing here deletes the work the item names.

export type RetryKind = "launch-reconcile" | "pr-discovery" | "landed-retire";
export type RetryPhase = "retrying" | "needs-captain";

export type RetryItem = {
  kind: RetryKind;
  subject: string;
  owner: string | null;
  label: string;
  hint: string;
  phase: RetryPhase;
  attempts: number;
  reason: string;
  firstAt: number;
  nextAt: number;
  noticed: boolean;
};

export type RetryFailure = {
  item: RetryItem;
  // True when this failure is worth one log line: the first one, a new reason, or the escalation.
  logged: boolean;
  escalated: boolean;
};

export const RETRY_BASE_MS = 60_000;
export const RETRY_MAX_MS = 30 * 60_000;
export const RETRY_BOUND = 8;

type Database = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

// Counters and ages ("last beat: 35484s ago") change on every attempt; they do not make a new reason.
const reasonShape = (reason: string) => reason.replace(/\d+/g, "#");

export function createRetryLedger(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS retry_items (
    kind TEXT NOT NULL, subject TEXT NOT NULL, owner TEXT, phase TEXT NOT NULL, record TEXT NOT NULL,
    PRIMARY KEY (kind, subject));
    CREATE INDEX IF NOT EXISTS retry_items_owner ON retry_items(owner, phase);`);
  function get(kind: RetryKind, subject: string): RetryItem | undefined {
    const row = db.prepare("SELECT record FROM retry_items WHERE kind=? AND subject=?").get(kind, subject) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as RetryItem : undefined;
  }
  function save(item: RetryItem): RetryItem {
    db.prepare("INSERT INTO retry_items VALUES (?,?,?,?,?) ON CONFLICT(kind, subject) DO UPDATE SET owner=excluded.owner,phase=excluded.phase,record=excluded.record")
      .run(item.kind, item.subject, item.owner, item.phase, JSON.stringify(item));
    return item;
  }
  function isDue(kind: RetryKind, subject: string, now: number): boolean {
    const item = get(kind, subject);
    return item === undefined || (item.phase === "retrying" && item.nextAt <= now);
  }
  function fail(input: { kind: RetryKind; subject: string; owner: string | null; label: string; hint?: string; reason: string; now: number }): RetryFailure {
    const prior = get(input.kind, input.subject);
    const attempts = (prior?.attempts ?? 0) + 1;
    const phase: RetryPhase = prior?.phase === "needs-captain" || attempts >= RETRY_BOUND ? "needs-captain" : "retrying";
    const item = save({
      kind: input.kind, subject: input.subject, owner: input.owner, label: input.label, hint: input.hint ?? prior?.hint ?? "",
      phase, attempts, reason: input.reason, firstAt: prior?.firstAt ?? input.now,
      nextAt: input.now + Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** (attempts - 1)),
      noticed: prior?.noticed ?? false,
    });
    const escalated = phase === "needs-captain" && prior?.phase !== "needs-captain";
    const logged = prior === undefined || escalated || reasonShape(prior.reason) !== reasonShape(input.reason);
    return { item, logged, escalated };
  }
  function clear(kind: RetryKind, subject: string): RetryItem | undefined {
    const prior = get(kind, subject);
    if (prior) db.prepare("DELETE FROM retry_items WHERE kind=? AND subject=?").run(kind, subject);
    return prior;
  }
  // Atomic claim so the captain is told about one escalation exactly once.
  function claimNotice(kind: RetryKind, subject: string): boolean {
    const item = get(kind, subject);
    if (!item || item.phase !== "needs-captain" || item.noticed) return false;
    save({ ...item, noticed: true });
    return true;
  }
  function needsCaptain(owner?: string): RetryItem[] {
    const rows = owner === undefined
      ? db.prepare("SELECT record FROM retry_items WHERE phase='needs-captain' ORDER BY kind, subject").all()
      : db.prepare("SELECT record FROM retry_items WHERE phase='needs-captain' AND owner=? ORDER BY kind, subject").all(owner);
    return (rows as { record: string }[]).map((r) => JSON.parse(r.record) as RetryItem);
  }
  return { get, isDue, fail, clear, claimNotice, needsCaptain };
}

export type RetryLedger = ReturnType<typeof createRetryLedger>;
