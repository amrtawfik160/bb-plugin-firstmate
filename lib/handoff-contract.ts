export const HANDOFF_UPSTREAM_COMMIT = "1f3e769616fdf9f31f85f4c3e6a9f71606634238";

export const HANDOFF_FAST_PATH = [
  "BB-DIVERGE intake fast path (upstream firstmate@" + HANDOFF_UPSTREAM_COMMIT.slice(0, 8) + " AGENTS.md intake/consult-first).",
  "For each new user message: answer in 2 sentences from what you already know, or call firstmate_dispatch now with the user's words as the task and its source ref.",
  "Do not read reports, project files, or drain wakes before that answer or dispatch. The crew does intake research.",
  "Never end a turn while a user message from this turn lacks a reply or a dispatch. One reply or dispatch per user message.",
].join(" ");

export const HANDOFF_WAKE_AMENDMENT =
  "If any user message arrived in this turn, you must answer or dispatch it. Never end with no text when a user message is still open.";

export const READY_EVIDENCE_RULE =
  "READY requires attached evidence that the core signal fired in a real run (command and output). Do not relay READY without that evidence.";

export function captainInstructionsWithHandoff(base: string, enabled: boolean): string {
  if (!enabled) return base;
  return `${HANDOFF_FAST_PATH} ${base}`;
}

export function wakeGuidanceWithHandoff(base: string, enabled: boolean): string {
  if (!enabled) return base;
  return `${base} ${HANDOFF_WAKE_AMENDMENT}`;
}
