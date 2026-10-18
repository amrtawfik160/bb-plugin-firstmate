import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createOwnerPromises, followupPromises, promiseTime } from "./owner-promises.ts";

const NOW = Date.parse("2026-10-18T15:00:00Z");

function db() {
  const raw = new DatabaseSync(":memory:");
  return Object.assign(raw, { transaction: <T>(fn: () => T) => () => { raw.exec("BEGIN"); try { const out = fn(); raw.exec("COMMIT"); return out; } catch (error) { raw.exec("ROLLBACK"); throw error; } } });
}

test("a promise time needs a date in the future; a time needs its zone", () => {
  assert.equal(promiseTime("2026-10-21T14:40:00Z", NOW), Date.parse("2026-10-21T14:40:00Z"));
  assert.equal(promiseTime("2026-10-21T16:40+02:00", NOW), Date.parse("2026-10-21T14:40:00Z"));
  // A date alone is 09:00 Cairo, when the owner's digest goes out.
  assert.equal(promiseTime("2026-10-21", NOW), Date.parse("2026-10-21T06:00:00Z"));
  assert.match(String(promiseTime("2026-10-21T14:40", NOW)), /zone/);
  assert.match(String(promiseTime("2026-10-17T10:00:00Z", NOW)), /past/);
  assert.match(String(promiseTime("next week", NOW)), /date/);
});

test("a promise is one record: a repeat returns it, it wakes once when due, and the captain closes it", () => {
  const promises = createOwnerPromises(db());
  const first = promises.add({ captain: "thr_cap", by: NOW + 60_000, what: "Check the W4 renewal", ref: "tg:200:1", task: "T3", source: "reply", at: NOW });
  assert.equal(first.created, true);
  assert.equal(first.promise.id, "P1");
  assert.equal(promises.add({ captain: "thr_cap", by: NOW + 60_000, what: "Check the W4 renewal", ref: "tg:200:1", task: "T3", source: "reply", at: NOW }).created, false);
  assert.deepEqual(promises.due("thr_cap", NOW).map((p) => p.id), []);
  assert.deepEqual(promises.due("thr_cap", NOW + 60_000).map((p) => p.id), ["P1"]);
  promises.markWoken(["P1"], NOW + 60_000);
  assert.deepEqual(promises.due("thr_cap", NOW + 120_000), [], "a woken promise does not wake again");
  assert.deepEqual(promises.list("thr_cap").map((p) => [p.id, p.state]), [["P1", "due"]], "it stays open until the captain closes it");
  assert.throws(() => promises.close("P1", "thr_cap", "dropped", "", NOW), /reason/);
  promises.close("P1", "thr_cap", "kept", "Renewal paid", NOW + 180_000);
  assert.deepEqual(promises.list("thr_cap"), []);
  assert.equal(promises.list("thr_cap", { includeClosed: true })[0]?.state, "kept");
  assert.throws(() => promises.close("P1", "thr_other", "kept", "x", NOW), /No promise P1/);
});

test("a claim takes each due promise once; a released claim is due again", () => {
  const promises = createOwnerPromises(db());
  promises.add({ captain: "thr_cap", by: NOW, what: "Check the renewal", ref: null, task: null, source: "reply", at: NOW - 1 });
  assert.deepEqual(promises.claimDue("thr_cap", NOW).map((p) => p.id), ["P1"]);
  assert.deepEqual(promises.claimDue("thr_cap", NOW), [], "a second check finds it taken");
  promises.release(["P1"]);
  assert.deepEqual(promises.claimDue("thr_cap", NOW + 1).map((p) => p.id), ["P1"]);
});

test("the follow-ups import keeps each line with a future date, at its earliest future date, and lists the rest", () => {
  const file = [
    "",
    "- 2026-10-17 pool-2 disk move done. On or after 2026-10-24: delete the detached volume.",
    "- 2026-10-17 T227 server merge (crew 7181e669):",
    "  - on/after 2026-10-24 22:13 UTC: delete S2 (stopped, empty).",
    "- PR 2547 now contains all of PR 2534. When 2547 merges, close 2534. (17 Oct)",
    "- 2551 Stripe renewals: W4 is due 21 Oct about 14:40 UTC, and W1 is due 28 Oct.",
    "- Areliaa cuts are live (18 Oct 06:45 UTC). Measure about 21 Oct 08:00 UTC; delete old queries after 19 Oct 06:45 UTC.",
  ].join("\n");
  const plan = followupPromises(file, NOW);
  assert.deepEqual(plan.promises.map((p) => [p.line, new Date(p.by).toISOString()]), [
    [2, "2026-10-24T06:00:00.000Z"],
    [4, "2026-10-24T22:13:00.000Z"],
    [6, "2026-10-21T14:40:00.000Z"],
    [7, "2026-10-19T06:45:00.000Z"],
  ]);
  assert.equal(plan.promises[1]!.what, "2026-10-17 T227 server merge (crew 7181e669): on/after 2026-10-24 22:13 UTC: delete S2 (stopped, empty).", "a sub-line carries its parent line");
  assert.deepEqual(plan.skipped.map((s) => s.line), [3, 5], "a line whose dates are all past is not a dated promise");
});

// Checker round 2 (161-verdict-2.md), finding 1, kept as written; a store reopened on the same file is a restart.
test("round 2: crash after claiming a promise must not lose its undelivered reminder", async () => {
 const {DatabaseSync}=await import("node:sqlite");
 const {mkdtempSync,rmSync}=await import("node:fs");
 const dir=mkdtempSync("/tmp/verify161-r2-crash-");
 const connect=()=>{const raw=new DatabaseSync(`${dir}/promise.sqlite`);return Object.assign(raw,{transaction:<T>(fn:()=>T)=>()=>{raw.exec("BEGIN");try{const out=fn();raw.exec("COMMIT");return out;}catch(e){raw.exec("ROLLBACK");throw e;}}});};
 let db=connect();
 try {
  const promises=createOwnerPromises(db);
  promises.add({captain:"thr_cap",by:1000,what:"Not delivered yet",ref:null,task:null,source:"reply",at:0});
  assert.equal(promises.claimDue("thr_cap",1000).length,1);
  // Crash at server.ts's boundary after claimDue and before deliverToCaptain. No send occurred.
  db.close(); db=connect();
  assert.equal(createOwnerPromises(db).claimDue("thr_cap",2000).length,1,"A restart must recover the unsent reminder");
 } finally {db.close();rmSync(dir,{recursive:true,force:true});}
});

test("a claim left by a stopped process is taken again; markWoken records the delivery and nothing wakes again", () => {
  const raw = db();
  createOwnerPromises(raw).add({ captain: "thr_cap", by: NOW, what: "Check the renewal", ref: null, task: null, source: "reply", at: NOW - 1 });
  assert.equal(createOwnerPromises(raw).claimDue("thr_cap", NOW).length, 1);
  const restarted = createOwnerPromises(raw);
  assert.deepEqual(restarted.claimDue("thr_cap", NOW).map((p) => p.id), ["P1"], "the earlier process never sent it");
  restarted.markWoken(["P1"], NOW);
  assert.deepEqual(createOwnerPromises(raw).claimDue("thr_cap", NOW + 1), []);
  assert.equal(restarted.list("thr_cap")[0]?.state, "due");
});
