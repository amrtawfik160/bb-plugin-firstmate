// Skill-fidelity checker.
//
// Enforces the "copy native, mark every divergence" convention documented in
// CONTRIBUTING.md ("Skill fidelity"). It makes an UNMARKED divergence from the
// pinned native source fail loudly, instead of relying on a reviewer noticing.
//
// A plugin skill re-derived from native carries a machine-parseable `BB-SOURCE`
// header (native path + pinned SHA + a vendored snapshot path). Every place the
// copy departs from native is either:
//   - a `BB-DIVERGE` block whose `native-quote` must resolve verbatim in the
//     pinned native snapshot (the anchor), plus a `bb:` behaviour and a `reason:`, or
//   - a `<!-- BB-ONLY: <reason> -->` … `<!-- /BB-ONLY -->` fence around
//     BB-specific rendered text that has no native source.
// All OTHER rendered prose must appear verbatim (whitespace/markdown-normalized)
// in the pinned native snapshot. Prose that is neither native nor marked fails.
//
// Runs fully offline against the vendored snapshot under native-snapshot/<sha>/,
// so it is safe in `npm test`. Pass `--native <dir>` to additionally prove the
// vendored snapshot still matches a live native clone at the pinned SHA (drift).
//
// CLI:  node --experimental-strip-types scripts/skill-fidelity.ts [--native <dir>]

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

export type Diverge = {
  native: string;
  nativeQuote: string;
  bb: string;
  reason: string;
  line: number;
};

export type Skill = {
  path: string; // repo-relative
  hasFrontmatter: boolean;
  bbSource: { native: string; sha: string; snapshot: string; fidelity: string } | null;
  diverges: Diverge[];
  bbOnly: { reason: string; line: number }[];
  rendered: string; // rendered prose with frontmatter, comments and BB-ONLY fences removed
};

const SKILL_GLOBS = [
  "skills/afk/SKILL.md",
  "skills/bearings/SKILL.md",
  "skills/captain/references/escalation.md",
  "skills/captain/references/ask-user-authority.md",
  "skills/captain/references/diagnostic-reasoning.md",
];

export function normalize(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // md links -> text
    .replace(/[`*_>#]/g, "")
    .replace(/→|->/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    // Drop list scaffolding uniformly (bullets, numbered markers, inline " - "
    // dashes) so wrapping/marker differences between our copy and native's
    // never register as a divergence.
    .replace(/(^|\s)[-*]\s+/g, " ")
    .replace(/(^|\s)\d+\.\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function commentBlocks(content: string): { body: string; index: number }[] {
  const out: { body: string; index: number }[] = [];
  const re = /<!--([\s\S]*?)-->/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.push({ body: m[1], index: m.index });
  return out;
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function field(body: string, key: string): string | null {
  // Matches `key: value` possibly wrapped across continuation lines until the
  // next `word:` field or end of the block.
  const re = new RegExp(`(?:^|\\n)\\s*${key}:\\s*([\\s\\S]*?)(?=\\n\\s*[a-z-]+:\\s|$)`, "i");
  const m = re.exec(body);
  if (!m) return null;
  return m[1].replace(/\s+/g, " ").trim();
}

export function scanSkill(repoRoot: string, rel: string): Skill {
  const content = readFileSync(join(repoRoot, rel), "utf8");
  const hasFrontmatter = /^---\n[\s\S]*?\n---\n/.test(content);

  let bbSource: Skill["bbSource"] = null;
  const diverges: Diverge[] = [];
  const bbOnly: { reason: string; line: number }[] = [];

  for (const { body, index } of commentBlocks(content)) {
    const head = body.trim();
    if (/^BB-SOURCE\b/.test(head)) {
      const native = field(body, "native");
      const sha = field(body, "sha");
      const snapshot = field(body, "snapshot");
      const fidelity = field(body, "fidelity") ?? "adapted";
      if (native && sha && snapshot) bbSource = { native, sha, snapshot, fidelity };
      else bbSource = { native: native ?? "", sha: sha ?? "", snapshot: snapshot ?? "", fidelity };
    } else if (/^BB-DIVERGE\b/.test(head)) {
      diverges.push({
        native: field(body, "native") ?? "",
        nativeQuote: field(body, "native-quote") ?? "",
        bb: field(body, "bb") ?? "",
        reason: field(body, "reason") ?? "",
        line: lineOf(content, index),
      });
    } else if (/^BB-ONLY:/.test(head)) {
      bbOnly.push({ reason: head.replace(/^BB-ONLY:\s*/, "").trim(), line: lineOf(content, index) });
    }
  }

  // Rendered prose = content minus frontmatter, minus BB-ONLY fenced regions,
  // minus every HTML comment, minus headings and list scaffolding.
  let rendered = content.replace(/^---\n[\s\S]*?\n---\n/, "");
  rendered = rendered.replace(/<!--\s*BB-ONLY:[\s\S]*?<!--\s*\/BB-ONLY\s*-->/g, " ");
  rendered = rendered.replace(/<!--[\s\S]*?-->/g, " ");
  rendered = rendered
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .map((l) => l.replace(/^\s*\d+\.\s+/, "").replace(/^\s*[-*]\s+/, ""))
    .join(" ");

  return { path: rel, hasFrontmatter, bbSource, diverges, bbOnly, rendered };
}

export function scanAll(repoRoot: string): Skill[] {
  return SKILL_GLOBS.map((rel) => scanSkill(repoRoot, rel));
}

export type Problem = { skill: string; line?: number; msg: string };

// Offline structural validation — safe in npm test, reads only the skill files.
export function validateStructure(skills: Skill[]): Problem[] {
  const problems: Problem[] = [];
  for (const s of skills) {
    if (!s.bbSource) {
      problems.push({ skill: s.path, msg: "missing BB-SOURCE header (native + sha + snapshot)" });
    } else {
      if (!/^[0-9a-f]{8,40}$/.test(s.bbSource.sha))
        problems.push({ skill: s.path, msg: `BB-SOURCE sha not a hex commit: ${JSON.stringify(s.bbSource.sha)}` });
      if (!s.bbSource.native) problems.push({ skill: s.path, msg: "BB-SOURCE missing native path" });
      if (!s.bbSource.snapshot) problems.push({ skill: s.path, msg: "BB-SOURCE missing snapshot path" });
      if (!["verbatim", "adapted"].includes(s.bbSource.fidelity))
        problems.push({ skill: s.path, msg: `BB-SOURCE fidelity must be verbatim|adapted, got ${s.bbSource.fidelity}` });
    }
    for (const d of s.diverges) {
      for (const [k, v] of [["native", d.native], ["native-quote", d.nativeQuote], ["bb", d.bb], ["reason", d.reason]] as const)
        if (!v) problems.push({ skill: s.path, line: d.line, msg: `BB-DIVERGE missing '${k}:' field` });
    }
    for (const b of s.bbOnly) if (!b.reason) problems.push({ skill: s.path, line: b.line, msg: "BB-ONLY fence missing reason" });
  }
  return problems;
}

// Split rendered prose into substantive sentences for membership checking.
export function sentences(rendered: string): string[] {
  return normalize(rendered)
    .split(/(?<=[.;:])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.replace(/[^a-z]/g, "").length >= 20);
}

// Offline content validation against the vendored snapshot: every non-marked
// rendered sentence must appear in the pinned native source, and every
// BB-DIVERGE native-quote must resolve there.
export function validateAgainstSnapshot(repoRoot: string, skills: Skill[]): Problem[] {
  const problems: Problem[] = [];
  for (const s of skills) {
    if (!s.bbSource) continue;
    const snapPath = join(repoRoot, s.bbSource.snapshot);
    if (!existsSync(snapPath)) {
      problems.push({ skill: s.path, msg: `snapshot not found: ${s.bbSource.snapshot}` });
      continue;
    }
    const nativeBlob = normalize(readFileSync(snapPath, "utf8"));

    for (const d of s.diverges) {
      const q = normalize(d.nativeQuote);
      if (q && !nativeBlob.includes(q))
        problems.push({ skill: s.path, line: d.line, msg: `BB-DIVERGE native-quote does not resolve in ${s.bbSource.snapshot}: ${JSON.stringify(d.nativeQuote.slice(0, 80))}` });
    }

    for (const sent of sentences(s.rendered)) {
      if (!nativeBlob.includes(sent))
        problems.push({ skill: s.path, msg: `unmarked divergence — rendered prose not in native, and not inside a BB-ONLY fence or BB-DIVERGE: ${JSON.stringify(sent.slice(0, 90))}` });
    }
  }
  return problems;
}

// Opt-in: prove the vendored snapshot still matches a live native clone at the
// pinned SHA. Flags a snapshot (and therefore every anchor resting on it) that
// no longer resolves after a native bump.
export function validateSnapshotFreshness(repoRoot: string, skills: Skill[], nativeDir: string): Problem[] {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  for (const s of skills) {
    if (!s.bbSource) continue;
    const key = `${s.bbSource.sha}::${s.bbSource.snapshot}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const snap = readFileSync(join(repoRoot, s.bbSource.snapshot), "utf8");
    // The snapshot is either a whole native file or a contiguous slice of one.
    const nativePathGuess = s.bbSource.native.replace(/\s*§.*$/, "").trim();
    let live: string;
    try {
      live = execFileSync("git", ["-C", nativeDir, "show", `${s.bbSource.sha}:${nativePathGuess}`], { encoding: "utf8" });
    } catch (e) {
      problems.push({ skill: s.path, msg: `cannot read native ${nativePathGuess}@${s.bbSource.sha} in ${nativeDir}: ${(e as Error).message.split("\n")[0]}` });
      continue;
    }
    if (!normalize(live).includes(normalize(snap)))
      problems.push({ skill: s.path, msg: `vendored snapshot ${s.bbSource.snapshot} no longer matches native ${nativePathGuess}@${s.bbSource.sha} — re-vendor and bump the pin` });
  }
  return problems;
}

function repoRootFromHere(): string {
  return dirname(dirname(new URL(import.meta.url).pathname));
}

export function runOffline(repoRoot: string): Problem[] {
  const skills = scanAll(repoRoot);
  return [...validateStructure(skills), ...validateAgainstSnapshot(repoRoot, skills)];
}

function main(): void {
  const repoRoot = repoRootFromHere();
  const skills = scanAll(repoRoot);
  const problems = [...validateStructure(skills), ...validateAgainstSnapshot(repoRoot, skills)];

  const nativeFlag = process.argv.indexOf("--native");
  if (nativeFlag !== -1) {
    const dir = process.argv[nativeFlag + 1];
    if (!dir || !existsSync(dir) || !statSync(dir).isDirectory()) {
      console.error(`--native given but ${dir} is not a directory`);
      process.exit(2);
    }
    problems.push(...validateSnapshotFreshness(repoRoot, skills, dir));
  }

  if (problems.length === 0) {
    console.log(`skill-fidelity: OK — ${skills.length} skills, ${skills.reduce((n, s) => n + s.diverges.length, 0)} BB-DIVERGE anchors resolved${nativeFlag !== -1 ? ", snapshot fresh vs native" : ""}.`);
    return;
  }
  console.error(`skill-fidelity: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p.skill}${p.line ? `:${p.line}` : ""} — ${p.msg}`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
