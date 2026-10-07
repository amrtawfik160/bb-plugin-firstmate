import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { askIdFromSourceEventId, createOwnerAsks, formatAskCard, newAskId } from "./owner-asks.ts";
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
    "❓ Question\n\nDark mode by default?\n\nRecommended: Yes\nIf no answer by 16:05 UTC, I'll go with Yes.",
  );
  assert.equal(formatAskCard({ kind: "blocker", text: "Need the Stripe key.", options: [], recommended: null, defaultAt: null }), "⛔ Blocker\n\nNeed the Stripe key.");
  assert.equal(
    formatAskCard({ kind: "approval", text: "Deploy?", options: [{ label: "Deploy", value: "d" }], recommended: 0, defaultAt: null }),
    "✅ Approval needed\n\nDeploy?\n\nRecommended: Deploy",
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
  assert.equal(asks.resolve("a2", "thr_cap", "answered", "again", NOW), undefined);
  assert.deepEqual(asks.listOpen("thr_cap").map((a) => a.id), ["a3"]);
});

test("automatic decisions reuse explicit asks, survive restart, and retain answered source identities", () => {
  const database = db();
  const asks = createOwnerAsks(database);
  asks.create({ id: "aexplicit", captain: "thr_cap", kind: "approval", text: "Publish Safi #491?", options: [{ label: "Publish", value: "publish" }, { label: "Wait", value: "wait" }], createdAt: NOW });
  const input = { captain: "thr_cap", kind: "question" as const, text: "**Publish Safi #491?**", options: [{ label: "A. Publish (Recommended)", value: "A" }, { label: "B. Wait", value: "B" }], sourceRef: "tg:200:3001:decision:0", createdAt: NOW };
  const first = asks.ensure(input);
  assert.deepEqual({ id: first.ask.id, created: first.created, state: first.ask.state }, { id: "aexplicit", created: false, state: "open" });
  assert.equal(asks.link("aexplicit", "thr_other", "https://t.me/c/200/3001"), false);
  assert.equal(asks.link("aexplicit", "thr_cap", "https://t.me/c/200/3001"), true);
  const restarted = createOwnerAsks(database);
  assert.equal(restarted.get("aexplicit")?.messageUrl, "https://t.me/c/200/3001");
  assert.equal(restarted.ensure({ ...input, sourceRef: "tg:200:3002:decision:0" }).ask.id, "aexplicit");
  assert.equal(restarted.resolve("aexplicit", "thr_cap", "answered", "Publish", NOW)?.resolution, "Publish");
  const replay = restarted.ensure(input);
  assert.deepEqual({ id: replay.ask.id, created: replay.created, state: replay.ask.state }, { id: "aexplicit", created: false, state: "answered" });
  assert.equal(restarted.listOpen("thr_cap").length, 0);
  assert.equal(restarted.ensure({ ...input, sourceRef: "tg:200:3003:decision:0" }).created, true);
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
  const result = asks.ensure({ id: "anew", captain: "thr_cap", kind: "question", text: "Approve cleanup?", options: [], sourceRef: "tg:200:3004:decision:0", messageUrl: "https://t.me/c/200/3004", createdAt: NOW });
  assert.deepEqual({ id: result.ask.id, created: result.created }, { id: "anew", created: true });
  assert.equal(formatBoard({ asks: [result.ask], calls: [], tasks: [], records: [], since: 0, now: NOW }), [
    "📌 Needs you (1)",
    "1. ❓ Approve cleanup? (0 min, ask anew) https://t.me/c/200/3004",
    "Tap a question's button or reply to it to answer.",
    "",
    "✅ Done since you last looked: nothing new.",
    "",
    "🔧 In progress: nothing open.",
  ].join("\n"));
});
