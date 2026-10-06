import type { ReliabilityFlags } from "./reliability-flags.ts";
import type { TelegramEnvelope } from "./telegram-envelope.ts";
import { COALESCE_WINDOW_MS } from "./telegram-envelope.ts";

export type InboundHookInput = {
  flags: ReliabilityFlags;
  attempt: "start-turn" | "join-turn" | string;
  initiator: string;
  text: string;
  now: number;
  queuedCount: number;
  telegram: TelegramEnvelope | null;
  coalesceDeadline: number | null;
};

export type InboundHookDecision = {
  record: boolean;
  action: "proceed" | "wait";
  sendAt?: number;
  reason?: string;
  steer: boolean;
};

export function inboundHookDecision(input: InboundHookInput): InboundHookDecision {
  const user = input.initiator === "user";
  const record = input.flags.inboundLedger !== "off" && user;
  if (!record) return { record: false, action: "proceed", steer: false };
  const threading = input.flags.telegramThreading === "on" && input.telegram !== null;
  const debounce = threading && input.attempt === "start-turn";
  if (debounce) {
    const sendAt = input.coalesceDeadline ?? input.now + COALESCE_WINDOW_MS;
    if (input.now < sendAt) {
      return { record: true, action: "wait", sendAt, reason: "Coalescing inbound Telegram burst", steer: false };
    }
  }
  const steer = input.attempt === "join-turn";
  return { record: true, action: "proceed", steer };
}
