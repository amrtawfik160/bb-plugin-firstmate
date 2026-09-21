import { test } from "node:test";
import assert from "node:assert/strict";
import {
  scanAll,
  runOffline,
  validateStructure,
  validateAgainstSnapshot,
  normalize,
  sentences,
  type Skill,
} from "./skill-fidelity.ts";

const ROOT = process.cwd();

test("every re-derived skill passes the offline fidelity check (no unmarked divergence)", () => {
  const problems = runOffline(ROOT);
  assert.deepEqual(
    problems,
    [],
    problems.map((p) => `${p.skill}${p.line ? `:${p.line}` : ""} — ${p.msg}`).join("\n"),
  );
});

test("each skill carries a BB-SOURCE header pinning a native path + SHA + snapshot", () => {
  for (const s of scanAll(ROOT)) {
    assert.ok(s.bbSource, `${s.path} missing BB-SOURCE`);
    assert.match(s.bbSource!.sha, /^[0-9a-f]{8,40}$/, `${s.path} bad sha`);
    assert.ok(s.bbSource!.native, `${s.path} missing native path`);
    assert.ok(s.bbSource!.snapshot, `${s.path} missing snapshot path`);
  }
});

test("every BB-DIVERGE anchor resolves verbatim in its pinned native snapshot", () => {
  // validateAgainstSnapshot fails a marker whose native-quote is not present.
  const problems = validateAgainstSnapshot(ROOT, scanAll(ROOT)).filter((p) => /native-quote/.test(p.msg));
  assert.deepEqual(problems, [], problems.map((p) => p.msg).join("\n"));
});

test("structural check fails a malformed marker", () => {
  const bad: Skill = {
    path: "fake/SKILL.md",
    hasFrontmatter: false,
    bbSource: { native: "", sha: "nothex", snapshot: "", fidelity: "sideways" },
    diverges: [{ native: "x", nativeQuote: "", bb: "y", reason: "", line: 3 }],
    bbOnly: [{ reason: "", line: 9 }],
    rendered: "",
  };
  const problems = validateStructure([bad]);
  const msgs = problems.map((p) => p.msg).join(" | ");
  assert.match(msgs, /sha not a hex commit/);
  assert.match(msgs, /missing native path/);
  assert.match(msgs, /missing snapshot path/);
  assert.match(msgs, /fidelity must be verbatim\|adapted/);
  assert.match(msgs, /native-quote:' field/);
  assert.match(msgs, /reason:' field/);
  assert.match(msgs, /BB-ONLY fence missing reason/);
});

test("content check flags rendered prose that is not in native and not marked", () => {
  const real = scanAll(ROOT).find((s) => s.path.endsWith("bearings/SKILL.md"))!;
  const mutated: Skill = {
    ...real,
    rendered: "This sentence about pineapples is definitely not present in native firstmate anywhere.",
    diverges: [],
  };
  const problems = validateAgainstSnapshot(ROOT, [mutated]);
  assert.ok(problems.some((p) => /unmarked divergence/.test(p.msg)), "expected an unmarked-divergence problem");
});

test("normalizer makes wrapping, bullets and arrow spelling irrelevant", () => {
  assert.equal(normalize("- teardown -> cleanup."), normalize("teardown → cleanup."));
  assert.equal(normalize("a\nb   c"), "a b c");
});

test("sentence splitter drops short structural fragments", () => {
  assert.deepEqual(sentences("Yes. No."), []); // both too short
  assert.ok(sentences("This is a sufficiently long policy sentence to be checked for membership.").length === 1);
});
