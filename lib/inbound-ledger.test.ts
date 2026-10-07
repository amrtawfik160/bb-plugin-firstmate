import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import Database from "better-sqlite3";
import {
  ACK_CUTOFF_MS,
  ACK_TEXT,
  SWEEP_ESCALATE_AFTER_MS,
  SWEEP_NUDGE_AFTER_MS,
  ackEligible,
  createInboundLedger,
  sweeperSteerText,
} from "./inbound-ledger.ts";
import { parseConnectorHeader, parseInboundTelegram, parseTelegramEnvelope } from "./telegram-envelope.ts";

function store() {
  return createInboundLedger(new Database(":memory:"));
}

let nextMessageId = 500;

/** A Telegram owner message; only those are tracked. */
function userEvent(over: Record<string, unknown> = {}) {
  const msg = nextMessageId++;
  return {
    captainThreadId: "thr_cap",
    text: "What are you currently working on?",
    receivedAt: 1_000,
    bbThreadId: "thr_cap",
    initiator: "user",
    telegram: parseTelegramEnvelope(`⟦tg chat=9 msg=${msg} reply_to=- group=- fwd=0 thread=- from=amr⟧`),
    ...over,
  };
}

test("plain BB text and this plugin's own reminders and notices are never tracked", () => {
  const ledger = store();
  for (const text of [
    "What are you currently working on?",
    "Unanswered for 590 min: bb:thr_cap:1:abc 'FM_DELIVERY_NOTICE=x' — answer or dispatch now.",
    "received #1791364638983:f9ee328a57ab: Unanswered for 590 min",
    "FM_DELIVERY_NOTICE=cyndra-ai/cyndra-saas#2112:89eb5160",
  ]) {
    assert.equal(ledger.record(userEvent({ text, telegram: undefined })), null, text);
  }
  assert.equal(ledger.listOpen("thr_cap").length, 0);
});

test("a burst of 3 messages produces 3 ledger rows", () => {
  const ledger = store();
  for (const [i, text] of ["one", "two", "three"].entries()) {
    const row = ledger.record(userEvent({
      text: `⟦tg chat=9 msg=${10 + i} reply_to=- group=- fwd=0 thread=- from=amr⟧\n${text}`,
      receivedAt: 1_000 + i,
      telegram: parseTelegramEnvelope(`⟦tg chat=9 msg=${10 + i} reply_to=- group=- fwd=0 thread=- from=amr⟧`),
    }));
    assert.equal(row?.state, "received");
  }
  assert.equal(ledger.listOpen("thr_cap").length, 3);
  assert.deepEqual(ledger.chatOrder("9").map((k) => k.messageId), ["10", "11", "12"]);
});

test("connector header rows key on telegram chat and message id", () => {
  const ledger = store();
  const text = `The following is an owner message from the private Telegram connector.
correlation: tgref:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee
binding: 5
telegram_user_id: 99
telegram_chat_id: 200
telegram_message_id: 1669
reply_target: none
project: none
Telegram result delivery: captain
What is the status?`;
  const row = ledger.record(userEvent({ text, telegram: parseInboundTelegram(text) }));
  assert.equal(row?.source, "telegram");
  assert.equal(row?.chatId, "200");
  assert.equal(row?.messageId, "1669");
  assert.equal(parseConnectorHeader(text)?.body, "What is the status?");
  assert.ok(row?.sourceRefs.includes("tgref:aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"));
});

test("telegram_message_ids create one row per member and keep tgref", () => {
  const ledger = store();
  const text = `The following is an owner message from the private Telegram connector.
correlation: tgref:11111111-2222-3333-4444-555555555555
binding: 5
telegram_user_id: 99
telegram_chat_id: 200
telegram_message_id: 1669
telegram_message_ids: 1669,1670,1672
telegram_items: 1669=text 1670=photo>1669 1671=forward>1669 1672=text
reply_target: none
project: none
Telegram result delivery: files
[#1669] first
[#1672] second`;
  const first = ledger.record(userEvent({ text, telegram: parseInboundTelegram(text) }));
  assert.equal(first?.messageId, "1669");
  assert.equal(ledger.listOpen("thr_cap").length, 3);
  assert.deepEqual(ledger.listOpen("thr_cap").map((row) => row.messageId), ["1669", "1670", "1672"]);
  assert.ok(ledger.get({ source: "telegram", chatId: "200", messageId: "1672" })?.sourceRefs.includes("tgref:11111111-2222-3333-4444-555555555555"));
});

test("bot own messages and acks stay out of the ledger", () => {
  const ledger = store();
  assert.equal(ledger.record(userEvent({ text: "On it.", isBotOwn: true })), null);
  assert.equal(ledger.record(userEvent({ text: "On it." })), null);
  assert.equal(ledger.record(userEvent({ initiator: "agent", text: "working" })), null);
  assert.equal(ledger.listOpen().length, 0);
});

test("record is idempotent on the telegram key", () => {
  const ledger = store();
  const event = userEvent({
    text: "⟦tg chat=9 msg=44 reply_to=- group=- fwd=0 thread=- from=amr⟧\nhello",
    telegram: parseTelegramEnvelope("⟦tg chat=9 msg=44 reply_to=- group=- fwd=0 thread=- from=amr⟧"),
  });
  const first = ledger.record(event);
  const second = ledger.record({ ...event, text: "⟦tg chat=9 msg=44 reply_to=- group=- fwd=0 thread=- from=amr⟧\nhello again" });
  assert.equal(first?.messageId, "44");
  assert.equal(second?.textHash, first?.textHash);
  assert.equal(ledger.listOpen().length, 1);
});

test("restart after ack does not re-ack old rows", () => {
  const ledger = store();
  const row = ledger.record(userEvent({ receivedAt: 1_000 }))!;
  ledger.markAcked(row, 1_100);
  assert.equal(ackEligible(ledger.get(row)!, 1_200), false);
  const stale = ledger.record(userEvent({ text: "old", receivedAt: 1_000, bbRowId: "old-1" }))!;
  assert.equal(ackEligible(stale, 1_000 + ACK_CUTOFF_MS + 1), false);
});

test("sweeper nudges then escalates and never writes reply text", () => {
  const ledger = store();
  const row = ledger.record(userEvent({ receivedAt: 0 }))!;
  ledger.markAcked(row, 1);
  const nudge = ledger.openForSweep(SWEEP_NUDGE_AFTER_MS);
  assert.equal(nudge[0]?.kind, "nudge");
  assert.match(sweeperSteerText(nudge[0]!), /Unanswered:/);
  const escalate = ledger.openForSweep(SWEEP_ESCALATE_AFTER_MS);
  assert.equal(escalate[0]?.kind, "escalate");
  assert.doesNotMatch(sweeperSteerText(escalate[0]!), /Still working|On it/);
});

test("outbox suppresses a duplicate send of the same kind", () => {
  const ledger = store();
  const row = ledger.record(userEvent({ telegram: parseTelegramEnvelope("⟦tg chat=9 msg=7 reply_to=- group=- fwd=0 thread=- from=amr⟧"), text: "⟦tg chat=9 msg=7 reply_to=- group=- fwd=0 thread=- from=amr⟧\nQ" }))!;
  const first = ledger.claimOutbox(row, "ack", ACK_TEXT, 10);
  const second = ledger.claimOutbox(row, "ack", ACK_TEXT, 11);
  assert.equal(first.sent, true);
  assert.equal(second.sent, false);
});

test("answered and delegated close the row", () => {
  const ledger = store();
  const a = ledger.record(userEvent({ text: "A", bbRowId: "a" }))!;
  const b = ledger.record(userEvent({ text: "B", bbRowId: "b" }))!;
  ledger.markAnswered(a, 5);
  ledger.markDelegated(b, "crew1", 6);
  assert.equal(ledger.listOpen().length, 0);
  assert.equal(ledger.get(a)?.state, "answered");
  assert.equal(ledger.get(b)?.crewId, "crew1");
});

test("only non-text batch items carry the media group id", () => {
  const ledger = store();
  const text = readFileSync(new URL("../test/fixtures/envelopes/main-media-batch.txt", import.meta.url), "utf8");
  ledger.record(userEvent({ text, telegram: parseInboundTelegram(text) }));
  const groups = Object.fromEntries(ledger.listOpen("thr_cap").map((row) => [row.messageId, row.mediaGroupId]));
  assert.deepEqual(groups, { "1669": null, "1670": "mg_7", "1671": "mg_7" });
});

test("a sweep reminds once per row and backs off before the next reminder", () => {
  const ledger = store();
  ledger.record(userEvent({ bbRowId: "r1" }));
  const first = 1_000 + SWEEP_NUDGE_AFTER_MS;
  assert.equal(ledger.openForSweep(first).length, 1);
  assert.equal(ledger.openForSweep(first + 1).length, 0, "a second captain idle right after must not repeat the reminder");
  assert.equal(ledger.openForSweep(first + 60_000).length, 0);
  assert.equal(ledger.openForSweep(1_000 + SWEEP_ESCALATE_AFTER_MS).length, 1, "escalation is a new reminder");
  assert.equal(ledger.openForSweep(1_000 + SWEEP_ESCALATE_AFTER_MS + 1).length, 0);
});

test("a released reply reservation can be claimed again", () => {
  const ledger = store();
  const row = ledger.record(userEvent({ bbRowId: "r1" }))!;
  assert.equal(ledger.claimOutbox(row, "reply", "answer", 1).sent, true);
  ledger.releaseOutbox(row, "reply");
  assert.equal(ledger.claimOutbox(row, "reply", "answer", 2).sent, true);
});

test("an album row from the final connector keeps its media group id", () => {
  const ledger = store();
  const text = readFileSync(new URL("../test/fixtures/envelopes/album.txt", import.meta.url), "utf8");
  ledger.record(userEvent({ text, telegram: parseInboundTelegram(text) }));
  const [row] = ledger.listOpen("thr_cap");
  assert.equal(row?.messageId, "1672");
  assert.equal(row?.mediaGroupId, "13800000000000001");
});

test("opening the ledger closes rows left open from plain BB text", () => {
  const db = new Database(":memory:");
  const ledger = createInboundLedger(db);
  const kept = ledger.record(userEvent())!;
  const legacy = { ...kept, source: "bb" as const, chatId: "thr_cap", messageId: "1:abc", sourceRefs: ["bb:thr_cap:1:abc"] };
  db.prepare("INSERT INTO inbound_ledger VALUES (?,?,?,?,?,?,?)")
    .run("bb", "thr_cap", "1:abc", "thr_cap", 1_000, "received", JSON.stringify(legacy));
  assert.equal(ledger.listOpen("thr_cap").length, 2);
  const reopened = createInboundLedger(db);
  assert.deepEqual(reopened.listOpen("thr_cap").map((row) => row.source), ["telegram"]);
  assert.equal(reopened.get({ source: "bb", chatId: "thr_cap", messageId: "1:abc" })?.state, "answered");
});
