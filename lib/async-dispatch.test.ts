import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_ACTIVE_CREWS } from "./policy.ts";
import { admissionDecision, spawnBackoffMs } from "./async-dispatch.ts";

test("default crew cap is 10", () => {
  assert.equal(DEFAULT_MAX_ACTIVE_CREWS, 10);
});

test("over-cap work queues when the flag is on and refuses when off", () => {
  const statuses = Array.from({ length: 10 }, () => "active");
  const queued = admissionDecision({ cap: 10, statuses, flagOn: true });
  assert.equal(queued.action, "queue");
  assert.match(queued.reason ?? "", /Queued/);
  const refused = admissionDecision({ cap: 10, statuses, flagOn: false });
  assert.equal(refused.action, "refuse");
  assert.match(refused.reason ?? "", /firstmate_queue/);
});

test("unknown statuses do not fill the cap", () => {
  const decision = admissionDecision({
    cap: 10,
    statuses: [...Array.from({ length: 9 }, () => "active"), "unknown"],
    flagOn: true,
  });
  assert.equal(decision.action, "admit");
  assert.equal(decision.activeCount, 9);
});

test("quota backoff waits for reset or exponential delay", () => {
  assert.equal(spawnBackoffMs({ rateLimited: false, resetsAt: null, now: 0 }), 0);
  assert.equal(spawnBackoffMs({ rateLimited: true, resetsAt: 8_000, now: 1_000 }), 7_000);
  assert.equal(spawnBackoffMs({ rateLimited: true, resetsAt: null, now: 0, attempt: 0 }), 30_000);
  assert.equal(spawnBackoffMs({ rateLimited: true, resetsAt: null, now: 0, attempt: 2 }), 120_000);
});
