// Invisible separators let the frontend distinguish a settled Firstmate tool
// result without adding user-visible text to the transcript.
export const FIRSTMATE_ROUTINE_MARKER = "\u2063\u2062\u2063\u2062\u2063";
export const FIRSTMATE_ATTENTION_MARKER = "\u2062\u2063\u2062\u2063\u2062";

const FIRSTMATE_TOOL = /\bfirstmate_[a-z0-9_]+\b/iu;
const ROUTINE_WATCH_TRANSPORT_FAILURE = /\bfirstmate_watch\b[\s\S]*\bdynamic tool request failed\b/iu;
const MATERIAL_TOOL_STATE = /\b(?:approval|cancelled|credential|denied|error|failed|failure|interrupted|login|needs attention|question)\b/iu;
const INTERNAL_CAPTAIN_WAKE = /^(?:FIRSTMATE INTERNAL WAKE|🔔\s*(?:[✅🚧❌❓✋⚖️🔎⏳]\s*)?crew\b|🛰️\s*fm-watch:)/iu;

export type TimelineNoiseDecision = "hide" | "show" | "unrelated";

const ROUTINE_REASONING_ROW = /^(?:Thinking|Thought(?: for .+)?)$/iu;

export function isRoutineReasoningRow(text: string): boolean {
  return ROUTINE_REASONING_ROW.test(text.trim());
}

export function firstmateTimelineNoiseDecision(text: string): TimelineNoiseDecision {
  if (text.includes(FIRSTMATE_ATTENTION_MARKER)) return "show";
  if (ROUTINE_WATCH_TRANSPORT_FAILURE.test(text)) return "hide";
  if (text.includes(FIRSTMATE_ROUTINE_MARKER)) return "hide";
  if (!FIRSTMATE_TOOL.test(text)) return "unrelated";
  return MATERIAL_TOOL_STATE.test(text) ? "show" : "hide";
}

export function captainTimelineNoiseDecision(
  text: string,
  genericExpandableWork: boolean,
): TimelineNoiseDecision {
  // Compatibility cleanup for visible wake rows written before agent-only
  // prompt blocks were available. New wakes are hidden by BB itself.
  if (INTERNAL_CAPTAIN_WAKE.test(text.trim())) return "hide";
  const firstmate = firstmateTimelineNoiseDecision(text);
  if (firstmate !== "unrelated") return firstmate;
  if (!genericExpandableWork) return "unrelated";
  return MATERIAL_TOOL_STATE.test(text) ? "show" : "hide";
}
