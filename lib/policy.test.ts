import assert from "node:assert/strict";
import test from "node:test";
import {
  afkShouldSend,
  capPermission,
  crewPrompt,
  decisionDue,
  hasStatusProtocol,
  looksReadOnly,
  parseOutcome,
  queueGate,
  quietShouldSend,
  resolveWorktree,
} from "./policy.ts";

test("capPermission never exceeds parent", () => {
  assert.equal(capPermission("full", "auto"), "auto");
  assert.equal(capPermission("accept-edits", "full"), "accept-edits");
  assert.equal(capPermission(undefined, "auto"), "auto");
  assert.equal(capPermission("full", undefined), "full");
});

test("ship defaults to isolated worktree; shared-env is an override", () => {
  assert.deepEqual(resolveWorktree({ shape: "ship" }), {
    worktree: true,
    sharedOverride: false,
  });
  assert.deepEqual(resolveWorktree({ shape: "ship", sharedEnv: true }), {
    worktree: false,
    sharedOverride: true,
  });
  assert.deepEqual(resolveWorktree({ shape: "scout" }), {
    worktree: false,
    sharedOverride: false,
  });
});

test("parseOutcome reads DONE/BLOCKED/FAILED", () => {
  assert.equal(parseOutcome("DONE: shipped https://example/pr/1"), "DONE: shipped https://example/pr/1");
  assert.equal(parseOutcome("noise\nFAILED: tests red\nmore"), "FAILED: tests red");
  assert.equal(parseOutcome("still working"), null);
});

test("hasStatusProtocol matches a leading verdict or a standalone line only", () => {
  assert.equal(hasStatusProtocol("DONE: shipped"), true);
  assert.equal(hasStatusProtocol("  blocked: need a token"), true);
  assert.equal(hasStatusProtocol("ACK: on it\n\nFAILED: tests red"), true);
  assert.equal(hasStatusProtocol("done corr=0123456789abcdef: note"), true);
  assert.equal(hasStatusProtocol("still working"), false);
  assert.equal(hasStatusProtocol("I am DONE: almost"), false);
  assert.equal(hasStatusProtocol("needs-decision: pick one"), false);
  assert.equal(hasStatusProtocol(null), false);
});

test("queueGate waits on deps and dates", () => {
  const now = Date.parse("2026-09-18T12:00:00Z");
  const items = [
    { id: "a", status: "queued", blockedBy: [] as string[], waitUntil: null as string | null },
    { id: "b", status: "queued", blockedBy: ["a"], waitUntil: null },
    { id: "c", status: "queued", blockedBy: [], waitUntil: "2026-09-19T00:00:00Z" },
  ];
  assert.equal(queueGate(items[0]!, items, now), null);
  assert.equal(queueGate(items[1]!, items, now), "waiting on a (queued)");
  assert.match(queueGate(items[2]!, items, now) ?? "", /gated until/);
  items[0]!.status = "done";
  assert.equal(queueGate(items[1]!, items, now), null);
});

test("decisionDue treats open as due and deferred as date-gated", () => {
  const now = Date.parse("2026-09-18T12:00:00Z");
  assert.equal(decisionDue({ status: "open", deferredUntil: null }, now), true);
  assert.equal(
    decisionDue({ status: "deferred", deferredUntil: "2026-09-18T11:00:00Z" }, now),
    true,
  );
  assert.equal(
    decisionDue({ status: "deferred", deferredUntil: "2026-09-18T13:00:00Z" }, now),
    false,
  );
});

test("afk holds idle pings; quiet still surfaces failures", () => {
  assert.equal(afkShouldSend("idle"), false);
  assert.equal(afkShouldSend("error"), true);
  assert.equal(afkShouldSend("review"), true);
  assert.equal(afkShouldSend("stuck (30m no output change)"), true);
  assert.equal(quietShouldSend("idle"), false);
  assert.equal(quietShouldSend("error"), true);
  assert.equal(quietShouldSend("review"), true);
});

test("crew prompt asserts isolation and forbids nested dispatch", () => {
  const text = crewPrompt({
    task: "Captain's intent: fix login\nFirstmate spec: one file",
    parentThreadId: "thr_cap",
    shape: "ship",
    mode: "direct-PR",
    isolated: true,
  });
  assert.match(text, /not isolated/);
  assert.match(text, /Do not dispatch other crews/);
  assert.match(text, /DONE:/);
  assert.match(text, /Captain's intent/);
});

test("looksReadOnly hints scout", () => {
  assert.equal(looksReadOnly("audit checkout latency"), true);
  assert.equal(looksReadOnly("fix flaky login test"), false);
});
