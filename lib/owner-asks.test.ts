import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { askLetterAnswer, askIdFromSourceEventId, createOwnerAsks, formatAskCard, newAskId, ownerAskedForOptions, PLAIN_DECISION_GUIDANCE, plainTextDecision } from "./owner-asks.ts";
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

// Sent to the owner as plain text on 11 and 12 Oct 2026, after the captain stopped sending cards.
const PLAIN_DECISIONS = {
  release: "Question: release the change that shows a plain icon first and the animated agent face after (#2284)?\n\nA. No, do not release it. I recommend this. The page loads slower for no gain.\nB. Yes, release it.\n\nUntil you answer, #2284 is not released.",
  straightLine: "Three items need fixes before release. I need 1 decision from you for StraightLine.\n\nDecision: go for the StraightLine call notes (orders 8 to 11) or hold them until the recording fix is live.",
  stillOpen: "Still open with you:\n\nSend the draft and the 2 card files to Jasher (A send, recommended / B change the wording first)",
  recap: "Recap: all finished Cyndra work is live. 12 decisions wait for you.",
};

test("Oct 11 repro: a plain-text message that asks the owner to choose is recognised as a decision", () => {
  for (const [name, text] of Object.entries(PLAIN_DECISIONS)) assert.equal(typeof plainTextDecision(text), "string", name);
  assert.equal(typeof plainTextDecision("Which one do you want?\n\nA) Ship today\nB) Wait for the review"), "string", "A) option lines");
  assert.equal(typeof plainTextDecision("Decision: the export format\n- **A.** CSV\n- **B.** PDF"), "string", "bullet and bold option lines with a cue");
});

test("reports, results of answered cards and changelogs are not decisions", () => {
  for (const text of [
    "Results of the cards you answered:\n\nA: the plain icon change is released (#2284).\nB: the StraightLine call notes are on hold.\n\nNothing else changed.",
    "Changelog\n\n- Digest: a finished item is listed once.\n- Cards: every decision is a card.\n\nA. Digest fix is live.\nB. Card fix is live.",
    "Rolled back. Is anything else broken? No: the checks pass.",
    "The decision you made on 10 Oct is live: #2284 is not released.",
    "Done. PR cyndra-saas#2146 is merged and deployed.",
  ]) assert.equal(plainTextDecision(text), null, text);
});

test("an owner message that asks for options or drafts allows a reply that lists them", () => {
  for (const asked of ["what are my options", "What are my options for the Jasher email?", "Draft 2 replies to Jasher for me", "give me 3 versions of the headline", "which decisions wait for me?"]) {
    assert.equal(ownerAskedForOptions(asked), true, asked);
  }
  for (const asked of ["Status?", "Fix the Metricool sync", "release #2284 today"]) assert.equal(ownerAskedForOptions(asked), false, asked);
});

test("the guidance names the card tool and the report without the question", () => {
  assert.match(PLAIN_DECISION_GUIDANCE, /firstmate_ask/);
  assert.match(PLAIN_DECISION_GUIDANCE, /without the question/);
});
