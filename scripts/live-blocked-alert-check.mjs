#!/usr/bin/env node
// LIVE proof for the missed-terminal reconcile (CONTRIBUTING rules 1 + 2).
//
// The defect: a crew dispatched through the real transport only gets its threadId
// persisted AFTER fm-spawn.sh returns. A fast crew ends its first turn — firing
// thread.idle (an in-band BLOCKED:/FAILED: both leave the thread idle) — before that
// write, so findCrewByThread returns undefined and the live event is dropped for
// good: no captain doorbell, no durable wake. The captain reproduced this twice on
// the merged plugin (crews 7b7db5c3, ba3552a2): state:blocked parsed fine, yet no
// `fm wake enqueued` line and no doorbell ever appeared.
//
// The plugin fix (server.ts) runs reconcileCrewTerminal once at the end of dispatch,
// after the record lands: it re-reads the thread's live state and drives the same
// handler a dropped live event would have. The unit tests in server.test.ts prove
// the plugin now WIRES that reconcile into dispatch and DIE when the two
// reconcileCrewTerminal calls are reverted.
//
// This script proves the OTHER half — that every REAL dependency the reconcile
// relies on behaves as claimed on the live host, without reloading the installed
// plugin. For BLOCKED and FAILED, fast and slow variants, it:
//
//   1. spawns a real scout through the REAL fm-spawn.sh (--backend bb --harness bb)
//      under a scratch FM_HOME (live /root/firstmate data/state untouched), and
//      waits until the crew is IDLE with its verdict — the exact "already idle when
//      the record lands" state the captain observed;
//   2. reads the thread with the SAME bb calls the reconcile uses
//      (`bb thread show` → status idle, `bb thread output` → the verdict text) and
//      feeds them to the ACTUAL parseOutcome + hasStatusProtocol from lib/policy.ts;
//   3. enqueues the durable wake with the REAL fm-wake-lib.sh fm_wake_append exactly
//      as the plugin's enqueueCaptainWake does, and asserts the `<id>.status` row
//      lands in the queue;
//   4. rings the doorbell built by the ACTUAL captainWakeDoorbell from server.ts via
//      a real `bb thread send`, and asserts it arrives in a real captain thread.
//
// Every real bb thread it creates (the captain inbox + each scout) is torn down.
//
//   node --experimental-strip-types scripts/live-blocked-alert-check.mjs
//
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseOutcome, hasStatusProtocol } from "../lib/policy.ts";
import { captainWakeDoorbell } from "../server.ts";

const NATIVE_FM = "/root/firstmate";
const PROJECT = process.env.FM_LIVE_PROJECT ?? "proj_f9qp5ifyiq";
const HOST = process.env.FM_LIVE_HOST ?? "host_m4jkvpkw67";
const REPO = process.env.FM_LIVE_REPO ?? "/root/github_projects/bb-plugin-firstmate";
const MODEL = process.env.FM_LIVE_MODEL ?? "claude-haiku-4-5-20251001";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 1 << 26, ...opts });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`, stdout: r.stdout ?? "" };
}
function shQuote(t) { return `'${String(t).replace(/'/g, `'\\''`)}'`; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SPAWNED = /window=bb:(thr_[a-z0-9]+)/m;

const created = [];
function teardown(tid) {
  sh("bb", ["thread", "stop", tid]);
  sh("bb", ["thread", "archive", tid]);
  sh("bb", ["thread", "delete", tid, "--yes"]);
  const wt = `/root/.bb-server/plugins/environment-git-worktree/host-data/worktrees/${tid}-1`;
  if (existsSync(wt)) rmSync(wt, { recursive: true, force: true });
}
function threadStatus(tid) {
  const r = sh("bb", ["thread", "show", tid, "--json"]);
  try { const j = JSON.parse(r.stdout); return j.status ?? j.thread?.status ?? "?"; } catch { return "?"; }
}
function threadOutput(tid) {
  const r = sh("bb", ["thread", "output", tid, "--json"]);
  try { const j = JSON.parse(r.stdout); return j.output ?? ""; } catch { return r.stdout; }
}
function threadLog(tid) {
  const r = sh("bb", ["thread", "log", tid]);
  return r.out;
}

const scratch = mkdtempSync(join(tmpdir(), "fm-blocked-alert-"));
const fmh = join(scratch, "fmhome");
console.log(`# live-blocked-alert-check scratch=${scratch} project=${PROJECT} host=${HOST}\n`);

const env = {
  ...process.env,
  FM_HOME: fmh, FM_ROOT: fmh, FM_BACKEND: "bb",
  FM_BB_PROJECT_ID: PROJECT, FM_BB_MACHINE: HOST, FM_BB_VISIBLE: "1",
  FM_SUPERVISION_MODEL: "autoarm", FM_BB_PROVIDER: "claude-code",
  FM_BINDIR: join(fmh, "bin-bb"),
};
const brief = (id) => join(fmh, "data", id, "brief.md");

function scaffoldAndFill(id, task) {
  sh(join(fmh, "bin-bb", "fm-brief.sh"), [id, "crew", "--scout"], { env });
  if (!existsSync(brief(id))) throw new Error(`fm-brief.sh did not scaffold ${id}`);
  const spec = "Do exactly the captain's intent above; report the verdict as instructed and nothing else.";
  writeFileSync(brief(id), readFileSync(brief(id), "utf8").replace("{TASK}", task).replace("{FIRSTMATE_SPEC}", spec));
}
function spawnScout(id) {
  const sp = sh(join(fmh, "bin-bb", "fm-spawn.sh"),
    [id, REPO, "--scout", "--backend", "bb", "--harness", "bb", "--model", MODEL],
    { env, timeout: 120000 });
  const m = SPAWNED.exec(sp.out);
  if (!m) throw new Error(`fm-spawn produced no thread for ${id}: ${sp.out.slice(-500)}`);
  created.push(m[1]);
  return m[1];
}
// Wait for the crew to reach the exact state the captain saw: idle with a verdict.
async function waitIdleWithVerdict(tid, timeoutMs = 210000) {
  const deadline = Date.now() + timeoutMs;
  let out = "", status = "?";
  while (Date.now() < deadline) {
    status = threadStatus(tid);
    out = threadOutput(tid);
    if (status === "idle" && parseOutcome(out)) return { status, out };
    await sleep(2500);
  }
  return { status, out };
}

// The plugin's enqueueCaptainWake, run against the REAL fm-wake-lib.sh under the
// scratch state dir (server.ts builds this exact script for runOnHost).
function enqueueDurableWake(crewId, note) {
  const stateDir = join(fmh, "state", "wake");
  const statusPath = join(stateDir, `${crewId}.status`);
  const key = `${crewId}.status`;
  const lib = join(fmh, "bin-bb", "fm-wake-lib.sh");
  const noteB64 = Buffer.from(note.replace(/[\r\n\t]+/g, " ").trim().slice(0, 800), "utf8").toString("base64");
  const script = [
    `export FM_HOME=${shQuote(fmh)}`,
    `export FM_ROOT=${shQuote(fmh)}`,
    `export FM_STATE_OVERRIDE=${shQuote(stateDir)}`,
    `[ -f ${shQuote(lib)} ] || { echo "error: missing ${lib}" >&2; exit 127; }`,
    `mkdir -p ${shQuote(stateDir)}`,
    `. ${shQuote(lib)}`,
    `note=$(printf '%s' ${shQuote(noteB64)} | base64 -d)`,
    `printf 'note: %s\\n' "$note" >> ${shQuote(statusPath)}`,
    `fm_wake_append signal ${shQuote(key)} ${shQuote(`crew ${crewId} update`)}`,
  ].join("\n");
  const r = sh("bash", ["-c", script], { env });
  const queue = join(stateDir, ".wake-queue");
  const queueText = existsSync(queue) ? readFileSync(queue, "utf8") : "";
  return { ok: r.code === 0, queueText, queue };
}

const CAPTAIN_PROMPT =
  "You are a disposable test inbox thread. Reply with exactly `INBOX READY` and stop. Do not do anything else, do not touch files.";

const VARIANTS = [
  { key: "fast-blocked", verb: "BLOCKED", wait: false },
  { key: "slow-blocked", verb: "BLOCKED", wait: true },
  { key: "fast-failed", verb: "FAILED", wait: false },
  { key: "slow-failed", verb: "FAILED", wait: true },
];

let captain = null;
try {
  // Scratch FM_HOME: the overlay-installed native firstmate WITHOUT its live data/state.
  const rc = sh("rsync", ["-a", "--exclude", "data/", "--exclude", "state/", `${NATIVE_FM}/`, `${fmh}/`]);
  if (rc.code !== 0) throw new Error(`rsync scratch FM_HOME failed: ${rc.out}`);
  mkdirSync(join(fmh, "data"), { recursive: true });
  mkdirSync(join(fmh, "state"), { recursive: true });

  // A real captain thread to receive the doorbells.
  const capSpawn = sh("bb", ["thread", "spawn", "--project", PROJECT, "--json", "--provider", "claude-code",
    "--model", MODEL, "--prompt", CAPTAIN_PROMPT]);
  try { captain = JSON.parse(capSpawn.stdout).id ?? JSON.parse(capSpawn.stdout).threadId; } catch {}
  if (!captain) throw new Error(`could not spawn captain inbox thread: ${capSpawn.out.slice(-400)}`);
  created.push(captain);
  console.log(`captain inbox thread=${captain}\n`);

  for (const v of VARIANTS) {
    const id = `alert-${v.key}`;
    const verdictLine = `${v.verb}: deliberate live test of the ${v.verb.toLowerCase()}-alert path (${v.key}) — no action needed, the captain expects this.`;
    // "slow" = a real, longer active→idle transition without leaning on the agent's
    // background-task machinery (which can outlast the idle-wait ceiling): make the
    // crew do a few seconds of in-turn work with ONE foreground bash step, then idle.
    const waitClause = v.wait
      ? "First run this exact single bash command as ONE foreground step and wait for it: `for i in $(seq 1 6); do echo working $i; sleep 3; done`. Do not use a background task. THEN "
      : "";
    const task = `This is a disposable live test — do not edit any files and do not open a PR. ${waitClause}reply with EXACTLY this line and nothing else:\n${verdictLine}`;
    scaffoldAndFill(id, task);
    const tid = spawnScout(id);

    const { status, out } = await waitIdleWithVerdict(tid);
    const outcome = parseOutcome(out);
    const reachedState = status === "idle" && outcome !== null && hasStatusProtocol(out);
    record(`${v.key}: real crew reaches idle with a parsed ${v.verb} verdict (reconcile's read inputs)`,
      reachedState && outcome.startsWith(`${v.verb}:`),
      reachedState ? `thread=${tid} status=${status} outcome=${JSON.stringify(outcome)}` : `status=${status} outcome=${JSON.stringify(outcome)} out=${JSON.stringify(out.slice(-200))}`);
    if (!reachedState) continue;

    // Durable wake — the real fm-wake queue must hold a row keyed <id>.status.
    const wake = enqueueDurableWake(id, outcome);
    const rowPresent = wake.ok && wake.queueText.includes(`${id}.status`);
    record(`${v.key}: durable wake row lands via the real fm-wake-lib (fm wake enqueued)`,
      rowPresent, rowPresent ? `queue has ${id}.status` : `enqueue ok=${wake.ok} queue=${JSON.stringify(wake.queueText.slice(-200))}`);

    // Doorbell — the real captainWakeDoorbell text delivered to the real captain
    // thread with mode:auto, exactly as the plugin's deliverToCaptain does.
    const head = `✅ crew ${id} done`; // kind stays "idle" for an in-band verdict (see notifyCaptain)
    const doorbell = captainWakeDoorbell(head, outcome);
    const dbFile = join(scratch, `doorbell-${v.key}.txt`);
    writeFileSync(dbFile, doorbell);
    const send = sh("bb", ["thread", "message", captain, "--mode", "auto", "--message-file", dbFile]);
    await sleep(2500);
    const log = threadLog(captain);
    const delivered = send.code === 0 && log.includes(id) && log.includes(`${v.verb}:`);
    record(`${v.key}: doorbell reaches the captain thread with the ${v.verb} alert`,
      delivered, delivered ? `captain=${captain} carries the ${v.verb} alert` : `send code=${send.code} logHas=${log.includes(id)}`);
  }
} catch (err) {
  record("live-blocked-alert-check ran to completion", false, String(err?.message ?? err));
} finally {
  for (const t of created) teardown(t);
  sh("bb", ["thread", "prune"]);
  try { rmSync(scratch, { recursive: true, force: true }); } catch {}
  if (created.length) console.log(`\n(cleaned up real threads: ${created.join(", ")})`);
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1);
