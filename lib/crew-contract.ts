import { homedir } from "node:os";
import type { Shape } from "./policy.ts";
import { BUG_FIX_PROOF, checkerSteps, HOUSE_RULES, OBSTACLES, OPERATOR_MERGE_STEPS, PLAYBOOK_RULES, SCREENSHOT_RULE } from "../owner/crew-rules.ts";
import type { CrewRole } from "../owner/crew-roles.ts";
import { codePipeline, CORE_PRINCIPLES, PROOF_STEP, type PipelineStep } from "../owner/pipelines.ts";

export const PLAYBOOK_CHOICES = ["feature", "bug-fix", "perf-issue", "refactoring", "prototype", "investigation", "visual-parity", "babysit", "none"] as const;
export type PlaybookChoice = (typeof PLAYBOOK_CHOICES)[number];

// Matched against the dispatch title only; the task body names too many words.
// First matching row wins. `none` is a deploy or operator task: it follows the
// delivery contract, not a playbook.
const TITLE_ROWS: ReadonlyArray<{ playbook: PlaybookChoice; pattern: RegExp }> = [
  { playbook: "none", pattern: /^(?:[\w .-]+:\s*)?(?:deploy|redeploy|merge|release|publish|land|roll ?out|roll ?back|rollback|restart)\b/i },
  { playbook: "babysit", pattern: /\b(?:babysit|get (?:it |the pr |ci )?green|review comments|bugbot|ci (?:red|failures?))\b/i },
  { playbook: "perf-issue", pattern: /\b(?:perf|performance|slow(?:ness|er|down)?|latency|speed ?up|contention|throughput|memory usage|cpu)\b/i },
  { playbook: "prototype", pattern: /\b(?:prototype|sketch|mock ?up|spike|poc|proof of concept)\b/i },
  { playbook: "visual-parity", pattern: /\b(?:visual parity|pixel|parity|match(?:es)? (?:the )?(?:figma|design|mock|screenshot)s?)\b/i },
  { playbook: "refactoring", pattern: /\b(?:refactor\w*|rename|extract|dedupe|de-?duplicate|restructure|reorgani[sz]e|clean ?up)\b/i },
  { playbook: "bug-fix", pattern: /\b(?:bugs?|fix(?:es|ed|ing)?|broken|breaks?|crash(?:es|ed)?|fail(?:s|ed|ing|ure)?|errors?|regression|flaky|wrong|incorrect|not working|doesn'?t work|stuck|hangs?|leaks?)\b/i },
  { playbook: "investigation", pattern: /\b(?:spec|specs|investigat\w*|audit|research|explore|why|how does|rfc|design doc|proposal)\b/i },
];

// A heading line ("## Captain's intent") is structure, not a title.
function titleOf(title: string | undefined, task: string): string {
  if (title !== undefined && title.trim() !== "") return title;
  return task.split("\n").find((line) => line.trim() !== "" && !/^\s*#/.test(line)) ?? "";
}

export function crewPlaybook(input: { shape: Shape; title?: string; task: string; playbook?: PlaybookChoice; role?: CrewRole }): PlaybookChoice {
  if (input.role === "checker") return "none";
  if (input.playbook !== undefined) return input.playbook;
  if (input.shape === "scout") return "investigation";
  const title = titleOf(input.title, input.task);
  return TITLE_ROWS.find((row) => row.pattern.test(title))?.playbook ?? "feature";
}

// Where each BB provider reads skills on this host. Every listed folder holds
// the same pstack install; an unknown provider gets the shared agents folder.
const SKILL_ROOTS: Readonly<Record<string, string>> = {
  "claude-code": ".claude/skills",
  codex: ".codex/skills",
  "acp-cursor": ".cursor/skills",
  "acp-grok": ".grok/skills",
  "acp-antigravity": ".gemini/skills",
  pi: ".pi/agent/skills",
};

const FALLBACK_SKILL_ROOT = ".agents/skills";

export function crewSkillRoot(providerId: string | null | undefined): string {
  return `${homedir()}/${SKILL_ROOTS[providerId ?? ""] ?? FALLBACK_SKILL_ROOT}`;
}

// Every skill a brief, the skill-routing table or a brief-named playbook sends a
// crew to. A name outside this list fails the brief tests; `skillCheckScript`
// reports which of these a live host lacks. create-skill is a Cursor built-in
// with no file, so the brief gives writing-for-agents in its place.
export const BRIEF_SKILLS = [
  "skill-routing", "poteto-mode", "no-comments", "diagnosing-bugs", "tdd", "benchmark-checklist", "codebase-design",
  "improve-codebase-architecture", "grill-with-docs", "to-spec", "to-tickets",
  "implement", "implement-spec", "grilling", "interrogate", "how", "why", "architect",
  "arena", "prototype", "code-review", "blast-radius", "pr", "unslop", "technical-writing", "writing-for-agents",
  "zoom-out", "deslop", "figure-it-out", "control-cli", "control-ui", "frontend-design",
  "sharpen", "verify-this", ...CORE_PRINCIPLES,
] as const;

// Read-only. A provider that is not installed (no parent folder) is skipped.
export function skillCheckScript(): string {
  const playbooks = PLAYBOOK_CHOICES.filter((choice) => choice !== "none");
  return [
    "check() {",
    '  p=$1; d="$HOME/$2"; m=""',
    '  [ -d "$(dirname "$d")" ] || return 0',
    '  [ -d "$d" ] || { echo "SKILLS_MISSING: $p $d: no skills folder"; return 0; }',
    `  for s in ${BRIEF_SKILLS.join(" ")}; do [ -r "$d/$s/SKILL.md" ] || m="$m $s"; done`,
    '  ls "$d"/principle-*/SKILL.md >/dev/null 2>&1 || m="$m principle-*"',
    `  for b in ${playbooks.join(" ")}; do [ -r "$d/poteto-mode/playbooks/$b.md" ] || m="$m poteto-mode/playbooks/$b.md"; done`,
    '  if [ -z "$m" ]; then echo "skills ok: $p $d"; else echo "SKILLS_MISSING: $p $d:$m"; fi',
    "}",
    ...Object.entries(SKILL_ROOTS).map(([providerId, root]) => `check ${providerId} ${root}`),
    `check other ${FALLBACK_SKILL_ROOT}`,
  ].join("\n");
}

// skill-routing ships with this plugin, not with pstack, so no provider folder
// holds it until this runs. A provider that is not installed (no parent folder)
// is skipped; a real folder or a working link is the owner's and stays.
export function skillRoutingLinkScript(target: string): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  return [
    `t=${q(target)}`,
    '[ -f "$t/SKILL.md" ] || { echo "skill-routing-link target-missing $t"; exit 0; }',
    `for r in ${[...Object.values(SKILL_ROOTS), FALLBACK_SKILL_ROOT].join(" ")}; do`,
    '  d="$HOME/$r"; p="$d/skill-routing"',
    '  [ -d "$(dirname "$d")" ] || continue',
    '  if [ -L "$p" ] && [ ! -e "$p" ]; then rm -f "$p"; s=repaired',
    '  elif [ -e "$p" ] || [ -L "$p" ]; then echo "skill-routing-link kept $p"; continue',
    '  else s=linked; fi',
    '  if mkdir -p "$d" && ln -s "$t" "$p"; then echo "skill-routing-link $s $p"; else echo "skill-routing-link failed $p"; fi',
    "done",
  ].join("\n");
}

// The fixed pipeline for a code task (owner/pipelines.ts), or null. A scout ships no code.
export function crewPipeline(input: { shape: Shape; title?: string; task: string; playbook?: PlaybookChoice; role?: CrewRole }): readonly PipelineStep[] | null {
  return input.shape === "ship" ? codePipeline(crewPlaybook(input)) : null;
}

function pipelineSection(playbook: PlaybookChoice, steps: readonly PipelineStep[], skill: (name: string) => string, dataDir: string | undefined): string[] {
  const proof = steps.findIndex((step) => step.title === PROOF_STEP) + 1;
  const report = dataDir !== undefined && dataDir !== "" ? `\`${dataDir}/report.md\`` : "your report file";
  return [
    `### Pipeline (${playbook.replace("-", " ")}). Do every step, in this order:`,
    ...steps.map((step, i) => {
      const how = step.title === PROOF_STEP
        ? `: use the project's verify skill if it has one (e.g. \`.agents/skills/verify-<app>/\`), else read \`${skill(step.skills[0]!)}\``
        : step.skills.length > 0 ? `: read ${step.skills.map((name) => `\`${skill(name)}\``).join(" and ")}` : "";
      return `P${i + 1}. ${step.title}${how}. Evidence: ${step.evidence}.`;
    }),
    "Your final report has one line per pipeline step: \"✓ P<n> <step>: <evidence>\" or \"skip: P<n> <step>: <reason>\".",
    `Write that report to ${report} before you record verification. \`bb firstmate deliveries verify\` refuses this crew's PR until the report has "✓ P${proof} ${PROOF_STEP}: driven <what>; seen <what>".`,
  ];
}

export function crewSkillBlock(input: { shape: Shape; title?: string; task: string; providerId?: string | null; playbook?: PlaybookChoice; dataDir?: string; role?: CrewRole }): string {
  const playbook = crewPlaybook(input);
  const pipeline = crewPipeline(input);
  const checker = input.role === "checker";
  const root = crewSkillRoot(input.providerId);
  const skill = (name: string) => `${root}/${name}/SKILL.md`;
  const hasDataDir = input.dataDir !== undefined && input.dataDir !== "";
  // The reads lead the block and the report accounts for them: a read the
  // report must name is a read that happens.
  const reads = playbook === "none" ? "steps 1 and 2" : "steps 1 to 3";
  const lines = [
    "### Skills (Firstmate adds this to every brief)",
    `First action, before any other command: read the files in ${reads}.`,
    `1. Read \`${root}/skill-routing/SKILL.md\`. Load every skill its matched rows and your playbook name.`,
    `2. Read \`${root}/poteto-mode/SKILL.md\` in full.`,
  ];
  if (checker) {
    lines.push("3. No playbook: you are a checker. Follow the Checker section.");
  } else if (playbook === "none") {
    lines.push("3. No playbook: this is a deploy or operator task. Follow the brief's delivery contract.");
  } else if (pipeline !== null) {
    lines.push(
      `3. Follow \`${root}/poteto-mode/playbooks/${playbook}.md\`.`,
      hasDataDir
        ? `4. Write every pipeline step into \`${input.dataDir}/todo.md\`, then the playbook steps, before any other work. Tick each step there as you go.`
        : "4. Copy every pipeline step, then the playbook steps, into your to-do list, before any other to-do.",
      "5. Your final report lists each pipeline step as the Pipeline section says.",
    );
  } else {
    lines.push(
      `3. Follow \`${root}/poteto-mode/playbooks/${playbook}.md\`.`,
      // One file for every provider: Claude Code and Grok crews kept no to-do list.
      hasDataDir
        ? `4. Write every step of that playbook into \`${input.dataDir}/todo.md\` before any other work. Tick each step there as you go.`
        : "4. Copy every step of that playbook into your to-do list, before any other to-do.",
      "5. Your final report lists each playbook step as \"✓ <step>\" or \"skip: <step>: <reason>\".",
    );
  }
  const named = CORE_PRINCIPLES.map((name) => `\`${skill(name)}\``);
  lines.push(
    "Your final report has a line \"Skills read: <paths>\" for those files, or \"not read: <path>: <reason>\".",
    `Core principles: read ${named.slice(0, -1).join(", ")} and ${named.at(-1)} in full. poteto-mode loads the other principles by their triggers.`,
    `Skills on this host are in \`${root}/<name>/SKILL.md\`. Load a skill by reading that file. Do not rely on a Skill tool for pstack skills; they are user-invocable only.`,
    "If a skill is not installed, continue and say so in your report.",
    ...HOUSE_RULES,
  );
  if (checker) lines.push(...checkerSteps(skill));
  else if (playbook === "none") lines.push(...OPERATOR_MERGE_STEPS);
  else lines.push(...PLAYBOOK_RULES);
  if (pipeline !== null) lines.push(...pipelineSection(playbook, pipeline, skill, input.dataDir));
  lines.push(SCREENSHOT_RULE);
  if (input.shape !== "scout" && !checker && pipeline === null) lines.push(`Before you open a PR, run /no-comments (\`${skill("no-comments")}\`) over your diff.`);
  if (playbook === "bug-fix" && pipeline === null) lines.push(BUG_FIX_PROOF);
  lines.push(...OBSTACLES);
  return lines.join("\n");
}

export function playbookStepCount(playbook: string): number {
  return playbook.match(/^\d+\.\s/gm)?.length ?? 0;
}

// What a DONE report lacks of the accounting the brief asks for: a skills line
// and one "✓"/"skip:" line per playbook step.
export function reportGaps(report: string, steps: number): string[] {
  const gaps: string[] = [];
  if (!/^[\s#*>-]*(?:skills read\b|not read:)/im.test(report)) gaps.push("a \"Skills read:\" line");
  // A pending or blocked line accounts for its step; verifyStepGap judges whether it was done.
  const lines = report.match(/^[ \t]*(?:[-*][ \t]*)?(?:\d+\.[ \t]*)?(?:✓|skip:|pending:|blocked:)/gim)?.length ?? 0;
  if (lines < Math.max(steps, 1)) gaps.push(`playbook step lines (${lines} of ${Math.max(steps, 1)})`);
  return gaps;
}

export function reportGapNote(crewId: string, gaps: readonly string[]): string {
  return `Report check: crew ${crewId}'s DONE report lacks ${gaps.join("; ")}. Asked the crew to add them. Its delivery is not held.`;
}

export function reportGapRequest(gaps: readonly string[]): string {
  return [
    `REPORT INCOMPLETE: your final report lacks ${gaps.join("; ")}.`,
    "Reply with only the missing parts: a line \"Skills read: <paths>\", and one line per playbook step, \"✓ <step>\" or \"skip: <step>: <reason>\".",
    "Do not redo the task. End with your DONE: line again.",
  ].join("\n");
}

// A report step line: "✓ 4. Verify…", "- pending: Verify…", "4. skip: Verify…".
const STEP_LINE = /^[ \t]*(?:[-*][ \t]*)?(?:(\d+)\.[ \t]*)?(✓|✔|✅|skip(?:ped)?:|pending:?|blocked:|todo:|not done:|☐|\[ \])[ \t]*(?:(\d+)\.[ \t]*)?(.*)$/gim;
const STEP_STATE: Record<string, string> = { skip: "skipped", skipped: "skipped", pending: "pending", blocked: "blocked" };

// Why a DONE report does not show the playbook's verify step done on the real
// surface, or null. The verify step is the first step that starts with Verify or
// Prove, or that rules out a wrong-surface result. A report with no step lines is
// left to reportGaps.
export function verifyStepGap(report: string, playbook: string): string | null {
  const step = [...playbook.matchAll(/^(\d+)\.\s+(.*)$/gm)].find((m) => /^(?:\*\*)?(?:verify|prove)\b/i.test(m[2]!) || /wrong-surface/i.test(m[2]!));
  if (step === undefined) return null;
  const title = step[2]!.replace(/\*\*/g, "").split(/\.(?:\s|$)/)[0]!.trim();
  const lead = title.toLowerCase().split(/\s+/).slice(0, 2).join(" ");
  const lines = [...report.matchAll(STEP_LINE)].map((m) => ({ number: m[1] ?? m[3], mark: m[2]!.toLowerCase().replace(/:$/, ""), body: m[4]!.trim() }));
  if (lines.length === 0) return null;
  const line = lines.find((l) => l.number === step[1] || l.body.toLowerCase().startsWith(lead)) ?? lines.find((l) => /\bverif/i.test(l.body));
  if (line === undefined) return `missing: no "${title}" line`;
  // A ✓ line is not judged on its wording; the merge gate needs a record with driven and seen.
  if (/^[✓✔✅]$/.test(line.mark)) return null;
  return `${STEP_STATE[line.mark] ?? "not done"}: "${line.body}"`;
}

const PROOF_LINE = new RegExp(`^[ \\t]*(?:[-*][ \\t]*)?(✓|✔|✅|skip(?:ped)?:|pending:?|blocked:|todo:|not done:|☐|\\[ \\])[ \\t]*((?:P?\\d+\\.?[ \\t]*)?${PROOF_STEP}\\b.*)$`, "im");

// Why a pipeline crew's report does not show the proof step done with what was driven
// and seen, or null.
export function pipelineProofGap(report: string): string | null {
  const line = PROOF_LINE.exec(report);
  if (line === null) return `missing: no "✓ P4 ${PROOF_STEP}" line`;
  const mark = line[1]!.toLowerCase().replace(/:$/, "");
  const body = line[2]!.trim();
  if (!/^[✓✔✅]$/.test(mark)) return `${STEP_STATE[mark] ?? "not done"}: "${body}"`;
  return /\bdriven\b.+\bseen\b/i.test(body) ? null : "no evidence: the line lacks \"driven <what>; seen <what>\"";
}

export function notVerifiedNote(crewId: string, gap: string): string {
  return [
    `NOT VERIFIED: crew ${crewId}'s DONE report has its verify step ${gap}.`,
    "CI and unit tests are not verification.",
    "Its PRs cannot merge until a verification record exists for the PR head: drive the changed surface, then firstmate_deliveries action=verify with the head commit, driven and seen.",
    "Only the owner's own words can waive it: firstmate_merge allowUnverified=\"<owner words>\".",
  ].join("\n");
}

export function notVerifiedRequest(gap: string): string {
  return [
    `VERIFY STEP NOT DONE: your report has the verify step ${gap}. CI and unit tests are not verification.`,
    "Drive the changed surface yourself, with the project's verification skill if it has one (for example `.agents/skills/verify-<app>/` in the repo), and reply with what you ran and what you saw.",
    "If you cannot drive it, reply \"blocked: <step>: <what stops you>\". Do not send a manual checklist for a human. End with your DONE: or BLOCKED: line again.",
  ].join("\n");
}

// Mirrored in overlay/bin/fm-worker-checkpoint.py. A KEY name needs a prefix so
// native decision keys (`[key=api]`) survive; 40-hex git commit IDs stay readable.
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_-]*(?:[A-Za-z0-9][_-]?key|secret|token|passw(?:or)?d|credential))(["']?\s*[:=]\s*)(["']?)(?!\[redacted\])[^\s"']+/gi;
const DEPLOY_KEY = /\b(?:prod|dev|preview):[A-Za-z0-9-]+\|[A-Za-z0-9+/=_-]{8,}/g;
const LONG_HEX = /\b[0-9a-f]{48,}\b/gi;
const LONG_BASE64 = /[A-Za-z0-9+/_-]{40,}={0,2}/g;
export const REDACTED = "[redacted]";

export function redactSecrets(text: string): string {
  return text
    .replace(DEPLOY_KEY, REDACTED)
    .replace(SECRET_ASSIGNMENT, (_match, name: string, separator: string, quote: string) => `${name}${separator}${quote}${REDACTED}`)
    .replace(LONG_HEX, REDACTED)
    .replace(LONG_BASE64, (run) => /[A-Z]/.test(run) && /[a-z]/.test(run) && /[0-9]/.test(run) ? REDACTED : run);
}
