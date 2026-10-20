import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createOwnerTasks, finishedState, isFinishedTask, isOpenTask, moveTask, reportedDoneState, stateFromPrs, TASK_TRANSITIONS, type OwnerTask, type TaskMove, type TaskState } from "./owner-tasks.ts";
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
        const move: TaskMove = to === "dropped" ? { to, reason: "owner said stop", ref: "tg:200:9" } : to === "live" ? { to, reason: "production OTA a7021b2c holds it" } : { to };
        moveTask(task(from), move, 1);
        allowed.push(`${from}->${to}`);
      } catch { /* refused */ }
    }
  }
  // Owner decision Q1 (18 Oct): only live or dropped finishes a task; nothing enters done any more,
  // merged stays open, and a finished task reopens only to working (new work on it).
  assert.deepEqual(allowed, [
    "working->needs_you", "working->ready", "working->check", "working->merged", "working->live", "working->dropped",
    "needs_you->working", "needs_you->ready", "needs_you->check", "needs_you->merged", "needs_you->live", "needs_you->dropped",
    "ready->working", "ready->needs_you", "ready->check", "ready->merged", "ready->live", "ready->dropped",
    "check->working", "check->needs_you", "check->ready", "check->merged", "check->live", "check->dropped",
    "merged->working", "merged->needs_you", "merged->ready", "merged->check", "merged->live", "merged->dropped",
    "live->working",
    "done->working", "done->merged", "done->live", "done->dropped",
    "dropped->working",
  ]);
});

test("merged is open, not finished; only live, dropped and the old done are finished", () => {
  assert.equal(isOpenTask(task("merged")), true);
  assert.equal(isFinishedTask(task("merged")), false);
  for (const state of ["live", "dropped", "done"] as const) assert.equal(isFinishedTask(task(state)), true, state);
  assert.throws(() => moveTask(task("working"), { to: "done", reason: "crew said DONE" }, 1), /cannot become done: only live or dropped finishes a task/);
});

test("dropping needs the owner's words and his message ref", () => {
  assert.throws(() => moveTask(task("working"), { to: "dropped", reason: "  ", ref: "tg:200:9" }, 1), /Dropping task T7 needs a reason\./);
  assert.throws(() => moveTask(task("working"), { to: "dropped", reason: "stop it", ref: " " }, 1), /needs the owner's message ref/);
  const dropped = moveTask(task("working"), { to: "dropped", reason: "duplicate of T3", ref: "tg:200:9" }, 1);
  assert.equal(dropped.dropReason, "duplicate of T3");
  assert.equal(dropped.dropRef, "tg:200:9");
});

test("live needs evidence of what production runs", () => {
  assert.throws(() => moveTask(task("merged"), { to: "live", reason: " " }, 1), /becomes live only with evidence/);
  assert.equal(moveTask(task("merged"), { to: "live", reason: "production OTA a7021b2c holds aa40ebbe" }, 1).evidence, "production OTA a7021b2c holds aa40ebbe");
});

// FORGOTTEN-WORK R2: T238 closed as done on a crew's DONE line while its 34 commits were never pushed.
test("a crew's done with no PR asks the captain to check; it never closes the task", () => {
  assert.deepEqual(finishedState(task("working"), [], { delivered: true, outcome: "PR1 committed on fm/2803e0af" })?.to, "check");
  assert.match((reportedDoneState(task("working"), [], "PR1 committed") as { reason: string }).reason, /make it live with evidence or drop it/);
  assert.equal(reportedDoneState(task("working"), [], "PR1 committed")?.to, "check");
});

const pr = (over: Partial<DeliveryRecord>) => ({ id: "a/b#1", status: "waiting-checks", forgeState: "open", mergeCommitSha: null, requirement: "merged", verifiedCommitSha: null, ...over }) as DeliveryRecord;

test("pull requests prove working, ready or merged, never live", () => {
  assert.equal(stateFromPrs([]), null);
  assert.equal(stateFromPrs([pr({ status: "ready-to-merge" }), pr({ status: "failing-checks" })]), "working");
  assert.equal(stateFromPrs([pr({ status: "pr-delivered", requirement: "pr" })]), "working", "a delivered PR the captain has not merged is not ready for the owner");
  assert.equal(stateFromPrs([pr({ status: "ready-to-merge" }), pr({ status: "complete", forgeState: "merged", mergeCommitSha: "m" })]), "ready");
  assert.equal(stateFromPrs([pr({ status: "complete", forgeState: "merged", mergeCommitSha: "m" }), pr({ status: "explicitly-abandoned" })]), "merged");
  assert.equal(stateFromPrs([pr({ status: "complete", forgeState: "merged", mergeCommitSha: "m", requirement: "merged-and-verified", verifiedCommitSha: "m" })]), "merged", "a verified merge is not production: only the live check proves live");
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

test("moving a task to the state it already has still writes a new outcome", () => {
  const tasks = createOwnerTasks(memoryDb());
  const task = tasks.open({ captain: "c", project: "Cyndra", title: "Wait", sourceRefs: ["tg:1:1"], at: 0 });
  assert.equal(tasks.move(task.id, "c", { to: "needs_you", reason: "first wait" }, 1).outcome, "first wait");
  const again = tasks.move(task.id, "c", { to: "needs_you", reason: "waiting for owner answers to N4-N7" }, 2);
  assert.equal(again.state, "needs_you");
  assert.equal(again.outcome, "waiting for owner answers to N4-N7");
  assert.equal(again.updatedAt, 2);
});

test("a task an open program holds cannot be closed or marked merged by hand, by its PRs, or by a finished crew", () => {
  let holding = true;
  const tasks = createOwnerTasks(memoryDb(), (t) => holding && t.id === "T1" ? "Task T1 holds program P1 (DM Pro epic): 19 tickets are open." : null);
  tasks.open({ captain: "c", project: "Cyndra", title: "DM Pro epic", sourceRefs: ["tg:1:4404"], crewId: "crew1", at: 0 });
  assert.throws(() => tasks.move("T1", "c", { to: "live", reason: "deployed" }, 1), /Task T1 holds program P1 \(DM Pro epic\): 19 tickets are open\./);
  assert.throws(() => tasks.move("T1", "c", { to: "dropped", reason: "owner stop", ref: "tg:1:4405" }, 1), /holds program P1/);
  assert.equal(tasks.move("T1", "c", { to: "needs_you" }, 1).state, "needs_you", "open states still move");
  const mergedPr = pr({ id: "cyndra-ai/cyndra-saas#2443", taskId: "crew1", status: "complete", forgeState: "merged", mergeCommitSha: "m" });
  tasks.reconcile("c", () => [mergedPr], 2);
  assert.equal(tasks.get("T1")!.state, "needs_you", "a merged PR does not close it");
  assert.equal(tasks.finishCrew("c", "crew1", { delivered: true, outcome: "DONE" }, () => false, () => [mergedPr], 3)!.state, "needs_you");
  holding = false;
  assert.equal(tasks.move("T1", "c", { to: "live", reason: "production runs m" }, 4).state, "live");
});

const merged = (id: string, taskId: string) => pr({ id, taskId, status: "complete", forgeState: "merged", mergeCommitSha: `m-${id}` });
const openPr = (id: string, taskId: string) => pr({ id, taskId, status: "waiting-checks", forgeState: "open" });

// FORGOTTEN-WORK R3: T74 was merged while PRs 2547 and 2534 were open; T239 was done while safi#576 was open.
test("a finished or merged task with a new PR, or an open PR, reopens; a dropped one only for a new PR", () => {
  const db = memoryDb();
  const tasks = createOwnerTasks(db);
  const records = new Map<string, DeliveryRecord[]>();
  for (const [n, crew] of [[1, "c74"], [2, "c239"], [3, "c204"], [4, "clive"]] as const) {
    tasks.open({ captain: "c", project: "Cyndra", title: `task ${n}`, sourceRefs: [`tg:1:${n}`], crewId: crew, at: 0 });
  }
  records.set("c74", [merged("cyndra-ai/cyndra-saas#2400", "c74")]);
  records.set("c239", [merged("amrtawfik160/safi#574", "c239")]);
  records.set("c204", [openPr("cyndra-ai/cyndra-saas#2487", "c204")]);
  records.set("clive", [merged("cyndra-ai/cyndra-saas#2401", "clive")]);
  const recordsFor = (t: OwnerTask) => records.get(t.crewIds[0]!) ?? [];
  tasks.reconcile("c", recordsFor, 1);
  assert.equal(tasks.get("T1")!.state, "merged");
  tasks.move("T3", "c", { to: "dropped", reason: "owner: stop the provisioner", ref: "tg:1:99" }, 2);
  tasks.move("T4", "c", { to: "live", reason: "production runs m-2401" }, 2);
  // The old done state, written before the live rule, with its PR still open on GitHub.
  db.prepare("UPDATE owner_task SET state='done', record=? WHERE id='T2'").run(JSON.stringify({ ...tasks.get("T2")!, state: "done", outcome: "Merged PR #574 and published OTA" }));
  records.set("c239", [merged("amrtawfik160/safi#574", "c239"), openPr("amrtawfik160/safi#576", "c239")]);
  records.set("c74", [merged("cyndra-ai/cyndra-saas#2400", "c74"), openPr("cyndra-ai/cyndra-saas#2547", "c74")]);
  tasks.reconcile("c", recordsFor, 3);
  assert.equal(tasks.get("T1")!.state, "working", "a merged task with a new open PR is working again");
  assert.deepEqual(tasks.get("T1")!.prs, ["cyndra-ai/cyndra-saas#2400", "cyndra-ai/cyndra-saas#2547"]);
  assert.equal(tasks.get("T2")!.state, "working");
  assert.equal(tasks.get("T3")!.state, "dropped", "an open PR the owner dropped stays dropped");
  assert.equal(tasks.get("T4")!.state, "live");
  // A merged PR opened before the task went live only joins its record (the replay found 3 such live tasks).
  records.set("clive", [merged("cyndra-ai/cyndra-saas#2401", "clive"), { ...merged("cyndra-ai/cyndra-saas#2399", "clive"), openedAt: 1 }]);
  assert.deepEqual(tasks.reconcile("c", recordsFor, 3.5).map((t) => `${t.id}:${t.state}:${t.updatedAt}`), ["T4:live:2"]);
  // T81 in the replay: a later PR of its crew that was closed without a merge is no new work.
  records.set("clive", [...records.get("clive")!, pr({ id: "cyndra-ai/cyndra-saas#2398", taskId: "clive", status: "explicitly-abandoned", forgeState: "closed", openedAt: 3 })]);
  assert.deepEqual(tasks.reconcile("c", recordsFor, 3.6).map((t) => `${t.id}:${t.state}`), ["T4:live"]);
  records.set("clive", [...records.get("clive")!, { ...merged("cyndra-ai/cyndra-saas#2410", "clive"), openedAt: 3 }]);
  records.set("c204", [openPr("cyndra-ai/cyndra-saas#2487", "c204"), openPr("cyndra-ai/cyndra-saas#2490", "c204")]);
  const changed = tasks.reconcile("c", recordsFor, 4).map((t) => `${t.id}:${t.state}`);
  assert.deepEqual(changed, ["T3:working", "T4:merged"], "a new merged PR takes a live task back to merged, not live");
  assert.deepEqual(tasks.reconcile("c", recordsFor, 5), [], "a second pass changes nothing");
});

test("a new crew on a finished task reopens it; the same crew again changes nothing", () => {
  const tasks = createOwnerTasks(memoryDb());
  tasks.open({ captain: "c", project: "Safi", title: "Publish OTA", sourceRefs: ["tg:1:1"], crewId: "a", at: 0 });
  assert.equal(tasks.get("T1")!.generation, 1);
  tasks.move("T1", "c", { to: "live", reason: "production OTA holds it" }, 1);
  assert.equal(tasks.attach("T1", "c", { crewId: "a", sourceRefs: [], at: 2 }).state, "live");
  assert.equal(tasks.get("T1")!.generation, 1);
  const reopened = tasks.attach("T1", "c", { crewId: "b", sourceRefs: ["tg:1:2"], at: 3 });
  assert.equal(reopened.state, "working");
  assert.equal(reopened.generation, 2);
});

// Repair thread, 18 Oct: T203 listed a read-only scout as a crew; T204's drop reason named a PR that now belongs to T247.
test("the captain removes a crew from a task and amends a drop reason; each change is kept in an append-only history", () => {
  const tasks = createOwnerTasks(memoryDb());
  tasks.open({ captain: "c", project: "Cyndra", title: "Humza bugs", sourceRefs: ["tg:1:1"], crewId: "0bd8dda8", at: 0 });
  tasks.attach("T1", "c", { crewId: "406628f1", sourceRefs: [], at: 1 });
  assert.throws(() => tasks.removeCrew("T1", "c", { crewId: "406628f1", reason: " ", actor: "thr_cap" }, 2), /needs a reason/);
  assert.throws(() => tasks.removeCrew("T1", "c", { crewId: "nope", reason: "x", actor: "thr_cap" }, 2), /Task T1 has no crew nope/);
  const fixed = tasks.removeCrew("T1", "c", { crewId: "406628f1", reason: "read-only scout, not a crew of this task", actor: "thr_cap" }, 2);
  assert.deepEqual(fixed.crewIds, ["0bd8dda8"]);
  assert.equal(fixed.state, "working", "a correction moves no state");
  assert.deepEqual(fixed.history, [{ at: 2, actor: "thr_cap", action: "remove-crew", before: "406628f1", after: null, reason: "read-only scout, not a crew of this task" }]);

  tasks.open({ captain: "c", project: "Cyndra", title: "Provisioner", sourceRefs: ["tg:1:2"], at: 0 });
  assert.throws(() => tasks.amendDropReason("T2", "c", { text: "x", reason: "y", actor: "thr_cap" }, 3), /Task T2 is working; only a dropped task has a drop reason/);
  tasks.move("T2", "c", { to: "dropped", reason: "Owner: stop; PR 2487 is not needed", ref: "tg:1:9" }, 3);
  assert.throws(() => tasks.amendDropReason("T2", "c", { text: "Owner: stop", reason: "", actor: "thr_cap" }, 4), /needs a reason/);
  const amended = tasks.amendDropReason("T2", "c", { text: "Owner: stop the provisioner", reason: "PR 2487 now belongs to T247", actor: "thr_cap" }, 4);
  assert.equal(amended.dropReason, "Owner: stop the provisioner");
  assert.equal(amended.dropRef, "tg:1:9", "the owner's message ref stays");
  assert.equal(amended.state, "dropped");
  assert.equal(amended.updatedAt, 3, "a correction does not make the task new on the board");
  const again = tasks.amendDropReason("T2", "c", { text: "Owner: stop the provisioner work", reason: "clearer words", actor: "thr_cap" }, 5);
  assert.deepEqual(again.history!.map((h) => [h.action, h.before, h.after]), [
    ["amend-drop-reason", "Owner: stop; PR 2487 is not needed", "Owner: stop the provisioner"],
    ["amend-drop-reason", "Owner: stop the provisioner", "Owner: stop the provisioner work"],
  ], "history only grows");
});

// Checker 162-verdict-1 fix 3: linkPr put the PR on the record before reconcile, so new work never reopened the task.
test("a PR the captain links to a finished task reopens it on the next reconcile; the finish time survives later edits", () => {
  const tasks = createOwnerTasks(memoryDb());
  const prRecord = (id: string, over: Partial<DeliveryRecord>) => pr({ id, taskId: "none", ...over });
  tasks.open({ captain: "c", project: "Safi", title: "dropped one", sourceRefs: ["tg:1:1"], at: 0 });
  tasks.move("T1", "c", { to: "dropped", reason: "stop this", ref: "tg:1:2" }, 10);
  tasks.linkPr("T1", "c", "amrtawfik160/safi#2", 200);
  assert.equal(tasks.get("T1")!.finishedAt, 10, "linking does not move the finish time");
  tasks.reconcile("c", () => [prRecord("amrtawfik160/safi#2", { status: "waiting-checks", forgeState: "open", openedAt: 100 })], 201);
  assert.equal(tasks.get("T1")!.state, "working");
  tasks.open({ captain: "c", project: "Safi", title: "live one", sourceRefs: ["tg:1:3"], at: 0 });
  tasks.move("T2", "c", { to: "live", reason: "old production evidence" }, 10);
  tasks.linkPr("T2", "c", "amrtawfik160/safi#3", 200);
  tasks.reconcile("c", (t) => t.id === "T2" ? [prRecord("amrtawfik160/safi#3", { status: "complete", forgeState: "merged", mergeCommitSha: "new", openedAt: 100 })] : [], 201);
  assert.equal(tasks.get("T2")!.state, "merged", "a newer merged PR takes a live task back to Not live yet");
  // A PR from before the finish, linked by hand later, is still new work when the captain links it after the finish.
  tasks.open({ captain: "c", project: "Safi", title: "old pr", sourceRefs: ["tg:1:4"], at: 0 });
  tasks.move("T3", "c", { to: "dropped", reason: "stop", ref: "tg:1:5" }, 50);
  tasks.linkPr("T3", "c", "amrtawfik160/safi#4", 60);
  tasks.reconcile("c", (t) => t.id === "T3" ? [prRecord("amrtawfik160/safi#4", { status: "waiting-checks", forgeState: "open", openedAt: 5 })] : [], 61);
  assert.equal(tasks.get("T3")!.state, "working", "the captain linked it after the drop: that is new work");
});

test("unsaved-work cleanup records kept: unsaved work on the task without moving it", () => {
  const tasks = createOwnerTasks(memoryDb());
  tasks.open({ captain: "c", project: "Cyndra", title: "Banner", sourceRefs: ["tg:1:1"], crewId: "c1", at: 0 });
  tasks.move("T1", "c", { to: "live", reason: "production OTA holds it" }, 10);
  const kept = tasks.keepWorktree("T1", "c", "kept: unsaved work");
  assert.equal(kept.state, "live");
  assert.equal(kept.worktreeKept, "kept: unsaved work");
  assert.equal(kept.updatedAt, 10);
  assert.equal(kept.finishedAt, 10);
  assert.equal(tasks.keepWorktree("T1", "c", "kept: unsaved work").updatedAt, 10);
});

test("the kept-worktree note clears once the worktree is removed", () => {
  const tasks = createOwnerTasks(memoryDb());
  tasks.open({ captain: "c", project: "Cyndra", title: "Banner", sourceRefs: ["tg:1:1"], crewId: "c1", at: 0 });
  tasks.move("T1", "c", { to: "dropped", reason: "owner said stop", ref: "tg:1:2" }, 10);
  tasks.keepWorktree("T1", "c", "kept: unsaved work");
  const cleared = tasks.keepWorktree("T1", "c", null);
  assert.equal(cleared.worktreeKept, undefined);
  assert.equal(tasks.get("T1")!.worktreeKept, undefined);
  assert.equal(cleared.state, "dropped");
});
