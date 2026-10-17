import assert from "node:assert/strict";
import test from "node:test";
import { nextSyncStep, ownerFacing, verdictOf, type SyncObservation, type SyncState } from "./native-sync.ts";

const PIN = "15ad1bd6524bdccca00feb07b3e3ed985fb2d7f4";
const AHEAD = "a".repeat(40);
const HEAD1 = "1".repeat(40);
const HEAD2 = "2".repeat(40);
const pr = (head = HEAD1) => ({ number: 140, url: "https://github.com/o/r/pull/140", branch: "native-sync/aaaaaaaa", head });
const seen = (over: Partial<SyncObservation> = {}): SyncObservation => ({ start: false, pin: PIN, upstream: AHEAD, prs: [], files: [], threads: {}, ...over });
const started: SyncState = { sync: { target: AHEAD, threadId: "thr_sync", at: "2026-10-18T04:00:00.000Z" } };

test("the weekly run does nothing while the pin is at upstream HEAD", () => {
  const step = nextSyncStep(seen({ start: true, upstream: PIN }), {});
  assert.equal(step.action, "none");
  assert.match(step.why, /pin 15ad1bd6 is upstream HEAD/);
});

test("the weekly run starts one sync crew when upstream HEAD differs from the pin", () => {
  const step = nextSyncStep(seen({ start: true }), {});
  assert.equal(step.action, "start-sync");
  if (step.action !== "start-sync") return;
  assert.equal(step.target, AHEAD);
  assert.equal(step.branch, "native-sync/aaaaaaaa");
  assert.match(step.prompt, /docs\/native-sync\.md/);
  assert.match(step.prompt, new RegExp(`from ${PIN} to ${AHEAD}`));
  assert.match(step.prompt, /Stop at the open PR/);
});

test("a follow-up run never starts a sync crew", () => {
  assert.equal(nextSyncStep(seen(), {}).action, "none");
});

test("no second sync crew while one is open", () => {
  const working = nextSyncStep(seen({ start: true, threads: { thr_sync: { status: "active", output: "" } } }), started);
  assert.equal(working.action, "none");
  assert.match(working.why, /sync crew thr_sync is still working/);
  const withPr = nextSyncStep(seen({ start: true, upstream: "b".repeat(40), prs: [pr()], threads: { thr_sync: { status: "active", output: "" } } }), started);
  assert.equal(withPr.action, "none");
});

test("a finished sync for the same upstream HEAD without an open PR is not started again", () => {
  const step = nextSyncStep(seen({ start: true, threads: { thr_sync: { status: "idle", output: "BLOCKED" } } }), started);
  assert.equal(step.action, "none");
  assert.match(step.why, /already ran/);
  const newer = nextSyncStep(seen({ start: true, upstream: "b".repeat(40), threads: { thr_sync: { status: "idle", output: "" } } }), started);
  assert.equal(newer.action, "start-sync");
});

test("an open sync PR whose crew finished gets one checker on a different model, at its head", () => {
  const step = nextSyncStep(seen({ prs: [pr()], threads: { thr_sync: { status: "idle", output: "PR open" } } }), started);
  assert.equal(step.action, "start-checker");
  if (step.action !== "start-checker") return;
  assert.equal(step.head, HEAD1);
  assert.match(step.prompt, /https:\/\/github\.com\/o\/r\/pull\/140/);
  assert.match(step.prompt, /VERDICT: pass/);
  const again = nextSyncStep(seen({ prs: [pr()], threads: { thr_sync: { status: "idle", output: "" }, thr_chk: { status: "active", output: "" } } }), { ...started, check: { head: HEAD1, threadId: "thr_chk", pr: 140, at: "x" } });
  assert.equal(again.action, "none");
  assert.match(again.why, /checker thr_chk is still working/);
});

test("a new push gets a new checker", () => {
  const step = nextSyncStep(seen({ prs: [pr(HEAD2)], threads: { thr_sync: { status: "idle", output: "" }, thr_chk: { status: "idle", output: "VERDICT: fail (1 finding)" } } }), { ...started, check: { head: HEAD1, threadId: "thr_chk", pr: 140, at: "x" }, reported: HEAD1 });
  assert.equal(step.action, "start-checker");
});

test("the repair thread gets one message with both results, once per head", () => {
  const state: SyncState = { ...started, check: { head: HEAD1, threadId: "thr_chk", pr: 140, at: "x" } };
  const threads = { thr_sync: { status: "idle", output: "Opened the sync PR.\nCanary: one dispatch, one merge, a mid-turn switch passed." }, thr_chk: { status: "idle", output: "Read the diff and ran the suite.\nVERDICT: pass" } };
  const step = nextSyncStep(seen({ prs: [pr()], threads, files: ["native-snapshot/aaaaaaaa/AGENTS.md", "lib/upstream-surface.ts"] }), state);
  assert.equal(step.action, "report");
  if (step.action !== "report") return;
  assert.match(step.message, /pull\/140/);
  assert.match(step.message, /Canary: one dispatch, one merge, a mid-turn switch passed\./);
  assert.match(step.message, /Checker verdict: pass/);
  assert.match(step.message, /Owner card: not needed/);
  assert.equal(nextSyncStep(seen({ prs: [pr()], threads }), { ...state, reported: HEAD1 }).action, "none");
});

test("the owner card is decided by the changed files, not by words", () => {
  assert.deepEqual(ownerFacing(["lib/upstream-surface.ts", "native-snapshot/x/AGENTS.md", "docs/verification/upstream-update-2026-10-25.md"]), []);
  assert.deepEqual(ownerFacing(["entry-skills/captain/references/telegram.md", "lib/telegram-reply.ts", "docs/verification/native-transport-allowlist.v1.json", "lib/owner-asks.ts", "owner/handoff-contract.ts", "server.ts"]),
    ["entry-skills/captain/references/telegram.md", "lib/telegram-reply.ts", "docs/verification/native-transport-allowlist.v1.json", "lib/owner-asks.ts", "owner/handoff-contract.ts"]);
  const state: SyncState = { ...started, check: { head: HEAD1, threadId: "thr_chk", pr: 140, at: "x" } };
  const step = nextSyncStep(seen({ prs: [pr()], files: ["entry-skills/captain/references/telegram.md"], threads: { thr_sync: { status: "idle", output: "done" }, thr_chk: { status: "idle", output: "VERDICT: pass" } } }), state);
  assert.equal(step.action, "report");
  if (step.action === "report") assert.match(step.message, /Owner card: needed\. This sync changes how Hanoon talks to the owner: entry-skills\/captain\/references\/telegram\.md/);
});

test("a checker that ends without a VERDICT line counts as a fail", () => {
  assert.deepEqual(verdictOf("looks fine"), { verdict: "fail", line: "no VERDICT line in the checker's final message" });
  assert.deepEqual(verdictOf("x\nVERDICT: fail (2 findings)\n"), { verdict: "fail", line: "VERDICT: fail (2 findings)" });
  assert.deepEqual(verdictOf("VERDICT: pass"), { verdict: "pass", line: "VERDICT: pass" });
});
