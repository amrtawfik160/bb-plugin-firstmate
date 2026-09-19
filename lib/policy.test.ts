import assert from "node:assert/strict";
import test from "node:test";
import {
  afkShouldSend,
  capPermission,
  crewPrompt,
  decisionDue,
  hasStatusProtocol,
  looksReadOnly,
  mergeGate,
  parseOutcome,
  queueGate,
  quietShouldSend,
  resolveWorktree,
  toReasoningLevel,
} from "./policy.ts";

test("toReasoningLevel accepts the dispatch-profile scale only", () => {
  for (const level of ["low", "medium", "high", "xhigh", "max"]) {
    assert.equal(toReasoningLevel(level), level);
  }
  assert.equal(toReasoningLevel("ultra"), undefined);
  assert.equal(toReasoningLevel("none"), undefined);
  assert.equal(toReasoningLevel(""), undefined);
  assert.equal(toReasoningLevel(undefined), undefined);
});

const GREEN = { prState: "open", mergeable: "MERGEABLE", failed: 0, pending: 0 } as const;

test("mergeGate treats zero checks (no_checks) as no failing checks", () => {
  const gate = mergeGate({ ...GREEN, checksState: "no_checks" });
  assert.deepEqual(gate, { ok: true, waived: [] });
});

test("mergeGate lands a green passing PR", () => {
  assert.deepEqual(mergeGate({ ...GREEN, checksState: "passing" }), { ok: true, waived: [] });
});

test("mergeGate refuses pending and unknown checks", () => {
  assert.equal(mergeGate({ ...GREEN, checksState: "pending", pending: 2 }).ok, false);
  assert.equal(mergeGate({ ...GREEN, checksState: "unknown" }).ok, false);
});

test("mergeGate refuses a non-open PR and an unmergeable one", () => {
  assert.equal(mergeGate({ ...GREEN, checksState: "passing", prState: "closed" }).ok, false);
  assert.equal(mergeGate({ ...GREEN, checksState: "passing", mergeable: "CONFLICTING" }).ok, false);
});

test("mergeGate refuses failing checks without a waiver", () => {
  const gate = mergeGate({ ...GREEN, checksState: "failing", failed: 1 });
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.reason, /allowRedCheck/);
});

test("mergeGate waives one exact red check when every other check is green", () => {
  const gate = mergeGate({
    ...GREEN,
    checksState: "failing",
    failed: 1,
    allowRedCheck: "flaky-e2e",
    redChecks: ["flaky-e2e"],
  });
  assert.deepEqual(gate, { ok: true, waived: ["flaky-e2e"] });
});

test("mergeGate refuses when the waiver leaves another red check", () => {
  const gate = mergeGate({
    ...GREEN,
    checksState: "failing",
    failed: 2,
    allowRedCheck: "flaky-e2e",
    redChecks: ["flaky-e2e", "typecheck"],
  });
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.reason, /typecheck/);
});

test("mergeGate refuses a waiver that names no failing check", () => {
  const gate = mergeGate({
    ...GREEN,
    checksState: "failing",
    failed: 1,
    allowRedCheck: "wrong-name",
    redChecks: ["flaky-e2e"],
  });
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.reason, /names no failing check/);
});

test("mergeGate never waives silently: an unreadable red set refuses", () => {
  const gate = mergeGate({
    ...GREEN,
    checksState: "failing",
    failed: 1,
    allowRedCheck: "flaky-e2e",
    redChecks: null,
  });
  assert.equal(gate.ok, false);
  if (!gate.ok) assert.match(gate.reason, /cannot read/);
});

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
