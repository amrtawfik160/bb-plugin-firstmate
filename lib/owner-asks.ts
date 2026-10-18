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
  /** Correct or reopen an ask owned by this captain. */
  resolve(id: string, captain: string, state: AskState, resolution: string, at: number): OwnerAsk | undefined;
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

  db.exec(`CREATE TABLE IF NOT EXISTS owner_ask_source (
    captain TEXT NOT NULL, source_ref TEXT NOT NULL, ask_id TEXT NOT NULL,
    PRIMARY KEY(captain, source_ref));
    CREATE TABLE IF NOT EXISTS owner_ask_impact (id TEXT PRIMARY KEY, impact TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_ask_new_work (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS owner_ask_link (
      id TEXT PRIMARY KEY, message_url TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS owner_ask_route (
      id TEXT PRIMARY KEY, project TEXT, task TEXT, subject TEXT);
    CREATE TABLE IF NOT EXISTS owner_ask_close (id TEXT PRIMARY KEY, told INTEGER NOT NULL DEFAULT 0, released INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS owner_ask_defer (id TEXT PRIMARY KEY, until INTEGER NOT NULL, told INTEGER NOT NULL DEFAULT 0);`);

  const select = `SELECT owner_ask.*,
    (SELECT impact FROM owner_ask_impact WHERE id=owner_ask.id) AS impact,
    (SELECT source_ref FROM owner_ask_source WHERE ask_id=owner_ask.id ORDER BY source_ref LIMIT 1) AS source_ref,
    EXISTS(SELECT 1 FROM owner_ask_new_work WHERE id=owner_ask.id) AS new_work,
    (SELECT project FROM owner_ask_route WHERE id=owner_ask.id) AS route_project,
    (SELECT task FROM owner_ask_route WHERE id=owner_ask.id) AS route_task,
    (SELECT subject FROM owner_ask_route WHERE id=owner_ask.id) AS route_subject,
    (SELECT until FROM owner_ask_defer WHERE id=owner_ask.id) AS deferred_until,
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
      return (db.prepare(`${select} WHERE captain=? AND EXISTS(SELECT 1 FROM owner_ask_close WHERE id=owner_ask.id AND told=0) ORDER BY created_at, owner_ask.id`).all(captain) as AskRecord[]).map(fromRecord);
    },
    unreleasedCloses(captain) {
      return (db.prepare(`${select} WHERE captain=? AND EXISTS(SELECT 1 FROM owner_ask_close WHERE id=owner_ask.id AND released=0) ORDER BY created_at, owner_ask.id`).all(captain) as AskRecord[]).map(fromRecord);
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
      return (db.prepare(`${select} WHERE captain=? AND (state='open' OR (state='answered' AND resolved_at>=?)) ORDER BY created_at, owner_ask.id`).all(captain, now - 86_400_000) as AskRecord[]).map(fromRecord);
    },
    resolve(id, captain, state, resolution, at) {
      return db.transaction(() => {
        const current = get(id);
        if (!current || current.captain !== captain || db.prepare("SELECT id FROM owner_ask_close WHERE id=?").get(id) !== undefined) return undefined;
        db.prepare("UPDATE owner_ask SET state=?, resolution=?, resolved_at=? WHERE id=?").run(state, state === "open" ? null : resolution, state === "open" ? null : at, id);
        // A skip ends when the card is answered or reopened: a reopened card waits on the owner again.
        db.prepare("DELETE FROM owner_ask_defer WHERE id=?").run(id);
        const { deferredUntil: _skip, ...rest } = current;
        return { ...rest, state, resolution: state === "open" ? null : resolution, resolvedAt: state === "open" ? null : at };
      })();
    },
    takeDue(captain, now) {
      return db.transaction(() => {
        const due = listOpen(captain).filter((ask) => ask.deferredUntil === undefined && ask.defaultAt !== null && ask.defaultAt <= now && mayDefault(ask) && recommendedLabel(ask) !== null);
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

/** Re-sent to the captain every turn and printed at session start, so it survives a compaction. */
// 10 Oct the captain ran gh pr merge; up to 13 Oct it ran Safi production publishes.
// Keep this sentence equal to the CAPTAIN RULES block in overlay/bin/bb-captain-hook.sh.
export const CAPTAIN_RULES = "Captain rules: do not deploy, publish, merge, commit or push yourself. A crew does that work. Merge with firstmate_merge crewId + pr. Before you tell the owner that something is open, check its firstmate_task or firstmate_deliveries record. Full rules: firstmate_skill name=captain reference=references/supervision.md.";
export const OWNER_DECISION_RULE = "Send every decision, approval or blocker for the owner with firstmate_ask, one question per card, never as plain text in firstmate_reply or closing text. Decide reversible choices yourself and say in one sentence what you chose. Open cards are on the owner's board, so reports do not repeat them. Full rules: firstmate_skill name=captain reference=references/telegram.md.";
