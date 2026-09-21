import assert from "node:assert/strict";
import test from "node:test";
import {
  afkShouldSend,
  capPermission,
  crewPrompt,
  decisionDue,
  foldOpenDecisions,
  hasStatusProtocol,
  latestStatus,
  looksReadOnly,
  mergeGate,
  parseOutcome,
  queueGate,
  quietShouldSend,
  resolveWorktree,
  statusLinesFrom,
  statusProtocolSummary,
  toReasoningLevel,
  verdictOf,
  verdictMarker,
  idleVerdictPresentation,
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

// ── Full status protocol fold (mirrors fm-classify-lib.sh) ────────────────────

test("foldOpenDecisions matches fm-classify-lib: keyed open/close, corr, reserved keys", () => {
  const stream = [
    "working: starting",
    "needs-decision [key=api-shape]: rename or keep?",
    "working: still going",
    "needs-decision: [key=db] pick postgres or sqlite",
    "blocked corr=0123456789abcdef [key=creds]: need token",
    "done: finished",
    "resolved [key=db] we chose sqlite", // note-head/no-colon closer for db
    "needs-decision: bare default question",
    "paused: waiting",
    "needs-decision [key=bad slug]: malformed slug is skipped",
    "blocked [key=pending-reply-7]: hijack attempt", // reserved key, wrong vocab -> ignored
    "blocked [key=pending-reply-8]: pending-reply-8: real owner note", // reserved, own vocab -> opens
  ];
  const open = foldOpenDecisions(stream);
  assert.deepEqual(open, [
    { key: "api-shape", verb: "needs-decision", note: "rename or keep?" },
    { key: "creds", verb: "blocked", note: "need token" },
    { key: "default", verb: "needs-decision", note: "bare default question" },
    { key: "pending-reply-8", verb: "blocked", note: "pending-reply-8: real owner note" },
  ]);
});

test("a later done/working never masks a still-open needs-decision", () => {
  const open = foldOpenDecisions([
    "needs-decision [key=x]: pick one",
    "working: kept going",
    "done: shipped part",
  ]);
  assert.deepEqual(open, [{ key: "x", verb: "needs-decision", note: "pick one" }]);
});

test("a bare resolved closes a bare needs-decision (default key)", () => {
  assert.deepEqual(foldOpenDecisions(["needs-decision: hmm", "resolved: done"]), []);
});

test("latestStatus returns the last recognized verb, ignoring prose", () => {
  assert.deepEqual(latestStatus(["working: a", "just chatting here", "paused: waiting on CI"]), {
    verb: "paused",
    note: "waiting on CI",
  });
  assert.equal(latestStatus(["no status at all", "still prose"]), null);
});

test("statusLinesFrom pulls only protocol lines out of chat output", () => {
  const lines = statusLinesFrom("Some narration.\nworking: building\nmore prose\nDONE: shipped");
  assert.deepEqual(lines, ["working: building", "DONE: shipped"]);
});

test("statusProtocolSummary reports state and open decisions, null when absent", () => {
  const summary = statusProtocolSummary(["needs-decision [key=k]: choose", "working: meanwhile"]);
  assert.match(summary!, /state: working/);
  assert.match(summary!, /open needs-decision \[k\]: choose/);
  assert.equal(statusProtocolSummary(["nothing to see"]), null);
});

test("verdictOf reads the terminal tag from a parsed outcome", () => {
  assert.equal(verdictOf(parseOutcome("DONE: shipped")), "DONE");
  assert.equal(verdictOf(parseOutcome("BLOCKED: need a remote")), "BLOCKED");
  assert.equal(verdictOf(parseOutcome("FAILED: contradictory reqs")), "FAILED");
  assert.equal(verdictOf(null), null);
  assert.equal(verdictOf(parseOutcome("just prose, no verdict")), null);
});

test("idleVerdictPresentation: BLOCKED/FAILED never render as done and never offer deliver", () => {
  const done = idleVerdictPresentation("c1", "DONE");
  assert.equal(done.head, "✅ crew c1 done");
  assert.match(done.next, /deliver c1/);

  const blocked = idleVerdictPresentation("c1", "BLOCKED");
  assert.equal(blocked.head, "🚧 crew c1 blocked");
  assert.doesNotMatch(blocked.head, /done/);
  assert.doesNotMatch(blocked.next, /deliver/);
  assert.match(blocked.next, /tell\|retry\|forget c1/);

  const failed = idleVerdictPresentation("c1", "FAILED");
  assert.equal(failed.head, "❌ crew c1 failed");
  assert.doesNotMatch(failed.head, /done/);
  assert.doesNotMatch(failed.next, /deliver/);
  assert.match(failed.next, /retry\|tell\|forget c1/);

  // A verdict-less idle keeps the prior done/deliver shape.
  const unknown = idleVerdictPresentation("c1", null);
  assert.equal(unknown.head, "✅ crew c1 done");
  assert.match(unknown.next, /deliver c1/);
});

test("verdictMarker gives a distinct glyph per verdict", () => {
  assert.equal(verdictMarker("DONE"), "✅ DONE");
  assert.equal(verdictMarker("BLOCKED"), "🚧 BLOCKED");
  assert.equal(verdictMarker("FAILED"), "❌ FAILED");
});
