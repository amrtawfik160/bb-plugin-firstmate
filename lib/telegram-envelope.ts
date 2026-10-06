export const TELEGRAM_ENVELOPE_RE =
  /⟦tg\s+chat=(?<chat>[^\s⟧]+)\s+msg=(?<msg>[^\s⟧]+)(?:\s+reply_to=(?<reply>[^\s⟧]+))?(?:\s+group=(?<group>[^\s⟧]+))?(?:\s+fwd=(?<fwd>[01]))?(?:\s+thread=(?<thread>[^\s⟧]+))?(?:\s+from=(?<from>[^\s⟧]+))?⟧/u;

export const FIRSTMATE_OUT_ENVELOPE_RE =
  /⟦fm-out\s+kind=(?<kind>[a-z]+)\s+chat=(?<chat>[^\s⟧]+)\s+msg=(?<msg>[^\s⟧]+)(?:\s+thread=(?<thread>[^\s⟧]+))?⟧/u;

export type TelegramEnvelope = {
  chatId: string;
  messageId: string;
  replyTo: string | null;
  mediaGroupId: string | null;
  forwarded: boolean;
  threadId: string | null;
  senderId: string | null;
};

const MISSING = new Set(["", "-", "null", "undefined"]);

function dash(value: string | undefined): string | null {
  if (value === undefined || MISSING.has(value)) return null;
  return value;
}

export function parseTelegramEnvelope(text: string): TelegramEnvelope | null {
  const match = TELEGRAM_ENVELOPE_RE.exec(text);
  if (!match?.groups) return null;
  const chatId = match.groups.chat ?? "";
  const messageId = match.groups.msg ?? "";
  if (chatId === "" || messageId === "") return null;
  return {
    chatId,
    messageId,
    replyTo: dash(match.groups.reply),
    mediaGroupId: dash(match.groups.group),
    forwarded: match.groups.fwd === "1",
    threadId: dash(match.groups.thread),
    senderId: dash(match.groups.from),
  };
}

export function parseTelegramSubmission(data: unknown): TelegramEnvelope | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  const chatId = String(row.chat_id ?? row.chatId ?? "");
  const messageId = String(row.message_id ?? row.messageId ?? "");
  if (chatId === "" || messageId === "") return null;
  return {
    chatId,
    messageId,
    replyTo: dash(row.reply_to != null ? String(row.reply_to) : row.replyTo != null ? String(row.replyTo) : undefined),
    mediaGroupId: dash(row.media_group_id != null ? String(row.media_group_id) : row.mediaGroupId != null ? String(row.mediaGroupId) : undefined),
    forwarded: row.fwd === 1 || row.fwd === "1" || row.forwarded === true,
    threadId: dash(row.message_thread_id != null ? String(row.message_thread_id) : row.threadId != null ? String(row.threadId) : undefined),
    senderId: dash(row.from != null ? String(row.from) : row.senderId != null ? String(row.senderId) : undefined),
  };
}

export function stripTelegramEnvelope(text: string): string {
  return text.replace(TELEGRAM_ENVELOPE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

export function formatTelegramEnvelope(env: TelegramEnvelope): string {
  return `⟦tg chat=${env.chatId} msg=${env.messageId} reply_to=${env.replyTo ?? "-"} group=${env.mediaGroupId ?? "-"} fwd=${env.forwarded ? "1" : "0"} thread=${env.threadId ?? "-"} from=${env.senderId ?? "-"}⟧`;
}

export function telegramSourceRef(env: Pick<TelegramEnvelope, "chatId" | "messageId">): string {
  return `tg:${env.chatId}:${env.messageId}`;
}

export function parseSourceRef(ref: string): { source: "telegram" | "bb"; chatId: string; messageId: string } | null {
  const tg = /^tg:([^:]+):(.+)$/.exec(ref);
  if (tg) return { source: "telegram", chatId: tg[1]!, messageId: tg[2]! };
  const bb = /^bb:([^:]+):(.+)$/.exec(ref);
  if (bb) return { source: "bb", chatId: bb[1]!, messageId: bb[2]! };
  return null;
}

export type TelegramReplyPayload = {
  chat_id: string;
  reply_parameters: { message_id: number; allow_sending_without_reply: true };
  message_thread_id?: number;
};

export function telegramReplyParameters(
  env: Pick<TelegramEnvelope, "chatId" | "messageId" | "threadId">,
): TelegramReplyPayload {
  const payload: TelegramReplyPayload = {
    chat_id: env.chatId,
    reply_parameters: {
      message_id: Number(env.messageId),
      allow_sending_without_reply: true,
    },
  };
  if (env.threadId) payload.message_thread_id = Number(env.threadId);
  return payload;
}

export function formatOutboundEnvelope(input: {
  kind: string;
  chatId: string;
  messageId: string;
  threadId?: string | null;
}): string {
  const thread = input.threadId ? ` thread=${input.threadId}` : "";
  return `⟦fm-out kind=${input.kind} chat=${input.chatId} msg=${input.messageId}${thread}⟧`;
}

export const COALESCE_WINDOW_MS = 2500;

export type CoalesceCandidate = {
  chatId: string;
  senderId: string | null;
  mediaGroupId: string | null;
  receivedAt: number;
  messageId: string;
};

export function coalesceBatches(
  rows: readonly CoalesceCandidate[],
  windowMs = COALESCE_WINDOW_MS,
): CoalesceCandidate[][] {
  const sorted = [...rows].sort((a, b) => a.receivedAt - b.receivedAt || a.messageId.localeCompare(b.messageId));
  const batches: CoalesceCandidate[][] = [];
  for (const row of sorted) {
    const last = batches.at(-1);
    const head = last?.[0];
    if (
      head &&
      head.chatId === row.chatId &&
      head.senderId === row.senderId &&
      (
        (head.mediaGroupId !== null && head.mediaGroupId === row.mediaGroupId) ||
        row.receivedAt - head.receivedAt <= windowMs
      )
    ) {
      last!.push(row);
      continue;
    }
    batches.push([row]);
  }
  return batches;
}

export function isBotOrAckText(text: string): boolean {
  const trimmed = stripTelegramEnvelope(text);
  if (FIRSTMATE_OUT_ENVELOPE_RE.test(text)) return true;
  if (/^On it\.?$/iu.test(trimmed)) return true;
  if (/^received #\d+/iu.test(trimmed)) return true;
  if (/^Still working on #/iu.test(trimmed)) return true;
  return false;
}
