import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createInboundLedger } from "./inbound-ledger.ts";
import { createTelegramReplay } from "./telegram-replay.ts";
import { coalesceBatches } from "./telegram-envelope.ts";

function harness() {
  const ledger = createInboundLedger(new Database(":memory:"));
  return { ledger, replay: createTelegramReplay({ ledger, captainThreadId: "thr_cap", coalesceMs: 2500 }) };
}

test("burst of 3 messages produces 3 ledger rows and 3 threaded replies", () => {
  const { ledger, replay } = harness();
  replay.ingest({ chatId: "9", messageId: "1", text: "task a", at: 0, senderId: "amr" });
  replay.ingest({ chatId: "9", messageId: "2", text: "task b", at: 10_000, senderId: "amr" });
  replay.ingest({ chatId: "9", messageId: "3", text: "task c", at: 20_000, senderId: "amr" });
  replay.flush(30_000);
  assert.equal(ledger.listOpen("thr_cap").length, 3);
  for (const id of ["1", "2", "3"]) {
    const reply = replay.answer(id, `answer ${id}`, 31_000);
    assert.ok(reply);
    assert.deepEqual(reply.reply_parameters, { message_id: Number(id), allow_sending_without_reply: true });
  }
  const replies = replay.replies().filter((r) => r.kind === "reply");
  assert.equal(replies.length, 3);
  assert.deepEqual(replies.map((r) => r.messageId), ["1", "2", "3"]);
});

test("media plus caption coalesces into 1 task keeping every source id", () => {
  const { ledger, replay } = harness();
  replay.ingest({ chatId: "9", messageId: "10", text: "investigate this issue", at: 0, senderId: "amr" });
  replay.ingest({
    chatId: "9",
    messageId: "11",
    text: "screenshot",
    at: 400,
    senderId: "amr",
    forwarded: true,
    mediaGroupId: "mg1",
  });
  replay.flush(3_000);
  const rows = [ledger.get({ source: "telegram", chatId: "9", messageId: "10" }), ledger.get({ source: "telegram", chatId: "9", messageId: "11" })];
  assert.ok(rows[0] && rows[1]);
  const batches = coalesceBatches([
    { chatId: "9", senderId: "amr", mediaGroupId: null, receivedAt: 0, messageId: "10" },
    { chatId: "9", senderId: "amr", mediaGroupId: "mg1", receivedAt: 400, messageId: "11" },
  ]);
  assert.equal(batches.length, 1);
  assert.deepEqual(rows[0]!.sourceRefs.sort(), ["tg:9:10", "tg:9:11"]);
  assert.equal(replay.replies().filter((r) => r.kind === "ack").length, 1);
});

test("reload between ack and reply still leaves the sweeper a live row", () => {
  const db = new Database(":memory:");
  const first = createInboundLedger(db);
  const replay = createTelegramReplay({ ledger: first });
  replay.ingest({ chatId: "9", messageId: "5", text: "status?", at: 0, senderId: "amr" });
  replay.flush(3_000);
  assert.equal(first.get({ source: "telegram", chatId: "9", messageId: "5" })?.state, "acked");
  replay.restart();
  const restored = createInboundLedger(db);
  assert.equal(restored.get({ source: "telegram", chatId: "9", messageId: "5" })?.state, "acked");
  assert.equal(restored.openForSweep(4 * 60_000)[0]?.row.messageId, "5");
});

test("duplicate sends are suppressed", () => {
  const { replay } = harness();
  replay.ingest({ chatId: "9", messageId: "8", text: "hi", at: 0, senderId: "amr" });
  replay.flush(3_000);
  const a = replay.answer("8", "working", 4_000);
  const b = replay.answer("8", "working", 4_100);
  assert.ok(a);
  assert.equal(b, null);
  assert.equal(replay.replies().filter((r) => r.kind === "reply").length, 1);
});

test("three quick separate questions stay three items with three replies", () => {
  const { ledger, replay } = harness();
  replay.ingest({ chatId: "9", messageId: "1", text: "task a", at: 0, senderId: "amr" });
  replay.ingest({ chatId: "9", messageId: "2", text: "task b", at: 200, senderId: "amr" });
  replay.ingest({ chatId: "9", messageId: "3", text: "task c", at: 400, senderId: "amr" });
  replay.flush(3_000);
  assert.equal(ledger.listOpen("thr_cap").length, 3);
  assert.equal(replay.replies().filter((r) => r.kind === "ack").length, 3);
  for (const id of ["1", "2", "3"]) {
    assert.ok(replay.answer(id, `answer ${id}`, 4_000));
  }
  assert.equal(replay.replies().filter((r) => r.kind === "reply").length, 3);
});

test("a restart mid-burst flushes from the ledger and does not lose rows", () => {
  const db = new Database(":memory:");
  const first = createInboundLedger(db);
  const replay = createTelegramReplay({ ledger: first, captainThreadId: "thr_cap", coalesceMs: 2500 });
  replay.ingest({ chatId: "9", messageId: "21", text: "first question", at: 0, senderId: "amr" });
  replay.ingest({ chatId: "9", messageId: "22", text: "second question", at: 150, senderId: "amr" });
  replay.restart();
  const restored = createInboundLedger(db);
  const resumed = createTelegramReplay({ ledger: restored, captainThreadId: "thr_cap", coalesceMs: 2500 });
  const acks = resumed.flush(3_000);
  assert.equal(restored.listOpen("thr_cap").length, 2);
  assert.equal(acks.length, 2);
  assert.deepEqual(acks.map((row) => row.messageId).sort(), ["21", "22"]);
  assert.equal(restored.get({ source: "telegram", chatId: "9", messageId: "21" })?.state, "acked");
  assert.equal(restored.get({ source: "telegram", chatId: "9", messageId: "22" })?.state, "acked");
});

test("a mid-turn status question is a ledger row plus a steer, not a fold", () => {
  const { ledger, replay } = harness();
  replay.ingest({ chatId: "9", messageId: "1", text: "do the long task", at: 0, senderId: "amr" });
  replay.ingest({ chatId: "9", messageId: "2", text: "What are you currently working on?", at: 12_000, senderId: "amr" });
  replay.flush(20_000);
  assert.equal(ledger.listOpen().length, 2);
  assert.ok(ledger.get({ source: "telegram", chatId: "9", messageId: "2" }));
});
