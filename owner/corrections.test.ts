import assert from "node:assert/strict";
import test from "node:test";
import { addCorrection, CAPTAIN_MAX_RULES, CORRECTION_RULE, correctionBrief, fixCorrection, readLedger, within } from "./corrections.ts";

const at = (d: string) => `2026-10-${d}T10:00:00.000Z`;

test("each owner correction gets one ledger row with the date and the owner's words ref", () => {
  const first = addCorrection("", { ref: "tg:985:4410", words: "You sent me the PR list again without links.", at: at("13") });
  assert.equal(first.added, true);
  assert.equal(first.correction.id, "C1");
  const second = addCorrection(first.text, { ref: "tg:985:4502", words: "Same mistake as Monday.", at: at("15") });
  assert.equal(second.correction.id, "C2");
  const again = addCorrection(second.text, { ref: "tg:985:4410", words: "You sent me the PR list again without links.", at: at("16") });
  assert.equal(again.added, false, "the same owner message is one correction");
  assert.equal(again.text, second.text);
  assert.deepEqual(readLedger(second.text).map((c) => [c.id, c.ref, c.at]), [["C1", "tg:985:4410", at("13")], ["C2", "tg:985:4502", at("15")]]);
});

test("a fix records the fix ref and a one-line changelog", () => {
  const { text } = addCorrection("", { ref: "tg:985:4410", words: "No links again.", at: at("13") });
  const fixed = fixCorrection(text, { id: "C1", ref: "https://github.com/o/r/pull/12", changelog: "PR lists now always carry their links.", at: at("14") }, "rule\n");
  const [row] = readLedger(fixed);
  assert.deepEqual(row.fix, { ref: "https://github.com/o/r/pull/12", changelog: "PR lists now always carry their links.", at: at("14") });
  assert.throws(() => fixCorrection(text, { id: "C9", ref: "x", changelog: "y", at: at("14") }, ""), /Unknown correction C9/);
  assert.throws(() => fixCorrection(text, { id: "C1", ref: "x", changelog: "one\ntwo", at: at("14") }, ""), /one line/);
  assert.throws(() => fixCorrection(text, { id: "C1", ref: "", changelog: "y", at: at("14") }, ""), /--fix/);
});

test("captain.md stays short: a fix is refused while it has more rules than the limit", () => {
  const { text } = addCorrection("", { ref: "tg:1:1", words: "w", at: at("13") });
  const long = Array.from({ length: CAPTAIN_MAX_RULES + 1 }, (_, i) => `Rule ${i}.`).join("\n\n");
  assert.throws(() => fixCorrection(text, { id: "C1", ref: "data/captain.md", changelog: "c", at: at("14") }, long), /data\/captain\.archive\.md/);
  const short = Array.from({ length: CAPTAIN_MAX_RULES }, (_, i) => `Rule ${i}.`).join("\n");
  assert.doesNotThrow(() => fixCorrection(text, { id: "C1", ref: "data/captain.md", changelog: "c", at: at("14") }, short));
});

test("the crew brief asks for the smallest structural fix with pstack correct", () => {
  const { correction } = addCorrection("", { ref: "tg:985:4410", words: "You merged without asking.", at: at("13") });
  const brief = correctionBrief(correction, "/homes/cap");
  for (const want of ["`correct`", "principle-encode-lessons-in-structure", "You merged without asking.", "tg:985:4410", "/homes/cap/data/captain.md", "/homes/cap/data/captain.archive.md", "FIX: ", "CHANGELOG: "]) assert.ok(brief.includes(want), want);
  assert.match(brief, /check.*tool refusal.*skill edit.*captain\.md rule/s);
});

test("the captain rule is short and points to the full rules", () => {
  assert.ok(CORRECTION_RULE.length < 200, `${CORRECTION_RULE.length} characters`);
  assert.match(CORRECTION_RULE, /references\/corrections\.md/);
});

test("a week window keeps rows from since up to until", () => {
  let text = "";
  for (const [d, ref] of [["09", "a"], ["12", "b"], ["18", "c"]]) text = addCorrection(text, { ref, words: "w", at: at(d) }).text;
  assert.deepEqual(within(readLedger(text), Date.parse(at("11")), Date.parse(at("18"))).map((c) => c.ref), ["b"]);
});
