// Owner layer (decisions Q16, Q21): the weekly scorecard for the "Hanoon & tools" topic, and
// the weekly reflect crew that runs after it. `bb firstmate scorecard --json` gives the
// Firstmate counts; scripts/weekly-scorecard.ts adds the Telegram counts and sends both to the
// captain.
import { CAPTAIN_ARCHIVE_FILE, CAPTAIN_FILE, CAPTAIN_MAX_RULES } from "./corrections.ts";

export const SCORECARD_PROJECT = "Hanoon & tools";

export type ScorecardData = {
  since: string;
  until: string;
  corrections: { id: string; ref: string; at: string; fixed: boolean }[];
  redone: { task: string; title: string; extraCrews: number }[];
  checkerFails: { pr: string; at: string; model: string }[];
  unproven: { pr: string; crew: string; at: string }[];
  /** Left out: not read here. null: the connector status could not be read. baseline: no earlier snapshot. */
  telegram?: { sent: number; failed: number; baseline: boolean } | null;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Cairo" });
const distinct = (values: readonly string[]) => new Set(values).size;

export function renderScorecard(d: ScorecardData): string {
  const fixed = d.corrections.filter((c) => c.fixed).length;
  const extra = d.redone.reduce((sum, r) => sum + r.extraCrews, 0);
  const t = d.telegram;
  return [
    `🛠 ${SCORECARD_PROJECT} · Weekly scorecard, ${day(d.since)} to ${day(d.until)}`,
    `Owner corrections: ${plural(d.corrections.length, "correction")}.${d.corrections.length > 0 ? ` ${fixed} ${fixed === 1 ? "is" : "are"} fixed.` : ""} Source: corrections ledger.`,
    `Redone work: ${plural(extra, "extra crew")}${extra > 0 ? ` on ${plural(d.redone.length, "owner task")}` : ""}. Source: owner task records.`,
    `Checker findings: ${plural(d.checkerFails.length, "fail verdict")}${d.checkerFails.length > 0 ? ` on ${plural(distinct(d.checkerFails.map((f) => f.pr)), "PR")}` : ""}. Source: checker verdicts.`,
    `Done claims without proof: ${plural(d.unproven.length, "refused proof")}${d.unproven.length > 0 ? ` on ${plural(distinct(d.unproven.map((u) => u.pr)), "PR")}` : ""}. Source: proof gate.`,
    t === undefined ? null
      : t === null ? "Noise: not read. bb telegram status failed."
      : t.baseline ? `Noise: no earlier count, so no weekly number yet. Totals so far: ${t.sent} sent, ${t.failed} failed or not confirmed. Source: Telegram connector status.`
      : `Noise: ${plural(t.sent, "Telegram message")} sent. ${t.failed} failed or not confirmed. Source: Telegram connector status.`,
  ].filter((line) => line !== null).join("\n");
}

/** Extra crews an owner task got in the window. A checker crew checks work; it does not redo it. */
export function redoneWork(
  tasks: readonly { id: string; title: string; crewIds: readonly string[] }[],
  crews: readonly { id: string; createdAt: string; role?: string | null }[],
  since: number,
  until: number,
): ScorecardData["redone"] {
  const byId = new Map(crews.map((c) => [c.id, c]));
  return tasks.flatMap((task) => {
    const doers = task.crewIds.map((id) => byId.get(id)).filter((c) => c !== undefined && c.role !== "checker")
      .sort((a, b) => Date.parse(a!.createdAt) - Date.parse(b!.createdAt));
    const extraCrews = doers.slice(1).filter((c) => { const t = Date.parse(c!.createdAt); return t >= since && t < until; }).length;
    return extraCrews > 0 ? [{ task: task.id, title: task.title, extraCrews }] : [];
  });
}

type TelegramCount = { sent: number; failed: number };
/** The connector keeps totals. The week is the change since the snapshot of the last run. */
export function telegramNoise(status: { inbox?: { failed?: number }; outbox?: { sent?: number; uncertain?: number } }, previous: TelegramCount | undefined): { now: TelegramCount; week: { sent: number; failed: number; baseline: boolean } } {
  const now = { sent: status.outbox?.sent ?? 0, failed: (status.inbox?.failed ?? 0) + (status.outbox?.uncertain ?? 0) };
  if (previous === undefined) return { now, week: { ...now, baseline: true } };
  return { now, week: { sent: Math.max(0, now.sent - previous.sent), failed: Math.max(0, now.failed - previous.failed), baseline: false } };
}

export function captainMessage(scorecard: string, d: ScorecardData, ctx: { home: string; project: string; captain: string }): string {
  const range = `--since ${d.since} --until ${d.until}`;
  return [
    `Weekly scorecard and reflect (automation, week ending ${day(d.until)}). Do these in order:`,
    `1. Post the scorecard below to the owner unchanged, as its own message, in the ${SCORECARD_PROJECT} project topic.`,
    `2. Dispatch the weekly reflect crew: firstmate_dispatch projectId=${ctx.project} role=builder playbook=none title="Weekly reflect ${day(d.until)}" with the reflect task below as its task.`,
    "3. When it finishes, send the owner its CHANGELOG lines, one line per skill or rule edit. If it made no edit, say so in one line.",
    "",
    "Scorecard:",
    scorecard,
    "",
    "Reflect task:",
    "Run pstack `reflect` over this week's owner corrections, checker verdicts, refused proofs and redone work. Use `principle-encode-lessons-in-structure`.",
    `1. Read the week: bb firstmate corrections list ${range.split(" --until")[0]} --json, and bb firstmate scorecard --captain ${ctx.captain} ${range} --json for each item and its source.`,
    "2. Find the patterns that repeat. For each, pick the smallest structural fix: a check or test, a tool refusal, a skill edit, or a captain.md rule.",
    `3. Skill and code edits: open one PR with the \`pr\` skill. Captain rules: edit ${ctx.home}/${CAPTAIN_FILE}; it keeps at most ${CAPTAIN_MAX_RULES} lines, so move the oldest rules to ${ctx.home}/${CAPTAIN_ARCHIVE_FILE} first.`,
    "4. End your final message with one line per edit: CHANGELOG: <one plain line for the owner, with no technical words>. With no edit, write CHANGELOG: no change this week.",
  ].join("\n");
}
