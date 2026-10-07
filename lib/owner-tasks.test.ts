import assert from "node:assert/strict";
import test from "node:test";
import { moveTask, stateFromPrs, TASK_TRANSITIONS, type OwnerTask, type TaskState } from "./owner-tasks.ts";
import type { DeliveryRecord } from "./pr-delivery.ts";

const task = (state: TaskState): OwnerTask => ({
  id: "T7", captain: "thr_cap", project: null, title: "Metricool fix", sourceRefs: ["tg:200:1"], state, prs: [], crewIds: [], backfilled: false, createdAt: 0, updatedAt: 0,
});

test("every allowed move succeeds and every other move is refused", () => {
  const states = Object.keys(TASK_TRANSITIONS) as TaskState[];
  const allowed: string[] = [];
  for (const from of states) {
    for (const to of states) {
      if (from === to) continue;
      try {
        moveTask(task(from), to === "dropped" ? { to, reason: "owner said stop" } : { to }, 1);
        allowed.push(`${from}->${to}`);
      } catch { /* refused */ }
    }
  }
  assert.deepEqual(allowed, [
    "working->needs_you", "working->ready", "working->merged", "working->live", "working->done", "working->dropped",
    "needs_you->working", "needs_you->ready", "needs_you->merged", "needs_you->live", "needs_you->done", "needs_you->dropped",
    "ready->working", "ready->needs_you", "ready->merged", "ready->live", "ready->done", "ready->dropped",
    "merged->live", "merged->done",
  ]);
});

test("dropping needs a reason", () => {
  assert.throws(() => moveTask(task("working"), { to: "dropped", reason: "  " }, 1), /Dropping task T7 needs a reason\./);
  assert.equal(moveTask(task("working"), { to: "dropped", reason: "duplicate of T3" }, 1).dropReason, "duplicate of T3");
});

const pr = (over: Partial<DeliveryRecord>) => ({ id: "a/b#1", status: "waiting-checks", forgeState: "open", mergeCommitSha: null, requirement: "merged", verifiedCommitSha: null, ...over }) as DeliveryRecord;

test("pull requests prove working, ready, merged, or live", () => {
  assert.equal(stateFromPrs([]), null);
  assert.equal(stateFromPrs([pr({ status: "ready-to-merge" }), pr({ status: "failing-checks" })]), "working");
  assert.equal(stateFromPrs([pr({ status: "pr-delivered", requirement: "pr" })]), "working", "a PR the board shows as waiting for review is not ready");
  assert.equal(stateFromPrs([pr({ status: "ready-to-merge" }), pr({ status: "complete", forgeState: "merged", mergeCommitSha: "m" })]), "ready");
  assert.equal(stateFromPrs([pr({ status: "complete", forgeState: "merged", mergeCommitSha: "m" }), pr({ status: "explicitly-abandoned" })]), "merged");
  assert.equal(stateFromPrs([pr({ status: "complete", forgeState: "merged", mergeCommitSha: "m", requirement: "merged-and-verified", verifiedCommitSha: "m" })]), "live");
  assert.equal(stateFromPrs([pr({ status: "explicitly-abandoned", forgeState: "closed" })]), null);
});
