import { createHash } from "node:crypto";
import { isBotOrAckText, parseSourceRef, telegramSourceRef, type TelegramEnvelope } from "./telegram-envelope.ts";

export type InboundSource = "bb" | "telegram";
export type InboundState = "received" | "acked" | "answered" | "delegated";
export type OutboxKind = "ack" | "reply" | "progress" | "delegated" | "nudge";

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
  sourceRefs: string[];
  mediaGroupId: string | null;
  senderId: string | null;
  topicId: string | null;
  replyTo: string | null;
  forwarded: boolean;
  isBotOwn: boolean;
  isAck: boolean;
};

export type OutboxRow = InboundKey & {
  kind: OutboxKind;
  contentHash: string;
  sentAt: number;
  outgoingMessageId: string | null;
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
  const source: InboundSource = tg ? "telegram" : "bb";
  const chatId = tg?.chatId ?? event.bbThreadId;
  const messageId = tg?.messageId ?? event.bbRowId ?? `${event.receivedAt}:${hashText(event.text).slice(0, 12)}`;
  const ref = source === "telegram"
    ? telegramSourceRef({ chatId, messageId })
    : `bb:${chatId}:${messageId}`;
  return {
    source,
    chatId,
    messageId,
    captainThreadId: event.captainThreadId,
    receivedAt: event.receivedAt,
    textHash: hashText(event.text),
    preview: previewOf(event.text),
    state: "received",
    ackedAt: null,
    answeredAt: null,
    crewId: null,
    sourceRefs: [ref],
    mediaGroupId: tg?.mediaGroupId ?? null,
    senderId: tg?.senderId ?? null,
    topicId: tg?.threadId ?? null,
    replyTo: tg?.replyTo ?? null,
    forwarded: tg?.forwarded === true,
    isBotOwn: false,
    isAck: false,
  };
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
  markAcked(key: InboundKey, at: number): InboundRow | undefined;
  markAnswered(key: InboundKey, at: number): InboundRow | undefined;
  markDelegated(key: InboundKey, crewId: string, at: number): InboundRow | undefined;
  mergeSourceRefs(keys: InboundKey[], refs: string[]): void;
  claimOutbox(row: InboundKey, kind: OutboxKind, content: string, at: number): { sent: boolean; existing?: OutboxRow };
  rememberOutgoing(row: InboundKey, kind: OutboxKind, outgoingMessageId: string): void;
  outboxGet(row: InboundKey, kind: OutboxKind): OutboxRow | undefined;
  enqueueChat(chatId: string, key: InboundKey): number;
  chatOrder(chatId: string): InboundKey[];
  openForSweep(now: number): SweepAction[];
};

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
    const next = eventToRow(event);
    if (!next) return null;
    return db.transaction(() => {
      const existing = get(next);
      if (existing) return existing;
      save(next);
      const last = db.prepare("SELECT max(seq) AS seq FROM inbound_chat_queue WHERE chat_id=?").get(next.chatId) as { seq: number | null };
      db.prepare("INSERT INTO inbound_chat_queue VALUES (?,?,?,?)").run(next.chatId, (last.seq ?? 0) + 1, next.source, next.messageId);
      return next;
    })();
  }

  function listOpen(captainThreadId?: string): InboundRow[] {
    const rows = (captainThreadId
      ? db.prepare("SELECT record FROM inbound_ledger WHERE captain=? AND state IN ('received','acked') ORDER BY received_at").all(captainThreadId)
      : db.prepare("SELECT record FROM inbound_ledger WHERE state IN ('received','acked') ORDER BY received_at").all()) as { record: string }[];
    return rows.map((r) => parseRow(r.record));
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

  function claimOutbox(row: InboundKey, kind: OutboxKind, content: string, at: number) {
    const contentHash = hashText(content);
    return db.transaction(() => {
      const existing = db.prepare("SELECT record FROM inbound_outbox WHERE source=? AND chat_id=? AND message_id=? AND kind=?")
        .get(row.source, row.chatId, row.messageId, kind) as { record: string } | undefined;
      if (existing) return { sent: false, existing: JSON.parse(existing.record) as OutboxRow };
      const out: OutboxRow = { ...row, kind, contentHash, sentAt: at, outgoingMessageId: null };
      db.prepare("INSERT INTO inbound_outbox VALUES (?,?,?,?,?,?,?,?)")
        .run(row.source, row.chatId, row.messageId, kind, contentHash, at, null, JSON.stringify(out));
      return { sent: true };
    })();
  }

  return {
    record,
    get,
    listOpen,
    markAcked(key, at) {
      return transition(key, (row) => row.state === "received" ? { ...row, state: "acked", ackedAt: at } : row);
    },
    markAnswered(key, at) {
      return transition(key, (row) => {
        if (row.state === "answered") return row;
        return { ...row, state: "answered", answeredAt: at, ackedAt: row.ackedAt ?? at };
      });
    },
    markDelegated(key, crewId, at) {
      return transition(key, (row) => {
        if (row.state === "answered") return row;
        return { ...row, state: "delegated", crewId, ackedAt: row.ackedAt ?? at };
      });
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
    rememberOutgoing(row, kind, outgoingMessageId) {
      const existing = db.prepare("SELECT record FROM inbound_outbox WHERE source=? AND chat_id=? AND message_id=? AND kind=?")
        .get(row.source, row.chatId, row.messageId, kind) as { record: string } | undefined;
      if (!existing) return;
      const parsed = JSON.parse(existing.record) as OutboxRow;
      parsed.outgoingMessageId = outgoingMessageId;
      db.prepare("UPDATE inbound_outbox SET outgoing_message_id=?, record=? WHERE source=? AND chat_id=? AND message_id=? AND kind=?")
        .run(outgoingMessageId, JSON.stringify(parsed), row.source, row.chatId, row.messageId, kind);
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
    openForSweep(now) {
      return sweepActions(listOpen(), now);
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
