import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createOwnerAsks } from "./owner-asks.ts";
import { createOwnerTasks } from "./owner-tasks.ts";
import { repairStatusQuestionCards, STATUS_RECORD_RESOLUTION } from "./repair-status-question-cards.ts";

const NOW = Date.UTC(2026, 9, 18, 18, 55, 54);

function db() {
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

function insertOpenQuestion(database: ReturnType<typeof db>, id: string, text: string, task?: string) {
  const asks = createOwnerAsks(database);
  database.prepare("INSERT INTO owner_ask VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run(
    id, "thr_cap", "question", text, "[]", null, null, 0, "open", null, NOW, null,
  );
  if (task) database.prepare("INSERT INTO owner_ask_route VALUES (?,?,?,?)").run(id, "Cyndra", task, null);
  return asks.get(id)!;
}

test("repair cancels an open question with no options and copies its text onto the task", () => {
  const database = db();
  const tasks = createOwnerTasks(database);
  const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Cyndra UI workbench", sourceRefs: ["tg:1:1"], at: NOW });
  insertOpenQuestion(database, "ai2k81a", `${task.title}: waiting for owner answers to N4-N7`, task.id);
  const asks = createOwnerAsks(database);
  asks.create({
    id: "akeep", captain: "thr_cap", kind: "question", text: "Ship it?",
    options: [{ label: "Yes", value: "yes" }], createdAt: NOW, task: task.id,
  });
  asks.create({ id: "ablock", captain: "thr_cap", kind: "blocker", text: "Need the Stripe key.", options: [], createdAt: NOW });
  const repaired = repairStatusQuestionCards(database, NOW + 1);
  assert.deepEqual(repaired, [{ id: "ai2k81a", captain: "thr_cap", task: task.id, cancelled: true, noted: true }]);
  assert.equal(asks.get("ai2k81a")?.state, "cancelled");
  assert.equal(asks.get("ai2k81a")?.resolution, STATUS_RECORD_RESOLUTION);
  assert.equal(tasks.get(task.id)?.state, "needs_you");
  assert.equal(tasks.get(task.id)?.outcome, `${task.title}: waiting for owner answers to N4-N7`);
  assert.equal(asks.get("akeep")?.state, "open");
  assert.equal(asks.get("ablock")?.state, "open");
  assert.deepEqual(repairStatusQuestionCards(database, NOW + 2), []);
});

test("repair cancels a status question with no task and leaves a missing task's card cancelled", () => {
  const database = db();
  insertOpenQuestion(database, "adixf64", "Areliaa convex cost: paused on owner");
  insertOpenQuestion(database, "alhm4pu", "woo-app: blocked on owner", "T999");
  const repaired = repairStatusQuestionCards(database, NOW);
  assert.equal(repaired.length, 2);
  assert.equal(repaired.find((row) => row.id === "adixf64")?.noted, false);
  assert.equal(repaired.find((row) => row.id === "alhm4pu")?.noted, false);
  const asks = createOwnerAsks(database);
  assert.equal(asks.get("adixf64")?.state, "cancelled");
  assert.equal(asks.get("alhm4pu")?.state, "cancelled");
});
