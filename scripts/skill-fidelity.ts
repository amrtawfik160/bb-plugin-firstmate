// Skill-fidelity checker.
//
// Enforces the "copy native, mark every divergence" convention documented in
// CONTRIBUTING.md ("Skill fidelity"). It makes an UNMARKED divergence from the
// pinned native source fail loudly, and it constrains the two markers so neither
// can shelter a rewrite.
//
// A plugin skill re-derived from native carries a machine-parseable `BB-SOURCE`
// header (native path + pinned SHA + a vendored snapshot path). Every place the
// copy departs from native is either:
//   - a `BB-DIVERGE` block whose `native-quote` must resolve verbatim in the
//     pinned native snapshot (the anchor), plus a `bb:` behaviour and a `reason:`, or
//   - a `<!-- BB-ONLY: <reason> -->` … `<!-- /BB-ONLY -->` fence around
//     BB-specific rendered text.
//
// Invariants (see CONTRIBUTING.md for the honest limits):
//   1. Every rendered sentence OUTSIDE a fence must appear verbatim
//      (whitespace/markdown-normalized) in the pinned snapshot.
//   2. A `BB-ONLY` fence may not shelter native-derived or free prose:
//        - reason must be structured and non-empty,
//        - it is size-bounded (1..MAX_FENCE_SENTENCES sentences),
//        - NO sentence in it may resolve verbatim in native (that is over-fencing
//          — un-fence it so it is checked), and
//        - EVERY sentence in it must carry a BB allow-list token (a real BB tool /
//          command / identifier), so a fabricated policy sentence cannot hide here.
//   3. A `BB-ONLY` fence is load-bearing: it must be authorised by an ADJACENT
//      `BB-DIVERGE` marker. Delete the marker and the fence fails.
//
// Runs fully offline against the vendored snapshot under native-snapshot/<sha>/,
// so it is safe in `npm test`. Pass `--native <dir>` to additionally prove the
// vendored snapshot still matches a live native clone at the pinned SHA.
//
// CLI:  node --experimental-strip-types scripts/skill-fidelity.ts [--native <dir>]

import { readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { execFileSync } from "node:child_process";

const MAX_FENCE_SENTENCES = 6;
// Total fenced sentences allowed per skill. Bounds the "mint many small fences"
// bypass of the per-fence cap (break 7C): a skill cannot carry an unbounded
// amount of fenced BB text however it is split. Limit: a legitimately BB-heavy
// skill is capped here; raise deliberately if a real one needs it.
const MAX_FENCED_SENTENCES_PER_SKILL = 10;

// BB-specific tokens. A BB-ONLY fenced sentence must contain at least one, so it
// is provably about BB mechanics rather than free prose. Matched on normalized
// (lowercased, backtick-stripped) text.
const BB_TOKENS: RegExp[] = [
  /firstmate_[a-z]+/,
  /bb firstmate/,
  /supervision on/,
  /ready to review/,
  /--grant|--resolve-key|--yes|--allow-red/,
  /\/(afk|quiet|bearings|captain|stow)\b/,
  /\bdeliver\b/,
];

export type Diverge = { native: string; nativeQuote: string; bb: string; reason: string; line: number; endLine: number };

// The actual BB tokens a string carries (matched strings, e.g. "firstmate_afk"
// vs "firstmate_bearings" are distinct), so a marker and its fence can be checked
// for a shared, specific BB vocabulary rather than a shared regex.
function bbTokenSet(s: string): Set<string> {
  const n = normalize(s);
  const out = new Set<string>();
  for (const re of BB_TOKENS) for (const m of n.matchAll(new RegExp(re.source, "g"))) out.add(m[0]);
  return out;
}
export type Fence = { reason: string; inner: string; openLine: number; closeLine: number };

export type Skill = {
  path: string;
  hasFrontmatter: boolean;
  bbSource: { native: string; sha: string; snapshot: string; fidelity: string } | null;
  diverges: Diverge[];
  fences: Fence[];
  divergeLines: Set<number>; // lines covered by BB-DIVERGE comments (for adjacency)
  blankLines: Set<number>;
  rendered: string; // rendered prose: frontmatter, comments and fenced regions removed
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
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*>#]/g, "") // keep underscores: tool names like firstmate_afk carry them
    .replace(/→|->/g, " ")
    .replace(/[–—]/g, "-")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .toLowerCase()
    .replace(/(^|\s)[-*]\s+/g, " ")
    .replace(/(^|\s)\d+\.\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function sentences(text: string): string[] {
  return normalize(text)
    .split(/(?<=[.;:])\s+/)
    .map((x) => x.trim())
    .filter((x) => x.replace(/[^a-z]/g, "").length >= 20);
}

function lineOf(content: string, index: number): number {
  return content.slice(0, index).split("\n").length;
}

function field(body: string, key: string): string | null {
  const re = new RegExp(`(?:^|\\n)\\s*${key}:\\s*([\\s\\S]*?)(?=\\n\\s*[a-z-]+:\\s|$)`, "i");
  const m = re.exec(body);
  return m ? m[1].replace(/\s+/g, " ").trim() : null;
}

export function scanSkill(repoRoot: string, rel: string): Skill {
  const content = readFileSync(join(repoRoot, rel), "utf8");
  const hasFrontmatter = /^---\n[\s\S]*?\n---\n/.test(content);

  let bbSource: Skill["bbSource"] = null;
  const diverges: Diverge[] = [];
  const divergeLines = new Set<number>();

  const commentRe = /<!--([\s\S]*?)-->/g;
  let m: RegExpExecArray | null;
  while ((m = commentRe.exec(content)) !== null) {
    const body = m[1];
    const head = body.trim();
    const startLine = lineOf(content, m.index);
    const endLine = lineOf(content, m.index + m[0].length - 1);
    if (/^BB-SOURCE\b/.test(head)) {
      bbSource = {
        native: field(body, "native") ?? "",
        sha: field(body, "sha") ?? "",
        snapshot: field(body, "snapshot") ?? "",
        fidelity: field(body, "fidelity") ?? "adapted",
      };
    } else if (/^BB-DIVERGE\b/.test(head)) {
      diverges.push({
        native: field(body, "native") ?? "",
        nativeQuote: field(body, "native-quote") ?? "",
        bb: field(body, "bb") ?? "",
        reason: field(body, "reason") ?? "",
        line: startLine,
        endLine,
      });
      for (let l = startLine; l <= endLine; l++) divergeLines.add(l);
    }
  }

  // BB-ONLY fences (open comment … close comment), capturing reason + inner text.
  const fences: Fence[] = [];
  const fenceRe = /<!--\s*BB-ONLY:([\s\S]*?)-->([\s\S]*?)<!--\s*\/BB-ONLY\s*-->/g;
  while ((m = fenceRe.exec(content)) !== null) {
    fences.push({
      reason: m[1].replace(/\s+/g, " ").trim(),
      inner: m[2],
      openLine: lineOf(content, m.index),
      closeLine: lineOf(content, m.index + m[0].length - 1),
    });
  }

  const blankLines = new Set<number>();
  content.split("\n").forEach((l, i) => {
    if (l.trim() === "") blankLines.add(i + 1);
  });

  // Rendered prose = content minus frontmatter, minus fenced regions, minus every
  // HTML comment, minus headings and list scaffolding.
  let rendered = content.replace(/^---\n[\s\S]*?\n---\n/, "");
  rendered = rendered.replace(/<!--\s*BB-ONLY:[\s\S]*?<!--\s*\/BB-ONLY\s*-->/g, " ");
  rendered = rendered.replace(/<!--[\s\S]*?-->/g, " ");
  rendered = rendered
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join(" ");

  return { path: rel, hasFrontmatter, bbSource, diverges, fences, divergeLines, blankLines, rendered };
}

export function scanAll(repoRoot: string): Skill[] {
  return SKILL_GLOBS.map((rel) => scanSkill(repoRoot, rel));
}

export type Problem = { skill: string; line?: number; msg: string };

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
    for (const d of s.diverges)
      for (const [k, v] of [["native", d.native], ["native-quote", d.nativeQuote], ["bb", d.bb], ["reason", d.reason]] as const)
        if (!v) problems.push({ skill: s.path, line: d.line, msg: `BB-DIVERGE missing '${k}:' field` });
  }
  return problems;
}

// The nearest non-blank line above `line` (0 if none).
function nearestNonBlankAbove(line: number, blank: Set<number>): number {
  for (let l = line - 1; l >= 1; l--) if (!blank.has(l)) return l;
  return 0;
}
function nearestNonBlankBelow(line: number, blank: Set<number>, max: number): number {
  for (let l = line + 1; l <= max; l++) if (!blank.has(l)) return l;
  return 0;
}

// Constrain BB-ONLY fences: reason, size, BB-anchoring, and adjacency to a
// load-bearing BB-DIVERGE. (native-content-in-fence is checked in
// validateAgainstSnapshot, which has the snapshot.)
function divergeCoveringLine(s: Skill, line: number): Diverge | null {
  if (line <= 0) return null;
  for (const d of s.diverges) if (line >= d.line && line <= d.endLine) return d;
  return null;
}

export function validateFences(skills: Skill[]): Problem[] {
  const problems: Problem[] = [];
  for (const s of skills) {
    const maxLine = Math.max(0, ...s.fences.map((f) => f.closeLine), ...[...s.divergeLines], ...[...s.blankLines]);

    // Distinct anchors: a native-quote may not be reused across BB-DIVERGE
    // markers in one skill, so a valid anchor cannot be cloned to mint fences.
    const seenQuotes = new Map<string, number>();
    for (const d of s.diverges) {
      if (!d.nativeQuote) continue;
      const key = normalize(d.nativeQuote);
      if (seenQuotes.has(key))
        problems.push({ skill: s.path, line: d.line, msg: `BB-DIVERGE native-quote reused (also line ${seenQuotes.get(key)}); each anchor must be distinct so a valid quote cannot mint extra fences` });
      else seenQuotes.set(key, d.line);
    }

    let fencedTotal = 0;
    for (const f of s.fences) {
      if (f.reason.replace(/[^a-z]/gi, "").length < 8)
        problems.push({ skill: s.path, line: f.openLine, msg: "BB-ONLY reason is empty or too short (must be a structured, non-empty reason)" });
      const inner = sentences(f.inner);
      fencedTotal += inner.length;
      if (inner.length === 0)
        problems.push({ skill: s.path, line: f.openLine, msg: "BB-ONLY fence has no substantive sentence (fence something real, or drop it)" });
      if (inner.length > MAX_FENCE_SENTENCES)
        problems.push({ skill: s.path, line: f.openLine, msg: `BB-ONLY fence too large (${inner.length} sentences > ${MAX_FENCE_SENTENCES}); a fence must not grow into a parallel skill` });
      for (const sent of inner)
        if (!BB_TOKENS.some((re) => re.test(sent)))
          problems.push({ skill: s.path, line: f.openLine, msg: `BB-ONLY sentence is not BB-anchored (no BB tool/command token) — free prose cannot hide in a fence: ${JSON.stringify(sent.slice(0, 80))}` });

      // Load-bearing: an adjacent BB-DIVERGE must authorise the fence.
      const above = nearestNonBlankAbove(f.openLine, s.blankLines);
      const below = nearestNonBlankBelow(f.closeLine, s.blankLines, maxLine);
      const marker = divergeCoveringLine(s, above) ?? divergeCoveringLine(s, below);
      if (!marker) {
        problems.push({ skill: s.path, line: f.openLine, msg: "BB-ONLY fence is not authorised by an adjacent BB-DIVERGE (delete the marker and the fence must fail)" });
      } else {
        // The authorising marker's bb: must describe THIS fence — they must share
        // a BB vocabulary token, so a marker cannot rubber-stamp an unrelated fence.
        const shared = [...bbTokenSet(marker.bb)].some((t) => bbTokenSet(f.inner).has(t));
        if (!shared)
          problems.push({ skill: s.path, line: f.openLine, msg: `authorising BB-DIVERGE (line ${marker.line}) 'bb:' shares no BB token with the fence it authorises — the marker must describe its fence` });
      }
    }

    if (fencedTotal > MAX_FENCED_SENTENCES_PER_SKILL)
      problems.push({ skill: s.path, msg: `too much fenced BB-ONLY content (${fencedTotal} sentences > ${MAX_FENCED_SENTENCES_PER_SKILL} per skill); splitting into more fences does not raise the bound` });
  }
  return problems;
}

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

    // Rendered prose outside fences must be native.
    for (const sent of sentences(s.rendered))
      if (!nativeBlob.includes(sent))
        problems.push({ skill: s.path, msg: `unmarked divergence — rendered prose not in native, and not inside a BB-ONLY fence or BB-DIVERGE: ${JSON.stringify(sent.slice(0, 90))}` });

    // A fence may not shelter native-derived content (that is over-fencing).
    for (const f of s.fences)
      for (const sent of sentences(f.inner))
        if (nativeBlob.includes(sent))
          problems.push({ skill: s.path, line: f.openLine, msg: `native-derived sentence is fenced BB-ONLY — un-fence it so it is checked: ${JSON.stringify(sent.slice(0, 80))}` });
  }
  return problems;
}

export function validateSnapshotFreshness(repoRoot: string, skills: Skill[], nativeDir: string): Problem[] {
  const problems: Problem[] = [];
  const seen = new Set<string>();
  for (const s of skills) {
    if (!s.bbSource) continue;
    const key = `${s.bbSource.sha}::${s.bbSource.snapshot}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const snap = readFileSync(join(repoRoot, s.bbSource.snapshot), "utf8");
    const nativePath = s.bbSource.native.replace(/\s*§.*$/, "").trim();
    let live: string;
    try {
      live = execFileSync("git", ["-C", nativeDir, "show", `${s.bbSource.sha}:${nativePath}`], { encoding: "utf8" });
    } catch (e) {
      problems.push({ skill: s.path, msg: `cannot read native ${nativePath}@${s.bbSource.sha} in ${nativeDir}: ${(e as Error).message.split("\n")[0]}` });
      continue;
    }
    if (!normalize(live).includes(normalize(snap)))
      problems.push({ skill: s.path, msg: `vendored snapshot ${s.bbSource.snapshot} no longer matches native ${nativePath}@${s.bbSource.sha} — re-vendor and bump the pin` });
  }
  return problems;
}

export function runOffline(repoRoot: string): Problem[] {
  const skills = scanAll(repoRoot);
  return [...validateStructure(skills), ...validateFences(skills), ...validateAgainstSnapshot(repoRoot, skills)];
}

function repoRootFromHere(): string {
  return dirname(dirname(new URL(import.meta.url).pathname));
}

function main(): void {
  const repoRoot = repoRootFromHere();
  const skills = scanAll(repoRoot);
  const problems = runOffline(repoRoot);

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
    console.log(`skill-fidelity: OK — ${skills.length} skills, ${skills.reduce((n, s) => n + s.diverges.length, 0)} BB-DIVERGE anchors, ${skills.reduce((n, s) => n + s.fences.length, 0)} BB-ONLY fences authorised${nativeFlag !== -1 ? ", snapshot fresh vs native" : ""}.`);
    return;
  }
  console.error(`skill-fidelity: ${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p.skill}${p.line ? `:${p.line}` : ""} — ${p.msg}`);
  process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
