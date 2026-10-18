import { randomUUID } from "node:crypto";
import { clip, formatAge } from "./owner-asks.ts";

/**
 * Owner decision Q8 (18 Oct): a dated promise to the owner is a record, never only a line in a file the
 * captain rereads. It wakes the captain once at its time and stays on the board until the captain closes it.
 * open: not due yet. waking: its wake is being sent. due: the captain was woken. kept or dropped: closed by the captain.
 */
export type PromiseState = "open" | "waking" | "due" | "kept" | "dropped";

export interface OwnerPromise {
  id: string;
  captain: string;
  /** When it is due, ms. */
  by: number;
  what: string;
  /** The owner message it answers, when it came with a reply. */
  ref: string | null;
  task: string | null;
  /** reply: firstmate_reply's promise. followups: the one-time import of the captain's follow-ups file. */
  source: "reply" | "followups";
  state: PromiseState;
  createdAt: number;
  wokenAt: number | null;
  closedAt: number | null;
  reason?: string;
  /** While waking: the store instance that claimed it. A claim by an earlier process (a crash before the send) is taken again. */
  claim?: string | null;
}

export type NewOwnerPromise = Pick<OwnerPromise, "captain" | "by" | "what" | "ref" | "task" | "source"> & { at: number };

type Database = {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  transaction<T>(fn: () => T): () => T;
};

const OPEN: readonly PromiseState[] = ["open", "waking", "due"];
const MAX_AHEAD_MS = 400 * 24 * 60 * 60_000;
/** A date with no time is due at 09:00 Cairo (06:00 UTC), when the owner's digest goes out. */
const DATE_ONLY_HOUR_UTC = 6;

/** When a promise is due, from an ISO date or date-time with its zone; a string says why it is refused. */
export function promiseTime(by: string, now: number): number | string {
  const value = by.trim();
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  if (!dateOnly && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.test(value)) {
    return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)
      ? `promise.by ${value} has a time but no zone: add Z (UTC) or an offset such as +03:00.`
      : `promise.by ${value} is not a date: use 2026-10-21 or 2026-10-21T14:40Z.`;
  }
  const at = dateOnly ? Date.parse(`${value}T${String(DATE_ONLY_HOUR_UTC).padStart(2, "0")}:00:00Z`) : Date.parse(value);
  if (!Number.isFinite(at)) return `promise.by ${value} is not a date: use 2026-10-21 or 2026-10-21T14:40Z.`;
  if (at <= now) return `promise.by ${value} is in the past.`;
  if (at - now > MAX_AHEAD_MS) return `promise.by ${value} is more than a year ahead.`;
  return at;
}

export function promiseLine(promise: OwnerPromise, now: number): string {
  const when = promise.by > now ? `due in ${formatAge(promise.by - now)}` : `overdue ${formatAge(now - promise.by)}`;
  return `- ${promise.id} · ${clip(promise.what, 90)} — ${when}${promise.task ? ` · ${promise.task}` : ""}`;
}

export type OwnerPromises = {
  /** A repeat (same captain, time and words) returns the record it already has. */
  add(input: NewOwnerPromise): { promise: OwnerPromise; created: boolean };
  get(id: string): OwnerPromise | undefined;
  list(captain: string, scope?: { includeClosed?: boolean }): OwnerPromise[];
  /** Open promises whose time came and whose captain was not woken yet. */
  due(captain: string, now: number): OwnerPromise[];
  markWoken(ids: readonly string[], at: number): void;
  /**
   * Takes the due promises in one step, marked waking: a second check in this process finds none, so two checks at
   * once wake once. A claim left by an earlier process (it stopped before markWoken) is taken again, so a crash
   * before the send loses no reminder; a crash between the send and markWoken repeats it once. markWoken records
   * the delivery; release hands a failed wake back.
   */
  claimDue(captain: string, now: number): OwnerPromise[];
  /** A wake that was not delivered: its promises are due again. */
  release(ids: readonly string[]): void;
  close(id: string, captain: string, to: "kept" | "dropped", reason: string, at: number): OwnerPromise;
};

export function createOwnerPromises(db: Database): OwnerPromises {
  const instance = randomUUID();
  db.exec(`CREATE TABLE IF NOT EXISTS owner_promise (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, captain TEXT NOT NULL, state TEXT NOT NULL, due_at INTEGER NOT NULL, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS owner_promise_captain ON owner_promise(captain, state, due_at);`);

  const read = (rows: unknown[]) => (rows as { record: string }[]).map((row) => JSON.parse(row.record) as OwnerPromise);
  const get = (id: string) => read(db.prepare("SELECT record FROM owner_promise WHERE id=?").all(id))[0];
  const save = (promise: OwnerPromise) => {
    db.prepare("UPDATE owner_promise SET state=?, record=? WHERE id=?").run(promise.state, JSON.stringify(promise), promise.id);
    return promise;
  };
  const list = (captain: string, scope: { includeClosed?: boolean } = {}) => read(scope.includeClosed
    ? db.prepare("SELECT record FROM owner_promise WHERE captain=? ORDER BY due_at, seq").all(captain)
    : db.prepare(`SELECT record FROM owner_promise WHERE captain=? AND state IN (${OPEN.map(() => "?").join(",")}) ORDER BY due_at, seq`).all(captain, ...OPEN));

  return {
    add(input) {
      return db.transaction(() => {
        const what = input.what.replace(/\s+/g, " ").trim().slice(0, 500);
        const existing = list(input.captain, { includeClosed: true }).find((p) => p.by === input.by && p.what === what);
        if (existing) return { promise: existing, created: false };
        const last = db.prepare("SELECT max(seq) AS seq FROM owner_promise").get() as { seq: number | null };
        const seq = (last.seq ?? 0) + 1;
        const promise: OwnerPromise = {
          id: `P${seq}`, captain: input.captain, by: input.by, what, ref: input.ref, task: input.task, source: input.source,
          state: "open", createdAt: input.at, wokenAt: null, closedAt: null,
        };
        db.prepare("INSERT INTO owner_promise VALUES (?,?,?,?,?,?)").run(promise.id, seq, promise.captain, promise.state, promise.by, JSON.stringify(promise));
        return { promise, created: true };
      })();
    },
    get,
    list,
    due(captain, now) {
      return read(db.prepare("SELECT record FROM owner_promise WHERE captain=? AND state='open' AND due_at<=? ORDER BY due_at, seq").all(captain, now));
    },
    markWoken(ids, at) {
      db.transaction(() => {
        for (const id of ids) {
          const promise = get(id);
          if (promise?.state === "open" || promise?.state === "waking") save({ ...promise, state: "due", wokenAt: at, claim: null });
        }
      })();
    },
    claimDue(captain, now) {
      return db.transaction(() => {
        const due = read(db.prepare("SELECT record FROM owner_promise WHERE captain=? AND state IN ('open','waking') AND due_at<=? ORDER BY due_at, seq").all(captain, now))
          .filter((promise) => promise.state === "open" || promise.claim !== instance);
        return due.map((promise) => save({ ...promise, state: "waking", claim: instance }));
      })();
    },
    release(ids) {
      db.transaction(() => {
        for (const id of ids) {
          const promise = get(id);
          if (promise?.state === "waking" && promise.claim === instance) save({ ...promise, state: "open", claim: null });
        }
      })();
    },
    close(id, captain, to, reason, at) {
      return db.transaction(() => {
        const promise = get(id);
        if (!promise || promise.captain !== captain) throw new Error(`No promise ${id} for this captain.`);
        if (!OPEN.includes(promise.state)) throw new Error(`Promise ${id} is already ${promise.state}.`);
        const why = reason.trim();
        if (to === "dropped" && why === "") throw new Error(`Dropping promise ${id} needs a reason.`);
        return save({ ...promise, state: to, closedAt: at, ...(why ? { reason: why } : {}) });
      })();
    },
  };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const TIME = String.raw`(?:\s+(?:about\s+)?(\d{1,2}):(\d{2})\s*UTC)?`;
const ISO_DATE = new RegExp(String.raw`\b(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})\s*UTC)?`, "g");
const DAY_MONTH = new RegExp(String.raw`\b(\d{1,2}) (${MONTHS.join("|")})[a-z]*\.?(?: (\d{4}))?${TIME}`, "gi");

/** Every date and time a line names, read as UTC. A day and month with no year is the nearest such day to now. */
function datesIn(line: string, now: number): number[] {
  const at = (year: number, month: number, day: number, hour?: string, minute?: string) =>
    Date.UTC(year, month, day, hour === undefined ? DATE_ONLY_HOUR_UTC : Number(hour), minute === undefined ? 0 : Number(minute));
  const found: number[] = [];
  for (const m of line.matchAll(ISO_DATE)) found.push(at(Number(m[1]), Number(m[2]) - 1, Number(m[3]), m[4], m[5]));
  const year = new Date(now).getUTCFullYear();
  for (const m of line.matchAll(DAY_MONTH)) {
    const month = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase());
    if (m[3] !== undefined) { found.push(at(Number(m[3]), month, Number(m[1]), m[4], m[5])); continue; }
    const candidates = [year - 1, year, year + 1].map((y) => at(y, month, Number(m[1]), m[4], m[5]));
    found.push(candidates.reduce((best, next) => Math.abs(next - now) < Math.abs(best - now) ? next : best));
  }
  return found.filter(Number.isFinite);
}

export type FollowupPlan = {
  promises: Array<{ line: number; by: number; what: string }>;
  skipped: Array<{ line: number; text: string }>;
};

/**
 * The one-time import of the captain's follow-ups file (owner decision Q8). Each bullet line that names a
 * date after now becomes a promise due at its earliest such date; a sub-bullet carries its parent line.
 * Lines whose dates are all past, or that name none, are listed and left in the file. The caller shows
 * the plan as a dry run first; only the dates are read, never what the words mean.
 */
export function followupPromises(file: string, now: number): FollowupPlan {
  const plan: FollowupPlan = { promises: [], skipped: [] };
  let parent = "";
  file.split("\n").forEach((raw, index) => {
    const bullet = /^(\s*)[-*]\s+(.*)$/.exec(raw);
    if (!bullet || bullet[2]!.trim() === "") return;
    const body = bullet[2]!.trim();
    const nested = bullet[1]!.length > 0;
    if (!nested) parent = body;
    const what = nested && parent ? `${parent} ${body}` : body;
    const future = datesIn(body, now).filter((at) => at > now);
    if (future.length === 0) plan.skipped.push({ line: index + 1, text: clip(body, 120) });
    else plan.promises.push({ line: index + 1, by: Math.min(...future), what: clip(what, 500) });
  });
  return plan;
}
