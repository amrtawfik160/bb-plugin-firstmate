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
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { captainMessage, renderScorecard, scheduledWeek, telegramWeek, type ScorecardData, type TelegramWeek } from "../owner/scorecard.ts";
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

type State = { weeks?: Record<string, { op: string; text: string; sent: boolean }> };
let state: State = {};
try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { state = {}; }
const save = (next: State) => {
  writeFileSync(`${statePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${statePath}.tmp`, statePath);
};
const bb = (argv: string[]) => execFileSync("bb", argv, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const week = scheduledWeek(now);
const prior = state.weeks?.[week.key];
const record = (entry: { op: string; text: string; sent: boolean }) => save({ weeks: Object.fromEntries([...Object.entries(state.weeks ?? {}), [week.key, entry]].slice(-10)) });

function tell(text: string): void {
  const scratch = mkdtempSync(join(tmpdir(), "scorecard-"));
  try {
    writeFileSync(join(scratch, "message.md"), text);
    bb(["thread", "tell", captain, "--message-file", join(scratch, "message.md")]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// The connector's outbox rows in order of creation, 20 per page. Pages before the week are
// skipped by a binary search over page numbers.
function readTelegram(since: number, until: number): TelegramWeek {
  try {
    const page = (n: number) => (JSON.parse(bb(["telegram", "export", "--offset", String(n * 20), "--limit", "20"])).outbox ?? []) as { created_at: number; state: string }[];
    const first = page(0);
    if (first.length === 0) return telegramWeek([], null, since, until);
    const reaches = (rows: { created_at: number }[]) => rows.length === 0 || rows[rows.length - 1]!.created_at >= since;
    let lo = 0;
    let hi = 0;
    while (!reaches(hi === 0 ? first : page(hi))) { lo = hi; hi = hi === 0 ? 1 : hi * 2; }
    while (lo < hi) { const mid = Math.floor((lo + hi) / 2); if (reaches(mid === 0 ? first : page(mid))) hi = mid; else lo = mid + 1; }
    const rows: { created_at: number; state: string }[] = [];
    for (let n = hi; ; n++) {
      const p = n === 0 ? first : page(n);
      rows.push(...p);
      if (p.length < 20 || p[p.length - 1]!.created_at >= until) break;
    }
    return telegramWeek(rows, first[0]!.created_at, since, until);
  } catch {
    return { unavailable: "bb telegram export failed" };
  }
}

if (send && prior?.sent) {
  console.log(`weekly-scorecard: already sent the week ending ${week.key}`);
} else if (send && prior !== undefined && bb(["thread", "log", captain, "--limit", "100"]).includes(prior.text.split("\n")[0]!)) {
  record({ ...prior, sent: true });
  console.log(`weekly-scorecard: confirmed the week ending ${week.key} in ${captain}'s log; nothing sent again`);
} else if (send && prior !== undefined) {
  tell(prior.text);
  record({ ...prior, sent: true });
  console.log(`weekly-scorecard: sent the week ending ${week.key} to ${captain} (the earlier send was not delivered)`);
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
    record({ op, text: message, sent: false });
    tell(message);
    record({ op, text: message, sent: true });
    console.log(`weekly-scorecard: sent the week ending ${week.key} to ${captain}`);
  }
}
