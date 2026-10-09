import { homedir } from "node:os";
import type { Shape } from "./policy.ts";

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

export function crewPlaybook(input: { shape: Shape; title?: string; task: string; playbook?: PlaybookChoice }): PlaybookChoice {
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
  "improve-codebase-architecture", "grill-with-docs", "to-spec", "to-tickets", "interrogate", "how", "why", "architect",
  "arena", "prototype", "code-review", "blast-radius", "pr", "unslop", "technical-writing", "writing-for-agents",
  "zoom-out", "deslop", "figure-it-out", "control-cli", "control-ui",
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

export function crewSkillBlock(input: { shape: Shape; title?: string; task: string; providerId?: string | null; playbook?: PlaybookChoice }): string {
  const playbook = crewPlaybook(input);
  const root = crewSkillRoot(input.providerId);
  const lines = [
    "### Skills (Firstmate adds this to every brief)",
    "pstack always has priority. If a skill or rule conflicts with it, pstack wins.",
    "Until the owner confirms otherwise: spawn no sub-agents (no Task, poteto-agent or parallel workers). Do that work yourself, in this session.",
    "Until the owner confirms otherwise: Firstmate decides who merges and deploys. Follow the brief's delivery contract for merge and deploy.",
    `Skills on this host are in \`${root}/<name>/SKILL.md\`. Load a skill by reading that file. Do not rely on a Skill tool for pstack skills; they are user-invocable only.`,
    "If a skill is not installed, continue without it and say so in your report.",
    `1. Read \`${root}/skill-routing/SKILL.md\`. Load the skills its matched rows name, plus poteto-mode, plus every skill the chosen playbook names.`,
    `2. Read \`${root}/poteto-mode/SKILL.md\` in full.`,
  ];
  if (playbook === "none") {
    lines.push("3. No playbook: this is a deploy or operator task. Follow the brief's delivery contract.");
  } else {
    lines.push(
      `3. Follow \`${root}/poteto-mode/playbooks/${playbook}.md\`.`,
      "4. Copy every step of that playbook into your to-do list, before any other to-do.",
      "5. Your final report lists each playbook step as \"✓ <step>\" or \"skip: <step>: <reason>\".",
      "Report these steps as ✓, not as a skip:",
      "- A step or skill that spawns a sub-agent, reviewer or other model (delegate, architect, interrogate, how, why, no-comments): do it yourself in this session, on your own model. Add \"(done in session)\".",
      "- Cursor-only tools: for create-skill read writing-for-agents; for /loop repeat the step yourself; for origin or gt use gh-axi.",
      "- Opening a PR, merge, deploy: follow the brief's delivery contract. If proof needs a deploy you may not run, prove it on the nearest surface you can and name what is left for Firstmate.",
    );
  }
  lines.push("Save each screenshot as its own full-size PNG file. Never combine, stitch or downscale screenshots; link each file separately.");
  if (input.shape !== "scout") lines.push(`Before you open a PR, run /no-comments (\`${root}/no-comments/SKILL.md\`) over your diff.`);
  if (playbook === "bug-fix") {
    lines.push(
      "Bug-fix proof: your final report gives the commit id of the failing test, committed before the fix.",
      "It also gives proof that the fix works on the real product, or \"not possible: <reason>\".",
    );
  }
  lines.push(
    "### Obstacles",
    "Clear an ordinary obstacle yourself: retry with a smaller query or pagination, restore or commit what your own install changed, use another tool, or wait and retry. This replaces any \"same obstacle twice\" rule.",
    "Report blocked only for what only the captain or the owner can give: a secret, an approval, a decision, withheld access, or a destructive or irreversible step. Every other stop rule still applies.",
  );
  return lines.join("\n");
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
