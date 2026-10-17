import assert from "node:assert/strict";
import test from "node:test";
import { captainMessage, redoneWork, renderScorecard, telegramNoise, type ScorecardData } from "./scorecard.ts";

const since = Date.parse("2026-10-11T19:00:00.000Z");
const until = Date.parse("2026-10-18T19:00:00.000Z");

const FIXTURE: ScorecardData = {
  since: "2026-10-11T19:00:00.000Z",
  until: "2026-10-18T19:00:00.000Z",
  corrections: [
    { id: "C4", ref: "tg:985:4410", at: "2026-10-13T08:00:00.000Z", fixed: true },
    { id: "C5", ref: "tg:985:4502", at: "2026-10-15T08:00:00.000Z", fixed: false },
  ],
  redone: [{ task: "T12", title: "Safi login fix", extraCrews: 2 }],
  checkerFails: [{ pr: "amrtawfik160/safi#88", at: "2026-10-14T08:00:00.000Z", model: "gpt-6-astra" }],
  unproven: [{ pr: "amrtawfik160/safi#88", crew: "a1b2c3d4", at: "2026-10-14T07:00:00.000Z" }, { pr: "amrtawfik160/areliaa#12", crew: "e5f6a7b8", at: "2026-10-16T07:00:00.000Z" }],
  telegram: { sent: 412, failed: 3, baseline: false },
};

test("the scorecard renders each count on its own line, with its unit and its source", () => {
  const text = renderScorecard(FIXTURE);
  assert.deepEqual(text.split("\n"), [
    "🛠 Hanoon & tools · Weekly scorecard, 11 Oct to 18 Oct",
    "Owner corrections: 2 corrections. 1 is fixed. Source: corrections ledger.",
    "Redone work: 2 extra crews on 1 owner task. Source: owner task records.",
    "Checker findings: 1 fail verdict on 1 PR. Source: checker verdicts.",
    "Done claims without proof: 2 refused proofs on 2 PRs. Source: proof gate.",
    "Noise: 412 Telegram messages sent. 3 failed or not confirmed. Source: Telegram connector status.",
  ]);
});

test("an empty week says zero, and a first run says it has no earlier Telegram count", () => {
  const text = renderScorecard({ ...FIXTURE, corrections: [], redone: [], checkerFails: [], unproven: [], telegram: { sent: 2594, failed: 15, baseline: true } });
  assert.match(text, /Owner corrections: 0 corrections\. Source/);
  assert.match(text, /Redone work: 0 extra crews\. Source/);
  assert.match(text, /Noise: no earlier count, so no weekly number yet\. Totals so far: 2594 sent, 15 failed or not confirmed\./);
  const unread = renderScorecard({ ...FIXTURE, telegram: null });
  assert.match(unread, /Noise: not read\. bb telegram status failed\./);
  const { telegram: _, ...firstmateOnly } = FIXTURE;
  assert.equal(renderScorecard(firstmateOnly).split("\n").length, 5, "the Firstmate command alone leaves the Telegram line out");
});

test("redone work counts the extra crews an owner task got this week; checkers are not redone work", () => {
  const crews = [
    { id: "a", createdAt: "2026-10-05T00:00:00.000Z" },
    { id: "b", createdAt: "2026-10-12T00:00:00.000Z" },
    { id: "c", createdAt: "2026-10-13T00:00:00.000Z", role: "checker" },
    { id: "d", createdAt: "2026-10-14T00:00:00.000Z" },
    { id: "e", createdAt: "2026-10-14T00:00:00.000Z" },
  ];
  const tasks = [
    { id: "T1", title: "Login fix", crewIds: ["a", "b", "c"] },
    { id: "T2", title: "One crew", crewIds: ["d"] },
    { id: "T3", title: "Unknown crew", crewIds: ["zz", "e"] },
  ];
  assert.deepEqual(redoneWork(tasks, crews, since, until), [{ task: "T1", title: "Login fix", extraCrews: 1 }]);
});

test("Telegram noise is the change since the last weekly snapshot", () => {
  const status = { inbox: { delivered: 900, failed: 2 }, outbox: { sent: 3000, uncertain: 14 } };
  assert.deepEqual(telegramNoise(status, { sent: 2594, failed: 15 }), { now: { sent: 3000, failed: 16 }, week: { sent: 406, failed: 1, baseline: false } });
  assert.deepEqual(telegramNoise(status, undefined), { now: { sent: 3000, failed: 16 }, week: { sent: 3000, failed: 16, baseline: true } });
});

test("the captain gets the scorecard to post unchanged, then the reflect crew to dispatch", () => {
  const message = captainMessage(renderScorecard(FIXTURE), FIXTURE, { home: "/homes/cap", project: "proj_example01", captain: "thr_cap" });
  const lines = message.split("\n");
  assert.match(lines[0], /^Weekly scorecard and reflect/);
  assert.match(message, /1\. Post the scorecard below to the owner unchanged, as its own message, in the Hanoon & tools project topic\./);
  assert.match(message, /2\. Dispatch the weekly reflect crew: firstmate_dispatch projectId=proj_example01 role=builder playbook=none title="Weekly reflect 18 Oct"/);
  assert.match(message, /3\. When it finishes, send the owner its CHANGELOG lines/);
  assert.ok(message.includes(renderScorecard(FIXTURE)));
  for (const want of ["pstack `reflect`", "bb firstmate corrections list --since 2026-10-11T19:00:00.000Z", "bb firstmate scorecard --captain thr_cap --since 2026-10-11T19:00:00.000Z --until 2026-10-18T19:00:00.000Z --json", "/homes/cap/data/captain.md", "CHANGELOG: "]) assert.ok(message.includes(want), want);
});
