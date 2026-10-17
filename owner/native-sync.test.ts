import assert from "node:assert/strict";
import test from "node:test";
import { MAX_SYNC_ATTEMPTS, nextSyncStep, ownerFacing, verdictOf, type SyncObservation, type SyncState } from "./native-sync.ts";

const PIN = "15ad1bd6524bdccca00feb07b3e3ed985fb2d7f4";
const AHEAD = "a".repeat(40);
const HEAD1 = "1".repeat(40);
const HEAD2 = "2".repeat(40);
const pr = (head = HEAD1, number = 140) => ({ number, url: `https://github.com/o/r/pull/${number}`, branch: "native-sync/aaaaaaaa", head });
const seen = (over: Partial<SyncObservation> = {}): SyncObservation => ({ start: false, retry: false, pin: PIN, upstream: AHEAD, prs: [], closed: [], files: [], threads: {}, launched: {}, delivered: {}, newOp: "op9", ...over });
const started: SyncState = { sync: { op: "op1", target: AHEAD, threadId: "thr_sync", at: "2026-10-18T04:00:00.000Z", attempt: 1 } };
const idle = (output = "") => ({ status: "idle", output });
const busy = { status: "active", output: "" };

test("the weekly run does nothing while the pin is at upstream HEAD", () => {
  const step = nextSyncStep(seen({ start: true, upstream: PIN }), {});
  assert.equal(step.action, "none");
  if (step.action === "none") assert.match(step.why, /pin 15ad1bd6 is upstream HEAD/);
});

test("the weekly run starts one sync crew, with its operation id in the title", () => {
  const step = nextSyncStep(seen({ start: true }), {});
  assert.equal(step.action, "spawn-sync");
  if (step.action !== "spawn-sync") return;
  assert.equal(step.op, "op9");
  assert.equal(step.attempt, 1);
  assert.equal(step.title, "Native sync to aaaaaaaa [op:op9]");
  assert.match(step.prompt, /docs\/native-sync\.md/);
  assert.match(step.prompt, new RegExp(`from ${PIN} to ${AHEAD}`));
  assert.equal(nextSyncStep(seen(), {}).action, "none", "a follow-up run never starts a new sync");
});

test("a launch whose result was lost is adopted when its thread exists, and launched again only when it does not", () => {
  const pending: SyncState = { sync: { op: "op1", target: AHEAD, at: "x", attempt: 1 } };
  assert.deepEqual(nextSyncStep(seen({ launched: { op1: ["thr_sync"] } }), pending), { action: "adopt", slot: "sync", threadId: "thr_sync" });
  const twins = nextSyncStep(seen({ launched: { op1: ["thr_a", "thr_b"] } }), pending);
  assert.equal(twins.action, "none", "two marked threads are uncertain, never a reason to spawn");
  const again = nextSyncStep(seen(), pending);
  assert.equal(again.action, "spawn-sync");
  if (again.action === "spawn-sync") assert.equal(again.op, "op1", "the retry reuses the same operation id");
  const check: SyncState = { ...started, check: { op: "op2", head: HEAD1, pr: 140, at: "x" } };
  assert.deepEqual(nextSyncStep(seen({ prs: [pr()], threads: { thr_sync: idle() }, launched: { op2: ["thr_chk"] } }), check), { action: "adopt", slot: "check", threadId: "thr_chk" });
});

test("a message whose result was lost is confirmed from the repair thread's log, or sent again with the same marker", () => {
  const state: SyncState = { ...started, outbox: { key: "report:x", op: "op5", text: "[native-sync op5]\nhello", at: "x" } };
  assert.deepEqual(nextSyncStep(seen({ delivered: { op5: "found" } }), state), { action: "delivered", key: "report:x" });
  assert.equal(nextSyncStep(seen({ delivered: { op5: "unknown" } }), state).action, "none");
  assert.equal(nextSyncStep(seen(), state).action, "none", "no search result is unknown, not absent");
  assert.deepEqual(nextSyncStep(seen({ delivered: { op5: "absent" } }), state), { action: "tell", key: "report:x", op: "op5", text: "[native-sync op5]\nhello" });
});

test("no second sync crew while one is open", () => {
  const working = nextSyncStep(seen({ start: true, threads: { thr_sync: busy } }), started);
  assert.equal(working.action, "none");
  if (working.action === "none") assert.match(working.why, /sync crew thr_sync is still working/);
  assert.equal(nextSyncStep(seen({ start: true, upstream: "b".repeat(40), prs: [pr()], threads: { thr_sync: busy } }), started).action, "none");
});

test("a sync crew that ended without a PR is started again once, then reported once", () => {
  for (const thread of [idle("BLOCKED: guard refused"), { status: "error", output: "" }, undefined]) {
    const retry = nextSyncStep(seen({ threads: { thr_sync: thread } }), started);
    assert.equal(retry.action, "spawn-sync");
    if (retry.action === "spawn-sync") assert.equal(retry.attempt, 2);
  }
  const last: SyncState = { sync: { ...started.sync!, attempt: MAX_SYNC_ATTEMPTS } };
  const report = nextSyncStep(seen({ threads: { thr_sync: idle("BLOCKED: guard refused") } }), last);
  assert.equal(report.action, "tell");
  if (report.action !== "tell") return;
  assert.equal(report.key, `failed:${AHEAD}`);
  assert.match(report.text, /^\[native-sync op9\]\n/);
  assert.match(report.text, /ended 2 times without a PR/);
  assert.match(report.text, /BLOCKED: guard refused/);
  assert.match(report.text, /tick --start --retry/);
  const after = nextSyncStep(seen({ start: true, threads: { thr_sync: idle() } }), { ...last, done: [`failed:${AHEAD}`] });
  assert.equal(after.action, "none");
  const forced = nextSyncStep(seen({ retry: true, threads: { thr_sync: idle() } }), { ...last, done: [`failed:${AHEAD}`] });
  assert.equal(forced.action, "spawn-sync");
  if (forced.action === "spawn-sync") assert.equal(forced.attempt, 1);
});

test("a sync PR closed without merge is reported once and not started again", () => {
  const closed = [pr(HEAD1, 141)];
  const step = nextSyncStep(seen({ start: true, closed, threads: { thr_sync: idle() } }), started);
  assert.equal(step.action, "tell");
  if (step.action === "tell") {
    assert.equal(step.key, "closed:141");
    assert.match(step.text, /closed without a merge/);
  }
  assert.equal(nextSyncStep(seen({ start: true, closed, threads: { thr_sync: idle() } }), { ...started, done: ["closed:141"] }).action, "none");
});

test("a merged sync is done: the pin moved to upstream HEAD", () => {
  assert.equal(nextSyncStep(seen({ start: true, upstream: PIN, threads: { thr_sync: idle() } }), { sync: { ...started.sync!, target: PIN } }).action, "none");
});

test("an open sync PR gets one checker per head, and an old checker finishes first", () => {
  const step = nextSyncStep(seen({ prs: [pr()], threads: { thr_sync: idle("PR open") } }), started);
  assert.equal(step.action, "spawn-check");
  if (step.action !== "spawn-check") return;
  assert.equal(step.head, HEAD1);
  assert.equal(step.title, "Check native sync PR #140 [op:op9]");
  assert.match(step.prompt, /pull\/140/);
  const checking: SyncState = { ...started, check: { op: "op2", head: HEAD1, threadId: "thr_chk", pr: 140, at: "x" } };
  assert.equal(nextSyncStep(seen({ prs: [pr()], threads: { thr_sync: idle(), thr_chk: busy } }), checking).action, "none");
  assert.equal(nextSyncStep(seen({ prs: [pr(HEAD2)], threads: { thr_sync: idle(), thr_chk: busy } }), checking).action, "none");
  assert.equal(nextSyncStep(seen({ prs: [pr(HEAD2)], threads: { thr_sync: idle(), thr_chk: idle("VERDICT: fail (1 finding)") } }), checking).action, "spawn-check");
});

test("the repair thread gets one message with both results, once per head", () => {
  const state: SyncState = { ...started, check: { op: "op2", head: HEAD1, threadId: "thr_chk", pr: 140, at: "x" } };
  const threads = { thr_sync: idle("Opened the sync PR.\nCanary: one dispatch, one merge, a mid-turn switch passed."), thr_chk: idle("Ran the suite.\nVERDICT: pass") };
  const step = nextSyncStep(seen({ prs: [pr()], threads, files: ["lib/upstream-surface.ts"] }), state);
  assert.equal(step.action, "tell");
  if (step.action !== "tell") return;
  assert.equal(step.key, `report:${HEAD1}`);
  assert.match(step.text, /^\[native-sync op9\]\n/);
  assert.match(step.text, /Checker verdict: pass/);
  assert.match(step.text, /Canary: one dispatch, one merge, a mid-turn switch passed\./);
  assert.match(step.text, /Owner card: not needed/);
  assert.equal(nextSyncStep(seen({ prs: [pr()], threads }), { ...state, done: [`report:${HEAD1}`] }).action, "none");
});

test("the owner card is decided by the changed files, not by words", () => {
  assert.deepEqual(ownerFacing(["lib/upstream-surface.ts", "native-snapshot/x/AGENTS.md", "docs/verification/upstream-update-2026-10-25.md", "server.ts"]), []);
  assert.deepEqual(ownerFacing(["entry-skills/captain/references/telegram.md", "lib/telegram-reply.ts", "docs/verification/native-transport-allowlist.v1.json", "lib/owner-asks.ts", "owner/handoff-contract.ts"]),
    ["entry-skills/captain/references/telegram.md", "lib/telegram-reply.ts", "docs/verification/native-transport-allowlist.v1.json", "lib/owner-asks.ts", "owner/handoff-contract.ts"]);
  const state: SyncState = { ...started, check: { op: "op2", head: HEAD1, threadId: "thr_chk", pr: 140, at: "x" } };
  const step = nextSyncStep(seen({ prs: [pr()], files: ["entry-skills/captain/references/telegram.md"], threads: { thr_sync: idle("done"), thr_chk: idle("VERDICT: pass") } }), state);
  if (step.action === "tell") assert.match(step.text, /Owner card: needed\. This sync changes how Hanoon talks to the owner: entry-skills\/captain\/references\/telegram\.md/);
  else assert.fail(step.action);
});

test("the verdict is the checker's last line; anything else counts as a fail", () => {
  assert.deepEqual(verdictOf("looks fine"), { verdict: "fail", line: "no VERDICT line at the end of the checker's final message" });
  assert.deepEqual(verdictOf("x\nVERDICT: fail (2 findings)\n"), { verdict: "fail", line: "VERDICT: fail (2 findings)" });
  assert.deepEqual(verdictOf("VERDICT: pass"), { verdict: "pass", line: "VERDICT: pass" });
  assert.equal(verdictOf("VERDICT: pass\nBut one more finding: the guard failed.").verdict, "fail");
});
