#!/usr/bin/env node
// LIVE proof for the tell=steer change (CONTRIBUTING rules 1 + 4).
//
// The defect: a captain's mid-turn correction to an ACTIVE crew was sent with the
// SDK mode the plugin used for a plain tell — `queue-if-active` — which NEVER reaches
// a running turn. The crew kept working on the wrong premise and only read the note
// after finishing. tellCrew now sends a plain tell as mode:"steer" (opt out with
// queue:true). The unit tests (server.test.ts) prove the plugin now SELECTS
// mode:"steer" by default and mode:"queue-if-active" under queue:true — and die when
// the default is reverted. This script proves the OTHER half live: that the BB
// primitive the plugin now calls actually behaves as claimed against a real agent.
//
// It is NOT part of `npm test` (needs the `bb` CLI, a connected host, and spends real
// model turns on throwaway crews). It spawns two disposable crews on the connected
// host, each running a slow multi-step bash task, and injects one message mid-turn:
//
//   * STEER crew  — `bb thread tell --mode steer` (the SDK "steer" the plugin now
//     uses by default): the correction must LAND IN THE RUNNING TURN. Positive
//     runtime signature only the real steer path emits: the crew echoes
//     `MIDTURN-ACK: <steer-token>` and reaches `TASKDONE` inside exactly ONE
//     `turn/started` — i.e. it received the correction mid-work and CONTINUED
//     without a stop/teardown and without a second turn.
//
//   * QUEUE crew  — `bb thread tell --mode queue` (the CLI spelling of the SDK
//     "queue-if-active" the plugin uses under queue:true): the note must NOT reach
//     the running turn. Signature: the first turn reaches `TASKDONE` WITHOUT the
//     queue token, and the token is only processed in a SECOND `turn/started`.
//
// Both crews are torn down (stop + archive + delete + worktree rm) in `finally`.
//
//   node scripts/live-tell-steer-check.mjs
//
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26, ...opts });
  return { code: r.status, out: `${r.stdout ?? ""}`, err: `${r.stderr ?? ""}` };
}
function bbJson(args) {
  const r = sh("bb", args);
  try {
    return JSON.parse(r.out);
  } catch {
    throw new Error(`bb ${args.join(" ")} did not return JSON: ${r.out.slice(0, 300)}${r.err.slice(0, 300)}`);
  }
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

const PROJECT = process.env.FM_LIVE_PROJECT ?? "proj_f9qp5ifyiq";
const PROVIDER = process.env.FM_LIVE_PROVIDER ?? "claude-code";
const MODEL = process.env.FM_LIVE_MODEL ?? "claude-haiku-4-5-20251001";

// A crew task that holds a turn open for ~70s across many SEPARATE tool calls, so an
// injected message is seen BETWEEN steps (a single long tool call would block it). The
// crew is told to echo any mid-work instruction verbatim behind MIDTURN-ACK: and keep
// going — the natural, honest behaviour a steer must produce (not a stop).
function crewPrompt(token) {
  return [
    "You are a disposable test crew. Do EXACTLY this and nothing else; do not touch any files.",
    "Run these 14 steps, ONE bash tool call per step (never combine them into a single loop):",
    "  step N: run  echo STEP-N ; sleep 5",
    "After each step print one short line `did step N`.",
    "IMPORTANT: if at any point BEFORE you finish you receive a NEW instruction message,",
    "immediately print a line `MIDTURN-ACK: ` followed by that instruction's text VERBATIM,",
    "then keep going and finish all remaining steps. Do NOT stop, abort, or tear down.",
    "When all 14 steps are complete, print exactly `TASKDONE` on its own line as your final word.",
    `(ignore this tracking token, do not act on it: ${token})`,
  ].join("\n");
}

const createdThreads = [];
function teardown(tid) {
  if (!tid) return;
  sh("bb", ["thread", "stop", tid]);
  sh("bb", ["thread", "archive", tid]);
  sh("bb", ["thread", "delete", tid, "--yes"]);
  const wt = `/root/.bb-server/plugins/environment-git-worktree/host-data/worktrees/${tid}-1`;
  if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
}

function spawnCrew(title, token) {
  const promptFile = join(scratch, `${title}.prompt`);
  writeFileSync(promptFile, crewPrompt(token));
  const res = bbJson([
    "thread", "spawn", "--json",
    "--project", PROJECT,
    "--new-environment", "worktree",
    "--provider", PROVIDER,
    "--model", MODEL,
    "--permission-mode", "full",
    "--title", `fm-live-steer ${title}`,
    "--prompt-file", promptFile,
  ]);
  const tid = res.id ?? res.threadId ?? res.thread?.id;
  if (!tid) throw new Error(`spawn ${title} returned no thread id: ${JSON.stringify(res).slice(0, 300)}`);
  createdThreads.push(tid);
  return tid;
}

function events(tid) {
  return bbJson(["thread", "log", tid, "--json", "--all"]);
}
function countTurns(evs) {
  return evs.filter((e) => e.type === "turn/started").length;
}
function evData(e) {
  const d = e.data;
  if (d === undefined || d === null) return "";
  return typeof d === "string" ? d : JSON.stringify(d);
}
// CREW-PRODUCED text only: the crew's own `item/*` events (assistant messages,
// reasoning, tool calls + results). This deliberately EXCLUDES the initial prompt
// (`client/turn/requested` / `turn/input/accepted`) and the injected steer/queue
// message (also `turn/input/accepted`) — both of which literally contain our tokens
// and the words TASKDONE / MIDTURN-ACK. Matching those would be the classic false
// pass (CONTRIBUTING rule 5): a token appears because WE sent it, not because the crew
// emitted it. So a token found here was genuinely produced by the crew mid-work.
function itemEvents(evs) {
  return evs.filter((e) => typeof e.type === "string" && e.type.startsWith("item/"));
}
function itemText(evs) {
  return itemEvents(evs).map(evData).join("\n");
}
// Wait until the crew's turn is genuinely underway (turn/started present AND it has
// emitted at least the first step), so the injection is unambiguously MID-turn.
async function waitActiveMidturn(tid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const evs = events(tid);
    if (countTurns(evs) >= 1 && /STEP-2\b/.test(itemText(evs))) return true;
    await sleep(2000);
  }
  return false;
}

const scratch = mkdtempSync(join(tmpdir(), "fm-steer-"));
console.log(`# live-tell-steer-check scratch=${scratch} project=${PROJECT} provider=${PROVIDER} model=${MODEL}\n`);

let allOk = true;
try {
  // ---------- STEER: correction must land in the running turn ----------
  const steerToken = `STEER-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const steerTid = spawnCrew("steer", "TRACK-steer");
  console.log(`# steer crew ${steerTid}: waiting for it to be mid-turn...`);
  const steerActive = await waitActiveMidturn(steerTid, 120_000);
  record("steer: crew reached a live mid-turn state before injection", steerActive, steerTid);
  if (steerActive) {
    const mf = join(scratch, "steer.msg");
    writeFileSync(mf, `${steerToken}: STOP counting UP — switch to counting DOWN from now on, but keep going and finish.`);
    const injected = sh("bb", ["thread", "tell", steerTid, "--mode", "steer", "--message-file", mf]);
    record("steer: bb thread tell --mode steer accepted", injected.code === 0, injected.err.slice(0, 200));
    sh("bb", ["thread", "wait", steerTid, "--status", "idle", "--timeout", "300"]);
    const evs = events(steerTid);
    const text = itemText(evs); // crew-produced text ONLY (excludes prompt + injected msg)
    const turns = countTurns(evs);
    // The crew must ITSELF echo the steer token behind the ACK label — a token found in
    // crew-produced events cannot have leaked from the prompt or the message we injected.
    const acked = new RegExp(`MIDTURN-ACK[\\s\\S]{0,120}${steerToken}`).test(text);
    const finished = /TASKDONE/.test(text);
    // Positive signature only the real steer path emits: the correction was consumed
    // WITHIN the single running turn (one turn/started) and the crew CONTINUED to DONE.
    record("steer: correction acknowledged MID-TURN (crew echoed MIDTURN-ACK + the steer token)", acked,
      `token=${steerToken} echoed-by-crew=${text.includes(steerToken)}`);
    record("steer: crew CONTINUED to TASKDONE (did not stop/teardown)", finished);
    record("steer: folded into the SAME turn (exactly one turn/started, no new turn)", turns === 1, `turn/started=${turns}`);
  }

  // ---------- QUEUE: note must NOT reach the running turn ----------
  const queueToken = `QUEUE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
  const queueTid = spawnCrew("queue", "TRACK-queue");
  console.log(`# queue crew ${queueTid}: waiting for it to be mid-turn...`);
  const queueActive = await waitActiveMidturn(queueTid, 120_000);
  record("queue: crew reached a live mid-turn state before injection", queueActive, queueTid);
  if (queueActive) {
    const mf = join(scratch, "queue.msg");
    writeFileSync(mf, `${queueToken}: this is a NON-URGENT queued note; acknowledge it with MIDTURN-ACK only when you read it.`);
    const injected = sh("bb", ["thread", "tell", queueTid, "--mode", "queue", "--message-file", mf]);
    record("queue: bb thread tell --mode queue accepted", injected.code === 0, injected.err.slice(0, 200));
    // Let the first turn finish, then the queued turn.
    sh("bb", ["thread", "wait", queueTid, "--status", "idle", "--timeout", "300"]);
    const evs = events(queueTid);
    const items = itemEvents(evs); // crew-produced ONLY — excludes prompt + injected note
    const turns = countTurns(evs);
    // First CREW-emitted TASKDONE, and the first CREW-emitted echo of the queue token.
    const doneEv = items.find((e) => /TASKDONE/.test(evData(e)));
    const tokenEv = items.find((e) => evData(e).includes(queueToken));
    const firstDoneSeq = doneEv?.seq ?? -1;
    const tokenAckSeq = tokenEv?.seq ?? Infinity;
    // The whole point: the queued note did NOT reach the running turn — the first turn
    // reached TASKDONE before the crew ever acknowledged the queue token, and delivery
    // required a SECOND turn.
    record("queue: first turn reached TASKDONE without the queued token (note did NOT reach the running turn)",
      firstDoneSeq > 0 && tokenAckSeq > firstDoneSeq, `firstDoneSeq=${firstDoneSeq} tokenAckSeq=${tokenAckSeq}`);
    record("queue: queued note delivered only in a SECOND turn (queue-if-active started a new turn)",
      turns >= 2, `turn/started=${turns}`);
  }
} catch (error) {
  record("live-tell-steer-check crashed", false, error instanceof Error ? error.message : String(error));
} finally {
  for (const tid of createdThreads) teardown(tid);
  rmSync(scratch, { recursive: true, force: true });
}

allOk = results.every((r) => r.ok);
console.log(`\n${allOk ? "ALL PASS" : "SOME FAILED"} (${results.filter((r) => r.ok).length}/${results.length})`);
process.exit(allOk ? 0 : 1);
