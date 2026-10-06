export const TELEGRAM_ENVELOPE_RE =
  /⟦tg\s+chat=(?<chat>[^\s⟧]+)\s+msg=(?<msg>[^\s⟧]+)(?:\s+reply_to=(?<reply>[^\s⟧]+))?(?:\s+group=(?<group>[^\s⟧]+))?(?:\s+fwd=(?<fwd>[01]))?(?:\s+thread=(?<thread>[^\s⟧]+))?(?:\s+from=(?<from>[^\s⟧]+))?⟧/u;

export const FIRSTMATE_OUT_ENVELOPE_RE =
  /⟦fm-out\s+kind=(?<kind>[a-z]+)\s+chat=(?<chat>[^\s⟧]+)\s+msg=(?<msg>[^\s⟧]+)(?:\s+thread=(?<thread>[^\s⟧]+))?⟧/u;

export const CONNECTOR_BANNER = "The following is an owner message from the private Telegram connector.";

export type TelegramEnvelope = {
  chatId: string;
  messageId: string;
  replyTo: string | null;
  mediaGroupId: string | null;
  forwarded: boolean;
  threadId: string | null;
  senderId: string | null;
  correlation?: string | null;
  binding?: string | null;
  messageIds?: string[];
  items?: string | null;
  project?: string | null;
};

export type ConnectorHeader = TelegramEnvelope & {
  body: string;
};

export type TelegramItemDecl = {
  id: string;
  kind: string;
  attachedTo: string | null;
};

const MISSING = new Set(["", "-", "null", "undefined", "none"]);

function dash(value: string | undefined): string | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (MISSING.has(trimmed.toLowerCase())) return null;
  return trimmed;
}

function splitIds(value: string | null): string[] {
  if (!value) return [];
  return value.split(/[\s,]+/).map((part) => part.trim()).filter((part) => dash(part) !== null);
}

export function parseTelegramItems(raw: string | null | undefined): TelegramItemDecl[] {
  if (!raw) return [];
  const out: TelegramItemDecl[] = [];
  for (const token of raw.trim().split(/\s+/)) {
    const match = /^(\d+)=([A-Za-z][A-Za-z0-9_-]*)(?:>(\d+))?$/.exec(token);
    if (!match) continue;
    out.push({ id: match[1]!, kind: match[2]!.toLowerCase(), attachedTo: match[3] ?? null });
  }
  return out;
}

export function parseConnectorHeader(text: string): ConnectorHeader | null {
  const start = text.replace(/^\uFEFF/, "").trimStart();
  if (!start.startsWith(CONNECTOR_BANNER)) return null;
  const rest = start.slice(CONNECTOR_BANNER.length).replace(/^\r?\n/, "");
  const lines = rest.split(/\r?\n/);
  const fields = new Map<string, string>();
  let index = 0;
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === "") {
      index += 1;
      break;
    }
    if (line.startsWith("Telegram result delivery:")) continue;
    const match = /^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/.exec(line);
    if (!match) break;
    fields.set(match[1]!.toLowerCase(), match[2]!.trim());
  }
  const chatId = dash(fields.get("telegram_chat_id"));
  const messageIds = splitIds(dash(fields.get("telegram_message_ids")) ?? "");
  const messageId = dash(fields.get("telegram_message_id")) ?? messageIds[0] ?? null;
  if (!chatId || !messageId) return null;
  return {
    chatId,
    messageId,
    replyTo: dash(fields.get("reply_target") ?? fields.get("telegram_reply_to")),
    mediaGroupId: dash(fields.get("telegram_media_group_id")),
    forwarded: fields.get("telegram_forwarded") === "1" || fields.get("telegram_forwarded") === "true",
    threadId: dash(fields.get("telegram_thread_id") ?? fields.get("telegram_message_thread_id")),
    senderId: dash(fields.get("telegram_user_id")),
    correlation: dash(fields.get("correlation")),
    binding: dash(fields.get("binding")),
    messageIds: messageIds.length > 0 ? messageIds : [messageId],
    items: dash(fields.get("telegram_items")),
    project: dash(fields.get("project")),
    body: lines.slice(index).join("\n").trim(),
  };
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

export function parseInboundTelegram(text: string): TelegramEnvelope | null {
  const header = parseConnectorHeader(text);
  if (header) {
    const { body: _body, ...envelope } = header;
    return envelope;
  }
  return parseTelegramEnvelope(text);
}

export function parseTelegramSubmission(data: unknown): TelegramEnvelope | null {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
  const row = data as Record<string, unknown>;
  const chatId = String(row.chat_id ?? row.chatId ?? row.telegram_chat_id ?? "");
  const messageId = String(row.message_id ?? row.messageId ?? row.telegram_message_id ?? "");
  if (chatId === "" || messageId === "" || MISSING.has(chatId) || MISSING.has(messageId)) return null;
  return {
    chatId,
    messageId,
    replyTo: dash(row.reply_to != null ? String(row.reply_to) : row.replyTo != null ? String(row.replyTo) : row.reply_target != null ? String(row.reply_target) : undefined),
    mediaGroupId: dash(row.media_group_id != null ? String(row.media_group_id) : row.mediaGroupId != null ? String(row.mediaGroupId) : row.telegram_media_group_id != null ? String(row.telegram_media_group_id) : undefined),
    forwarded: row.fwd === 1 || row.fwd === "1" || row.forwarded === true,
    threadId: dash(row.message_thread_id != null ? String(row.message_thread_id) : row.threadId != null ? String(row.threadId) : undefined),
    senderId: dash(row.from != null ? String(row.from) : row.senderId != null ? String(row.senderId) : row.telegram_user_id != null ? String(row.telegram_user_id) : undefined),
  };
}

export function stripConnectorHeader(text: string): string {
  const parsed = parseConnectorHeader(text);
  return parsed ? parsed.body : text;
}

export function stripTelegramEnvelope(text: string): string {
  return stripConnectorHeader(text).replace(TELEGRAM_ENVELOPE_RE, "").replace(/\n{3,}/g, "\n\n").trim();
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

export type CoalesceKind = "text" | "media" | "uncaptioned";

export type CoalesceCandidate = {
  chatId: string;
  senderId: string | null;
  mediaGroupId: string | null;
  receivedAt: number;
  messageId: string;
  forwarded?: boolean;
  kind?: CoalesceKind;
};

export function isAttachableCoalesce(row: CoalesceCandidate): boolean {
  if (row.forwarded === true) return true;
  if (row.mediaGroupId !== null && row.mediaGroupId !== undefined) return true;
  return row.kind === "media" || row.kind === "uncaptioned";
}

export function coalesceBatches(
  rows: readonly CoalesceCandidate[],
  windowMs = COALESCE_WINDOW_MS,
): CoalesceCandidate[][] {
  const sorted = [...rows].sort((a, b) => a.receivedAt - b.receivedAt || a.messageId.localeCompare(b.messageId));
  const batches: CoalesceCandidate[][] = [];
  for (const row of sorted) {
    const last = batches.at(-1);
    const tail = last?.at(-1);
    const sameGroup = tail !== undefined
      && tail.mediaGroupId !== null
      && tail.mediaGroupId !== undefined
      && tail.mediaGroupId === row.mediaGroupId;
    if (
      last &&
      tail &&
      tail.chatId === row.chatId &&
      tail.senderId === row.senderId &&
      (
        sameGroup ||
        (isAttachableCoalesce(row) && row.receivedAt - tail.receivedAt <= windowMs)
      )
    ) {
      last.push(row);
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
