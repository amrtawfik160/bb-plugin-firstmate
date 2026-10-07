import { randomInt } from "node:crypto";

/** Questions, blockers and approvals the captain thread needs from the owner, kept until answered. */
export type AskKind = "question" | "blocker" | "approval";
export type AskState = "open" | "answered" | "defaulted" | "cancelled";
export type AskOption = { label: string; value: string };

export type OwnerAsk = {
  id: string;
  captain: string;
  kind: AskKind;
  text: string;
  options: AskOption[];
  recommended: number | null;
  defaultAt: number | null;
  irreversible: boolean;
  state: AskState;
  resolution: string | null;
  createdAt: number;
  resolvedAt: number | null;
};

export type NewOwnerAsk = Pick<OwnerAsk, "captain" | "kind" | "text" | "options"> & {
  id?: string;
  recommended?: number | null;
  defaultAt?: number | null;
  irreversible?: boolean;
  createdAt: number;
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

type AskRecord = {
  id: string; captain: string; kind: string; text: string; options: string; recommended: number | null;
  default_at: number | null; irreversible: number; state: string; resolution: string | null;
  created_at: number; resolved_at: number | null;
};

export const ASK_KIND_TITLE: Record<AskKind, string> = {
  question: "❓ Question",
  blocker: "⛔ Blocker",
  approval: "✅ Approval needed",
};

const ASK_KIND_EMOJI: Record<AskKind, string> = { question: "❓", blocker: "⛔", approval: "✅" };

export function newAskId(): string {
  return `a${randomInt(0, 36 ** 6).toString(36).padStart(6, "0")}`;
}

/** Approvals and irreversible asks wait for the owner; they never proceed on a deadline. */
export function mayDefault(ask: Pick<OwnerAsk, "kind" | "irreversible">): boolean {
  return ask.kind !== "approval" && !ask.irreversible;
}

export function recommendedLabel(ask: Pick<OwnerAsk, "options" | "recommended">): string | null {
  return ask.recommended === null ? null : ask.options[ask.recommended]?.label ?? null;
}

export function formatUtcTime(at: number): string {
  return `${new Date(at).toISOString().slice(11, 16)} UTC`;
}

export function formatAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** The question card text the connector sends to the owner. */
export function formatAskCard(ask: Pick<OwnerAsk, "kind" | "text" | "options" | "recommended" | "defaultAt">): string {
  const label = recommendedLabel(ask);
  const footer = [
    ...(label !== null ? [`Recommended: ${label}`] : []),
    ...(label !== null && ask.defaultAt !== null ? [`If no answer by ${formatUtcTime(ask.defaultAt)}, I'll go with ${label}.`] : []),
  ];
  return [ASK_KIND_TITLE[ask.kind], "", ask.text.trim(), ...(footer.length > 0 ? ["", ...footer] : [])].join("\n");
}

export const BOARD_MAX_LINES = 15;
export const BOARD_MAX_CHARS = 3500;
export const BOARD_EMPTY = "📌 Nothing needs you right now.";
export const BOARD_ANSWER_HINT = "Tap a question's button or reply to it to answer.";

/** Plain text for the Telegram board: open asks oldest first, then crew items waiting for the owner. */
export function formatBoard(input: { asks: readonly OwnerAsk[]; calls: readonly string[]; now: number }): string {
  const asks = [...input.asks].filter((ask) => ask.state === "open").sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const items = [
    ...asks.map((ask) => {
      const label = recommendedLabel(ask);
      return `${ASK_KIND_EMOJI[ask.kind]} ${clip(ask.text, 140)} (${formatAge(input.now - ask.createdAt)}, ask ${ask.id})`
        + (label !== null ? ` Recommended: ${label}.` : "")
        + (ask.defaultAt !== null && label !== null ? ` Auto at ${formatUtcTime(ask.defaultAt)}.` : "");
    }),
    ...input.calls.map((call) => clip(call, 160)),
  ];
  if (items.length === 0) return BOARD_EMPTY;
  const lines = items.slice(0, BOARD_MAX_LINES).map((item, index) => `${index + 1}. ${item}`);
  if (items.length > BOARD_MAX_LINES) lines.push(`…and ${items.length - BOARD_MAX_LINES} more`);
  const tail = asks.length > 0 ? `\n\n${BOARD_ANSWER_HINT}` : "";
  const head = `📌 Waiting on you (${items.length})\n\n`;
  const body = lines.join("\n");
  const room = BOARD_MAX_CHARS - head.length - tail.length;
  return `${head}${body.length <= room ? body : `${body.slice(0, room - 1)}…`}${tail}`;
}

/** `ask:<id>` is the connector's outbox source id for an ask card; replies and taps carry it back. */
export function askIdFromSourceEventId(sourceEventId: string | null | undefined): string | null {
  const match = /^ask:([A-Za-z0-9_-]{1,64})$/.exec(sourceEventId ?? "");
  return match ? match[1]! : null;
}

export type OwnerAsks = {
  create(input: NewOwnerAsk): OwnerAsk;
  get(id: string): OwnerAsk | undefined;
  listOpen(captain: string): OwnerAsk[];
  /** Close one open ask owned by this captain; undefined when it is missing, foreign, or already closed. */
  resolve(id: string, captain: string, state: Exclude<AskState, "open">, resolution: string, at: number): OwnerAsk | undefined;
  /** Mark this captain's overdue reversible asks defaulted and return them, each exactly once. */
  takeDue(captain: string, now: number): OwnerAsk[];
};

function fromRecord(row: AskRecord): OwnerAsk {
  let options: AskOption[] = [];
  try {
    const parsed: unknown = JSON.parse(row.options);
    if (Array.isArray(parsed)) options = parsed as AskOption[];
  } catch { /* stored by this module; an unreadable value shows no options */ }
  return {
    id: row.id,
    captain: row.captain,
    kind: row.kind as AskKind,
    text: row.text,
    options,
    recommended: row.recommended,
    defaultAt: row.default_at,
    irreversible: row.irreversible === 1,
    state: row.state as AskState,
    resolution: row.resolution,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

export function createOwnerAsks(db: Database): OwnerAsks {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_ask (
    id TEXT PRIMARY KEY, captain TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, options TEXT NOT NULL,
    recommended INTEGER, default_at INTEGER, irreversible INTEGER NOT NULL, state TEXT NOT NULL,
    resolution TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER);
    CREATE INDEX IF NOT EXISTS owner_ask_open ON owner_ask(captain, state, created_at);`);

  function get(id: string): OwnerAsk | undefined {
    const row = db.prepare("SELECT * FROM owner_ask WHERE id=?").get(id) as AskRecord | undefined;
    return row ? fromRecord(row) : undefined;
  }

  function listOpen(captain: string): OwnerAsk[] {
    return (db.prepare("SELECT * FROM owner_ask WHERE captain=? AND state='open' ORDER BY created_at, id").all(captain) as AskRecord[]).map(fromRecord);
  }

  return {
    create(input) {
      return db.transaction(() => {
        let id = input.id ?? newAskId();
        while (input.id === undefined && get(id)) id = newAskId();
        const ask: OwnerAsk = {
          id,
          captain: input.captain,
          kind: input.kind,
          text: input.text,
          options: input.options,
          recommended: input.recommended ?? null,
          defaultAt: input.defaultAt ?? null,
          irreversible: input.irreversible === true,
          state: "open",
          resolution: null,
          createdAt: input.createdAt,
          resolvedAt: null,
        };
        db.prepare("INSERT INTO owner_ask VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
          ask.id, ask.captain, ask.kind, ask.text, JSON.stringify(ask.options), ask.recommended, ask.defaultAt,
          ask.irreversible ? 1 : 0, ask.state, null, ask.createdAt, null,
        );
        return ask;
      })();
    },
    get,
    listOpen,
    resolve(id, captain, state, resolution, at) {
      return db.transaction(() => {
        const current = get(id);
        if (!current || current.captain !== captain || current.state !== "open") return undefined;
        db.prepare("UPDATE owner_ask SET state=?, resolution=?, resolved_at=? WHERE id=?").run(state, resolution, at, id);
        return { ...current, state, resolution, resolvedAt: at };
      })();
    },
    takeDue(captain, now) {
      return db.transaction(() => {
        const due = listOpen(captain).filter((ask) => ask.defaultAt !== null && ask.defaultAt <= now && mayDefault(ask) && recommendedLabel(ask) !== null);
        return due.map((ask) => {
          const resolution = recommendedLabel(ask)!;
          db.prepare("UPDATE owner_ask SET state='defaulted', resolution=?, resolved_at=? WHERE id=?").run(resolution, now, ask.id);
          return { ...ask, state: "defaulted" as const, resolution, resolvedAt: now };
        });
      })();
    },
  };
}
