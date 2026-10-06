import assert from "node:assert/strict";
import test from "node:test";
import { oldestUnanswered, refuseLaterThanOldest, sendTelegramReply, telegramReplyFallbackBody } from "./telegram-reply.ts";
import type { InboundRow } from "./inbound-ledger.ts";

function row(over: Partial<InboundRow>): InboundRow {
  return {
    source: "telegram",
    chatId: "200",
    messageId: "1",
    captainThreadId: "thr_cap",
    receivedAt: 1,
    textHash: "x",
    preview: "q",
    state: "acked",
    ackedAt: 2,
    answeredAt: null,
    crewId: null,
    sourceRefs: ["tg:200:1"],
    mediaGroupId: null,
    senderId: "99",
    topicId: null,
    replyTo: null,
    forwarded: false,
    isBotOwn: false,
    isAck: false,
    ...over,
  };
}

test("sendTelegramReply uses the bridge RPC when it exists", async () => {
  const calls: unknown[] = [];
  const result = await sendTelegramReply({
    payload: { chatId: "200", messageId: "1669", kind: "ack", text: "On it.", correlation: "tgref:abc" },
    callRpc: async (args) => {
      calls.push(args);
      return { queued: 1, duplicate: false };
    },
  });
  assert.equal(result.channel, "rpc");
  assert.match(result.body, /⟦fm-out kind=ack chat=200 msg=1669⟧/);
  assert.equal((calls[0] as { pluginId: string; method: string }).pluginId, "telegram");
  assert.equal((calls[0] as { method: string }).method, "reply");
  assert.equal((calls[0] as { input: { correlation?: string } }).input.correlation, "tgref:abc");
});

test("sendTelegramReply falls back to an fm-out line when the RPC is missing", async () => {
  const result = await sendTelegramReply({
    payload: { chatId: "200", messageId: "1669", kind: "reply", text: "done" },
    callRpc: async () => {
      throw new Error("Unknown method telegram.reply");
    },
  });
  assert.equal(result.channel, "envelope");
  assert.equal(result.body, telegramReplyFallbackBody({ chatId: "200", messageId: "1669", kind: "reply", text: "done" }));
});

test("final answers target the oldest unanswered item, never the latest", () => {
  const open = [
    row({ messageId: "10", receivedAt: 1, state: "acked" }),
    row({ messageId: "11", receivedAt: 2, state: "received" }),
  ];
  assert.equal(oldestUnanswered(open)?.messageId, "10");
  assert.equal(refuseLaterThanOldest({ chosen: open[1]!, open })?.messageId, "10");
  assert.equal(refuseLaterThanOldest({ chosen: open[0]!, open }), null);
});
