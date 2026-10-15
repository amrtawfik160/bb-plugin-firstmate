import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createOwnerTasks, moveTask, stateFromPrs, TASK_TRANSITIONS, type OwnerTask, type TaskState } from "./owner-tasks.ts";
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
    "working->needs_you", "working->ready", "working->check", "working->merged", "working->live", "working->done", "working->dropped",
    "needs_you->working", "needs_you->ready", "needs_you->check", "needs_you->merged", "needs_you->live", "needs_you->done", "needs_you->dropped",
    "ready->working", "ready->needs_you", "ready->check", "ready->merged", "ready->live", "ready->done", "ready->dropped",
    "check->working", "check->needs_you", "check->ready", "check->merged", "check->live", "check->done", "check->dropped",
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
  assert.equal(stateFromPrs([pr({ status: "pr-delivered", requirement: "pr" })]), "working", "a delivered PR the captain has not merged is not ready for the owner");
  assert.equal(stateFromPrs([pr({ status: "ready-to-merge" }), pr({ status: "complete", forgeState: "merged", mergeCommitSha: "m" })]), "ready");
  assert.equal(stateFromPrs([pr({ status: "complete", forgeState: "merged", mergeCommitSha: "m" }), pr({ status: "explicitly-abandoned" })]), "merged");
  assert.equal(stateFromPrs([pr({ status: "complete", forgeState: "merged", mergeCommitSha: "m", requirement: "merged-and-verified", verifiedCommitSha: "m" })]), "live");
  assert.equal(stateFromPrs([pr({ status: "explicitly-abandoned", forgeState: "closed" })]), null);
});

function memoryDb() {
  const raw = new DatabaseSync(":memory:");
  return Object.assign(raw, {
    transaction<T>(fn: () => T) {
      return () => {
        raw.exec("BEGIN");
        try { const out = fn(); raw.exec("COMMIT"); return out; } catch (error) { raw.exec("ROLLBACK"); throw error; }
      };
    },
  });
}

test("a task an open program holds cannot be closed or marked merged by hand, by its PRs, or by a finished crew", () => {
  let holding = true;
  const tasks = createOwnerTasks(memoryDb(), (t) => holding && t.id === "T1" ? "Task T1 holds program P1 (DM Pro epic): 19 tickets are open." : null);
  tasks.open({ captain: "c", project: "Cyndra", title: "DM Pro epic", sourceRefs: ["tg:1:4404"], crewId: "crew1", at: 0 });
  assert.throws(() => tasks.move("T1", "c", { to: "done" }, 1), /Task T1 holds program P1 \(DM Pro epic\): 19 tickets are open\./);
  assert.throws(() => tasks.move("T1", "c", { to: "dropped", reason: "owner stop" }, 1), /holds program P1/);
  assert.equal(tasks.move("T1", "c", { to: "needs_you" }, 1).state, "needs_you", "open states still move");
  const mergedPr = pr({ id: "cyndra-ai/cyndra-saas#2443", taskId: "crew1", status: "complete", forgeState: "merged", mergeCommitSha: "m" });
  tasks.reconcile("c", () => [mergedPr], 2);
  assert.equal(tasks.get("T1")!.state, "needs_you", "a merged PR does not close it");
  assert.equal(tasks.finishCrew("c", "crew1", { delivered: true, outcome: "DONE" }, () => false, () => [mergedPr], 3)!.state, "needs_you");
  holding = false;
  assert.equal(tasks.move("T1", "c", { to: "done" }, 4).state, "done");
});
