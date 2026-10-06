import assert from "node:assert/strict";
import test from "node:test";
import { idleVerdictPresentation } from "./policy.ts";
import {
  countsTowardActiveCap,
  crewStatusPageHead,
  honestIdleVerdictPresentation,
  interruptIsStopped,
  readyClaim,
  readyHasEvidence,
  statusReadLabel,
} from "./honest-status.ts";

test("null verdict is unknown, not done", () => {
  assert.equal(idleVerdictPresentation("c1", null).head, "✅ crew c1 done");
  const honest = honestIdleVerdictPresentation("c1", null);
  assert.equal(honest.head, "❓ crew c1 unknown");
  assert.doesNotMatch(honest.head, /done/);
  assert.doesNotMatch(honest.next, /deliver/);
});

test("a 15s timeout is unreachable, not gone", () => {
  assert.match(crewStatusPageHead("c1", "unknown", true), /unreachable/);
  assert.doesNotMatch(crewStatusPageHead("c1", "unknown", true), /gone/);
  assert.equal(statusReadLabel(true, "unknown"), "unreachable");
});

test("READY without evidence is not allowed", () => {
  assert.equal(readyHasEvidence("READY: login is fixed"), false);
  assert.equal(readyClaim("c1", "READY: login is fixed").allowed, false);
  assert.equal(readyHasEvidence("READY: login is fixed\n```\nnpm test\n# pass 12\n```"), true);
  assert.equal(readyClaim("c1", "evidence: curl /health → HTTP 200").allowed, true);
});

test("any interrupt reason counts as stopped", () => {
  assert.equal(interruptIsStopped("manual-stop"), true);
  assert.equal(interruptIsStopped("bb thread stop"), true);
  assert.equal(interruptIsStopped(""), false);
});

test("unknown status does not consume a cap slot", () => {
  assert.equal(countsTowardActiveCap("unknown"), false);
  assert.equal(countsTowardActiveCap("active"), true);
  assert.equal(countsTowardActiveCap("starting"), true);
});
