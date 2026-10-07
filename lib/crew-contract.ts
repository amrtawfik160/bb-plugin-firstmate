import type { Shape } from "./policy.ts";

// First matching row wins. A scout always investigates; ship work that names a
// defect is a bug fix, and every other ship task is a feature.
const PLAYBOOKS: ReadonlyArray<{ playbook: string; matches: (shape: Shape, task: string) => boolean }> = [
  { playbook: "investigation.md", matches: (shape) => shape === "scout" },
  { playbook: "bug-fix.md", matches: (_shape, task) => /\b(?:bugs?|fix(?:es|ed|ing)?|broken|breaks?|crash(?:es|ed)?|fail(?:s|ed|ing|ure)?|errors?|regression|flaky|wrong|incorrect|not working|doesn'?t work|stuck|hangs?|leaks?)\b/i.test(task) },
  { playbook: "feature.md", matches: () => true },
];

export function crewPlaybook(shape: Shape, task: string): string {
  return PLAYBOOKS.find((row) => row.matches(shape, task))!.playbook;
}

export function crewSkillBlock(shape: Shape, task: string): string {
  return [
    "### Skills (Firstmate adds this to every brief)",
    "Before any other step, read the skill-routing skill and follow the rows that match this task, under its Firstmate rules.",
    `Then read \`poteto-mode/SKILL.md\` in full and follow \`poteto-mode/playbooks/${crewPlaybook(shape, task)}\`.`,
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
