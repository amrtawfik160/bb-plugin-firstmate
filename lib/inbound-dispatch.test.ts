import assert from "node:assert/strict";
import test from "node:test";
import { inboundHookDecision } from "./inbound-dispatch.ts";
import { DEFAULT_RELIABILITY_FLAGS } from "./reliability-flags.ts";
import { parseTelegramEnvelope } from "./telegram-envelope.ts";

const tg = parseTelegramEnvelope("⟦tg chat=9 msg=1 reply_to=- group=- fwd=0 thread=- from=amr⟧");

test("shadow records and never waits", () => {
  const decision = inboundHookDecision({
    flags: { ...DEFAULT_RELIABILITY_FLAGS, inboundLedger: "shadow" },
    attempt: "start-turn", initiator: "user", text: "hi", now: 0, queuedCount: 0, telegram: tg, coalesceDeadline: null,
  });
  assert.equal(decision.record, true);
  assert.equal(decision.action, "proceed");
});

test("telegram start-turn coalesces then proceeds, join-turn steers", () => {
  const flags = { ...DEFAULT_RELIABILITY_FLAGS, inboundLedger: "on", telegramThreading: "on" };
  const wait = inboundHookDecision({
    flags, attempt: "start-turn", initiator: "user", text: "hi", now: 0, queuedCount: 0, telegram: tg, coalesceDeadline: null,
  });
  assert.equal(wait.action, "wait");
  assert.ok((wait.sendAt ?? 0) > 0);
  const ready = inboundHookDecision({
    flags, attempt: "start-turn", initiator: "user", text: "hi", now: wait.sendAt!, queuedCount: 2, telegram: tg, coalesceDeadline: wait.sendAt!,
  });
  assert.equal(ready.action, "proceed");
  const mid = inboundHookDecision({
    flags, attempt: "join-turn", initiator: "user", text: "status?", now: 1, queuedCount: 0, telegram: tg, coalesceDeadline: null,
  });
  assert.equal(mid.action, "proceed");
  assert.equal(mid.steer, true);
});
