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
