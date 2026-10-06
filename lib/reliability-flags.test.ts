import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_RELIABILITY_FLAGS, parseReliabilityFlags } from "./reliability-flags.ts";

test("reliability flags default off", () => {
  assert.deepEqual(parseReliabilityFlags(""), DEFAULT_RELIABILITY_FLAGS);
  assert.deepEqual(parseReliabilityFlags("not-json"), DEFAULT_RELIABILITY_FLAGS);
  assert.deepEqual(parseReliabilityFlags({ inboundLedger: "nope" }), DEFAULT_RELIABILITY_FLAGS);
});

test("reliability flags accept shadow ledger and independent toggles", () => {
  assert.deepEqual(parseReliabilityFlags('{"inboundLedger":"shadow","honestStatus":"on"}'), {
    ...DEFAULT_RELIABILITY_FLAGS,
    inboundLedger: "shadow",
    honestStatus: "on",
  });
});
