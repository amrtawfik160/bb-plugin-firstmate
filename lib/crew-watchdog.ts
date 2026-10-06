import { createHash } from "node:crypto";

export const WATCHDOG_MAX_TURNS = 8;
export const WATCHDOG_MAX_WALL_MS = 45 * 60_000;
export const WATCHDOG_MAX_429 = 2;
export const WATCHDOG_NEAR_IDENTICAL = 15;

export type WatchdogReason = "turns" | "wall-clock" | "rate-limit" | "loop";

export type WatchdogState = {
  crewId: string;
  threadId: string;
  startedAt: number;
  turns: number;
  rateLimitCount: number;
  lastOutputHash: string | null;
  nearIdentical: number;
  trippedAt: number | null;
  reason: WatchdogReason | null;
  savedState: string | null;
};

export function emptyWatchdog(crewId: string, threadId: string, startedAt: number): WatchdogState {
  return {
    crewId,
    threadId,
    startedAt,
    turns: 0,
    rateLimitCount: 0,
    lastOutputHash: null,
    nearIdentical: 0,
    trippedAt: null,
    reason: null,
    savedState: null,
  };
}

export function hashOutput(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/g, " ").trim()).digest("hex");
}

export function observeOutput(state: WatchdogState, text: string): WatchdogState {
  const next = hashOutput(text);
  if (state.lastOutputHash !== null && state.lastOutputHash === next) {
    return { ...state, lastOutputHash: next, nearIdentical: state.nearIdentical + 1 };
  }
  return { ...state, lastOutputHash: next, nearIdentical: 0 };
}

export function observeTurn(state: WatchdogState): WatchdogState {
  return { ...state, turns: state.turns + 1 };
}

export function observeRateLimit(state: WatchdogState): WatchdogState {
  return { ...state, rateLimitCount: state.rateLimitCount + 1 };
}

export function watchdogTrip(state: WatchdogState, now: number): WatchdogReason | null {
  if (state.trippedAt !== null) return state.reason;
  if (state.rateLimitCount >= WATCHDOG_MAX_429) return "rate-limit";
  if (state.nearIdentical >= WATCHDOG_NEAR_IDENTICAL) return "loop";
  if (state.turns >= WATCHDOG_MAX_TURNS) return "turns";
  if (now - state.startedAt >= WATCHDOG_MAX_WALL_MS) return "wall-clock";
  return null;
}

export function tripWatchdog(state: WatchdogState, now: number, savedState: string): WatchdogState {
  const reason = watchdogTrip(state, now);
  if (reason === null) return state;
  return { ...state, trippedAt: now, reason, savedState };
}

export function watchdogFailText(state: WatchdogState): string {
  const reason = state.reason ?? "unknown";
  return `Watchdog stopped crew ${state.crewId} (${reason}). State saved. next: bb firstmate tell|retry|forget ${state.crewId}`;
}

export function providerErrorIsRateLimit(row: { type?: string; data?: unknown }): boolean {
  if (row.type !== "provider/error") return false;
  const data = row.data !== null && typeof row.data === "object" && !Array.isArray(row.data)
    ? row.data as Record<string, unknown>
    : {};
  const info = data.errorInfo !== null && typeof data.errorInfo === "object" && !Array.isArray(data.errorInfo)
    ? data.errorInfo as Record<string, unknown>
    : {};
  if (info.category === "rate-limit") return true;
  const detail = String(data.detail ?? data.message ?? "");
  return /429|rate.?limit|quota|resource.?exhausted/i.test(detail);
}

type Database = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
};

export function createWatchdogStore(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS crew_watchdog (
    crew_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, started_at INTEGER NOT NULL, record TEXT NOT NULL);`);
  function get(crewId: string): WatchdogState | undefined {
    const found = db.prepare("SELECT record FROM crew_watchdog WHERE crew_id=?").get(crewId) as { record: string } | undefined;
    return found ? JSON.parse(found.record) as WatchdogState : undefined;
  }
  function save(state: WatchdogState) {
    db.prepare("INSERT INTO crew_watchdog VALUES (?,?,?,?) ON CONFLICT(crew_id) DO UPDATE SET thread_id=excluded.thread_id,started_at=excluded.started_at,record=excluded.record")
      .run(state.crewId, state.threadId, state.startedAt, JSON.stringify(state));
    return state;
  }
  function loadOrCreate(crewId: string, threadId: string, startedAt: number): WatchdogState {
    return get(crewId) ?? save(emptyWatchdog(crewId, threadId, startedAt));
  }
  function listTripped(): WatchdogState[] {
    const rows = db.prepare("SELECT record FROM crew_watchdog").all() as { record: string }[];
    return rows.map((r) => JSON.parse(r.record) as WatchdogState).filter((s) => s.trippedAt !== null);
  }
  return { get, save, loadOrCreate, listTripped };
}
