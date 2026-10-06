import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createDoorbellHold, doorbellHoldDecision } from "./doorbell-hold.ts";

test("plugin doorbells queue while the captain is busy", () => {
  assert.equal(doorbellHoldDecision({
    attempt: "join-turn", initiator: "agent", text: "🔔 ✅ crew c1 done", targetIsCaptain: true, flagOn: true,
  }), "hold");
  assert.equal(doorbellHoldDecision({
    attempt: "join-turn", initiator: "system", text: "@thread:thr_x completed", targetIsCaptain: true, flagOn: true,
  }), "hold");
  assert.equal(doorbellHoldDecision({
    attempt: "join-turn", initiator: "agent", text: "🔔 ⚖️ crew c1 NEEDS DECISION", targetIsCaptain: true, flagOn: true,
  }), "proceed");
  assert.equal(doorbellHoldDecision({
    attempt: "join-turn", initiator: "user", text: "status?", targetIsCaptain: true, flagOn: true,
  }), "proceed");
  assert.equal(doorbellHoldDecision({
    attempt: "join-turn", initiator: "agent", text: "🔔 ✅ crew c1 done", targetIsCaptain: true, flagOn: false,
  }), "proceed");
});

test("held doorbells drain in order", () => {
  const hold = createDoorbellHold(new Database(":memory:"));
  hold.enqueue({ captainThreadId: "thr_cap", text: "first", crewId: "c1", urgent: false, createdAt: 1 });
  hold.enqueue({ captainThreadId: "thr_cap", text: "second", crewId: "c2", urgent: false, createdAt: 2 });
  assert.deepEqual(hold.drain("thr_cap").map((r) => r.text), ["first", "second"]);
  assert.equal(hold.pending("thr_cap"), 0);
});
