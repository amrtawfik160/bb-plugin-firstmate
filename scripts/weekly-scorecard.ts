#!/usr/bin/env node
// Weekly scorecard and reflect (owner decisions Q16, Q21). A BB script automation runs
//   node scripts/weekly-scorecard.ts --send      Sunday 21:00 Cairo
// It covers the scheduled week: the 7 days up to the Sunday 21:00 Cairo run on or before
// now, so a late retry covers the same week. It reads the week's Firstmate counts
// (bb firstmate scorecard) and the Telegram connector's records (bb telegram export), then
// sends the captain one message: the scorecard to post in the "Hanoon & tools" topic, and the
// reflect crew to dispatch. Without --send it prints that message and sends nothing.
// One message per scheduled week: the run saves the week and its operation id before it
// sends, and a later run looks for that marker in the captain's log before it sends again.
// Env: FM_CAPTAIN_THREAD (the live captain), FM_REFLECT_PROJECT (the BB project of the reflect
// crew). Optional: FM_SCORECARD_STATE (state file). --now <iso> sets the clock.
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { captainMessage, renderScorecard, scheduledWeek, telegramWeek, type ScorecardData, type TelegramWeek } from "../owner/scorecard.ts";
import { bb, findMessage } from "./bb-calls.ts";
import { singleRun } from "./single-run.ts";

const args = process.argv.slice(2);
const send = args.includes("--send");
const nowArg = args.includes("--now") ? args[args.indexOf("--now") + 1] : undefined;
const captain = process.env.FM_CAPTAIN_THREAD ?? "";
const project = process.env.FM_REFLECT_PROJECT ?? "";
if (captain === "" || (send && project === "")) {
  console.error("weekly-scorecard: set FM_CAPTAIN_THREAD, and FM_REFLECT_PROJECT for --send.");
  process.exit(2);
}
const now = nowArg === undefined ? Date.now() : Date.parse(nowArg);
if (!Number.isFinite(now)) {
  console.error(`weekly-scorecard: --now ${nowArg} is not a date.`);
  process.exit(2);
}
const statePath = process.env.FM_SCORECARD_STATE || join(homedir(), ".bb-firstmate", "scorecard", "state.json");
singleRun(`${statePath}.lock`, "weekly-scorecard");

type Entry = { op: string; text: string; sent: boolean; at: string; receipt?: unknown };
type State = { weeks?: Record<string, Entry> };
let state: State = {};
try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { state = {}; }
const save = (next: State) => {
  writeFileSync(`${statePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${statePath}.tmp`, statePath);
};
// The Telegram read and the log search each get a budget well inside the automation's 10
// minutes, so the captain still gets the scorecard when the connector hangs.
const EXPORT_BUDGET_MS = Number(process.env.FM_SCORECARD_EXPORT_BUDGET_MS) || 3 * 60_000;
const SEARCH_BUDGET_MS = Number(process.env.FM_SCORECARD_SEARCH_BUDGET_MS) || 3 * 60_000;
const week = scheduledWeek(now);
const prior = state.weeks?.[week.key];
const record = (entry: Entry) => save({ weeks: Object.fromEntries([...Object.entries(state.weeks ?? {}), [week.key, entry]].slice(-10)) });

function tell(text: string): unknown {
  const scratch = mkdtempSync(join(tmpdir(), "scorecard-"));
  try {
    writeFileSync(join(scratch, "message.md"), text);
    const out = bb(["thread", "tell", captain, "--message-file", join(scratch, "message.md"), "--json"]);
    try { return JSON.parse(out); } catch { return out.trim(); }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

type Row = { created_at: number; state: string };
// The connector's outbox rows in order of creation. Row 0 alone can prove the week incomplete.
// A binary search over single rows finds the week's first row; pages from there shrink when
// the connector says a page is too large. Every call and the whole read have a time budget.
function readTelegram(since: number, until: number): TelegramWeek {
  const deadline = Date.now() + EXPORT_BUDGET_MS;
  const rows = (offset: number, limit: number): Row[] => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("budget");
    return (JSON.parse(bb(["telegram", "export", "--offset", String(offset), "--limit", String(limit)], Math.min(30_000, left))).outbox ?? []) as Row[];
  };
  try {
    const first = rows(0, 1);
    if (first.length === 0) return telegramWeek([], null, since, until);
    if (first[0]!.created_at > since) return telegramWeek([], first[0]!.created_at, since, until);
    const before = (offset: number) => { const [row] = rows(offset, 1); return row !== undefined && row.created_at < since; };
    // The first row at or after `since`: row 0 when it is not before the week.
    let lo = 0;
    let hi = first[0]!.created_at < since ? 1 : 0;
    if (hi > 0) {
      while (before(hi)) { lo = hi; hi *= 2; }
      while (lo + 1 < hi) { const mid = Math.floor((lo + hi) / 2); if (before(mid)) lo = mid; else hi = mid; }
    }
    const week: Row[] = [];
    let size = 20;
    for (let offset = hi; ;) {
      let page: Row[];
      try { page = rows(offset, size); } catch (error) {
        if (size > 1 && /too large/i.test(String((error as { stderr?: string }).stderr ?? error))) { size = Math.max(1, Math.floor(size / 2)); continue; }
        throw error;
      }
      week.push(...page);
      if (page.length < size || page[page.length - 1]!.created_at >= until) break;
      offset += page.length;
    }
    return telegramWeek(week, first[0]!.created_at, since, until);
  } catch (error) {
    return { unavailable: Date.now() >= deadline || (error as { code?: string }).code === "ETIMEDOUT" || String(error).includes("budget") ? "export timed out" : "bb telegram export failed" };
  }
}

const earlier = send && prior !== undefined && !prior.sent ? findMessage(captain, prior.text.split("\n")[0]!, Date.parse(prior.at), SEARCH_BUDGET_MS) : undefined;
if (send && prior?.sent) {
  console.log(`weekly-scorecard: already sent the week ending ${week.key}`);
} else if (earlier === "found") {
  record({ ...prior!, sent: true });
  console.log(`weekly-scorecard: confirmed the week ending ${week.key} in ${captain}'s log; nothing sent again`);
} else if (earlier === "unknown") {
  console.log(`weekly-scorecard: none: cannot confirm whether the week ending ${week.key} was sent; the log search did not finish. It runs again next time.`);
} else if (earlier === "absent") {
  const receipt = tell(prior!.text);
  record({ ...prior!, sent: true, receipt });
  console.log(`weekly-scorecard: sent the week ending ${week.key} to ${captain} (its whole log since the first try has no such message)`);
} else {
  const iso = (at: number) => new Date(at).toISOString();
  const card = JSON.parse(bb(["firstmate", "scorecard", "--captain", captain, "--since", iso(week.since), "--until", iso(week.until), "--json"])) as ScorecardData & { home: string };
  const data: ScorecardData = { ...card, telegram: readTelegram(week.since, week.until) };
  const scorecard = renderScorecard(data);
  const op = randomBytes(4).toString("hex");
  const message = captainMessage(scorecard, data, { home: card.home, project: project || "<project id>", captain, marker: `[weekly-scorecard ${week.key} ${op}]` });
  if (!send) {
    console.log(scorecard);
    console.log(`\n--- dry run: nothing sent. The captain would get: ---\n${message}`);
  } else {
    const at = new Date().toISOString();
    record({ op, text: message, sent: false, at });
    const receipt = tell(message);
    record({ op, text: message, sent: true, at, receipt });
    console.log(`weekly-scorecard: sent the week ending ${week.key} to ${captain}`);
  }
}
