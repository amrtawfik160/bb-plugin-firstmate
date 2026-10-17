import assert from "node:assert/strict";
import test from "node:test";
import { captainMessage, renderScorecard, scheduledWeek, telegramWeek, type ScorecardData } from "./scorecard.ts";

const since = Date.parse("2026-10-11T18:00:00.000Z");
const until = Date.parse("2026-10-18T18:00:00.000Z");

const FIXTURE: ScorecardData = {
  since: "2026-10-11T18:00:00.000Z",
  until: "2026-10-18T18:00:00.000Z",
  corrections: [
    { id: "C4", ref: "tg:985:4410", at: "2026-10-13T08:00:00.000Z", fixed: true },
    { id: "C5", ref: "tg:985:4502", at: "2026-10-15T08:00:00.000Z", fixed: false },
  ],
  redone: [{ task: "T12", title: "Safi login fix", crew: "b2", role: "builder", shape: "ship", after: ["b1"], reason: "started on owner task T12 after builder crew b1 ended (FAILED)", at: "2026-10-14T08:00:00.000Z" }],
  checks: [
    { pr: "amrtawfik160/safi#88", commitSha: "a", crew: "chk", model: "gpt-6-astra", verdict: "fail", findings: 3, notes: "1. x\n2. y\n3. z", at: "2026-10-14T08:00:00.000Z" },
    { pr: "amrtawfik160/safi#88", commitSha: "b", crew: "chk", model: "gpt-6-astra", verdict: "pass", findings: 0, notes: "ok", at: "2026-10-15T08:00:00.000Z" },
  ],
  unproven: [{ crew: "a1b2c3d4", run: "thr_a", pr: "amrtawfik160/safi#88", gap: "pending", at: "2026-10-14T07:00:00.000Z" }, { crew: "e5f6a7b8", run: "thr_b", pr: null, gap: "missing", at: "2026-10-16T07:00:00.000Z" }],
  telegram: { sent: 412, notDelivered: 3, queued: 1 },
};

test("the scorecard renders each count on its own line, with its unit and its source", () => {
  assert.deepEqual(renderScorecard(FIXTURE).split("\n"), [
    "🛠 Hanoon & tools · Weekly scorecard, 11 Oct to 18 Oct",
    "Owner corrections: 2 corrections. 1 is fixed. Source: corrections ledger.",
    "Redone work: 1 crew started on 1 owner task after an earlier crew of the same role on it ended. Source: re-dispatch records.",
    "Checker findings: 3 findings in 1 fail verdict on 1 PR. Source: checker verdicts.",
    "Done claims without proof: 2 claims by 2 crews. Source: proof checks.",
    "Noise: 412 Telegram messages sent. 3 not delivered. 1 still queued. Drops are not readable from the CLI. Source: Telegram connector records.",
  ]);
});

test("a fail verdict without a finding count is named, not counted as zero findings", () => {
  const text = renderScorecard({ ...FIXTURE, checks: [...FIXTURE.checks, { ...FIXTURE.checks[0], pr: "o/r#9", findings: null }] });
  assert.match(text, /Checker findings: 3 findings in 2 fail verdicts on 2 PRs; 1 verdict gave no finding count\. Source: checker verdicts\./);
});

test("an empty week says zero, and an unreadable or incomplete Telegram record says so", () => {
  const text = renderScorecard({ ...FIXTURE, corrections: [], redone: [], checks: [], unproven: [], telegram: { unavailable: "rows before 12 Oct are no longer kept" } });
  assert.match(text, /Owner corrections: 0 corrections\. Source/);
  assert.match(text, /Redone work: 0 crews started on an owner task after an earlier crew of the same role on it ended\. Source/);
  assert.match(text, /Checker findings: 0 fail verdicts\. Source/);
  assert.match(text, /Noise: not available \(rows before 12 Oct are no longer kept\)\./);
  const { telegram: _, ...firstmateOnly } = FIXTURE;
  assert.equal(renderScorecard(firstmateOnly).split("\n").length, 5, "the Firstmate command alone leaves the Telegram line out");
});

test("Telegram noise counts the connector's records created in the week, not its pruned totals", () => {
  const row = (at: string, state: string) => ({ created_at: Date.parse(at), state });
  const rows = [row("2026-10-10T00:00:00Z", "sent"), row("2026-10-12T00:00:00Z", "sent"), row("2026-10-13T00:00:00Z", "sent"), row("2026-10-14T00:00:00Z", "failed"), row("2026-10-15T00:00:00Z", "uncertain"), row("2026-10-18T17:00:00Z", "pending"), row("2026-10-19T00:00:00Z", "sent")];
  assert.deepEqual(telegramWeek(rows, Date.parse("2026-10-01T00:00:00Z"), since, until), { sent: 2, notDelivered: 2, queued: 1 });
  assert.deepEqual(telegramWeek(rows.slice(1), Date.parse("2026-10-12T00:00:00Z"), since, until), { unavailable: "the connector keeps records only from 12 Oct, after the week began" });
});

test("the scheduled week is the Sunday 21:00 Cairo run on or before now, so a Monday retry is the same week", () => {
  const sunday = scheduledWeek(Date.parse("2026-10-18T18:00:00.000Z"));
  assert.deepEqual(sunday, { key: "2026-10-18", since: Date.parse("2026-10-11T18:00:00.000Z"), until: Date.parse("2026-10-18T18:00:00.000Z") });
  assert.deepEqual(scheduledWeek(Date.parse("2026-10-19T09:00:00.000Z")), sunday);
  assert.equal(scheduledWeek(Date.parse("2026-10-18T17:59:00.000Z")).key, "2026-10-11");
  assert.equal(scheduledWeek(Date.parse("2026-11-08T19:00:00.000Z")).until, Date.parse("2026-11-08T19:00:00.000Z"), "Cairo winter time is UTC+2");
});

test("the captain gets the scorecard to post unchanged, then the reflect crew, which reads the captain's own ledger", () => {
  const message = captainMessage(renderScorecard(FIXTURE), FIXTURE, { home: "/homes/cap", project: "proj_example01", captain: "thr_cap", marker: "[weekly-scorecard 2026-10-18 op1]" });
  assert.match(message.split("\n")[0], /^\[weekly-scorecard 2026-10-18 op1\]$/);
  assert.match(message, /1\. Post the scorecard below to the owner unchanged, as its own message, in the Hanoon & tools project topic\./);
  assert.match(message, /2\. Dispatch the weekly reflect crew: firstmate_dispatch projectId=proj_example01 role=builder playbook=none title="Weekly reflect 18 Oct"/);
  assert.ok(message.includes(renderScorecard(FIXTURE)));
  for (const want of ["pstack `reflect`", "bb firstmate corrections list --captain thr_cap --since 2026-10-11T18:00:00.000Z --until 2026-10-18T18:00:00.000Z --json", "bb firstmate scorecard --captain thr_cap --since 2026-10-11T18:00:00.000Z --until 2026-10-18T18:00:00.000Z --json", "/homes/cap/data/captain.md", "CHANGELOG: "]) assert.ok(message.includes(want), want);
});
