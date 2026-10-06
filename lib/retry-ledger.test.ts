import assert from "node:assert/strict";
import test from "node:test";
import Database from "better-sqlite3";
import { createRetryLedger } from "./retry-ledger.ts";

const ledger = () => createRetryLedger(new Database(":memory:"));
const failure = (reason: string, now: number) =>
  ({ kind: "launch-reconcile" as const, subject: "k1", owner: "thr_cap", label: "Launch 4b4adda5", reason, now });

test("a repeated failure logs once, backs off, and escalates to needs-captain at the bound", () => {
  const retries = ledger();
  const seen: Array<[number, boolean, boolean, string, number]> = [];
  let now = 1_000_000;
  for (let i = 0; i < 8; i++) {
    assert.equal(retries.isDue("launch-reconcile", "k1", now), true);
    const out = retries.fail(failure(`still uncertain after ${i} reads`, now));
    seen.push([out.item.attempts, out.logged, out.escalated, out.item.phase, out.item.nextAt - now]);
    now = out.item.nextAt;
  }
  assert.deepEqual(seen, [
    [1, true, false, "retrying", 60_000],
    [2, false, false, "retrying", 120_000],
    [3, false, false, "retrying", 240_000],
    [4, false, false, "retrying", 480_000],
    [5, false, false, "retrying", 960_000],
    [6, false, false, "retrying", 1_800_000],
    [7, false, false, "retrying", 1_800_000],
    [8, true, true, "needs-captain", 1_800_000],
  ]);
  assert.equal(retries.isDue("launch-reconcile", "k1", now + 10 * 3_600_000), false);
  assert.deepEqual(retries.needsCaptain("thr_cap").map((i) => [i.label, i.attempts]), [["Launch 4b4adda5", 8]]);
  assert.deepEqual(retries.needsCaptain("thr_other"), []);
});

test("a new failure reason is logged again without resetting the attempt count", () => {
  const retries = ledger();
  retries.fail(failure("worktree has uncommitted changes", 0));
  const changed = retries.fail(failure("Environment unavailable", 60_000));
  assert.deepEqual([changed.logged, changed.item.attempts, changed.item.reason], [true, 2, "Environment unavailable"]);
});

test("clearing an item returns its history and makes the next failure start over", () => {
  const retries = ledger();
  retries.fail(failure("uncertain", 0));
  retries.fail(failure("uncertain", 60_000));
  assert.equal(retries.clear("launch-reconcile", "k1")?.attempts, 2);
  assert.equal(retries.clear("launch-reconcile", "k1"), undefined);
  assert.equal(retries.fail(failure("uncertain", 500_000)).item.attempts, 1);
});

test("the needs-captain notice is claimed once", () => {
  const retries = ledger();
  for (let i = 0; i < 8; i++) retries.fail(failure("uncertain", i));
  assert.equal(retries.claimNotice("launch-reconcile", "k1"), true);
  assert.equal(retries.claimNotice("launch-reconcile", "k1"), false);
});
