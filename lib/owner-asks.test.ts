import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as ownerAsksModule from "./owner-asks.ts";
import { askLetterAnswer, askIdFromSourceEventId, createOwnerAsks, formatAskCard, newAskId, packAnswers } from "./owner-asks.ts";
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

// 14 Oct: each card repeated its options, "Recommended: ..." and "If no answer by ..., I'll go with ..." under the question.
test("formatAskCard puts the question first and the deadline in one short line; the buttons carry the options and the ✓", () => {
  assert.equal(
    formatAskCard({ kind: "question", text: "Dark mode by default?", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], recommended: 0, defaultAt: Date.UTC(2026, 9, 7, 16, 5) }),
    "❓ Dark mode by default?\n\nIf no answer by 16:05 UTC, I go with ✓.",
  );
  assert.equal(formatAskCard({ kind: "blocker", text: "Need the Stripe key.", options: [], recommended: null, defaultAt: null }), "⛔ Need the Stripe key.");
  assert.equal(formatAskCard({ kind: "approval", text: "Deploy?", options: [{ label: "Deploy", value: "d" }], recommended: 0, defaultAt: null }), "✅ Deploy?");
  // A label longer than a button shows is listed in full, because its button ends early.
  assert.equal(
    formatAskCard({ kind: "question", text: "Who provides the proxies?", options: [{ label: "A. Cyndra buys one proxy provider account and bills it through credits", value: "A" }, { label: "B. Each customer brings their own proxy", value: "B" }], recommended: 1, defaultAt: Date.UTC(2026, 9, 14, 22, 26) }),
    "❓ Who provides the proxies?\nA. Cyndra buys one proxy provider account and bills it through credits\nB. Each customer brings their own proxy\n\nIf no answer by 22:26 UTC, I go with ✓.",
  );
});

test("packAnswers reads the cards a pack answer recorded, one line per card", () => {
  assert.deepEqual(packAnswers("1A 3C\nAnswers recorded on the cards:\n- ask apx0v8q: A. Lower: 50 a day max\n- ask agqtl7j: C. 90 days, then delete"), [
    { id: "apx0v8q", answer: "A. Lower: 50 a day max" },
    { id: "agqtl7j", answer: "C. 90 days, then delete" },
  ]);
  assert.deepEqual(packAnswers("- ask apx0v8q: quoted without the heading"), []);
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

test("an owner tap stamps answeredByOwner; the captain can still correct it", () => {
  const asks = createOwnerAsks(db());
  const opts = [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }];
  asks.create({ id: "a1", captain: "thr_cap", kind: "question", text: "q", options: opts, createdAt: NOW });
  assert.equal(asks.resolve("a1", "thr_cap", "answered", "Yes", NOW, "owner")?.resolution, "Yes");
  assert.equal(asks.answeredByOwner("a1"), true);
  assert.equal(asks.resolve("a1", "thr_cap", "answered", "Captain correction", NOW + 2)?.resolution, "Captain correction");
  assert.equal(asks.answeredByOwner("a1"), false);
});

test("an owner confirmation stamps a card the captain already answered", () => {
  const asks = createOwnerAsks(db());
  const opts = [{ label: "Approve", value: "approve" }, { label: "No", value: "no" }];
  asks.create({ id: "a1", captain: "thr_cap", kind: "approval", text: "Merge?", options: opts, createdAt: NOW });
  assert.equal(asks.resolve("a1", "thr_cap", "answered", "Approve", NOW)?.resolution, "Approve");
  assert.equal(asks.answeredByOwner("a1"), false);
  assert.equal(asks.resolve("a1", "thr_cap", "answered", "Approve", NOW + 1, "owner")?.resolution, "Approve");
  assert.equal(asks.answeredByOwner("a1"), true);
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
    "✅ Finished since you last looked: nothing new.",
    "",
    "🚀 Not live yet: nothing merged waits to go live.",
    "",
    "🔧 In progress: nothing open.",
  ].join("\n"));
});

test("impact survives restart while old 12-column writers still work", () => {
  const database = db();
  const asks = createOwnerAsks(database);
  const ask = asks.create({ id: "aimpact", captain: "thr_cap", kind: "question", impact: "New customers can start their agents again.", text: "Find the addresses?", options: [{ label: "Find and verify the full address list before changing production.", value: "find" }], createdAt: NOW });
  assert.equal(createOwnerAsks(database).get("aimpact")?.impact, "New customers can start their agents again.");
  assert.equal(formatAskCard(ask), "❓ Find the addresses?\nNew customers can start their agents again.\nA. Find and verify the full address list before changing production.");
  assert.equal(database.prepare("PRAGMA table_info(owner_ask)").all().length, 12);
});


test("card answers accept only a valid letter, optionally followed by a period", () => {
  const ask = { options: [{ label: "Send the list", value: "send" }, { label: "Find the list", value: "find" }] };
  for (const text of ["B", "b", "B.", " b. "]) assert.equal(askLetterAnswer(ask, text), "Find the list");
  for (const text of ["What?", "B. send me a link", "1 B", "7B", "C", "Find the list", "B!", "B\nA"]) assert.equal(askLetterAnswer(ask, text), null);
});


// 15 Oct, 08:54 UTC: the agent-native card offered "Yes, build it" and said "If no answer by 12:54 UTC, I go with ✓".
// The owner had not asked for a build. A card that starts new work waits for the owner and never defaults.
test("a card that starts new work never gets a default and says it waits for the owner", () => {
  const asks = createOwnerAsks(db());
  const card = {
    captain: "thr_cap", kind: "question" as const, recommended: 0, createdAt: NOW, startsNewWork: true,
    text: "agent-native: may we add its first idea to our CI, so a check that could not run is reported separately from one that passed (1 to 2 days)?",
    options: [{ label: "Yes, build it", value: "A" }, { label: "No", value: "B" }],
  };
  // A caller that still passes a deadline gets none: the stored ask has no default.
  const ask = asks.create({ ...card, defaultAt: NOW + 4 * 3_600_000 });
  assert.equal(ask.defaultAt, null);
  assert.equal(asks.get(ask.id)?.startsNewWork, true);
  assert.equal(asks.get(ask.id)?.defaultAt, null);
  assert.deepEqual(asks.takeDue("thr_cap", NOW + 5 * 3_600_000), []);
  assert.equal(asks.get(ask.id)?.state, "open");
  assert.equal(formatAskCard(ask), `❓ ${card.text}\n\nThis starts new work, so I wait for your answer.`);
  // A reversible card that starts no new work keeps its deadline.
  const plain = asks.create({ ...card, startsNewWork: false, text: "Dark mode by default?", defaultAt: NOW + 60_000 });
  assert.equal(asks.get(plain.id)?.startsNewWork, false);
  assert.equal(asks.get(plain.id)?.defaultAt, NOW + 60_000);
});

test("no check judges reply prose: the plain-text decision and card-repeat matchers are gone", () => {
  for (const name of ["plainTextDecision", "cardRepeat", "ownerAskedForOptions", "PLAIN_DECISION_GUIDANCE"]) {
    assert.equal(name in ownerAsksModule, false, name);
  }
});

// 18 Oct, owner: "add skip button also in the waiting for you section". Skip is "decide later": the card
// is deferred until a time, never deleted, and comes back on its own when that time is up.
test("a skipped card is deferred until its time, keeps its options, and comes back on its own for the owner, never decided by its old deadline", () => {
  const asks = createOwnerAsks(db());
  const options = [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }];
  asks.create({ id: "a1", captain: "thr_cap", kind: "question", text: "Ship?", options, recommended: 0, defaultAt: NOW - 1, createdAt: NOW - 60_000 });
  asks.create({ id: "a2", captain: "thr_cap", kind: "question", text: "Other?", options, createdAt: NOW - 60_000 });
  const until = NOW + 3_600_000;

  assert.deepEqual(asks.defer(["a1"], "thr_cap", until, NOW), { deferred: ["a1"], already: [], refused: [], until });
  assert.equal(asks.get("a1")?.state, "open", "a skipped card is still open: an answer on it still counts");
  assert.equal(asks.get("a1")?.deferredUntil, until);
  assert.equal(ownerAsksModule.isDeferred(asks.get("a1")!, NOW), true);
  assert.deepEqual(asks.listWaiting("thr_cap", NOW).map((ask) => ask.id), ["a2"], "a skipped card does not wait on the owner");
  assert.deepEqual(asks.takeDue("thr_cap", NOW), [], "a skipped card does not proceed on its deadline while skipped");

  assert.deepEqual(asks.defer(["a1"], "thr_cap", NOW + 60_000, NOW), { deferred: [], already: ["a1"], refused: [], until }, "a skipped card keeps its time");

  assert.equal(ownerAsksModule.isDeferred(asks.get("a1")!, until), false, "at its time the card is back");
  assert.deepEqual(asks.listWaiting("thr_cap", until).map((ask) => ask.id), ["a1", "a2"]);
  // Checker 159 finding 3: "decide later" brings the question back to the owner; its old deadline does not decide it.
  assert.deepEqual(asks.takeDue("thr_cap", until), []);
  assert.deepEqual(asks.takeDue("thr_cap", until + 86_400_000), []);
  assert.equal(asks.get("a1")?.state, "open");
});

// Checker 159 finding 2: a stale card (answered, cancelled, another captain's, unknown) is refused, and the
// whole Skip changes nothing, so the connector can refuse it too.
test("a Skip that names a card no longer open is refused whole and changes nothing", () => {
  const asks = createOwnerAsks(db());
  const options = [{ label: "Yes", value: "yes" }];
  for (const id of ["a1", "a2", "a3"]) asks.create({ id, captain: id === "a3" ? "thr_other" : "thr_cap", kind: "question", text: "Ship?", options, createdAt: NOW });
  asks.resolve("a2", "thr_cap", "answered", "Yes", NOW);
  assert.deepEqual(asks.defer(["a1", "a2", "a3", "missing"], "thr_cap", NOW + 60_000, NOW), { deferred: [], already: [], refused: ["a2", "a3", "missing"], until: null });
  assert.equal(asks.get("a1")?.deferredUntil, undefined, "nothing was skipped");
});

test("each skipped card waits until the captain is told, and is told once", () => {
  const asks = createOwnerAsks(db());
  const options = [{ label: "Yes", value: "yes" }];
  for (const id of ["a1", "a2"]) asks.create({ id, captain: "thr_cap", kind: "question", text: "Ship?", options, createdAt: NOW });
  asks.defer(["a1", "a2"], "thr_cap", NOW + 60_000, NOW);
  assert.deepEqual(asks.untoldSkips("thr_cap", NOW).map((ask) => ask.id), ["a1", "a2"]);
  asks.markSkipsTold(["a1", "a2"]);
  assert.deepEqual(asks.untoldSkips("thr_cap", NOW), []);
  assert.deepEqual(asks.untoldSkips("thr_cap", NOW + 60_000), [], "a skip whose time passed needs no notice");
});

test("a skipped card answered early is answered, and a reopened card is no longer skipped", () => {
  const asks = createOwnerAsks(db());
  const options = [{ label: "Yes", value: "yes" }];
  asks.create({ id: "a1", captain: "thr_cap", kind: "question", text: "Ship?", options, createdAt: NOW });
  asks.defer(["a1"], "thr_cap", NOW + 3_600_000, NOW);
  asks.resolve("a1", "thr_cap", "answered", "Yes", NOW + 60_000);
  assert.equal(asks.get("a1")?.state, "answered");
  asks.resolve("a1", "thr_cap", "open", "", NOW + 120_000);
  assert.equal(asks.get("a1")?.deferredUntil, undefined, "a reopened card waits on the owner again");
  assert.deepEqual(asks.listWaiting("thr_cap", NOW + 120_000).map((ask) => ask.id), ["a1"]);
});
