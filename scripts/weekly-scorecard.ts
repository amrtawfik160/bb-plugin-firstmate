#!/usr/bin/env node
// Weekly scorecard and reflect (owner decisions Q16, Q21). A BB script automation runs
//   node scripts/weekly-scorecard.ts --send      Sunday 21:00 Cairo
// It reads the week's Firstmate counts (bb firstmate scorecard) and the Telegram connector's
// counts (bb telegram status), then sends the captain one message: the scorecard to post in
// the "Hanoon & tools" topic, and the reflect crew to dispatch. Without --send it prints that
// message and sends nothing. One message per week; a repeated run sends nothing.
// Env: FM_CAPTAIN_THREAD (the live captain), FM_REFLECT_PROJECT (the BB project of the reflect
// crew). Optional: FM_SCORECARD_STATE (state file). --until <iso> sets the end of the week.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { captainMessage, renderScorecard, telegramNoise, type ScorecardData } from "../owner/scorecard.ts";

const args = process.argv.slice(2);
const send = args.includes("--send");
const untilArg = args.includes("--until") ? args[args.indexOf("--until") + 1] : undefined;
const captain = process.env.FM_CAPTAIN_THREAD ?? "";
const project = process.env.FM_REFLECT_PROJECT ?? "";
if (captain === "" || (send && project === "")) {
  console.error("weekly-scorecard: set FM_CAPTAIN_THREAD, and FM_REFLECT_PROJECT for --send.");
  process.exit(2);
}
const statePath = process.env.FM_SCORECARD_STATE || join(homedir(), ".bb-firstmate", "scorecard", "state.json");
const until = untilArg === undefined ? Date.now() : Date.parse(untilArg);
if (!Number.isFinite(until)) {
  console.error(`weekly-scorecard: --until ${untilArg} is not a date.`);
  process.exit(2);
}
const since = until - 7 * 86_400_000;
const week = new Date(until).toLocaleDateString("en-CA", { timeZone: "Africa/Cairo" });

type State = { week?: string; telegram?: { sent: number; failed: number; at: string } };
let state: State = {};
try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { state = {}; }
if (send && state.week === week) {
  console.log(`weekly-scorecard: already sent the week ending ${week}`);
  process.exit(0);
}

const bb = (argv: string[]) => execFileSync("bb", argv, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const card = JSON.parse(bb(["firstmate", "scorecard", "--captain", captain, "--since", new Date(since).toISOString(), "--until", new Date(until).toISOString(), "--json"])) as ScorecardData & { home: string };
let status: Parameters<typeof telegramNoise>[0] | null = null;
try { status = JSON.parse(bb(["telegram", "status", "--json"])); } catch { status = null; }
const noise = status === null ? null : telegramNoise(status, state.telegram);
const data: ScorecardData = { ...card, telegram: noise === null ? null : noise.week };
const scorecard = renderScorecard(data);
const message = captainMessage(scorecard, data, { home: card.home, project: project || "<project id>", captain });

if (!send) {
  console.log(scorecard);
  console.log(`\n--- dry run: nothing sent. The captain would get: ---\n${message}`);
  process.exit(0);
}

const scratch = mkdtempSync(join(tmpdir(), "scorecard-"));
try {
  writeFileSync(join(scratch, "message.md"), message);
  bb(["thread", "tell", captain, "--message-file", join(scratch, "message.md")]);
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
mkdirSync(dirname(statePath), { recursive: true });
const next: State = { week, telegram: noise === null ? state.telegram : { ...noise.now, at: new Date(until).toISOString() } };
writeFileSync(`${statePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
renameSync(`${statePath}.tmp`, statePath);
console.log(`weekly-scorecard: sent the week ending ${week} to ${captain}`);
