import assert from "node:assert/strict";
import test from "node:test";
import type { OwnerTask, TaskState } from "./owner-tasks.ts";
import { dueStalls, findStalls, nextStep, notLiveItems, notLiveLine, STALL_MS, stallAlerts, type LivePlan } from "./stalls.ts";

const H = 60 * 60_000;
const task = (id: string, state: TaskState, updatedAt: number, over: Partial<OwnerTask> = {}): OwnerTask => ({
  id, captain: "c", project: "Safi", title: `task ${id}`, sourceRefs: [], state, prs: [], crewIds: [], backfilled: false, createdAt: 0, updatedAt, ...over,
});
const safi: LivePlan = { next: "publish the OTA update to preview and production and deploy the backend", actor: "the captain", missing: null };
const cyndra: LivePlan = { next: "deploy to production in a release window and check it there", actor: "the captain", missing: "no record says which commit Cyndra production runs" };
const planFor = (t: OwnerTask) => t.project === "Safi" ? safi : t.project === "Cyndra" ? cyndra : undefined;

test("each open state names its next step and who takes it", () => {
  assert.deepEqual(nextStep(task("T1", "needs_you", 0), undefined, 0), { next: "answer the open question", who: "the owner" });
  assert.deepEqual(nextStep(task("T1", "merged", 0), safi, 0), { next: safi.next, who: "the captain" });
  assert.match(nextStep(task("T1", "merged", 0, { project: "Cyndra" }), cyndra, 0).next, /\(live check missing: no record says which commit Cyndra production runs\)/);
  assert.deepEqual(nextStep(task("T1", "working", 0), undefined, 2), { next: "wait for 2 crews", who: "the crew" });
});

test("a stall is an open task with no running crew and no step for more than 24 hours", () => {
  const now = 100 * H;
  const tasks = [
    task("T1", "merged", now - 25 * H),
    task("T2", "merged", now - 23 * H),
    task("T3", "working", now - 30 * H, { crewIds: ["run"] }),
    task("T4", "live", now - 90 * H),
    task("T5", "check", now - 26 * H),
  ];
  assert.deepEqual(findStalls(tasks, new Set(["run"]), planFor, now).map((s) => s.task.id), ["T1", "T5"]);
});

test("one alert per stall; again only after another 24 hours stalled; a task that moved is a new stall", () => {
  const now = 100 * H;
  const stalled = (updatedAt: number) => findStalls([task("T1", "merged", updatedAt)], new Set(), planFor, now + 0);
  let memory = {};
  const first = dueStalls(stalled(now - 25 * H), memory, now);
  assert.deepEqual(first.due.map((s) => s.task.id), ["T1"]);
  memory = first.memory;
  assert.deepEqual(dueStalls(stalled(now - 25 * H), memory, now + 1 * H).due, [], "no repeat within 24 hours");
  assert.deepEqual(dueStalls(stalled(now - 25 * H), memory, now + STALL_MS).due.map((s) => s.task.id), ["T1"], "still stalled 24 hours later: one repeat");
  assert.deepEqual(dueStalls(stalled(now - 26 * H), memory, now + 2 * H).due.map((s) => s.task.id), ["T1"], "it moved and stalled again: a new stall");
  assert.deepEqual(dueStalls([], memory, now + 3 * H).memory, {}, "a task no longer stalled leaves the memory");
});

test("alerts are grouped per project, name who must act, and cap their lines", () => {
  const now = 1000 * H;
  const tasks = [
    ...Array.from({ length: 17 }, (_, i) => task(`T${i + 1}`, "merged", now - (30 + i) * H, { project: "Cyndra" })),
    task("T50", "needs_you", now - 48 * H),
  ];
  const alerts = stallAlerts(findStalls(tasks, new Set(), planFor, now));
  assert.deepEqual(alerts.map((a) => a.project), ["Cyndra", "Safi"]);
  const [cy, sa] = alerts;
  assert.match(cy!.text, /^17 tasks have had no next step for more than 24 hours in Cyndra:/);
  assert.match(cy!.text, /- T17 task T17 \(merged, not live, no step for 46 h\): the captain must deploy to production/);
  assert.match(cy!.text, /…and 2 more on the board\.$/);
  assert.equal(cy!.ids.length, 17);
  assert.match(sa!.text, /T50 task T50 \(needs you, no step for 2 d\): the owner must answer the open question/);
});

test("not live yet lists merged tasks only, oldest first, with age, next step and who acts", () => {
  const now = 100 * H;
  const items = notLiveItems([task("T1", "merged", now - 2 * H), task("T2", "merged", now - 50 * H, { project: "Cyndra" }), task("T3", "working", 0), task("T4", "live", 0)], planFor, now);
  assert.deepEqual(items.map((i) => i.id), ["T2", "T1"]);
  assert.equal(items[0]!.missing, "no record says which commit Cyndra production runs");
  assert.equal(notLiveLine(items[1]!), "T1 Safi · task T1 · merged 2 h ago · next: publish the OTA update to preview and production and deploy the backend · the captain");
});
