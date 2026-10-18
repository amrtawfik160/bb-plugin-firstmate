import assert from "node:assert/strict";
import test from "node:test";
import { bbPingCarriesOutcome, captainCompactDue, inboxWakeText, waitNoTurnsFor } from "./server.ts";

/**
 * Replay of one realistic day of the Hanoon captain (token report, 17-18 Oct 2026), before and after each token cut
 * of the 18 Oct owner decisions (Q9, Q11-Q13, Q18; Q10 is another change). The day is generated from a fixed seed with the report's daily counts:
 * 107 owner messages in bursts, 752 crew turn ends (141 of them WAITING), about 300 routine plugin wakes, 505 captain
 * tells to crews, and the captain's free texts. Every policy decision goes through the production function that
 * makes it. What the replay does not model: provider latency, turns the provider starts itself, and the repair thread.
 */

type Event =
  | { at: number; kind: "owner" }
  | { at: number; kind: "crew-end"; crew: string; outcome: "WAITING" | "DONE" | "FAILED" }
  | { at: number; kind: "routine" }
  | { at: number; kind: "tell"; crew: string; text: string };

const DAY_MS = 24 * 3_600_000;
const TURN_MS = 60_000; // a captain turn: about 4.4 model calls (report).
const CALLS_PER_TURN = 4.4;

function rng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function day(seed = 18_10_2026): Event[] {
  const random = rng(seed);
  const at = () => Math.floor(random() * DAY_MS);
  const events: Event[] = [];
  const crews = Array.from({ length: 24 }, (_, i) => `crew${i}`);
  // Owner messages arrive in bursts of 1 to 6, a few seconds apart: 107 in all.
  for (let left = 107; left > 0;) {
    const start = at();
    const burst = Math.min(left, 1 + Math.floor(random() * 6));
    for (let i = 0; i < burst; i++) events.push({ at: start + i * 4_000, kind: "owner" });
    left -= burst;
  }
  for (let i = 0; i < 752; i++) {
    const outcome = i < 141 ? "WAITING" : i < 141 + 40 ? "FAILED" : "DONE";
    events.push({ at: at(), kind: "crew-end", crew: crews[i % crews.length]!, outcome });
  }
  // Routine plugin wakes (delivery notices, doorbells, fm-watch) come in small clusters, 0.5 to 4 s apart.
  for (let left = 300; left > 0;) {
    let t = at();
    const cluster = Math.min(left, 1 + Math.floor(random() * 4));
    for (let i = 0; i < cluster; i++) { events.push({ at: t, kind: "routine" }); t += 500 + Math.floor(random() * 3_500); }
    left -= cluster;
  }
  for (let i = 0; i < 505; i++) {
    const long = i % 50 === 0;
    events.push({ at: at(), kind: "tell", crew: crews[i % crews.length]!, text: long ? "x".repeat(13_000) : `Instruction ${i}: rebase on main and rerun the focused tests.` });
  }
  return events.sort((a, b) => a.at - b.at);
}

type Cuts = {
  freeTextOnTurnStart: boolean; // item 2, Firstmate side
  typedTurnNoReminder: boolean; // item 2, connector side
  parentNotifications: "auto" | "stuck"; // item 3
  wakeBatchMs: number; // item 4
  inboxInWake: boolean; // item 5
  waitNoTurnsCrews: string; // item 6
};

const BEFORE: Cuts = { freeTextOnTurnStart: false, typedTurnNoReminder: false, parentNotifications: "auto", wakeBatchMs: 1_500, inboxInWake: false, waitNoTurnsCrews: "" };

/**
 * One captain: an event that reaches it while idle starts a turn; one that reaches it mid-turn joins that turn.
 * A turn ends with a free text with probability 0.35 and sends a typed message (reply, card, alert) with 0.2.
 */
function captainTurns(events: Event[], cuts: Cuts, seed = 7): { turns: number; reminderTurns: number; pingTurns: number } {
  const random = rng(seed);
  const waiting = new Set<string>();
  // What reaches the captain, and when.
  const arrivals: Array<{ at: number; kind: "owner" | "ping" | "routine"; crew?: string; outcome?: string }> = [];
  for (const event of events) {
    if (event.kind === "owner") arrivals.push({ at: event.at, kind: "owner" });
    if (event.kind === "routine") arrivals.push({ at: event.at, kind: "routine" });
    if (event.kind === "crew-end") {
      if (event.outcome === "WAITING") waiting.add(event.crew); else waiting.delete(event.crew);
      const kind = event.outcome === "FAILED" ? "error" : "idle";
      // BB pings the captain about 2 s after a crew turn ends, unless the crew was spawned to ping only when stuck.
      const bbPings = bbPingCarriesOutcome({ kind, durable: true, captainThreadId: "cap", crewParentThreadId: "cap", crewOriginKind: null, crewParentNotifications: cuts.parentNotifications });
      if (bbPings) arrivals.push({ at: event.at + 2_000, kind: "ping", crew: event.crew, outcome: event.outcome });
      // Without BB's ping, Firstmate's own doorbell reports it; a WAITING crew never wakes the captain (handleWaitingYield).
      else if (event.outcome !== "WAITING") arrivals.push({ at: event.at + 3_000, kind: "routine" });
    }
  }
  // Routine wakes are held for the batch window that the first one opens (holdCaptainWake), then sent as one wake.
  const routine = arrivals.filter((a) => a.kind === "routine").map((a) => a.at).sort((a, b) => a - b);
  const wakes: number[] = [];
  for (let k = 0; k < routine.length;) {
    const due = routine[k]! + cuts.wakeBatchMs;
    while (k < routine.length && routine[k]! <= due) k += 1;
    wakes.push(due);
  }
  const queue = [...arrivals.filter((a) => a.kind !== "routine"), ...wakes.map((at) => ({ at, kind: "routine" as const }))].sort((a, b) => a.at - b.at);
  let turns = 0, reminderTurns = 0, pingTurns = 0;
  let busyUntil = -1;
  // A turn ended at `end`: before this change its free text made Firstmate start a reminder turn 1 s later.
  const settle = (until: number): void => {
    while (busyUntil >= 0 && busyUntil < until) {
      const end = busyUntil;
      busyUntil = -1;
      const freeText = random() < 0.35;
      const typed = random() < 0.2;
      if (!freeText || (cuts.typedTurnNoReminder && typed) || cuts.freeTextOnTurnStart) continue;
      if (end + 1_000 >= until) continue; // the next real wake starts the turn; the reminder joins it
      reminderTurns += 1; turns += 1; busyUntil = end + 1_000 + TURN_MS;
      random(); random(); // a reminder turn answers with firstmate_free_text and writes no new free text
    }
  };
  for (const arrival of queue) {
    settle(arrival.at);
    if (busyUntil >= arrival.at) continue; // joins the running turn
    turns += 1; busyUntil = arrival.at + TURN_MS;
    if (arrival.kind === "ping") pingTurns += 1;
  }
  settle(Number.MAX_SAFE_INTEGER);
  return { turns, reminderTurns, pingTurns };
}

/** Model calls a crew spends on Firstmate's tells: the woken turn, plus the inbox read and its acknowledgement when the text is not in the wake. */
function crewTellCalls(events: Event[], cuts: Cuts): number {
  let calls = 0;
  for (const event of events) {
    if (event.kind !== "tell") continue;
    const inline = cuts.inboxInWake && inboxWakeText({ crewId: event.crew, records: [{ id: "001.msg", body: event.text }] }) !== null;
    calls += inline ? 1 : 3;
  }
  return calls;
}

/** Crew turns spent on WAITING: each WAITING report costs the resume turns Firstmate schedules (one per 5 minutes for a 30-minute wait). */
function crewWaitingTurns(events: Event[], cuts: Cuts): number {
  let turns = 0;
  for (const event of events) {
    if (event.kind !== "crew-end" || event.outcome !== "WAITING") continue;
    // A crew under native wait-no-turns blocks in one foreground command: no resume turns.
    turns += waitNoTurnsFor(cuts.waitNoTurnsCrews, event.crew) ? 0 : 6;
  }
  return turns;
}

/**
 * Tokens the captain rereads in a day: every model call rereads the whole context, which grows ~4.2k tokens per turn.
 * The model assumes each compaction shrinks the context to 65k. A compaction that does not shrink it is not retried
 * (check 158/1), so a failed compaction leaves the old reread cost, not a loop.
 */
function captainContextTokens(turns: number, budget: number, ratio: number, before: boolean): { compactions: number; tokens: number } {
  let context = 63_000, compactions = 0, tokens = 0, lastAt: number | null = null;
  for (let turn = 0; turn < turns; turn++) {
    tokens += context * CALLS_PER_TURN;
    context += 4_200;
    const now = turn * (DAY_MS / turns);
    // Before this change the trigger was the larger of the budget and the share (main 0f47019).
    const due = before
      ? context >= Math.max(budget, 1_000_000 * ratio) && (lastAt === null || now - lastAt >= 1_200_000)
      : captainCompactDue({ usedTokens: context, modelContextWindow: 1_000_000, estimated: false, budget, ratio, providerThreshold: 967_000, lastCompactAt: lastAt, now, cooldownMs: 1_200_000 });
    if (due) { compactions += 1; context = 65_000; lastAt = now; }
  }
  return { compactions, tokens };
}

test("token day replay: each cut lowers captain turns or crew calls, measured on one realistic day", (t) => {
  const events = day();
  const AFTER: Cuts = { freeTextOnTurnStart: false, typedTurnNoReminder: false, parentNotifications: "auto", wakeBatchMs: 5_000, inboxInWake: true, waitNoTurnsCrews: "crew3" };
  const base = captainTurns(events, BEFORE);
  const rows: Array<[string, number, number, string]> = [];
  const step = (label: string, cuts: Cuts) => captainTurns(events, cuts);

  // Free-text reminders (Q10) are owned by another change; this replay leaves them as they are.
  const stuck = step("item 3 (stuck)", { ...BEFORE, parentNotifications: "stuck" });
  rows.push(["captain turns: crews spawned with parentNotifications=stuck (item 3, BB 0.46.2, off by default)", base.turns, stuck.turns, "turns per day"]);
  assert.ok(stuck.pingTurns < base.pingTurns, "no BB ping for a finished or WAITING turn");
  assert.ok(stuck.turns < base.turns);

  const batch = step("item 4", { ...BEFORE, wakeBatchMs: 5_000 });
  rows.push(["captain turns: routine wakes batched 5 s, not 1.5 s (item 4)", base.turns, batch.turns, "turns per day"]);
  assert.ok(batch.turns <= base.turns);

  const all = captainTurns(events, AFTER);
  rows.push(["captain turns: item 4 (stuck stays off)", base.turns, all.turns, "turns per day"]);
  assert.ok(all.turns < base.turns);

  const tellBefore = crewTellCalls(events, BEFORE), tellAfter = crewTellCalls(events, AFTER);
  rows.push(["crew model calls for captain tells (item 5)", tellBefore, tellAfter, "calls per day, all crews"]);
  assert.equal(tellBefore, 505 * 3);
  assert.equal(tellAfter, 494 + 11 * 3, "a text past the size cap (11 of 505) still uses the inbox pointer");

  const waitBefore = crewWaitingTurns(events, BEFORE), waitAfter = crewWaitingTurns(events, AFTER);
  rows.push(["crew resume turns for WAITING, canary crew3 only (item 6)", waitBefore, waitAfter, "turns per day, all crews"]);
  assert.ok(waitAfter < waitBefore && waitAfter > 0, "only the canary crew changes");

  const ctxBefore = captainContextTokens(base.turns, 200_000, 0.6, true);
  const ctxAfter = captainContextTokens(all.turns, 200_000, 0.9, false);
  rows.push(["captain compactions (item 1)", ctxBefore.compactions, ctxAfter.compactions, "per day"]);
  rows.push(["captain context tokens reread (item 1, with item 4)", Math.round(ctxBefore.tokens / 1e6), Math.round(ctxAfter.tokens / 1e6), "million tokens per day"]);
  assert.ok(ctxAfter.tokens < ctxBefore.tokens * 0.6, `${ctxBefore.tokens} -> ${ctxAfter.tokens}`);

  for (const [label, before, after, unit] of rows) t.diagnostic(`${label}: ${before} -> ${after} ${unit}`);
});
