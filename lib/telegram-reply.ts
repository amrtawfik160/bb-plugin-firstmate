import { z } from "zod";
import { formatOutboundEnvelope } from "./telegram-envelope.ts";
import type { InboundRow } from "./inbound-ledger.ts";

export const TELEGRAM_BRIDGE_PLUGIN_ID = "telegram";
export const TELEGRAM_REPLY_METHOD = "reply";

export type TelegramReplyKind = "ack" | "reply" | "progress" | "delegated" | "nudge";

export type TelegramReplyInput = {
  chatId: string;
  messageId: string;
  kind: TelegramReplyKind;
  text: string;
};

export type TelegramReplyRpcArgs = {
  pluginId: string;
  method: string;
  input: TelegramReplyInput;
  outputSchema: typeof telegramReplyOutputSchema;
};

export const telegramReplyOutputSchema = z.unknown();

export type TelegramReplyResult = {
  channel: "rpc" | "envelope";
  body: string;
};

export function telegramReplyFallbackBody(input: TelegramReplyInput & { threadId?: string | null }): string {
  return `${formatOutboundEnvelope({
    kind: input.kind,
    chatId: input.chatId,
    messageId: input.messageId,
    threadId: input.threadId,
  })}\n${input.text}`;
}

export function isTelegramRpcMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|unknown method|no such|missing|unavailable|cannot find|plugin .*not/i.test(message);
}

export function oldestUnanswered<T extends { receivedAt: number; messageId: string; state?: string }>(
  rows: readonly T[],
): T | undefined {
  return rows
    .filter((row) => row.state === undefined || row.state === "received" || row.state === "acked")
    .slice()
    .sort((a, b) => a.receivedAt - b.receivedAt || a.messageId.localeCompare(b.messageId))[0];
}

export function refuseLaterThanOldest(input: {
  chosen: Pick<InboundRow, "source" | "chatId" | "messageId" | "receivedAt">;
  open: readonly InboundRow[];
}): InboundRow | null {
  const older = oldestUnanswered(
    input.open.filter((row) => row.source === input.chosen.source && row.chatId === input.chosen.chatId),
  );
  if (!older) return null;
  if (older.messageId === input.chosen.messageId) return null;
  if (older.receivedAt < input.chosen.receivedAt) return older;
  return null;
}

export async function sendTelegramReply(input: {
  payload: TelegramReplyInput & { threadId?: string | null };
  callRpc?: ((args: TelegramReplyRpcArgs) => Promise<unknown>) | null;
}): Promise<TelegramReplyResult> {
  const body = telegramReplyFallbackBody(input.payload);
  if (!input.callRpc) return { channel: "envelope", body };
  try {
    await input.callRpc({
      pluginId: TELEGRAM_BRIDGE_PLUGIN_ID,
      method: TELEGRAM_REPLY_METHOD,
      input: {
        chatId: input.payload.chatId,
        messageId: input.payload.messageId,
        kind: input.payload.kind,
        text: input.payload.text,
      },
      outputSchema: telegramReplyOutputSchema,
    });
    return { channel: "rpc", body };
  } catch (error) {
    if (!isTelegramRpcMissing(error)) throw error;
    return { channel: "envelope", body };
  }
}
