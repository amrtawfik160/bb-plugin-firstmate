import type { CreateInboundLedger, LedgerEvent } from "./inbound-ledger.ts";
import { ACK_TEXT, ackEligible } from "./inbound-ledger.ts";
import {
  COALESCE_WINDOW_MS,
  coalesceBatches,
  formatOutboundEnvelope,
  parseInboundTelegram,
  stripTelegramEnvelope,
  telegramReplyParameters,
  telegramSourceRef,
  type TelegramEnvelope,
} from "./telegram-envelope.ts";

export type ReplayUpdate = {
  chatId: string;
  messageId: string;
  text: string;
  at: number;
  senderId?: string;
  mediaGroupId?: string | null;
  forwarded?: boolean;
  threadId?: string | null;
  replyTo?: string | null;
  fromBot?: boolean;
};

export type ReplayReply = {
  kind: "ack" | "reply";
  chatId: string;
  messageId: string;
  text: string;
  reply_parameters: { message_id: number; allow_sending_without_reply: true };
  message_thread_id?: number;
};

export type ReplayHarness = {
  ingest(update: ReplayUpdate): { coalesced: boolean; waitUntil: number | null };
  flush(now: number): ReplayReply[];
  answer(messageId: string, text: string, now: number): ReplayReply | null;
  restart(): void;
  replies(): ReplayReply[];
  ledgerCount(): number;
};

function envelopeOf(update: ReplayUpdate): TelegramEnvelope {
  const parsed = parseInboundTelegram(update.text);
  if (parsed) {
    return {
      ...parsed,
      mediaGroupId: update.mediaGroupId ?? parsed.mediaGroupId,
      forwarded: update.forwarded === true || parsed.forwarded,
      senderId: update.senderId ?? parsed.senderId,
      threadId: update.threadId ?? parsed.threadId,
      replyTo: update.replyTo ?? parsed.replyTo,
    };
  }
  return {
    chatId: update.chatId,
    messageId: update.messageId,
    replyTo: update.replyTo ?? null,
    mediaGroupId: update.mediaGroupId ?? null,
    forwarded: update.forwarded === true,
    threadId: update.threadId ?? null,
    senderId: update.senderId ?? null,
  };
}

export function createTelegramReplay(input: {
  ledger: CreateInboundLedger;
  captainThreadId?: string;
  coalesceMs?: number;
}): ReplayHarness {
  const captain = input.captainThreadId ?? "thr_cap";
  const windowMs = input.coalesceMs ?? COALESCE_WINDOW_MS;
  const sent: ReplayReply[] = [];
  let pending: ReplayUpdate[] = [];
  let waitUntil: number | null = null;

  function eventOf(update: ReplayUpdate): LedgerEvent {
    return {
      captainThreadId: captain,
      text: update.text,
      receivedAt: update.at,
      bbThreadId: captain,
      telegram: envelopeOf(update),
      initiator: update.fromBot ? "agent" : "user",
      isBotOwn: update.fromBot === true,
    };
  }

  function emit(kind: ReplayReply["kind"], env: TelegramEnvelope, text: string, now: number): ReplayReply | null {
    const key = { source: "telegram" as const, chatId: env.chatId, messageId: env.messageId };
    const body = `${formatOutboundEnvelope({ kind, chatId: env.chatId, messageId: env.messageId, threadId: env.threadId })}\n${text}`;
    const claim = input.ledger.claimOutbox(key, kind, body, now);
    if (!claim.sent) return null;
    const params = telegramReplyParameters(env);
    const reply: ReplayReply = {
      kind,
      chatId: env.chatId,
      messageId: env.messageId,
      text: body,
      reply_parameters: params.reply_parameters,
      ...(params.message_thread_id !== undefined ? { message_thread_id: params.message_thread_id } : {}),
    };
    sent.push(reply);
    return reply;
  }

  function updatesFromLedger(): ReplayUpdate[] {
    return input.ledger.listOpen(captain)
      .filter((row) => row.state === "received")
      .map((row) => ({
        chatId: row.chatId,
        messageId: row.messageId,
        text: row.preview,
        at: row.receivedAt,
        senderId: row.senderId ?? undefined,
        mediaGroupId: row.mediaGroupId,
        forwarded: row.forwarded,
        threadId: row.topicId,
        replyTo: row.replyTo,
      }));
  }

  function flush(now: number): ReplayReply[] {
    if (pending.length > 0 && waitUntil !== null && now < waitUntil) return [];
    let batch = pending.splice(0, pending.length);
    waitUntil = null;
    if (batch.length === 0) batch = updatesFromLedger();
    if (batch.length === 0) return [];
    const groups = coalesceBatches(
      batch.map((u) => ({
        chatId: u.chatId,
        senderId: u.senderId ?? envelopeOf(u).senderId,
        mediaGroupId: u.mediaGroupId ?? envelopeOf(u).mediaGroupId,
        receivedAt: u.at,
        messageId: u.messageId,
        forwarded: u.forwarded === true || envelopeOf(u).forwarded,
        kind: (u.forwarded === true || u.mediaGroupId || envelopeOf(u).mediaGroupId || envelopeOf(u).forwarded)
          ? "media" as const
          : "text" as const,
      })),
      windowMs,
    );
    const out: ReplayReply[] = [];
    for (const group of groups) {
      const ids = new Set(group.map((g) => g.messageId));
      const members = batch.filter((u) => ids.has(u.messageId));
      const refs = members.map((u) => telegramSourceRef(envelopeOf(u)));
      input.ledger.mergeSourceRefs(
        members.map((u) => ({ source: "telegram" as const, chatId: u.chatId, messageId: u.messageId })),
        refs,
      );
      const primary = members[0]!;
      const row = input.ledger.get({ source: "telegram", chatId: primary.chatId, messageId: primary.messageId });
      if (!row || !ackEligible(row, now)) continue;
      const env = envelopeOf(primary);
      const ack = emit("ack", env, ACK_TEXT, now);
      if (ack) {
        input.ledger.markAcked(row, now);
        out.push(ack);
      }
    }
    return out;
  }

  return {
    ingest(update) {
      const row = input.ledger.record(eventOf(update));
      if (!row) return { coalesced: false, waitUntil };
      pending.push(update);
      waitUntil = (waitUntil ?? update.at) + 0;
      waitUntil = Math.max(waitUntil, update.at + windowMs);
      return { coalesced: pending.length > 1, waitUntil };
    },
    flush,
    answer(messageId, text, now) {
      const row = input.ledger.listOpen(captain).find((r) => r.messageId === messageId)
        ?? input.ledger.get({ source: "telegram", chatId: pending[0]?.chatId ?? "", messageId });
      if (!row) return null;
      const env: TelegramEnvelope = {
        chatId: row.chatId,
        messageId: row.messageId,
        replyTo: row.replyTo,
        mediaGroupId: row.mediaGroupId,
        forwarded: row.forwarded,
        threadId: row.topicId,
        senderId: row.senderId,
      };
      const reply = emit("reply", env, stripTelegramEnvelope(text), now);
      if (reply) input.ledger.markAnswered(row, now);
      return reply;
    },
    restart() {
      pending = [];
      waitUntil = null;
    },
    replies() {
      return [...sent];
    },
    ledgerCount() {
      return input.ledger.listOpen(captain).length + sent.filter((r) => r.kind === "reply").length;
    },
  };
}
