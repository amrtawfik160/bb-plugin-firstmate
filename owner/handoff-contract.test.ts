import assert from "node:assert/strict";
import test from "node:test";
import { HANDOFF_FAST_PATH, captainInstructionsWithHandoff, wakeGuidanceWithHandoff } from "./handoff-contract.ts";

test("handoff contract slims intake to two sentences or dispatch now", () => {
  assert.match(HANDOFF_FAST_PATH, /2 sentences/);
  assert.match(HANDOFF_FAST_PATH, /firstmate_dispatch/);
  assert.match(HANDOFF_FAST_PATH, /Do not read reports/);
  const on = captainInstructionsWithHandoff("BASE", true);
  assert.ok(on.startsWith(HANDOFF_FAST_PATH));
  assert.equal(captainInstructionsWithHandoff("BASE", false), "BASE");
  assert.match(wakeGuidanceWithHandoff("WAKE", true), /user message/);
});
