import { randomInt } from "node:crypto";

/** Questions, blockers and approvals the captain thread needs from the owner, kept until answered. */
export type AskKind = "question" | "blocker" | "approval";
export type AskState = "open" | "answered" | "defaulted" | "cancelled";
export type AskOption = { label: string; value: string };
export type RoundQuestion = {
  question: string;
  options: AskOption[];
  recommended: number;
};

export type OwnerAsk = {
  id: string;
  captain: string;
  kind: AskKind;
  text: string;
  impact?: string;
  options: AskOption[];
  recommended: number | null;
  /** A grilling batch stored as one ask: 2 to 12 questions in one Telegram message. */
  round?: RoundQuestion[];
  /** 1-based question index to the recorded option label. */
  roundAnswers?: Record<number, string>;
  defaultAt: number | null;
  irreversible: boolean;
  /** An option starts new work (a build, a new crew, a new ticket), so the ask waits for the owner. */
  startsNewWork: boolean;
  state: AskState;
  resolution: string | null;
  createdAt: number;
  resolvedAt: number | null;
  sourceRef?: string;
  messageUrl?: string;
  /** Where the card belongs: its project, its owner task, and its subject (the words before a leading colon). */
  project?: string;
  task?: string;
  subject?: string;
  /**
   * The owner skipped the card ("decide later") until this time: it is still open but waits on no one
   * until then. A card once skipped never proceeds on its deadline: at this time it waits for the owner.
   */
  deferredUntil?: number;
};

export type AskClosure = { closed: string[]; already: string[]; refused: string[] };
export const OWNER_CLOSED_RESOLUTION = "closed by owner, no action";
export const ASK_FOLLOWUP_EFFECTS = ["owner-answered", "refresh-board"] as const;
export const ASK_FOLLOWUP_RETRY_BOUND = 8;
export const ASK_FOLLOWUP_GIVE_UP_MS = 2 * 60 * 60_000;
export type AskFollowUpEffect = (typeof ASK_FOLLOWUP_EFFECTS)[number];
export type AskFollowUpState = "pending" | "done" | "failed";
export type AskFollowUp = {
  askId: string;
  answerSeq: number;
  effect: AskFollowUpEffect;
  state: AskFollowUpState;
  error: string | null;
  createdAt: number;
  attempts: number;
  firstFailedAt: number | null;
  noticed: boolean;
  previous: string | null;
  resolution: string | null;
};

/**
 * Structured button labels from a crew report. JSON only: a whole-note array or
 * `{choices|options:[...]}`, a trailing JSON value, or a `choices:` JSON line.
 * Prose is not parsed and never becomes Yes/No.
 */
export function choicesFromCrewReport(note: string): AskOption[] | null {
  for (const payload of structuredChoicePayloads(note)) {
    const options = parseChoicePayload(payload);
    if (options !== null && options.length > 0) return options;
  }
  return null;
}

/** Structured choices from a crew report, or none. */
export function choicesFromDecisionNote(note: string): AskOption[] {
  return choicesFromCrewReport(note) ?? [];
}

/** Question text with a trailing structured choices payload removed. */
export function crewQuestionText(note: string): string {
  const tail = jsonTail(note.trim());
  if (tail === undefined || tail.length === note.trim().length) return note.trim();
  return note.trim().slice(0, note.trim().length - tail.length).trim();
}

function structuredChoicePayloads(note: string): string[] {
  const trimmed = note.trim();
  const payloads = [trimmed];
  for (const line of trimmed.split("\n")) {
    const text = line.trim();
    const prefix = "choices:";
    if (text.length >= prefix.length && text.slice(0, prefix.length).toLowerCase() === prefix) {
      payloads.push(text.slice(text.indexOf(":") + 1).trim());
    }
  }
  const tail = jsonTail(trimmed);
  if (tail !== undefined) payloads.push(tail);
  return payloads;
}

function jsonTail(text: string): string | undefined {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch !== "{" && ch !== "[") continue;
    const slice = text.slice(i);
    try {
      JSON.parse(slice);
      return slice;
    } catch { /* keep scanning for a trailing JSON value */ }
  }
  return undefined;
}

function parseChoicePayload(raw: string): AskOption[] | null {
  try {
    const value: unknown = JSON.parse(raw);
    const list = Array.isArray(value) ? value
      : value !== null && typeof value === "object" && Array.isArray((value as { choices?: unknown }).choices)
        ? (value as { choices: unknown[] }).choices
      : value !== null && typeof value === "object" && Array.isArray((value as { options?: unknown }).options)
        ? (value as { options: unknown[] }).options
      : null;
    if (list === null || list.length === 0) return null;
    const options: AskOption[] = [];
    for (let i = 0; i < list.length; i++) {
      const item = list[i];
      if (typeof item === "string") {
        const label = item.trim();
        if (label.length === 0 || label.length > 80) return null;
        options.push({ label, value: String.fromCharCode(97 + i) });
        continue;
      }
      if (item !== null && typeof item === "object" && typeof (item as { label?: unknown }).label === "string") {
        const label = (item as { label: string }).label.trim();
        if (label.length === 0 || label.length > 80) return null;
        const value = typeof (item as { value?: unknown }).value === "string" && (item as { value: string }).value.trim() !== ""
          ? (item as { value: string }).value
          : String.fromCharCode(97 + i);
        options.push({ label, value });
        continue;
      }
      return null;
    }
    return options;
  } catch {
    return null;
  }
}

export type AskDeferral = { deferred: string[]; already: string[]; refused: string[]; until: number | null };

export type NewOwnerAsk = Pick<OwnerAsk, "captain" | "kind" | "text" | "options"> & {
  impact?: string;
  id?: string;
  sourceRef?: string;
  messageUrl?: string;
  recommended?: number | null;
  defaultAt?: number | null;
  irreversible?: boolean;
  startsNewWork?: boolean;
  project?: string;
  task?: string;
  subject?: string;
  createdAt: number;
  round?: RoundQuestion[];
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
  created_at: number; resolved_at: number | null; impact: string | null; source_ref: string | null; message_url: string | null; new_work: number;
  route_project: string | null; route_task: string | null; route_subject: string | null; deferred_until: number | null;
};

export const ASK_KIND_EMOJI: Record<AskKind, string> = { question: "❓", blocker: "⛔", approval: "✅" };

export function newAskId(): string {
  return `a${randomInt(0, 36 ** 6).toString(36).padStart(6, "0")}`;
}

/** Approvals, irreversible asks and asks that start new work wait for the owner; they never proceed on a deadline. */
export function mayDefault(ask: Pick<OwnerAsk, "kind" | "irreversible"> & { startsNewWork?: boolean }): boolean {
  return ask.kind !== "approval" && !ask.irreversible && ask.startsNewWork !== true;
}

/** An open card the owner skipped whose time has not come yet. At its time it is back, with nothing to do. */
export function isDeferred(ask: Pick<OwnerAsk, "state" | "deferredUntil">, now: number): boolean {
  return ask.state === "open" && ask.deferredUntil !== undefined && ask.deferredUntil > now;
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

/** Characters a full-width Telegram button shows. Keep equal to BUTTON_ROOM in the connector's src/ask-pack.ts. */
export const ASK_BUTTON_ROOM = 42;

function optionText(label: string): string {
  return label.replace(/^[A-Z][.):]\s*/i, "").trim();
}

/**
 * The question card text the connector sends to the owner: the question first, then impact. The buttons carry
 * the options and mark the recommended one with ✓, so the text lists options only when a button cannot show
 * a whole label. The deadline is one short line.
 */
export function formatAskCard(ask: Pick<OwnerAsk, "kind" | "text" | "impact" | "options" | "recommended" | "defaultAt"> & { startsNewWork?: boolean }): string {
  const label = recommendedLabel(ask);
  const listed = ask.options.some((option) => optionText(option.label).length > ASK_BUTTON_ROOM)
    ? ask.options.map((option, index) => `${String.fromCharCode(65 + index)}. ${optionText(option.label)}`)
    : [];
  const deadline = label !== null && ask.defaultAt !== null
    ? ["", `If no answer by ${formatUtcTime(ask.defaultAt)}, I go with ✓.`]
    : ask.startsNewWork === true ? ["", "This starts new work, so I wait for your answer."] : [];
  return [`${ASK_KIND_EMOJI[ask.kind]} ${ask.text.trim()}`, ...(ask.impact ? [ask.impact] : []), ...listed, ...deadline].join("\n");
}

export const ASK_ROUND_MAX_CHARS = 3000;
export const ASK_ROUND_ANSWER_HINT = "Answer like 1A 2C, or 'yes' to accept all recommended.";

/** One numbered Telegram message for a grilling batch: no buttons, recommended marked with ✓. */
export function formatAskRound(ask: Pick<OwnerAsk, "text" | "round"> & { impact?: string }): string {
  const round = ask.round ?? [];
  const questions = round.map((item, index) => {
    const lines = [`${index + 1}. ${item.question.trim()}`];
    for (let i = 0; i < item.options.length; i++) {
      const letter = String.fromCharCode(65 + i);
      const mark = item.recommended === i ? "✓ " : "";
      lines.push(`${mark}${letter}. ${optionText(item.options[i]!.label)}`);
    }
    return lines.join("\n");
  });
  const first = round[0]?.question.trim() ?? "";
  const title = ask.text.trim() !== "" && ask.text.trim() !== first ? ask.text.trim() : "";
  const head = [title, ask.impact?.trim() ?? ""].filter((part) => part !== "");
  return [...head, ...questions, ASK_ROUND_ANSWER_HINT].join("\n\n");
}

export function isRoundAsk(ask: Pick<OwnerAsk, "round">): boolean {
  return (ask.round?.length ?? 0) >= 2;
}

/**
 * The cards a pack answer recorded. The connector sends "Accept all recommended", "2B" or "1A 3C" with one
 * "- ask <id>: <option label>" line per card under "Answers recorded on the cards:".
 */
export function packAnswers(body: string): Array<{ id: string; answer: string }> {
  const at = body.indexOf("Answers recorded on the cards:");
  if (at < 0) return [];
  return [...body.slice(at).matchAll(/^- ask ([A-Za-z0-9_-]{1,64}): (.+)$/gm)].map((match) => ({ id: match[1]!, answer: match[2]!.trim() }));
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
  /** The open asks that wait on the owner now: open and not skipped until later. */
  listWaiting(captain: string, now: number): OwnerAsk[];
  listCandidates(captain: string, now: number): OwnerAsk[];
  /** Correct or reopen an ask owned by this captain. Owner answers pass `tap` for connector tap identity. */
  resolve(id: string, captain: string, state: AskState, resolution: string, at: number, source?: "owner", tap?: { tapId: string; answeredAt: number }): OwnerAsk | undefined;
  /** Record answers on a grilling round. Partial keeps it open; a full set closes it. */
  recordRoundAnswers(id: string, captain: string, answers: ReadonlyArray<{ n: number; choice: string }>, at: number): { ask: OwnerAsk; complete: boolean; summary: string; error?: string } | undefined;
  answeredByOwner(id: string): boolean;
  /** Close only the named cards, atomically; owner closes are terminal and repeated closes are no-ops. */
  close(ids: readonly string[], captain: string, now?: number): AskClosure;
  untoldCloses(captain: string): OwnerAsk[];
  markClosesTold(ids: readonly string[]): void;
  unreleasedCloses(captain: string): OwnerAsk[];
  markClosesReleased(ids: readonly string[]): void;
  /**
   * The owner skipped these cards until `until`. All or nothing: when any id is not this captain's open
   * ask, nothing changes and `refused` names those ids. `already`: asks still skipped from before, which
   * keep their time; `until` is the time in effect for the cards (null when refused).
   */
  defer(ids: readonly string[], captain: string, until: number, now?: number): AskDeferral;
  /** This captain's skipped asks, still skipped at `now`, whose captain was not told yet. */
  untoldSkips(captain: string, now: number): OwnerAsk[];
  /** The captain was told of these skipped asks. */
  markSkipsTold(ids: readonly string[]): void;
  /** Mark this captain's overdue reversible asks defaulted and return them, each exactly once. */
  takeDue(captain: string, now: number): OwnerAsk[];
  /** Defaulted asks whose captain has not yet been told to go ahead. */
  untoldDefaults(captain: string): OwnerAsk[];
  markDefaultsTold(ids: readonly string[]): void;
  pendingFollowUps(): AskFollowUp[];
  failedFollowUps(): AskFollowUp[];
  markFollowUpDone(askId: string, effect: AskFollowUpEffect, answerSeq?: number): void;
  failFollowUp(askId: string, effect: AskFollowUpEffect, error: string, now?: number, answerSeq?: number): AskFollowUpState;
  recordFollowUpError(askId: string, effect: AskFollowUpEffect, error: string, answerSeq?: number): void;
  claimFollowUpNotice(askId: string, effect: AskFollowUpEffect, answerSeq?: number): boolean;
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
    startsNewWork: row.new_work === 1,
    state: row.state as AskState,
    resolution: row.resolution,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    ...(row.source_ref ? { sourceRef: row.source_ref } : {}),
    ...(row.message_url ? { messageUrl: row.message_url } : {}),
    ...(row.route_project ? { project: row.route_project } : {}),
    ...(row.route_task ? { task: row.route_task } : {}),
    ...(row.route_subject ? { subject: row.route_subject } : {}),
    ...(row.deferred_until !== null && row.deferred_until !== undefined ? { deferredUntil: row.deferred_until } : {}),
  };
}

/** Cards in one pack are sent within this window; a pack never replaces its own cards. */
export const ASK_PACK_WINDOW_MS = 60_000;

/**
 * Owner decision Q7: the open card a new one replaces. Same subject, and the same task, or the same
 * project when neither card has a task. A card from the last minute is part of the same pack.
 */
export function replacedBy(next: Pick<OwnerAsk, "captain" | "project" | "task" | "subject" | "createdAt">, open: readonly OwnerAsk[]): OwnerAsk[] {
  const lower = (text: string | undefined) => (text ?? "").trim().toLowerCase();
  return open.filter((ask) => ask.captain === next.captain && ask.state === "open"
    && next.createdAt - ask.createdAt >= ASK_PACK_WINDOW_MS
    && lower(ask.subject) === lower(next.subject)
    && (next.task !== undefined || ask.task !== undefined ? ask.task === next.task : lower(ask.project) !== "" && lower(ask.project) === lower(next.project)));
}

export function createOwnerAsks(db: Database): OwnerAsks {
  db.exec(`CREATE TABLE IF NOT EXISTS owner_ask (
    id TEXT PRIMARY KEY, captain TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, options TEXT NOT NULL,
    recommended INTEGER, default_at INTEGER, irreversible INTEGER NOT NULL, state TEXT NOT NULL,
    resolution TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER);
    CREATE INDEX IF NOT EXISTS owner_ask_open ON owner_ask(captain, state, created_at);`);

  db.exec(`CREATE TABLE IF NOT EXISTS owner_ask_answer (id TEXT PRIMARY KEY, source TEXT NOT NULL);`);
  try { db.exec("ALTER TABLE owner_ask_answer ADD COLUMN resolution TEXT"); } catch { /* already present on this database */ }
  try { db.exec("ALTER TABLE owner_ask_answer ADD COLUMN at INTEGER"); } catch { /* already present on this database */ }
  try { db.exec("ALTER TABLE owner_ask_answer ADD COLUMN tap_id TEXT"); } catch { /* already present on this database */ }
  db.exec(`CREATE TABLE IF NOT EXISTS owner_ask_reopen (id TEXT PRIMARY KEY, at INTEGER NOT NULL);`);
  try {
    db.exec("UPDATE owner_ask_answer SET resolution=(SELECT resolution FROM owner_ask WHERE owner_ask.id=owner_ask_answer.id) WHERE source='owner' AND (resolution IS NULL OR resolution='')");
    db.exec("UPDATE owner_ask_answer SET at=(SELECT resolved_at FROM owner_ask WHERE owner_ask.id=owner_ask_answer.id) WHERE source='owner' AND at IS NULL");
  } catch { /* owner_ask is always created first; ignore a half-migrated test database */ }
  db.exec("CREATE TABLE IF NOT EXISTS owner_ask_stamp_migrated (v INTEGER PRIMARY KEY)");
  db.exec("BEGIN IMMEDIATE");
  try {
    if (db.prepare("SELECT v FROM owner_ask_stamp_migrated WHERE v=1").get() === undefined) {
      db.exec(`UPDATE owner_ask_answer
        SET tap_id = CASE WHEN tap_id IS NULL OR tap_id = '' THEN 'legacy:' || id ELSE tap_id END,
            at = COALESCE(at, (SELECT resolved_at FROM owner_ask WHERE owner_ask.id = owner_ask_answer.id), 0)
        WHERE source = 'owner'`);
      db.exec("INSERT INTO owner_ask_stamp_migrated(v) VALUES (1);\nCOMMIT");
    } else {
      db.exec("COMMIT");
    }
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch (rollbackError) {
      if (!/no transaction is active/i.test(String(rollbackError))) throw rollbackError;
    }
    throw error;
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS owner_ask_source (
    captain TEXT NOT NULL, source_ref TEXT NOT NULL, ask_id TEXT NOT NULL,
    PRIMARY KEY(captain, source_ref));
    CREATE TABLE IF NOT EXISTS owner_ask_impact (id TEXT PRIMARY KEY, impact TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_ask_new_work (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS owner_ask_link (
      id TEXT PRIMARY KEY, message_url TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_ask_route (
      id TEXT PRIMARY KEY, project TEXT, task TEXT, subject TEXT);
    CREATE TABLE IF NOT EXISTS owner_ask_close (id TEXT PRIMARY KEY, told INTEGER NOT NULL DEFAULT 0, released INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS owner_ask_defer (id TEXT PRIMARY KEY, until INTEGER NOT NULL, told INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS owner_ask_followup (
      ask_id TEXT NOT NULL, answer_seq INTEGER NOT NULL, effect TEXT NOT NULL, state TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, first_failed_at INTEGER, noticed INTEGER NOT NULL DEFAULT 0,
      previous TEXT, resolution TEXT,
      PRIMARY KEY (ask_id, answer_seq, effect));
    CREATE TABLE IF NOT EXISTS owner_ask_default_notice (
      id TEXT PRIMARY KEY, told INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS owner_ask_round (id TEXT PRIMARY KEY, questions TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_ask_round_answer (
      id TEXT NOT NULL, idx INTEGER NOT NULL, label TEXT NOT NULL, choice INTEGER, PRIMARY KEY (id, idx));`);
  {
    const roundAnswerCols = new Set((db.prepare("PRAGMA table_info(owner_ask_round_answer)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!roundAnswerCols.has("choice")) db.exec("ALTER TABLE owner_ask_round_answer ADD COLUMN choice INTEGER");
  }
  {
    const cols = new Set((db.prepare("PRAGMA table_info(owner_ask_followup)").all() as Array<{ name: string }>).map((row) => row.name));
    if (!cols.has("attempts")) db.exec("ALTER TABLE owner_ask_followup ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
    if (!cols.has("first_failed_at")) db.exec("ALTER TABLE owner_ask_followup ADD COLUMN first_failed_at INTEGER");
    if (!cols.has("noticed")) db.exec("ALTER TABLE owner_ask_followup ADD COLUMN noticed INTEGER NOT NULL DEFAULT 0");
    if (!cols.has("answer_seq")) {
      db.exec(`CREATE TABLE owner_ask_followup_new (
        ask_id TEXT NOT NULL, answer_seq INTEGER NOT NULL, effect TEXT NOT NULL, state TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0, first_failed_at INTEGER, noticed INTEGER NOT NULL DEFAULT 0,
        previous TEXT, resolution TEXT,
        PRIMARY KEY (ask_id, answer_seq, effect));
        INSERT INTO owner_ask_followup_new (ask_id, answer_seq, effect, state, error, created_at, attempts, first_failed_at, noticed, previous, resolution)
        SELECT f.ask_id, 1, f.effect, f.state, f.error, f.created_at, COALESCE(f.attempts, 0), f.first_failed_at, COALESCE(f.noticed, 0), NULL, NULLIF(TRIM(a.resolution), '')
        FROM owner_ask_followup f LEFT JOIN owner_ask a ON a.id = f.ask_id;
        DROP TABLE owner_ask_followup;
        ALTER TABLE owner_ask_followup_new RENAME TO owner_ask_followup;`);
    } else {
      if (!cols.has("previous")) db.exec("ALTER TABLE owner_ask_followup ADD COLUMN previous TEXT");
      if (!cols.has("resolution")) {
        db.exec("ALTER TABLE owner_ask_followup ADD COLUMN resolution TEXT");
        db.exec(`UPDATE owner_ask_followup SET resolution = (SELECT NULLIF(TRIM(resolution), '') FROM owner_ask WHERE owner_ask.id = owner_ask_followup.ask_id) WHERE resolution IS NULL`);
      }
    }
  }

  const select = `SELECT owner_ask.*,
    (SELECT impact FROM owner_ask_impact WHERE id=owner_ask.id) AS impact,
    (SELECT source_ref FROM owner_ask_source WHERE ask_id=owner_ask.id ORDER BY source_ref LIMIT 1) AS source_ref,
    EXISTS(SELECT 1 FROM owner_ask_new_work WHERE id=owner_ask.id) AS new_work,
    (SELECT project FROM owner_ask_route WHERE id=owner_ask.id) AS route_project,
    (SELECT task FROM owner_ask_route WHERE id=owner_ask.id) AS route_task,
    (SELECT subject FROM owner_ask_route WHERE id=owner_ask.id) AS route_subject,
    (SELECT until FROM owner_ask_defer WHERE id=owner_ask.id) AS deferred_until,
    owner_ask_link.message_url FROM owner_ask LEFT JOIN owner_ask_link USING(id)`;

  function load(row: AskRecord): OwnerAsk {
    const ask = fromRecord(row);
    const roundRow = db.prepare("SELECT questions FROM owner_ask_round WHERE id=?").get(ask.id) as { questions: string } | undefined;
    if (!roundRow) return ask;
    let round: RoundQuestion[] = [];
    try {
      const parsed: unknown = JSON.parse(roundRow.questions);
      if (Array.isArray(parsed)) round = parsed as RoundQuestion[];
    } catch { return ask; }
    if (round.length === 0) return ask;
    const answers = db.prepare("SELECT idx, label FROM owner_ask_round_answer WHERE id=?").all(ask.id) as Array<{ idx: number; label: string }>;
    return {
      ...ask,
      round,
      ...(answers.length > 0 ? { roundAnswers: Object.fromEntries(answers.map((item) => [item.idx, item.label])) } : {}),
    };
  }

  function get(id: string): OwnerAsk | undefined {
    const row = db.prepare(`${select} WHERE owner_ask.id=?`).get(id) as AskRecord | undefined;
    return row ? load(row) : undefined;
  }

  function answeredByOwner(id: string): boolean {
    return db.prepare("SELECT id FROM owner_ask_answer WHERE id=? AND source='owner'").get(id) !== undefined;
  }

  function listOpen(captain: string): OwnerAsk[] {
    return (db.prepare(`${select} WHERE captain=? AND state='open' ORDER BY created_at, owner_ask.id`).all(captain) as AskRecord[]).map(load);
  }

  function create(input: NewOwnerAsk): OwnerAsk {
    if (input.kind === "question" && input.options.length === 0 && (input.round === undefined || input.round.length === 0)) {
      throw new Error("A question card needs options. Status belongs on the task, not as an open card.");
    }
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
      // A card that starts new work has no default, even when a caller passes one.
      defaultAt: input.startsNewWork === true ? null : input.defaultAt ?? null,
      irreversible: input.irreversible === true,
      startsNewWork: input.startsNewWork === true,
      state: "open",
      resolution: null,
      createdAt: input.createdAt,
      resolvedAt: null,
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      ...(input.messageUrl ? { messageUrl: input.messageUrl } : {}),
      ...(input.project ? { project: input.project } : {}),
      ...(input.task ? { task: input.task } : {}),
      ...(input.subject ? { subject: input.subject } : {}),
      ...(input.round && input.round.length > 0 ? { round: input.round } : {}),
    };
    db.prepare("INSERT INTO owner_ask VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
      ask.id, ask.captain, ask.kind, ask.text, JSON.stringify(ask.options), ask.recommended, ask.defaultAt,
      ask.irreversible ? 1 : 0, ask.state, null, ask.createdAt, null,
    );
    if (input.impact) db.prepare("INSERT INTO owner_ask_impact VALUES (?,?)").run(id, input.impact);
    if (ask.startsNewWork) db.prepare("INSERT INTO owner_ask_new_work VALUES (?)").run(id);
    if (input.sourceRef) db.prepare("INSERT INTO owner_ask_source VALUES (?,?,?)").run(input.captain, input.sourceRef, ask.id);
    if (input.messageUrl) db.prepare("INSERT INTO owner_ask_link VALUES (?,?)").run(ask.id, input.messageUrl);
    if (input.project || input.task || input.subject) db.prepare("INSERT INTO owner_ask_route VALUES (?,?,?,?)").run(ask.id, input.project ?? null, input.task ?? null, input.subject ?? null);
    if (input.round && input.round.length > 0) db.prepare("INSERT INTO owner_ask_round VALUES (?,?)").run(id, JSON.stringify(input.round));
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
    listWaiting: (captain, now) => listOpen(captain).filter((ask) => !isDeferred(ask, now)),
    close(ids, captain, now = Date.now()) {
      return db.transaction(() => {
        const current = [...new Set(ids)].map((id) => ({ id, ask: get(id) }));
        const already = current.filter(({ id, ask }) => ask?.captain === captain && db.prepare("SELECT id FROM owner_ask_close WHERE id=?").get(id) !== undefined).map(({ id }) => id);
        const refused = current.filter(({ id, ask }) => !ask || ask.captain !== captain || (ask.state !== "open" && !already.includes(id))).map(({ id }) => id);
        if (refused.length > 0) return { closed: [], already: [], refused };
        const closed = current.filter(({ id }) => !already.includes(id)).map(({ id }) => id);
        // A repeat also repairs native work left incomplete by an earlier version or interrupted drain.
        for (const id of already) db.prepare("UPDATE owner_ask_close SET released=0 WHERE id=?").run(id);
        for (const id of closed) {
          db.prepare("UPDATE owner_ask SET state='cancelled', resolution=?, resolved_at=? WHERE id=?").run(OWNER_CLOSED_RESOLUTION, now, id);
          db.prepare("DELETE FROM owner_ask_defer WHERE id=?").run(id);
          db.prepare("INSERT INTO owner_ask_close VALUES (?,0,0)").run(id);
        }
        return { closed, already, refused: [] };
      })();
    },
    untoldCloses(captain) {
      return (db.prepare(`${select} WHERE captain=? AND EXISTS(SELECT 1 FROM owner_ask_close WHERE id=owner_ask.id AND told=0) ORDER BY created_at, owner_ask.id`).all(captain) as AskRecord[]).map(load);
    },
    unreleasedCloses(captain) {
      return (db.prepare(`${select} WHERE captain=? AND EXISTS(SELECT 1 FROM owner_ask_close WHERE id=owner_ask.id AND released=0) ORDER BY created_at, owner_ask.id`).all(captain) as AskRecord[]).map(load);
    },
    markClosesReleased(ids) {
      for (const id of ids) db.prepare("UPDATE owner_ask_close SET released=1 WHERE id=?").run(id);
    },
    markClosesTold(ids) {
      for (const id of ids) db.prepare("UPDATE owner_ask_close SET told=1 WHERE id=?").run(id);
    },
    defer(ids, captain, until, now = Date.now()) {
      return db.transaction(() => {
        const wanted = [...new Set(ids)];
        const current = wanted.map((id) => ({ id, ask: get(id) }));
        const refused = current.filter(({ ask }) => !ask || ask.captain !== captain || ask.state !== "open").map(({ id }) => id);
        if (refused.length > 0) return { deferred: [], already: [], refused, until: null };
        const already = current.filter(({ ask }) => isDeferred(ask!, now));
        const deferred = current.filter(({ ask }) => !isDeferred(ask!, now)).map(({ id }) => id);
        const effective = already.length > 0 ? Math.max(...already.map(({ ask }) => ask!.deferredUntil!)) : until;
        for (const id of deferred) {
          db.prepare("INSERT INTO owner_ask_defer VALUES (?,?,0) ON CONFLICT(id) DO UPDATE SET until=excluded.until, told=0").run(id, effective);
        }
        return { deferred, already: already.map(({ id }) => id), refused: [], until: effective };
      })();
    },
    untoldSkips(captain, now) {
      return listOpen(captain).filter((ask) => isDeferred(ask, now) && (db.prepare("SELECT told FROM owner_ask_defer WHERE id=?").get(ask.id) as { told: number } | undefined)?.told === 0);
    },
    markSkipsTold(ids) {
      for (const id of ids) db.prepare("UPDATE owner_ask_defer SET told=1 WHERE id=?").run(id);
    },
    listCandidates(captain, now) {
      return (db.prepare(`${select} WHERE captain=? AND (state='open' OR (state='answered' AND resolved_at>=?)) ORDER BY created_at, owner_ask.id`).all(captain, now - 86_400_000) as AskRecord[]).map(load);
    },
    answeredByOwner,
    resolve(id, captain, state, resolution, at, source, tap) {
      return db.transaction(() => {
        const current = get(id);
        if (!current || current.captain !== captain || db.prepare("SELECT id FROM owner_ask_close WHERE id=?").get(id) !== undefined) return undefined;
        const { deferredUntil: _skip, ...rest } = current;
        const clearDefer = () => db.prepare("DELETE FROM owner_ask_defer WHERE id=?").run(id);
        const enqueueOwnerFollowUps = (writtenResolution: string, writtenAt: number) => {
          const previousRecorded = (lastFollowUpResolution(id) ?? current.resolution ?? "").trim();
          const seq = nextAnswerSeq(id);
          for (const effect of ASK_FOLLOWUP_EFFECTS) {
            db.prepare("INSERT INTO owner_ask_followup (ask_id, answer_seq, effect, state, error, created_at, previous, resolution) VALUES (?,?,?,?,?,?,?,?)")
              .run(id, seq, effect, "pending", null, writtenAt, previousRecorded === "" ? null : previousRecorded, writtenResolution);
          }
        };
        if (state === "open") {
          db.prepare("UPDATE owner_ask SET state=?, resolution=?, resolved_at=? WHERE id=?").run("open", null, null, id);
          db.prepare("INSERT INTO owner_ask_reopen(id, at) VALUES (?,?) ON CONFLICT(id) DO UPDATE SET at=excluded.at").run(id, at);
          clearDefer();
          db.prepare("DELETE FROM owner_ask_round_answer WHERE id=?").run(id);
          return { ...rest, state: "open" as const, resolution: null, resolvedAt: null, roundAnswers: undefined };
        }
        if (source === "owner" && state === "answered") {
          const existing = db.prepare("SELECT resolution, at, tap_id FROM owner_ask_answer WHERE id=? AND source='owner'").get(id) as { resolution: string | null; at: number | null; tap_id: string | null } | undefined;
          const reopen = db.prepare("SELECT at FROM owner_ask_reopen WHERE id=?").get(id) as { at: number } | undefined;
          const tapId = typeof tap?.tapId === "string" && tap.tapId !== "" ? tap.tapId : undefined;
          const answeredAt = tap !== undefined && tapId !== undefined && Number.isFinite(tap.answeredAt) ? Math.min(tap.answeredAt, at) : undefined;
          const stamped = tapId !== undefined && answeredAt !== undefined;
          if (tapId !== undefined && existing?.tap_id === tapId) {
            if (reopen !== undefined && (answeredAt === undefined || answeredAt <= reopen.at)) return undefined;
            return current;
          }
          if (reopen !== undefined && answeredAt !== undefined && answeredAt <= reopen.at) return undefined;
          const identified = typeof existing?.tap_id === "string" && existing.tap_id !== "";
          const sameChoice = existing !== undefined && String(existing.resolution ?? "") === String(resolution ?? "");
          const unansweredSinceReopen = reopen === undefined || existing?.at == null || existing.at > reopen.at;
          if (tapId === undefined && sameChoice && unansweredSinceReopen) {
            clearDefer();
            return rest;
          }
          const displayAt = answeredAt ?? at;
          db.prepare("UPDATE owner_ask SET state=?, resolution=?, resolved_at=? WHERE id=?").run(state, resolution, displayAt, id);
          if (stamped) {
            db.prepare("INSERT INTO owner_ask_answer(id, source, resolution, at, tap_id) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source, resolution=excluded.resolution, at=excluded.at, tap_id=excluded.tap_id").run(id, source, resolution, displayAt, tapId);
            enqueueOwnerFollowUps(resolution, displayAt);
          } else if (!identified) {
            db.prepare("INSERT INTO owner_ask_answer(id, source, resolution, at, tap_id) VALUES (?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source=excluded.source, resolution=excluded.resolution, at=excluded.at, tap_id=excluded.tap_id").run(id, source, resolution, displayAt, null);
            enqueueOwnerFollowUps(resolution, displayAt);
          }
          clearDefer();
          return { ...rest, state, resolution, resolvedAt: displayAt };
        }
        if (state === "answered") db.prepare("DELETE FROM owner_ask_answer WHERE id=?").run(id);
        db.prepare("UPDATE owner_ask SET state=?, resolution=?, resolved_at=? WHERE id=?").run(state, resolution, at, id);
        clearDefer();
        return { ...rest, state, resolution, resolvedAt: at };
      })();
    },
    recordRoundAnswers(id, captain, answers, at) {
      return db.transaction(() => {
        const current = get(id);
        if (!current || current.captain !== captain || current.state !== "open") return undefined;
        if (current.round === undefined || current.round.length === 0) {
          return { ask: current, complete: false, summary: "", error: "Ask is not a grilling round." };
        }
        const round = current.round;
        const storedChoice = Object.fromEntries(
          (db.prepare("SELECT idx, choice FROM owner_ask_round_answer WHERE id=?").all(id) as Array<{ idx: number; choice: number | null }>)
            .filter((row): row is { idx: number; choice: number } => typeof row.choice === "number" && row.choice >= 0)
            .map((row) => [row.idx, row.choice]),
        ) as Record<number, number>;
        const next = { ...(current.roundAnswers ?? {}) };
        const nextChoice = { ...storedChoice };
        const prior = roundAnswerSummary(round, current.roundAnswers ?? {}, storedChoice);
        for (const item of answers) {
          const question = round[item.n - 1];
          if (question === undefined) {
            return { ask: current, complete: false, summary: prior, error: `No question ${item.n} in this round.` };
          }
          const matched = matchRoundChoice(question.options, item.choice);
          if (matched === null) {
            return { ask: current, complete: false, summary: prior, error: `Question ${item.n} has no option ${item.choice}.` };
          }
          next[item.n] = matched.label;
          nextChoice[item.n] = matched.index;
        }
        for (const item of answers) {
          db.prepare("INSERT INTO owner_ask_round_answer (id, idx, label, choice) VALUES (?,?,?,?) ON CONFLICT(id, idx) DO UPDATE SET label=excluded.label, choice=excluded.choice").run(id, item.n, next[item.n], nextChoice[item.n]);
        }
        const summary = roundAnswerSummary(round, next, nextChoice);
        const complete = round.every((_, index) => next[index + 1] !== undefined);
        if (complete) {
          db.prepare("UPDATE owner_ask SET state='answered', resolution=?, resolved_at=? WHERE id=?").run(summary, at, id);
          db.prepare("DELETE FROM owner_ask_defer WHERE id=?").run(id);
        }
        return { ask: get(id)!, complete, summary };
      })();
    },
    takeDue(captain, now) {
      return db.transaction(() => {
        const due = listOpen(captain).filter((ask) => ask.deferredUntil === undefined && ask.defaultAt !== null && ask.defaultAt <= now && mayDefault(ask) && recommendedLabel(ask) !== null);
        return due.map((ask) => {
          const resolution = recommendedLabel(ask)!;
          db.prepare("UPDATE owner_ask SET state='defaulted', resolution=?, resolved_at=? WHERE id=?").run(resolution, now, ask.id);
          db.prepare("INSERT OR IGNORE INTO owner_ask_default_notice VALUES (?,0)").run(ask.id);
          return { ...ask, state: "defaulted" as const, resolution, resolvedAt: now };
        });
      })();
    },
    untoldDefaults(captain) {
      return (db.prepare(`${select} WHERE captain=? AND state='defaulted' AND EXISTS(SELECT 1 FROM owner_ask_default_notice WHERE id=owner_ask.id AND told=0) ORDER BY created_at, owner_ask.id`).all(captain) as AskRecord[]).map(load);
    },
    markDefaultsTold(ids) {
      for (const id of ids) db.prepare("UPDATE owner_ask_default_notice SET told=1 WHERE id=?").run(id);
    },
    pendingFollowUps() {
      return followUps("pending");
    },
    failedFollowUps() {
      return followUps("failed");
    },
    markFollowUpDone(askId, effect, answerSeq = 1) {
      db.prepare("UPDATE owner_ask_followup SET state='done', error=NULL WHERE ask_id=? AND answer_seq=? AND effect=?").run(askId, answerSeq, effect);
    },
    failFollowUp(askId, effect, error, now = Date.now(), answerSeq = 1) {
      const row = followUpRow(askId, effect, answerSeq);
      if (row === undefined || row.state !== "pending") return (row?.state ?? "pending") as AskFollowUpState;
      const attempts = row.attempts + 1;
      const firstFailedAt = row.firstFailedAt ?? now;
      const state: AskFollowUpState = attempts >= ASK_FOLLOWUP_RETRY_BOUND || now - firstFailedAt >= ASK_FOLLOWUP_GIVE_UP_MS ? "failed" : "pending";
      db.prepare("UPDATE owner_ask_followup SET error=?, attempts=?, first_failed_at=?, state=? WHERE ask_id=? AND answer_seq=? AND effect=? AND state='pending'").run(error, attempts, firstFailedAt, state, askId, answerSeq, effect);
      return state;
    },
    recordFollowUpError(askId, effect, error, answerSeq = 1) {
      db.prepare("UPDATE owner_ask_followup SET error=? WHERE ask_id=? AND answer_seq=? AND effect=? AND state='pending'").run(error, askId, answerSeq, effect);
    },
    claimFollowUpNotice(askId, effect, answerSeq = 1) {
      const row = followUpRow(askId, effect, answerSeq);
      if (!row || row.state !== "failed" || row.noticed) return false;
      db.prepare("UPDATE owner_ask_followup SET noticed=1 WHERE ask_id=? AND answer_seq=? AND effect=? AND state='failed' AND noticed=0").run(askId, answerSeq, effect);
      return true;
    },
  };

  function lastFollowUpResolution(id: string): string | null {
    const row = db.prepare("SELECT resolution FROM owner_ask_followup WHERE ask_id=? AND resolution IS NOT NULL AND TRIM(resolution) != '' ORDER BY answer_seq DESC LIMIT 1").get(id) as { resolution: string } | undefined;
    return row?.resolution ?? null;
  }
  function nextAnswerSeq(id: string): number {
    const row = db.prepare("SELECT MAX(answer_seq) AS n FROM owner_ask_followup WHERE ask_id=?").get(id) as { n: number | null } | undefined;
    return (row?.n ?? 0) + 1;
  }
  function followUpRow(askId: string, effect: AskFollowUpEffect, answerSeq = 1): AskFollowUp | undefined {
    const row = db.prepare("SELECT ask_id, answer_seq, effect, state, error, created_at, attempts, first_failed_at, noticed, previous, resolution FROM owner_ask_followup WHERE ask_id=? AND answer_seq=? AND effect=?").get(askId, answerSeq, effect) as FollowUpRecord | undefined;
    return row ? fromFollowUp(row) : undefined;
  }
  function followUps(state: "pending" | "failed"): AskFollowUp[] {
    return (db.prepare("SELECT ask_id, answer_seq, effect, state, error, created_at, attempts, first_failed_at, noticed, previous, resolution FROM owner_ask_followup WHERE state=? ORDER BY ask_id, answer_seq, effect").all(state) as FollowUpRecord[]).map(fromFollowUp);
  }
}

type FollowUpRecord = {
  ask_id: string; answer_seq: number; effect: string; state: string; error: string | null; created_at: number;
  attempts: number; first_failed_at: number | null; noticed: number; previous: string | null; resolution: string | null;
};

function fromFollowUp(row: FollowUpRecord): AskFollowUp {
  return {
    askId: row.ask_id,
    answerSeq: row.answer_seq ?? 1,
    effect: row.effect as AskFollowUpEffect,
    state: row.state as AskFollowUpState,
    error: row.error,
    createdAt: row.created_at,
    attempts: row.attempts ?? 0,
    firstFailedAt: row.first_failed_at,
    noticed: row.noticed === 1,
    previous: row.previous ?? null,
    resolution: row.resolution ?? null,
  };
}

export function askLetterAnswer(ask: Pick<OwnerAsk, "options">, text: string): string | null {
  const letter = /^([a-z])\.?$/i.exec(text.trim())?.[1]?.toUpperCase();
  return letter ? ask.options[letter.charCodeAt(0) - 65]?.label ?? null : null;
}

export function matchRoundChoice(options: readonly AskOption[], choice: string): { index: number; label: string } | null {
  const raw = choice.trim();
  if (raw === "") return null;
  const letter = /^([a-d])\.?$/i.exec(raw)?.[1]?.toUpperCase();
  if (letter !== undefined) {
    const index = letter.charCodeAt(0) - 65;
    const option = options[index];
    return option === undefined ? null : { index, label: option.label };
  }
  const index = options.findIndex((option) => option.label === raw || optionText(option.label) === raw);
  return index < 0 ? null : { index, label: options[index]!.label };
}

export function roundAnswerSummary(round: readonly RoundQuestion[], answers: Record<number, string>, indexes: Record<number, number> = {}): string {
  return round.flatMap((question, index) => {
    const n = index + 1;
    const label = answers[n];
    if (label === undefined) return [];
    const optionIndex = indexes[n] ?? question.options.findIndex((option) => option.label === label);
    const letter = optionIndex >= 0 ? String.fromCharCode(65 + optionIndex) : "?";
    return [`${n}${letter}`];
  }).join(" ");
}

/** Re-sent to the captain every turn and printed at session start, so it survives a compaction. */
// 10 Oct the captain ran gh pr merge; up to 13 Oct it ran Safi production publishes.
// Keep this sentence equal to the CAPTAIN RULES block in overlay/bin/bb-captain-hook.sh.
export const CAPTAIN_RULES = "Captain rules: do not deploy, publish, merge, commit or push yourself. A crew does that work. Merge with firstmate_merge crewId + pr. Before you tell the owner that something is open, check its firstmate_task or firstmate_deliveries record. Full rules: firstmate_skill name=captain reference=references/supervision.md.";
export const OWNER_DECISION_RULE = "Send every decision, approval or blocker for the owner with firstmate_ask, one question per card, never as plain text in firstmate_reply or closing text. A grilling question batch is one firstmate_ask round: one message, no per-question cards. Decide reversible choices yourself and say in one sentence what you chose. Open cards are on the owner's board, so reports do not repeat them. Full rules: firstmate_skill name=captain reference=references/telegram.md.";
