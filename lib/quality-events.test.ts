import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createQualityEvents } from "./quality-events.ts";

const DAY = 86_400_000;
const T0 = Date.parse("2026-10-12T00:00:00.000Z");

test("redo is a crew started on an owner task after an earlier crew of the same role on it ended; parallel, staged and checker crews are not", () => {
  const q = createQualityEvents(new DatabaseSync(":memory:"));
  const crew = (id: string, role: string, shape: string, at: number) => q.noteTaskCrew({ captain: "thr_cap", task: "T1", title: "Login fix", crew: id, role, shape, at });
  assert.equal(crew("look", "lookup", "scout", T0), null);
  q.noteCrewEnded({ captain: "thr_cap", crew: "look", outcome: "DONE: found it", at: T0 + 1 });
  assert.equal(crew("build1", "builder", "ship", T0 + 2), null, "a builder after a lookup ended is a staged step");
  assert.equal(crew("api", "builder", "ship", T0 + 3), null, "a parallel builder while build1 runs is not a redo");
  assert.equal(crew("chk", "checker", "ship", T0 + 4), null);
  q.noteCrewEnded({ captain: "thr_cap", crew: "build1", outcome: "FAILED: tests red", at: T0 + 5 });
  q.noteCrewEnded({ captain: "thr_cap", crew: "build1", outcome: "retired", at: T0 + 6 });
  assert.equal(crew("chk2", "checker", "ship", T0 + 7), null, "a checker after a builder ended checks; it redoes nothing");
  const redo = crew("build2", "builder", "ship", T0 + 8);
  assert.deepEqual(redo, { task: "T1", title: "Login fix", crew: "build2", role: "builder", shape: "ship", after: ["build1"], reason: "started on owner task T1 after builder crew build1 ended (FAILED: tests red)" });
  assert.equal(crew("build2", "builder", "ship", T0 + 9), null, "the same crew attached again is not a new redo");
  const week = q.week(T0, T0 + DAY, "thr_cap");
  assert.deepEqual(week.redone.map((r) => [r.task, r.crew]), [["T1", "build2"]]);
  assert.deepEqual(q.week(T0, T0 + DAY, "thr_other").redone, []);
});

test("a done claim without proof counts once per crew run, from the done check or the verify gate", () => {
  const q = createQualityEvents(new DatabaseSync(":memory:"));
  q.noteUnproven({ captain: "thr_cap", crew: "c1", run: "thr_a", pr: null, gap: "missing", at: T0 });
  q.noteUnproven({ captain: "thr_cap", crew: "c1", run: "thr_a", pr: "o/r#5", gap: "pending", at: T0 + 1 });
  q.noteUnproven({ captain: "thr_cap", crew: "c1", run: "thr_a", pr: "o/r#5", gap: "pending", at: T0 + 2 });
  q.noteUnproven({ captain: "thr_cap", crew: "c1", run: "thr_b", pr: "o/r#5", gap: "missing", at: T0 + 3 });
  q.noteUnproven({ captain: "thr_cap", crew: "c2", run: "thr_c", pr: null, gap: "missing", at: T0 + 4 });
  const week = q.week(T0, T0 + DAY, "thr_cap");
  assert.deepEqual(week.unproven.map((u) => [u.crew, u.run]), [["c1", "thr_a"], ["c1", "thr_b"], ["c2", "thr_c"]]);
});

test("every checker verdict in the week is kept, with its finding count and notes, beyond any per-PR cap", () => {
  const q = createQualityEvents(new DatabaseSync(":memory:"));
  for (let i = 0; i < 25; i++) q.noteCheck({ captain: "thr_cap", pr: "o/r#5", commitSha: `${i}`.padStart(40, "0"), crew: "chk", model: "gpt-6-astra", verdict: "fail", findings: 2, notes: `1. a\n2. b ${i}`, at: T0 + i });
  q.noteCheck({ captain: "thr_cap", pr: "o/r#5", commitSha: "0".repeat(40), crew: "chk", model: "gpt-6-astra", verdict: "fail", findings: 2, notes: "again", at: T0 + 30 });
  q.noteCheck({ captain: "thr_cap", pr: "o/r#6", commitSha: "f".repeat(40), crew: "chk", model: "gpt-6-astra", verdict: "pass", findings: null, notes: "ok", at: T0 + 31 });
  q.noteCheck({ captain: "thr_cap", pr: "o/r#7", commitSha: "e".repeat(40), crew: "chk", model: "gpt-6-astra", verdict: "fail", findings: null, notes: "1. c", at: T0 + 32 });
  const week = q.week(T0, T0 + DAY, "thr_cap");
  assert.equal(week.checks.filter((c) => c.verdict === "fail").length, 26, "the same crew at the same head is one verdict");
  assert.equal(week.checks.filter((c) => c.verdict === "pass").length, 1);
  assert.equal(week.checks.find((c) => c.pr === "o/r#7")!.findings, null);
  assert.match(week.checks[0].notes, /1\. a/);
  assert.deepEqual(q.week(T0 + DAY, T0 + 2 * DAY, "thr_cap"), { redone: [], unproven: [], checks: [] });
});
