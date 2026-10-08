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
  impact?: string;
  options: AskOption[];
  recommended: number | null;
  defaultAt: number | null;
  irreversible: boolean;
  state: AskState;
  resolution: string | null;
  createdAt: number;
  resolvedAt: number | null;
  sourceRef?: string;
  messageUrl?: string;
};

export type NewOwnerAsk = Pick<OwnerAsk, "captain" | "kind" | "text" | "options"> & {
  impact?: string;
  id?: string;
  sourceRef?: string;
  messageUrl?: string;
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
  created_at: number; resolved_at: number | null; impact: string | null; source_ref: string | null; message_url: string | null;
};

export const ASK_KIND_TITLE: Record<AskKind, string> = {
  question: "❓ Question",
  blocker: "⛔ Blocker",
  approval: "✅ Approval needed",
};

export const ASK_KIND_EMOJI: Record<AskKind, string> = { question: "❓", blocker: "⛔", approval: "✅" };

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

export function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1).trimEnd()}…`;
}

/** The question card text the connector sends to the owner. */
export function formatAskCard(ask: Pick<OwnerAsk, "kind" | "text" | "impact" | "options" | "recommended" | "defaultAt">): string {
  const label = recommendedLabel(ask);
  const footer = [
    ...(label !== null ? [`Recommended: ${label}`] : []),
    ...(label !== null && ask.defaultAt !== null ? [`If no answer by ${formatUtcTime(ask.defaultAt)}, I'll go with ${label}.`] : []),
  ];
  return [...(ask.impact ? [ask.impact, ""] : []), ASK_KIND_TITLE[ask.kind], "", ask.text.trim(), ...ask.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${option.label.replace(/^[A-Z][.)]\s*/i, "")}`), ...(footer.length > 0 ? ["", ...footer] : [])].join("\n");
}

/** `ask:<id>` is the connector's outbox source id for an ask card; replies and taps carry it back. */
export function askIdFromSourceEventId(sourceEventId: string | null | undefined): string | null {
  const match = /^ask:([A-Za-z0-9_-]{1,64})$/.exec(sourceEventId ?? "");
  return match ? match[1]! : null;
}

export type OwnerAsks = {
  create(input: NewOwnerAsk): OwnerAsk;
  link(id: string, captain: string, messageUrl: string): boolean;
  get(id: string): OwnerAsk | undefined;
  listOpen(captain: string): OwnerAsk[];
  listCandidates(captain: string, now: number): OwnerAsk[];
  /** Correct or reopen an ask owned by this captain. */
  resolve(id: string, captain: string, state: AskState, resolution: string, at: number): OwnerAsk | undefined;
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
    ...(row.impact ? { impact: row.impact } : {}),
    options,
    recommended: row.recommended,
    defaultAt: row.default_at,
    irreversible: row.irreversible === 1,
    state: row.state as AskState,
    resolution: row.resolution,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
    ...(row.message_url ? { messageUrl: row.message_url } : {}),
  };
}

export function createOwnerAsks(db: Database): OwnerAsks {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_ask (
    id TEXT PRIMARY KEY, captain TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, options TEXT NOT NULL,
    recommended INTEGER, default_at INTEGER, irreversible INTEGER NOT NULL, state TEXT NOT NULL,
    resolution TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER);
    CREATE INDEX IF NOT EXISTS owner_ask_open ON owner_ask(captain, state, created_at);`);

  db.exec(`CREATE TABLE IF NOT EXISTS owner_ask_source (
    captain TEXT NOT NULL, source_ref TEXT NOT NULL, ask_id TEXT NOT NULL,
    PRIMARY KEY(captain, source_ref));
    CREATE TABLE IF NOT EXISTS owner_ask_impact (id TEXT PRIMARY KEY, impact TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_ask_link (
      id TEXT PRIMARY KEY, message_url TEXT NOT NULL);`);

  const select = `SELECT owner_ask.*,
    (SELECT impact FROM owner_ask_impact WHERE id=owner_ask.id) AS impact,
    (SELECT source_ref FROM owner_ask_source WHERE ask_id=owner_ask.id ORDER BY source_ref LIMIT 1) AS source_ref,
    owner_ask_link.message_url FROM owner_ask LEFT JOIN owner_ask_link USING(id)`;

  function get(id: string): OwnerAsk | undefined {
    const row = db.prepare(`${select} WHERE owner_ask.id=?`).get(id) as AskRecord | undefined;
    return row ? fromRecord(row) : undefined;
  }

  function listOpen(captain: string): OwnerAsk[] {
    return (db.prepare(`${select} WHERE captain=? AND state='open' ORDER BY created_at, owner_ask.id`).all(captain) as AskRecord[]).map(fromRecord);
  }

  function create(input: NewOwnerAsk): OwnerAsk {
    let id = input.id ?? newAskId();
    while (input.id === undefined && get(id)) id = newAskId();
    const ask: OwnerAsk = {
      id,
      captain: input.captain,
      kind: input.kind,
      text: input.text,
      ...(input.impact ? { impact: input.impact } : {}),
      options: input.options,
      recommended: input.recommended ?? null,
      defaultAt: input.defaultAt ?? null,
      irreversible: input.irreversible === true,
      state: "open",
      resolution: null,
      createdAt: input.createdAt,
      resolvedAt: null,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      ...(input.messageUrl ? { messageUrl: input.messageUrl } : {}),
    };
    db.prepare("INSERT INTO owner_ask VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
      ask.id, ask.captain, ask.kind, ask.text, JSON.stringify(ask.options), ask.recommended, ask.defaultAt,
      ask.irreversible ? 1 : 0, ask.state, null, ask.createdAt, null,
    );
    if (input.impact) db.prepare("INSERT INTO owner_ask_impact VALUES (?,?)").run(id, input.impact);
    if (input.sourceRef) db.prepare("INSERT INTO owner_ask_source VALUES (?,?,?)").run(input.captain, input.sourceRef, ask.id);
    if (input.messageUrl) db.prepare("INSERT INTO owner_ask_link VALUES (?,?)").run(ask.id, input.messageUrl);
    return ask;
  }

  return {
    create: (input) => db.transaction(() => create(input))(),
    link(id, captain, messageUrl) {
      const current = get(id);
      if (!current || current.captain !== captain) return false;
      db.prepare("INSERT INTO owner_ask_link VALUES (?,?) ON CONFLICT(id) DO UPDATE SET message_url=excluded.message_url").run(id, messageUrl);
      return true;
    },
    get,
    listOpen,
    listCandidates(captain, now) {
      return (db.prepare("SELECT * FROM owner_ask WHERE captain=? AND (state='open' OR (state='answered' AND resolved_at>=?)) ORDER BY created_at, id").all(captain, now - 86_400_000) as AskRecord[]).map(fromRecord);
    },
    resolve(id, captain, state, resolution, at) {
      return db.transaction(() => {
        const current = get(id);
        if (!current || current.captain !== captain) return undefined;
        db.prepare("UPDATE owner_ask SET state=?, resolution=?, resolved_at=? WHERE id=?").run(state, state === "open" ? null : resolution, state === "open" ? null : at, id);
        return { ...current, state, resolution: state === "open" ? null : resolution, resolvedAt: state === "open" ? null : at };
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

export function askLetterAnswer(ask: Pick<OwnerAsk, "options">, text: string): string | null {
  const letter = /^([a-z])\.?$/i.exec(text.trim())?.[1]?.toUpperCase();
  return letter ? ask.options[letter.charCodeAt(0) - 65]?.label ?? null : null;
}
