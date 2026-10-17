import { z } from "zod";
import { formatOutboundEnvelope } from "./telegram-envelope.ts";
import type { InboundRow } from "./inbound-ledger.ts";

export const TELEGRAM_BRIDGE_PLUGIN_ID = "telegram";
export const TELEGRAM_REPLY_METHOD = "reply";

export type TelegramReplyKind = "ack" | "reply" | "progress" | "delegated" | "nudge" | "final";

export type TelegramReplyInput = {
  chatId: string;
  messageId: string;
  kind: TelegramReplyKind;
  text: string;
  correlation?: string;
  /** Exact text from the owner message this reply answers. Telegram shows it as a quote. */
  quote?: string;
  /** The project the answer is about. With Telegram topics on, the connector sends it to that project's topic. */
  project?: string;
  /** The owner task the answer belongs to (T<n>): it replies to that task's status line. */
  task?: string;
  /** The answer is the task's result: it rings and marks the owner's messages done. */
  result?: boolean;
};

export type TelegramReplyRpcArgs = {
  pluginId: string;
  method: string;
  input: TelegramReplyInput;
  outputSchema: typeof telegramReplyOutputSchema;
};

export const telegramReplyOutputSchema = z.object({
  queued: z.number(),
  duplicate: z.boolean(),
  mode: z.enum(["on", "off"]).optional(),
  /** The connector held the reply back: it only repeats a card of its turn, and the card answers the owner. */
  cardRepeat: z.boolean().optional(),
  /** The connector held the reply back: it only says the work started, or it is a note about the owner. Nothing answered the owner. */
  dropped: z.enum(["started", "about-owner"]).optional(),
});

export function correlationOf(row: Pick<InboundRow, "sourceRefs">): string | undefined {
  return row.sourceRefs.find((ref) => ref.startsWith("tgref:"));
}

export type TelegramReplyResult = {
  channel: "rpc" | "envelope";
  body: string;
  // undelivered: no sender reached Telegram. body is the fm-out line, which nothing sends on its own.
  outcome: "delivered" | "not-applicable" | "undelivered";
  // The connector's threading mode, when telegram.reply reported one.
  mode?: "on" | "off";
  // The connector already held a reply with this message, kind and quote, so it sent nothing now, whatever the text.
  duplicate?: boolean;
  // The connector sent nothing: the reply only repeats a card of this turn, and that card answers the owner.
  cardRepeat?: boolean;
  // The connector sent nothing: the reply only says the work started, or is a note about the owner.
  dropped?: "started" | "about-owner";
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
  if (typeof error === "object" && error !== null && (error as { code?: unknown }).code === "unknown_method") return true;
  const message = error instanceof Error ? error.message : String(error);
  return /has no rpc method|unknown (?:rpc )?method|no such plugin|plugin "?[\w-]+"? (?:is )?not (?:found|installed|enabled|loaded|running)/i.test(message);
}

export function compareMessageIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const left = BigInt(a), right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
  }
  return a.localeCompare(b);
}

export function oldestUnanswered<T extends { receivedAt: number; messageId: string; state?: string }>(
  rows: readonly T[],
): T | undefined {
  return rows
    .filter((row) => row.state === undefined || row.state === "received" || row.state === "acked")
    .slice()
    .sort((a, b) => a.receivedAt - b.receivedAt || compareMessageIds(a.messageId, b.messageId))[0];
}

export function refuseLaterThanOldest(input: {
  chosen: Pick<InboundRow, "source" | "chatId" | "messageId" | "receivedAt">;
  open: readonly InboundRow[];
}): InboundRow | null {
  const older = oldestUnanswered(
    input.open.filter((row) => row.source === input.chosen.source && row.chatId === input.chosen.chatId),
  );
  if (!older) return null;
  if (compareMessageIds(older.messageId, input.chosen.messageId) === 0) return null;
  return older;
}

export async function sendTelegramReply(input: {
  payload: TelegramReplyInput & { threadId?: string | null };
  callRpc?: ((args: TelegramReplyRpcArgs) => Promise<unknown>) | null;
}): Promise<TelegramReplyResult> {
  const body = telegramReplyFallbackBody(input.payload);
  if (!input.callRpc) return { channel: "envelope", body, outcome: "undelivered" };
  let raw: unknown;
  try {
    raw = await input.callRpc({
      pluginId: TELEGRAM_BRIDGE_PLUGIN_ID,
      method: TELEGRAM_REPLY_METHOD,
      input: {
        chatId: input.payload.chatId,
        messageId: input.payload.messageId,
        kind: input.payload.kind,
        text: input.payload.text,
        ...(input.payload.correlation ? { correlation: input.payload.correlation } : {}),
        ...(input.payload.quote ? { quote: input.payload.quote } : {}),
        ...(input.payload.project ? { project: input.payload.project } : {}),
        ...(input.payload.task ? { task: input.payload.task } : {}),
        ...(input.payload.result ? { result: true } : {}),
      },
      outputSchema: telegramReplyOutputSchema,
    });
  } catch (error) {
    if (!isTelegramRpcMissing(error)) throw error;
    return { channel: "envelope", body, outcome: "undelivered" };
  }
  const result = telegramReplyOutputSchema.parse(raw);
  const mode = result.mode ? { mode: result.mode } : {};
  if (input.payload.kind === "ack" && result.mode === "off") return { channel: "rpc", body, outcome: "not-applicable", ...mode };
  if (result.cardRepeat === true) return { channel: "rpc", body, outcome: "delivered", cardRepeat: true, ...mode };
  if (result.dropped) return { channel: "rpc", body, outcome: "delivered", dropped: result.dropped, ...mode };
  if (result.queued > 0 || result.duplicate) return { channel: "rpc", body, outcome: "delivered", duplicate: result.queued <= 0 && result.duplicate, ...mode };
  throw new Error(`telegram.reply not queued (queued=${result.queued}, mode=${result.mode ?? "unknown"}).`);
}

export const TELEGRAM_REPLIED_METHOD = "replied";
export const telegramRepliedOutputSchema = z.object({ replied: z.array(z.string()) });

/**
 * Open Telegram items that the connector already answered in Telegram, for example with the
 * captain's turn text. Firstmate must not remind the captain about them, or the captain answers
 * the same message twice. A connector without the method answers nothing.
 */
export async function connectorReplied(input: {
  open: Array<{ source: string; chatId: string; messageId: string }>;
  callRpc: (args: { pluginId: string; method: string; input: { chatId: string; messageIds: string[] }; outputSchema: typeof telegramRepliedOutputSchema }) => Promise<unknown>;
}): Promise<Array<{ chatId: string; messageId: string }>> {
  const byChat = new Map<string, string[]>();
  for (const row of input.open) {
    if (row.source !== "telegram") continue;
    byChat.set(row.chatId, [...(byChat.get(row.chatId) ?? []), row.messageId]);
  }
  const found: Array<{ chatId: string; messageId: string }> = [];
  for (const [chatId, messageIds] of byChat) {
    let raw: unknown;
    try {
      raw = await input.callRpc({
        pluginId: TELEGRAM_BRIDGE_PLUGIN_ID,
        method: TELEGRAM_REPLIED_METHOD,
        input: { chatId, messageIds: messageIds.slice(0, 200) },
        outputSchema: telegramRepliedOutputSchema,
      });
    } catch (error) {
      if (isTelegramRpcMissing(error)) return found;
      throw error;
    }
    for (const messageId of telegramRepliedOutputSchema.parse(raw).replied) found.push({ chatId, messageId });
  }
  return found;
}
