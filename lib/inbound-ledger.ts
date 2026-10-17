import { createHash } from "node:crypto";
import { isBotOrAckText, parseSourceRef, parseTelegramItems, stripTelegramEnvelope, telegramSourceRef, type TelegramEnvelope } from "./telegram-envelope.ts";

export type InboundSource = "bb" | "telegram";
export type InboundState = "received" | "acked" | "answered" | "delegated";
export type OutboxKind = "ack" | "reply" | "progress" | "delegated" | "nudge";
/** A reply that quotes one part of the owner message, such as one of several questions, gets its own key. */
export type OutboxClaimKind = OutboxKind | `reply:q${string}` | `reply:t${string}`;

export function quotedReplyKind(quote: string | null | undefined): OutboxClaimKind {
  const trimmed = quote?.trim() ?? "";
  return trimmed === "" ? "reply" : `reply:q${hashText(trimmed).slice(0, 12)}`;
}

/** The claim for a reply that follows an earlier reply to the same message (and quote): one per different text. */
export function followUpReplyKind(text: string, quote?: string | null): OutboxClaimKind {
  const trimmed = quote?.trim() ?? "";
  return `reply:t${hashText(trimmed === "" ? text : `${trimmed}\0${text}`).slice(0, 12)}`;
}

export type InboundKey = {
  source: InboundSource;
  chatId: string;
  messageId: string;
};

export type InboundRow = InboundKey & {
  captainThreadId: string;
  receivedAt: number;
  textHash: string;
  preview: string;
  state: InboundState;
  ackedAt: number | null;
  answeredAt: number | null;
  crewId: string | null;
  /** When the crew this row was handed to ended (done, failed, stopped, archived or off the crew list). */
  crewEndedAt?: number | null;
  /** When the captain was told that crew ended and this row still needs an answer. Once per row. */
  handedBackAt?: number | null;
  /** The ref of the reply that also answered this message, when firstmate_reply covers it. */
  coveredBy?: string | null;
  sourceRefs: string[];
  mediaGroupId: string | null;
  senderId: string | null;
  topicId: string | null;
  replyTo: string | null;
  forwarded: boolean;
  isBotOwn: boolean;
  isAck: boolean;
  remindedAt?: number | null;
  reminders?: number;
  remindedKind?: SweepAction["kind"] | null;
};

export type OutboxRow = InboundKey & {
  kind: OutboxKind;
  contentHash: string;
  sentAt: number;
  outgoingMessageId: string | null;
  /** A reply sent without more=true: its exact repeat may close the message. Absent on older claims. */
  final?: boolean;
  /** firstmate_reply: the reservation is made but delivery is not confirmed yet, so a repeat closes nothing. */
  inFlight?: boolean;
  /** firstmate_reply: refs of the covers this reply listed. An exact repeat may close only these. */
  covers?: string[];
};

export type LedgerEvent = {
  captainThreadId: string;
  text: string;
  receivedAt: number;
  bbThreadId: string;
  bbRowId?: string;
  telegram?: TelegramEnvelope | null;
  initiator?: string;
  senderThreadId?: string | null;
  isBotOwn?: boolean;
};

export const ACK_CUTOFF_MS = 15 * 60_000;
export const SWEEP_NUDGE_AFTER_MS = 3 * 60_000;
export const SWEEP_ESCALATE_AFTER_MS = 10 * 60_000;
export const SWEEP_REMIND_MAX_MS = 2 * 60 * 60_000;
export const ACK_TEXT = "On it.";

type Database = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
};

const OPEN_STATES: InboundState[] = ["received", "acked"];

export function inboundKey(row: InboundKey): string {
  return `${row.source}:${row.chatId}:${row.messageId}`;
}

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function previewOf(text: string, max = 80): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

export function shouldIgnoreInbound(event: LedgerEvent): boolean {
  if (event.isBotOwn === true) return true;
  if (event.initiator === "agent" || event.initiator === "system") return true;
  if (isBotOrAckText(event.text)) return true;
  return false;
}

export function eventToRow(event: LedgerEvent): InboundRow | null {
  if (shouldIgnoreInbound(event)) return null;
  const tg = event.telegram ?? null;
  // Only owner messages from the Telegram connector are tracked. Plain BB text in a captain
  // thread includes this plugin's own reminders, acks and delivery notices; tracking those
  // made each reminder a new item with its own reminder, a loop that never ends.
  if (!tg) return null;
  const source: InboundSource = tg ? "telegram" : "bb";
  const chatId = tg?.chatId ?? event.bbThreadId;
  const messageId = tg?.messageId ?? event.bbRowId ?? `${event.receivedAt}:${hashText(event.text).slice(0, 12)}`;
  const ref = source === "telegram"
    ? telegramSourceRef({ chatId, messageId })
    : `bb:${chatId}:${messageId}`;
  const correlation = tg?.correlation ? tg.correlation : null;
  return {
    source,
    chatId,
    messageId,
    captainThreadId: event.captainThreadId,
    receivedAt: event.receivedAt,
    textHash: hashText(event.text),
    preview: previewOf(stripTelegramEnvelope(event.text) || event.text),
    state: "received",
    ackedAt: null,
    answeredAt: null,
    crewId: null,
    sourceRefs: correlation ? [ref, correlation] : [ref],
    mediaGroupId: tg?.mediaGroupId ?? null,
    senderId: tg?.senderId ?? null,
    topicId: tg?.threadId ?? null,
    replyTo: tg?.replyTo ?? null,
    forwarded: tg?.forwarded === true,
    isBotOwn: false,
    isAck: false,
  };
}

export function expandTelegramRows(event: LedgerEvent): InboundRow[] {
  const primary = eventToRow(event);
  if (!primary) return [];
  const tg = event.telegram;
  const ids = tg?.messageIds?.filter(Boolean) ?? [];
  if (ids.length === 0) return [primary];
  const items = parseTelegramItems(tg?.items);
  const byId = new Map(items.map((item) => [item.id, item]));
  return ids.map((id) => {
    const decl = byId.get(id);
    const media = items.length === 0 || (decl !== undefined && decl.kind !== "text");
    return {
      ...primary,
      messageId: id,
      mediaGroupId: media ? primary.mediaGroupId : null,
      sourceRefs: [
        telegramSourceRef({ chatId: primary.chatId, messageId: id }),
        ...primary.sourceRefs.filter((ref) => ref.startsWith("tgref:")),
      ],
      forwarded: decl?.kind === "forward" || primary.forwarded,
    };
  });
}

function parseRow(record: string): InboundRow {
  return JSON.parse(record) as InboundRow;
}

export type SweepAction =
  | { kind: "nudge"; row: InboundRow; ageMs: number }
  | { kind: "escalate"; row: InboundRow; ageMs: number };

export function sweepActions(rows: readonly InboundRow[], now: number): SweepAction[] {
  const out: SweepAction[] = [];
  for (const row of rows) {
    if (!OPEN_STATES.includes(row.state)) continue;
    const age = now - row.receivedAt;
    if (age >= SWEEP_ESCALATE_AFTER_MS) out.push({ kind: "escalate", row, ageMs: age });
    else if (age >= SWEEP_NUDGE_AFTER_MS) out.push({ kind: "nudge", row, ageMs: age });
  }
  return out;
}

// One reminder per level; repeats of the same level back off exponentially.
export function reminderDue(action: SweepAction, now: number): boolean {
  const row = action.row;
  if (row.remindedAt == null || row.remindedKind == null) return true;
  if (action.kind === "escalate" && row.remindedKind === "nudge") return true;
  const backoff = Math.min(SWEEP_REMIND_MAX_MS, SWEEP_ESCALATE_AFTER_MS * 2 ** Math.max(0, (row.reminders ?? 1) - 1));
  return now - row.remindedAt >= backoff;
}

export function sweeperSteerText(action: SweepAction): string {
  const ref = inboundKey(action.row);
  const preview = action.row.preview;
  if (action.kind === "escalate") {
    return `Unanswered for ${Math.round(action.ageMs / 60_000)} min: ${ref} '${preview}' — answer or dispatch now.`;
  }
  return `Unanswered: ${ref} '${preview}' — answer or delegate now.`;
}

export function ackEligible(row: InboundRow, now: number, cutoffMs = ACK_CUTOFF_MS): boolean {
  if (row.state !== "received") return false;
  if (row.isBotOwn || row.isAck) return false;
  return now - row.receivedAt <= cutoffMs;
}

export type CreateInboundLedger = {
  record(event: LedgerEvent): InboundRow | null;
  get(key: InboundKey): InboundRow | undefined;
  listOpen(captainThreadId?: string): InboundRow[];
  /** Open rows plus rows handed to a crew: every owner message that still needs a final answer. */
  listPending(captainThreadId: string): InboundRow[];
  hasTelegram(captainThreadId: string): boolean;
  markAcked(key: InboundKey, at: number): InboundRow | undefined;
  markAnswered(key: InboundKey, at: number): InboundRow | undefined;
  /**
   * The connector reports the reply to this message undelivered: it is open again, its reminders start
   * over, and its reply claims are cleared so the captain can answer it again.
   */
  reopen(key: InboundKey, at: number): InboundRow | undefined;
  /** One transaction: answers the anchor (when given) and each open cover, answered by the reply to by with no
   * message of its own and keeping its crew link, so a failure closes none. Returns the covers it closed. */
  finishReply(anchor: InboundKey | null, covers: InboundKey[], by: string, at: number): InboundRow[];
  markDelegated(key: InboundKey, crewId: string, at: number): InboundRow | undefined;
  /** Records that a crew ended on each still-delegated row handed to it. Returns the rows it changed. */
  crewEnded(crewId: string, at: number): InboundRow[];
  /** The captain's delegated rows whose crew ended and whose hand-back wake was not delivered yet. Records nothing. */
  handBacksDue(captainThreadId: string): InboundRow[];
  /** Records the hand-back of each row still due after its wake was delivered. A crash before this repeats the wake once. */
  markHandedBack(rows: InboundRow[], at: number): void;
  mergeSourceRefs(keys: InboundKey[], refs: string[]): void;
  /** reply: a firstmate_reply reservation, in flight until markDelivered. */
  claimOutbox(row: InboundKey, kind: OutboxClaimKind, content: string, at: number, reply?: { final: boolean; covers: string[] }): { sent: boolean; existing?: OutboxRow };
  /** Confirms a firstmate_reply reservation was delivered, so its exact repeat may finish the closure. */
  markDelivered(row: InboundKey, kind: OutboxClaimKind): void;
  releaseOutbox(row: InboundKey, kind: OutboxClaimKind): void;
  rememberOutgoing(row: InboundKey, kind: OutboxKind, outgoingMessageId: string): void;
  outboxGet(row: InboundKey, kind: OutboxKind): OutboxRow | undefined;
  enqueueChat(chatId: string, key: InboundKey): number;
  chatOrder(chatId: string): InboundKey[];
  openForSweep(now: number, captainThreadId?: string): SweepAction[];
};

/** One line per owner message still waiting for a final answer, so none is forgotten however many arrive. */
export function formatOwnerInbox(rows: InboundRow[], now: number): string {
  if (rows.length === 0) return "No owner message is waiting.";
  const lines = rows.map((row) => {
    const ref = row.source === "telegram" ? `tg:${row.chatId}:${row.messageId}` : `bb:${row.chatId}:${row.messageId}`;
    const age = Math.max(0, Math.round((now - row.receivedAt) / 60_000));
    const status = row.state !== "delegated" ? "needs your reply"
      : row.crewEndedAt != null ? `crew ${row.crewId ?? "unknown"} ended; needs your reply` : `with crew ${row.crewId ?? "unknown"}`;
    return `- ${ref} (${age} min, ${status}): '${row.preview}'`;
  });
  return [`${rows.length} owner message(s) still need a final answer:`, ...lines].join("\n");
}

/** The captain wake for owner messages whose crew ended with no answer to them. */
export function handBackText(rows: InboundRow[]): string {
  const lines = rows.map((row) => `- ${row.source === "telegram" ? telegramSourceRef(row) : `bb:${row.chatId}:${row.messageId}`} (crew ${row.crewId ?? "unknown"}): '${row.preview}'`);
  return ["These owner messages were handed to a crew that has ended, and they still have no answer. Answer each with firstmate_reply now:", ...lines].join("\n");
}

export function createInboundLedger(db: Database): CreateInboundLedger {
  db.exec(`CREATE TABLE IF NOT EXISTS inbound_ledger (
    source TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL,
    captain TEXT NOT NULL, received_at INTEGER NOT NULL, state TEXT NOT NULL, record TEXT NOT NULL,
    PRIMARY KEY (source, chat_id, message_id));
    CREATE INDEX IF NOT EXISTS inbound_ledger_open ON inbound_ledger(captain, state, received_at);
    CREATE TABLE IF NOT EXISTS inbound_outbox (
    source TEXT NOT NULL, chat_id TEXT NOT NULL, message_id TEXT NOT NULL, kind TEXT NOT NULL,
    content_hash TEXT NOT NULL, sent_at INTEGER NOT NULL, outgoing_message_id TEXT, record TEXT NOT NULL,
    PRIMARY KEY (source, chat_id, message_id, kind));
    CREATE TABLE IF NOT EXISTS inbound_chat_queue (
    chat_id TEXT NOT NULL, seq INTEGER NOT NULL, source TEXT NOT NULL, message_id TEXT NOT NULL,
    PRIMARY KEY (chat_id, seq));`);

  // Rows from plain BB text were the plugin's own reminders and notices (see eventToRow).
  // Close any left open so they stop raising reminders.
  for (const found of db.prepare("SELECT record FROM inbound_ledger WHERE source='bb' AND state IN ('received','acked')").all() as { record: string }[]) {
    const row = parseRow(found.record);
    db.prepare("UPDATE inbound_ledger SET state='answered', record=? WHERE source=? AND chat_id=? AND message_id=?")
      .run(JSON.stringify({ ...row, state: "answered", answeredAt: row.answeredAt ?? Date.now() }), row.source, row.chatId, row.messageId);
  }

  function get(key: InboundKey): InboundRow | undefined {
    const found = db.prepare("SELECT record FROM inbound_ledger WHERE source=? AND chat_id=? AND message_id=?").get(key.source, key.chatId, key.messageId) as { record: string } | undefined;
    return found ? parseRow(found.record) : undefined;
  }

  function save(row: InboundRow) {
    db.prepare("INSERT INTO inbound_ledger VALUES (?,?,?,?,?,?,?) ON CONFLICT(source,chat_id,message_id) DO UPDATE SET captain=excluded.captain,state=excluded.state,record=excluded.record")
      .run(row.source, row.chatId, row.messageId, row.captainThreadId, row.receivedAt, row.state, JSON.stringify(row));
    return row;
  }

  function record(event: LedgerEvent): InboundRow | null {
    const rows = expandTelegramRows(event);
    if (rows.length === 0) return null;
    return db.transaction(() => {
      let first: InboundRow | null = null;
      for (const next of rows) {
        const existing = get(next);
        if (existing) {
          first ??= existing;
          continue;
        }
        save(next);
        const last = db.prepare("SELECT max(seq) AS seq FROM inbound_chat_queue WHERE chat_id=?").get(next.chatId) as { seq: number | null };
        db.prepare("INSERT INTO inbound_chat_queue VALUES (?,?,?,?)").run(next.chatId, (last.seq ?? 0) + 1, next.source, next.messageId);
        first ??= next;
      }
      return first;
    })();
  }

  function listOpen(captainThreadId?: string): InboundRow[] {
    const rows = (captainThreadId
      ? db.prepare("SELECT record FROM inbound_ledger WHERE captain=? AND state IN ('received','acked') ORDER BY received_at").all(captainThreadId)
      : db.prepare("SELECT record FROM inbound_ledger WHERE state IN ('received','acked') ORDER BY received_at").all()) as { record: string }[];
    return rows.map((r) => parseRow(r.record));
  }

  function hasTelegram(captainThreadId: string): boolean {
    return db.prepare("SELECT 1 FROM inbound_ledger WHERE captain=? AND source='telegram' LIMIT 1").get(captainThreadId) != null;
  }

  function transition(key: InboundKey, change: (row: InboundRow) => InboundRow): InboundRow | undefined {
    return db.transaction(() => {
      const current = get(key);
      if (!current) return undefined;
      const next = change(current);
      save(next);
      return next;
    })();
  }

  function claimOutbox(row: InboundKey, kind: OutboxClaimKind, content: string, at: number, reply?: { final: boolean; covers: string[] }) {
    const contentHash = hashText(content);
    return db.transaction(() => {
      const existing = db.prepare("SELECT record FROM inbound_outbox WHERE source=? AND chat_id=? AND message_id=? AND kind=?")
        .get(row.source, row.chatId, row.messageId, kind) as { record: string } | undefined;
      if (existing) return { sent: false, existing: JSON.parse(existing.record) as OutboxRow };
      const out: OutboxRow = { ...row, kind: kind as OutboxKind, contentHash, sentAt: at, outgoingMessageId: null,
        ...(reply ? { ...(reply.final ? { final: true } : {}), inFlight: true, covers: reply.covers } : {}) };
      db.prepare("INSERT INTO inbound_outbox VALUES (?,?,?,?,?,?,?,?)")
        .run(row.source, row.chatId, row.messageId, kind, contentHash, at, null, JSON.stringify(out));
      return { sent: true };
    })();
  }

  function delegatedRows(captainThreadId?: string): InboundRow[] {
    const rows = (captainThreadId
      ? db.prepare("SELECT record FROM inbound_ledger WHERE captain=? AND state='delegated' ORDER BY received_at").all(captainThreadId)
      : db.prepare("SELECT record FROM inbound_ledger WHERE state='delegated' ORDER BY received_at").all()) as { record: string }[];
    return rows.map((r) => parseRow(r.record));
  }

  function listPending(captainThreadId: string): InboundRow[] {
    const rows = db.prepare("SELECT record FROM inbound_ledger WHERE captain=? AND state IN ('received','acked','delegated') ORDER BY received_at")
      .all(captainThreadId) as { record: string }[];
    return rows.map((r) => parseRow(r.record));
  }

  return {
    record,
    get,
    listOpen,
    listPending,
    hasTelegram,
    markAcked(key, at) {
      return transition(key, (row) => row.state === "received" ? { ...row, state: "acked", ackedAt: at } : row);
    },
    reopen(key, at) {
      return db.transaction(() => {
        const current = get(key);
        if (!current || current.state !== "answered") return current;
        db.prepare("DELETE FROM inbound_outbox WHERE source=? AND chat_id=? AND message_id=? AND kind <> 'ack'").run(key.source, key.chatId, key.messageId);
        return save({ ...current, state: "acked", answeredAt: null, ackedAt: current.ackedAt ?? at, coveredBy: undefined, remindedAt: null, remindedKind: null });
      })();
    },
    markAnswered(key, at) {
      return transition(key, (row) => {
        if (row.state === "answered") return row;
        return { ...row, state: "answered", answeredAt: at, ackedAt: row.ackedAt ?? at };
      });
    },
    finishReply(anchor, covers, by, at) {
      return db.transaction(() => {
        const current = anchor ? get(anchor) : undefined;
        if (current && current.state !== "answered") save({ ...current, state: "answered", answeredAt: at, ackedAt: current.ackedAt ?? at });
        const closed: InboundRow[] = [];
        for (const key of covers) {
          const row = get(key);
          if (!row || row.state === "answered") continue;
          closed.push(save({ ...row, state: "answered", coveredBy: by, answeredAt: at, ackedAt: row.ackedAt ?? at }));
        }
        return closed;
      })();
    },
    markDelegated(key, crewId, at) {
      return transition(key, (row) => {
        if (row.state === "answered") return row;
        if (row.state === "delegated" && row.crewId === crewId) return row;
        return { ...row, state: "delegated", crewId, crewEndedAt: null, handedBackAt: null, ackedAt: row.ackedAt ?? at };
      });
    },
    crewEnded(crewId, at) {
      return db.transaction(() => delegatedRows()
        .filter((row) => row.crewId === crewId && row.crewEndedAt == null)
        .map((row) => save({ ...row, crewEndedAt: at })))();
    },
    handBacksDue(captainThreadId) {
      return delegatedRows(captainThreadId).filter((row) => row.crewEndedAt != null && row.handedBackAt == null);
    },
    markHandedBack(rows, at) {
      db.transaction(() => {
        for (const sent of rows) {
          const row = get(sent);
          // A row handed to another crew since the wake was read waits for that crew; this wake does not count for it.
          if (row?.state !== "delegated" || row.crewEndedAt == null || row.handedBackAt != null || row.crewId !== sent.crewId) continue;
          save({ ...row, handedBackAt: at });
        }
      })();
    },
    mergeSourceRefs(keys, refs) {
      db.transaction(() => {
        for (const key of keys) {
          const row = get(key);
          if (!row) continue;
          const merged = [...new Set([...row.sourceRefs, ...refs])];
          save({ ...row, sourceRefs: merged });
        }
      })();
    },
    claimOutbox,
    releaseOutbox(row, kind) {
      db.prepare("DELETE FROM inbound_outbox WHERE source=? AND chat_id=? AND message_id=? AND kind=?")
        .run(row.source, row.chatId, row.messageId, kind);
    },
    rememberOutgoing(row, kind, outgoingMessageId) {
      const existing = db.prepare("SELECT record FROM inbound_outbox WHERE source=? AND chat_id=? AND message_id=? AND kind=?")
        .get(row.source, row.chatId, row.messageId, kind) as { record: string } | undefined;
      if (!existing) return;
      const parsed = JSON.parse(existing.record) as OutboxRow;
      parsed.outgoingMessageId = outgoingMessageId;
      db.prepare("UPDATE inbound_outbox SET outgoing_message_id=?, record=? WHERE source=? AND chat_id=? AND message_id=? AND kind=?")
        .run(outgoingMessageId, JSON.stringify(parsed), row.source, row.chatId, row.messageId, kind);
    },
    markDelivered(row, kind) {
      const existing = db.prepare("SELECT record FROM inbound_outbox WHERE source=? AND chat_id=? AND message_id=? AND kind=?")
        .get(row.source, row.chatId, row.messageId, kind) as { record: string } | undefined;
      if (!existing) return;
      const parsed = JSON.parse(existing.record) as OutboxRow;
      delete parsed.inFlight;
      db.prepare("UPDATE inbound_outbox SET record=? WHERE source=? AND chat_id=? AND message_id=? AND kind=?")
        .run(JSON.stringify(parsed), row.source, row.chatId, row.messageId, kind);
    },
    outboxGet(row, kind) {
      const found = db.prepare("SELECT record FROM inbound_outbox WHERE source=? AND chat_id=? AND message_id=? AND kind=?")
        .get(row.source, row.chatId, row.messageId, kind) as { record: string } | undefined;
      return found ? JSON.parse(found.record) as OutboxRow : undefined;
    },
    enqueueChat(chatId, key) {
      const last = db.prepare("SELECT max(seq) AS seq FROM inbound_chat_queue WHERE chat_id=?").get(chatId) as { seq: number | null };
      const seq = (last.seq ?? 0) + 1;
      db.prepare("INSERT INTO inbound_chat_queue VALUES (?,?,?,?)").run(chatId, seq, key.source, key.messageId);
      return seq;
    },
    chatOrder(chatId) {
      const rows = db.prepare("SELECT source, message_id FROM inbound_chat_queue WHERE chat_id=? ORDER BY seq").all(chatId) as { source: InboundSource; message_id: string }[];
      return rows.map((r) => ({ source: r.source, chatId, messageId: r.message_id }));
    },
    openForSweep(now, captainThreadId) {
      return db.transaction(() => {
        const due = sweepActions(listOpen(captainThreadId), now).filter((action) => reminderDue(action, now));
        for (const action of due) {
          save({ ...action.row, remindedAt: now, remindedKind: action.kind, reminders: (action.row.reminders ?? 0) + 1 });
        }
        return due;
      })();
    },
  };
}

export function keysFromSourceRefs(refs: string[]): InboundKey[] {
  const out: InboundKey[] = [];
  for (const ref of refs) {
    const parsed = parseSourceRef(ref);
    if (parsed) out.push(parsed);
  }
  return out;
}
