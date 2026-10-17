// Owner layer (decisions Q16, Q21): the weekly scorecard for the "Hanoon & tools" topic, and
// the weekly reflect crew that runs after it. `bb firstmate scorecard --json` gives the
// Firstmate counts from durable events (lib/quality-events.ts) and the corrections ledger;
// scripts/weekly-scorecard.ts adds the Telegram counts and sends both to the captain.
import { CAPTAIN_ARCHIVE_FILE, CAPTAIN_FILE, CAPTAIN_MAX_RULES } from "./corrections.ts";
import type { CheckEvent, RedoEvent, UnprovenEvent } from "../lib/quality-events.ts";

export const SCORECARD_PROJECT = "Hanoon & tools";

export type TelegramWeek = { sent: number; notDelivered: number; queued: number } | { unavailable: string };

export type ScorecardData = {
  since: string;
  until: string;
  corrections: { id: string; ref: string; at: string; fixed: boolean }[];
  redone: (RedoEvent & { at: string })[];
  checks: (CheckEvent & { at: string })[];
  unproven: (UnprovenEvent & { at: string })[];
  /** Left out: not read by this command. */
  telegram?: TelegramWeek;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const day = (at: string | number) => new Date(at).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "Africa/Cairo" });
const distinct = (values: readonly string[]) => new Set(values).size;

export function renderScorecard(d: ScorecardData): string {
  const fixed = d.corrections.filter((c) => c.fixed).length;
  const fails = d.checks.filter((c) => c.verdict === "fail");
  const counted = fails.filter((c) => c.findings !== null);
  const uncounted = fails.length - counted.length;
  const findings = counted.reduce((sum, c) => sum + (c.findings ?? 0), 0);
  const t = d.telegram;
  return [
    `🛠 ${SCORECARD_PROJECT} · Weekly scorecard, ${day(d.since)} to ${day(d.until)}`,
    `Owner corrections: ${plural(d.corrections.length, "correction")}.${d.corrections.length > 0 ? ` ${fixed} ${fixed === 1 ? "is" : "are"} fixed.` : ""} Source: corrections ledger.`,
    `Redone work: ${plural(d.redone.length, "crew")} started on ${d.redone.length > 0 ? plural(distinct(d.redone.map((r) => r.task)), "owner task") : "an owner task"} after an earlier crew of the same role on it ended. Source: re-dispatch records.`,
    fails.length === 0 ? "Checker findings: 0 fail verdicts. Source: checker verdicts."
      : `Checker findings: ${plural(findings, "finding")} in ${plural(fails.length, "fail verdict")} on ${plural(distinct(fails.map((f) => f.pr)), "PR")}${uncounted > 0 ? `; ${plural(uncounted, "verdict")} gave no finding count` : ""}. Source: checker verdicts.`,
    `Done claims without proof: ${plural(d.unproven.length, "claim")}${d.unproven.length > 0 ? ` by ${plural(distinct(d.unproven.map((u) => u.crew)), "crew")}` : ""}. Source: proof checks.`,
    t === undefined ? null
      : "unavailable" in t ? `Noise: not available (${t.unavailable}).`
      : `Noise: ${plural(t.sent, "Telegram message")} sent. ${t.notDelivered} not delivered. ${t.queued} still queued. Drops are not readable from the CLI. Source: Telegram connector records.`,
  ].filter((line) => line !== null).join("\n");
}

/** Telegram messages (outbox rows) created in [since, until). The connector prunes old rows,
 * so the week is complete only when its oldest kept row is no newer than the week's start. */
export function telegramWeek(rows: readonly { created_at: number; state: string }[], oldestKept: number | null, since: number, until: number): TelegramWeek {
  if (oldestKept !== null && oldestKept > since) return { unavailable: `the connector keeps records only from ${day(oldestKept)}, after the week began` };
  const week = rows.filter((r) => r.created_at >= since && r.created_at < until);
  return {
    sent: week.filter((r) => r.state === "sent").length,
    notDelivered: week.filter((r) => r.state === "failed" || r.state === "uncertain").length,
    queued: week.filter((r) => r.state === "pending" || r.state === "sending").length,
  };
}

// Africa/Cairo's offset from UTC at a moment, in ms (UTC+2 in winter, UTC+3 in summer).
function cairoOffset(at: number): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "Africa/Cairo", hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" })
    .formatToParts(at).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(at / 1000) * 1000;
}

/** The scheduled run (Sunday 21:00 Cairo) on or before now: its week and its key. */
export function scheduledWeek(now: number): { key: string; since: number; until: number } {
  const local = new Date(now + cairoOffset(now));
  const sunday = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - local.getUTCDay(), 21);
  const at = (wall: number) => wall - cairoOffset(wall - cairoOffset(wall));
  let until = at(sunday);
  if (until > now) until = at(sunday - 7 * 86_400_000);
  const key = new Date(until + cairoOffset(until)).toISOString().slice(0, 10);
  return { key, since: at(Date.parse(`${key}T21:00:00.000Z`) - 7 * 86_400_000), until };
}

export function captainMessage(scorecard: string, d: ScorecardData, ctx: { home: string; project: string; captain: string; marker: string }): string {
  const range = `--since ${d.since} --until ${d.until}`;
  return [
    ctx.marker,
    `Weekly scorecard and reflect (automation, week ending ${day(d.until)}). Do these in order:`,
    `1. Post the scorecard below to the owner unchanged, as its own message, in the ${SCORECARD_PROJECT} project topic.`,
    `2. Dispatch the weekly reflect crew: firstmate_dispatch projectId=${ctx.project} role=builder playbook=none title="Weekly reflect ${day(d.until)}" with the reflect task below as its task.`,
    "3. When it finishes, send the owner its CHANGELOG lines, one line per skill or rule edit. If it made no edit, say so in one line.",
    "",
    "Scorecard:",
    scorecard,
    "",
    "Reflect task:",
    "Run pstack `reflect` over this week's owner corrections, checker verdicts, done claims without proof and redone work. Use `principle-encode-lessons-in-structure`.",
    `1. Read the week, for captain ${ctx.captain}: bb firstmate corrections list --captain ${ctx.captain} ${range} --json, and bb firstmate scorecard --captain ${ctx.captain} ${range} --json for each item, its notes and its source.`,
    "2. Find the patterns that repeat. For each, pick the smallest structural fix: a check or test, a tool refusal, a skill edit, or a captain.md rule.",
    `3. Skill and code edits: open one PR with the \`pr\` skill. Captain rules: edit ${ctx.home}/${CAPTAIN_FILE}; it keeps at most ${CAPTAIN_MAX_RULES} lines, so move the oldest rules to ${ctx.home}/${CAPTAIN_ARCHIVE_FILE} first.`,
    "4. End your final message with one line per edit: CHANGELOG: <one plain line for the owner, with no technical words>. With no edit, write CHANGELOG: no change this week.",
  ].join("\n");
}
