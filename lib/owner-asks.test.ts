import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { askLetterAnswer, askIdFromSourceEventId, createOwnerAsks, formatAskCard, newAskId } from "./owner-asks.ts";
import { formatBoard } from "./owner-board.ts";

const NOW = Date.UTC(2026, 9, 7, 12, 0);

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

test("formatAskCard titles the card by kind and states the recommendation and deadline", () => {
  assert.equal(
    formatAskCard({ kind: "question", text: "Dark mode by default?", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], recommended: 0, defaultAt: Date.UTC(2026, 9, 7, 16, 5) }),
    "❓ Question\n\nDark mode by default?\nA. Yes\nB. No\n\nRecommended: Yes\nIf no answer by 16:05 UTC, I'll go with Yes.",
  );
  assert.equal(formatAskCard({ kind: "blocker", text: "Need the Stripe key.", options: [], recommended: null, defaultAt: null }), "⛔ Blocker\n\nNeed the Stripe key.");
  assert.equal(
    formatAskCard({ kind: "approval", text: "Deploy?", options: [{ label: "Deploy", value: "d" }], recommended: 0, defaultAt: null }),
    "✅ Approval needed\n\nDeploy?\nA. Deploy\n\nRecommended: Deploy",
  );
});

test("ask ids are short and readable, and only ask:<id> source ids name an ask", () => {
  assert.match(newAskId(), /^a[0-9a-z]{6}$/);
  assert.equal(askIdFromSourceEventId("ask:a1b2c3d"), "a1b2c3d");
  assert.equal(askIdFromSourceEventId("evt_1"), null);
  assert.equal(askIdFromSourceEventId(undefined), null);
});

test("the store resolves only the owner's open asks and defaults only reversible overdue ones once", () => {
  const asks = createOwnerAsks(db());
  const opts = [{ label: "Yes", value: "yes" }];
  asks.create({ id: "a1", captain: "thr_cap", kind: "question", text: "q", options: opts, recommended: 0, defaultAt: NOW - 1, createdAt: NOW - 10 });
  asks.create({ id: "a2", captain: "thr_cap", kind: "question", text: "q", options: opts, recommended: 0, defaultAt: NOW - 1, irreversible: true, createdAt: NOW - 9 });
  asks.create({ id: "a3", captain: "thr_cap", kind: "approval", text: "q", options: opts, recommended: 0, defaultAt: NOW - 1, createdAt: NOW - 8 });
  asks.create({ id: "a4", captain: "thr_other", kind: "question", text: "q", options: opts, recommended: 0, defaultAt: NOW - 1, createdAt: NOW - 7 });
  assert.deepEqual(asks.takeDue("thr_cap", NOW).map((a) => [a.id, a.state, a.resolution]), [["a1", "defaulted", "Yes"]]);
  assert.deepEqual(asks.takeDue("thr_cap", NOW), []);
  assert.equal(asks.resolve("a4", "thr_cap", "answered", "x", NOW), undefined);
  assert.equal(asks.get("a4")?.state, "open");
  assert.equal(asks.resolve("a2", "thr_cap", "cancelled", "not needed", NOW)?.state, "cancelled");
  assert.equal(asks.resolve("a2", "thr_cap", "answered", "Corrected answer", NOW)?.resolution, "Corrected answer");
  assert.equal(asks.resolve("a2", "thr_cap", "open", "Reopen", NOW)?.state, "open");
  assert.deepEqual(asks.listOpen("thr_cap").map((a) => a.id), ["a2", "a3"]);
});

test("old ask databases migrate without losing open asks and unparsed decisions link from the board", () => {
  const database = db();
  database.exec(`CREATE TABLE owner_ask (id TEXT PRIMARY KEY, captain TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, options TEXT NOT NULL, recommended INTEGER, default_at INTEGER, irreversible INTEGER NOT NULL, state TEXT NOT NULL, resolution TEXT, created_at INTEGER NOT NULL, resolved_at INTEGER);
    INSERT INTO owner_ask VALUES ('aold','thr_cap','question','Sign in to RunAnts?','[]',NULL,NULL,0,'open',NULL,0,NULL);`);
  const asks = createOwnerAsks(database);
  assert.equal(asks.get("aold")?.text, "Sign in to RunAnts?");
  database.prepare("INSERT INTO owner_ask VALUES (?,?,?,?,?,?,?,?,?,?,?,?)").run("arollback", "thr_other", "question", "Old plugin still asks?", "[]", null, null, 0, "open", null, NOW, null);
  assert.equal(asks.get("arollback")?.text, "Old plugin still asks?");
  assert.equal(database.prepare("PRAGMA table_info(owner_ask)").all().length, 12);
  const result = asks.create({ id: "anew", captain: "thr_cap", kind: "question", text: "Approve cleanup?", options: [], sourceRef: "tg:200:3004:decision:0", messageUrl: "https://t.me/c/200/3004", createdAt: NOW });
  assert.equal(result.id, "anew");
  assert.equal(formatBoard({ asks: [result], calls: [], tasks: [], records: [], since: 0, now: NOW }), [
    "📌 Needs you (1)",
    "1. ❓ Approve cleanup? (0 min, ask anew) https://t.me/c/200/3004",
    "Tap a question's button or reply with just its letter.",
    "",
    "✅ Done since you last looked: nothing new.",
    "",
    "🔧 In progress: nothing open.",
  ].join("\n"));
});

test("impact survives restart while old 12-column writers still work", () => {
  const database = db();
  const asks = createOwnerAsks(database);
  const ask = asks.create({ id: "aimpact", captain: "thr_cap", kind: "question", impact: "New customers can start their agents again.", text: "Find the addresses?", options: [{ label: "Find and verify the full address list before changing production.", value: "find" }], createdAt: NOW });
  assert.equal(createOwnerAsks(database).get("aimpact")?.impact, "New customers can start their agents again.");
  assert.equal(formatAskCard(ask), "New customers can start their agents again.\n\n❓ Question\n\nFind the addresses?\nA. Find and verify the full address list before changing production.");
  assert.equal(database.prepare("PRAGMA table_info(owner_ask)").all().length, 12);
});


test("card answers accept only a valid letter, optionally followed by a period", () => {
  const ask = { options: [{ label: "Send the list", value: "send" }, { label: "Find the list", value: "find" }] };
  for (const text of ["B", "b", "B.", " b. "]) assert.equal(askLetterAnswer(ask, text), "Find the list");
  for (const text of ["What?", "B. send me a link", "1 B", "7B", "C", "Find the list", "B!", "B\nA"]) assert.equal(askLetterAnswer(ask, text), null);
});
