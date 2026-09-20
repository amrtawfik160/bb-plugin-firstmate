// bb-plugin-firstmate — firstmate-style crews native to BB.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  afkShouldSend,
  bearingsText,
  capPermission,
  crewPrompt,
  decisionDue,
  hasStatusProtocol,
  looksReadOnly,
  foldOpenDecisions,
  latestStatus,
  mergeGate,
  parseOutcome,
  protocolNudgeText,
  queueGate,
  quietShouldSend,
  resolveWorktree,
  statusLinesFrom,
  statusProtocolSummary,
  toMode,
  toPermissionMode,
  toReasoningLevel,
  toShape,
  truncate,
  type DeliveryMode,
  type PermissionMode,
  type ReasoningLevel,
  type Shape,
} from "./lib/policy.ts";
import { rpcContract } from "./rpc.ts";

const shapeSchema = z.enum(["ship", "scout"]);
const modeSchema = z.enum(["direct-PR", "no-mistakes", "local-only"]);

const crewSchema = z.object({
  id: z.string(),
  task: z.string(),
  projectId: z.string(),
  threadId: z.string(),
  parentThreadId: z.string().nullable(),
  providerId: z.string().nullable(),
  model: z.string().nullable().default(null),
  reasoningLevel: z.string().nullable().default(null),
  worktree: z.boolean(),
  shape: shapeSchema.default("ship"),
  posture: z.string().default("direct-PR"),
  // Tri-state for the read-through reaper (R5): true = a state/<id>.meta was
  // confirmed written; false = the dispatch-time write failed (host briefly
  // down), so its current absence is NOT proof of teardown and read-through must
  // not reap it; undefined = legacy/native-recovered crew (real plane owns its
  // meta), reapable as before.
  metaWritten: z.boolean().optional(),
  createdAt: z.string(),
});
type Crew = z.infer<typeof crewSchema>;

const queueItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  detail: z.string().default(""),
  projectId: z.string(),
  shape: shapeSchema.default("ship"),
  mode: z.string().default(""),
  blockedBy: z.array(z.string()).default([]),
  waitUntil: z.string().nullable().default(null),
  status: z.enum(["queued", "dispatched", "done", "dropped"]).default("queued"),
  crewId: z.string().nullable().default(null),
  // The real data/backlog.md row id (fm-tasks-axi.sh) when queueOwner=real, so
  // dispatch/done/drop can drive the paired backlog transition. We now supply this
  // id ourselves (native caller-owns-the-id convention) = the KV item id on a
  // successful add. undefined = KV-only (real mode off, or the add failed).
  backlogId: z.string().optional(),
  // Legacy (kept for back-compat with rows persisted before the id-ownership
  // switch, when an unparseable `add` output was quarantined). No longer written.
  backlogUnparsed: z.boolean().optional(),
  createdAt: z.string(),
});
type QueueItem = z.infer<typeof queueItemSchema>;

const decisionSchema = z.object({
  id: z.string(),
  question: z.string(),
  options: z.array(z.string()).default([]),
  context: z.string().default(""),
  crewId: z.string().nullable().default(null),
  status: z.enum(["open", "answered", "deferred"]).default("open"),
  deferredUntil: z.string().nullable().default(null),
  answer: z.string().default(""),
  createdAt: z.string(),
});
type Decision = z.infer<typeof decisionSchema>;

const doneSchema = z.object({
  id: z.string(),
  task: z.string(),
  shape: shapeSchema.default("ship"),
  crewId: z.string(),
  outcome: z.string().default(""),
  pr: z.string().default(""),
  at: z.string(),
});
type DoneEntry = z.infer<typeof doneSchema>;

const postureSchema = z.object({
  mode: modeSchema.default("direct-PR"),
  yolo: z.boolean().default(false),
});
type Posture = z.infer<typeof postureSchema>;

const secondmateSchema = z.object({
  projectId: z.string(),
  threadId: z.string(),
  scope: z.string().default(""),
  // Native "non-exclusive clone list": the extra projects this secondmate also
  // handles beyond its home projectId. Routing considers all of them (scope-first).
  projects: z.array(z.string()).default([]),
  createdAt: z.string(),
});
type Secondmate = z.infer<typeof secondmateSchema>;

// Route dispatch to a registered secondmate by SCOPE + project clone list, not a
// bare projectId key. A secondmate is eligible when the dispatch project is its
// home project OR appears in its non-exclusive `projects` clone list. Among
// eligible mates, the one whose natural-language `scope` shares the most word
// tokens with the task wins — a deterministic, best-effort proxy for the captain's
// judgement (true NL routing stays the captain's call: register the fitting mate
// or dispatch from its thread). Ties break to the most recently registered.
// Returns undefined = no registered fit → dispatch stays with the main home.
export function formatSecondmate(m: Secondmate): string {
  const scope = m.scope !== "" ? ` (${m.scope})` : "";
  const projects = m.projects.length > 0 ? ` [projects: ${m.projects.join(", ")}]` : "";
  return `${m.projectId} → ${m.threadId}${scope}${projects}`;
}

export function pickSecondmate(mates: Secondmate[], projectId: string, task: string): Secondmate | undefined {
  const eligible = mates.filter((m) => m.projectId === projectId || m.projects.includes(projectId));
  if (eligible.length <= 1) return eligible[0];
  const words = new Set((task.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2));
  const score = (m: Secondmate): number => {
    const toks = (m.scope.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2);
    return toks.reduce((n, t) => n + (words.has(t) ? 1 : 0), 0);
  };
  return [...eligible].sort((a, b) => score(b) - score(a) || b.createdAt.localeCompare(a.createdAt))[0];
}

const MAX_HELD = 20;

const afkSchema = z.object({
  on: z.boolean(),
  words: z.string().default(""),
  since: z.string(),
  held: z.array(z.string()).default([]),
});
type AfkState = z.infer<typeof afkSchema>;

const quietSchema = z.object({
  on: z.boolean(),
  held: z.array(z.string()).default([]),
});
type QuietState = z.infer<typeof quietSchema>;

/** Keep the newest holds. Overflow is returned so the caller can flush it instead of dropping the new line. */
function pushHeld(held: string[], text: string): { held: string[]; evicted: string[] } {
  const next = [...held, text];
  if (next.length <= MAX_HELD) return { held: next, evicted: [] };
  return { held: next.slice(next.length - MAX_HELD), evicted: next.slice(0, next.length - MAX_HELD) };
}

const CREWS_KEY = "crews";
const QUEUE_KEY = "queue";
const DECISIONS_KEY = "decisions";
const DONE_KEY = "done";
const POSTURES_KEY = "postures";
const MEM_CAPTAIN_KEY = "memory-captain";
const MEM_LEARNINGS_KEY = "memory-learnings";
const SECONDMATES_KEY = "secondmates";
const AFK_KEY = "afk";
const QUIET_KEY = "quiet";
const NUDGE_KEY = "protocol-nudges";
const MAX_CREWS = 50;
// Newest of these is "tool/file activity". Output text alone false-alarms while a crew is editing.
const TOOL_ACTIVITY_TYPES = [
  "item/toolCall/progress",
  "item/mcpToolCall/progress",
  "item/commandExecution/outputDelta",
  "item/fileChange/outputDelta",
  "item/backgroundTask/progress",
  "item/backgroundTask/completed",
  "item/delegation/progress",
  "item/delegation/completed",
  "turn/diff/updated",
] as const;
const MAX_QUEUE = 100;
const MAX_DECISIONS = 100;
const MAX_DONE = 10;
const MAX_TASK = 4000;
const MAX_OUTPUT = 4000;
const MAX_FANOUT = 10;
const MAX_WATCH_CREWS = 10;
// Cap on fire-and-forget steering-inbox records kept per crew (state/<id>.inbox/NNN.msg).
// These are write-only audit records with no consumer (never mv'd to handled/), so
// without a bound they grow one-per-steer forever; the reaper keeps the newest this many.
const MAX_INBOX_RECORDS = 200;
const PLUGIN_ROOT = dirname(fileURLToPath(import.meta.url));
const OVERLAY_DIR = join(PLUGIN_ROOT, "overlay");
const FM_SCRIPT = /^[a-z0-9][a-z0-9-]*$/;

type FlagValue = string | true | string[];

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function ctxString(ctx: unknown, key: string): string | undefined {
  const value = asRecord(ctx)[key];
  return typeof value === "string" ? value : undefined;
}

function threadField(thread: unknown, key: string): string {
  const value = asRecord(thread)[key];
  return typeof value === "string" ? value : "unknown";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
}

const HOST_RC_MARKER = "__FM_HOST_RC";
const HOST_COMMAND_MAX = 10000;

function parseHostRc(raw: string): { exitCode: number; output: string } | null {
  const text = stripAnsi(raw);
  const match = new RegExp(`(?:\\r?\\n)${HOST_RC_MARKER}:([0-9]{1,3})(?:\\r?\\n)`).exec(text);
  if (!match || match.index === undefined) return null;
  return {
    exitCode: Number(match[1]),
    output: text.slice(0, match.index) + text.slice(match.index + match[0].length),
  };
}

// Wrap a command so its exit code is recoverable from terminal scrollback. The BB
// host terminal is a PTY; we run the command, print a parseable RC marker, then
// `sleep` so the marker survives until we read it (the terminal is force-closed by
// the caller). Bulky/arbitrary payloads never travel as terminal stdin — the PTY
// line discipline (canonical mode) buffers+echoes input without delivering it to
// the reading process, so writes hung until timeout; payloads are staged to a host
// file via writeHostBytes and fed with `< file` instead.
function wrapHostCommand(command: string): string {
  const assigned = `__fm_cmd=${shQuote(command)}`;
  const run = '"${SHELL:-/bin/bash}" -lc "$__fm_cmd"';
  const script = `${assigned}; set +e; ${run}; __fm_ec=$?; printf '\\n${HOST_RC_MARKER}:%s\\n' "$__fm_ec"; sleep 86400`;
  if (script.length > HOST_COMMAND_MAX) {
    throw new Error(`Host command too long (${script.length} > ${HOST_COMMAND_MAX}). Stage bulky payloads with writeHostBytes.`);
  }
  return script;
}

function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

// The drain hint appended to every real-mode doorbell. The durable wake queue stays the
// authoritative store; the chat doorbell is only a pointer to it, so a dropped doorbell can
// never lose the report (it survives in state/.wake-queue).
export const CAPTAIN_WAKE_DRAIN_HINT =
  "run `bb firstmate wake` to drain (durable; full report + open decisions surface there).";

// Build the real-mode (notifyOwner=real) doorbell: a compact summary carrying the crew id +
// a one-line outcome so the captain sees WHAT happened without a second `bb firstmate wake`,
// while the full report stays in the durable queue. `head` already names the crew and status
// (e.g. "✅ crew c1 done"); `summary` is the parsed outcome or a trimmed first line, or "".
export function captainWakeDoorbell(head: string, summary: string): string {
  return `🔔 ${head}${summary !== "" ? ` — ${summary}` : ""}\n${CAPTAIN_WAKE_DRAIN_HINT}`;
}

// Base FM_BACKEND=bb environment exports shared by every bb firstmate invocation
// (runFmScript). FM_SUPERVISION_MODEL=autoarm declares this home's supervision model —
// see the block in runFmScript / docs/bb-backend.md.
export function fmBackendEnv(input: {
  fmHome: string;
  hostId: string;
  projectId?: string;
  parentThreadId?: string;
}): string[] {
  return [
    `export FM_HOME=${shQuote(input.fmHome)}`,
    `export FM_ROOT=${shQuote(input.fmHome)}`,
    "export FM_BACKEND=bb",
    input.projectId !== undefined ? `export FM_BB_PROJECT_ID=${shQuote(input.projectId)}` : "",
    input.parentThreadId !== undefined ? `export FM_BB_PARENT_THREAD_ID=${shQuote(input.parentThreadId)}` : "",
    `export FM_BB_MACHINE=${shQuote(input.hostId)}`,
    "export FM_BB_VISIBLE=1",
    // A bb-backed home has no live watcher holding the lock between wakes (the keeper re-arms
    // fm-watch, which exits on every actionable wake), so fm-harness detection — run by the bb
    // daemon detached from any agent — resolves to `unknown` → the `persistent` model, which
    // demands a live lock-holder and permanently declares downtime while the beacon is fresh.
    // That is exactly the Claude Stop auto-arm shape (watcher only runs between turns), so the
    // model is `autoarm`: a fresh beacon within grace is healthy with no live watcher, a stale
    // beacon still alarms (no autoarm ledger explains the gap for a bb home). This is native
    // firstmate's own override (fm-wake-lib.sh fm_supervision_model), for "callers that
    // already know the harness" — the bb backend is exactly such a caller.
    "export FM_SUPERVISION_MODEL=autoarm",
  ].filter((line) => line !== "");
}

// fm-watch keeper paths + cadence (host-relative to fmHome).
export const FM_WATCH_KEEPER_PID = "state/.bb-watch-keeper.pid";
export const FM_WATCH_KEEPER_SH = "state/.bb-watch-keeper.sh";
// D7: the plugin (the keeper's OWNER) refreshes this beat every supervisor tick while
// watchOwner=fm-watch. The keeper self-exits when the beat goes stale, so a keeper
// whose owner is gone (plugin disposed/disabled/crashed, or the flag flipped and the
// plugin never reached the host) terminates on its own — teardown no longer depends on
// the plugin removing the pidfile. TTL is derived from the re-arm interval below.
export const FM_WATCH_OWNER_BEAT = "state/.bb-watch-owner.beat";
// B3(a): the owner beat is refreshed by the supervisor TICK (every ~checkMs, 15–30s),
// not by the keeper's own re-arm interval, and only when the host read/refresh call
// SUCCEEDS. A transiently slow or briefly-unreachable host makes several ticks fail in
// a row; with the old `max(120, interval*6)` (interval 10–20 ⇒ a flat 120s) a healthy
// keeper self-exited after only ~4 missed refreshes, degrading real transport until the
// next cycle re-launched it. Give the self-exit generous tolerance (a 10-minute floor,
// ~20 missed 30s refreshes) so transient slowness can never kill a healthy keeper, while
// a genuinely dead plugin — which never refreshes the beat again — still self-exits. This
// is only the backstop: the primary teardowns (pidfile removal on flag-off/dispose) are
// immediate, so a longer TTL costs nothing there.
export function fmWatchOwnerBeatTtl(interval: number): number {
  return Math.max(600, interval * 30);
}
// How often the on-host keeper re-arms fm-watch. fm-watch exits on every actionable wake and
// must be re-armed; the keeper (not the plugin's slow cycle) owns that, so the gap after a wake
// is bounded by this, not by the supervision interval + grace.
export function fmWatchKeeperInterval(graceSec: number): number {
  const grace = Math.max(30, Math.trunc(graceSec));
  return Math.max(10, Math.min(20, Math.floor(grace / 3)));
}

// The durable keeper: a standalone bash script (written to the host as a FILE via writeHostFile
// so there is no shell-quoting hazard). It records its own pid, self-exits when the pidfile no
// longer names it (teardown removes it), and re-arms fm-watch every `interval`s. fm-watch-arm.sh
// is idempotent (attaches to a live watcher), so the loop is cheap while a watcher blocks and only
// forks a new one after one exits.
export function fmWatchKeeperScript(hostId: string, fmHome: string, interval: number): string {
  const pid = `${fmHome}/${FM_WATCH_KEEPER_PID}`;
  const arm = `${fmHome}/bin/fm-watch-arm.sh`;
  const log = `${fmHome}/state/.bb-watch-arm.log`;
  const ownerBeat = `${fmHome}/${FM_WATCH_OWNER_BEAT}`;
  const ttl = fmWatchOwnerBeatTtl(interval);
  return [
    "#!/bin/bash",
    "# BB firstmate fm-watch keeper (managed; do not edit).",
    `export FM_HOME=${shQuote(fmHome)}`,
    `export FM_ROOT=${shQuote(fmHome)}`,
    "export FM_BACKEND=bb",
    `export FM_BB_MACHINE=${shQuote(hostId)}`,
    "export FM_BB_VISIBLE=1",
    // The bb-backed home is the auto-arm supervision model (see fmBackendEnv): the keeper re-arms
    // fm-watch, which runs only between wakes. Declare it so the watcher it launches judges a
    // fresh beacon with no live lock-holder as healthy.
    "export FM_SUPERVISION_MODEL=autoarm",
    // Arm each re-arm as a HANDLING SUCCESSOR. fm-watch treats every non-successor start after an
    // announced-but-unacked wake episode as a NEW down stretch and re-mints the recovery
    // generation (fm_recovery_marker_reopen_announced); the keeper re-arms every ~20s, so that
    // generation churned continuously and no `fm-wake-drain --ack-through … --recovery-generation
    // …` could ever match it — the ack loop. A re-arm is not a down stretch for this model, which
    // is exactly what the successor flag encodes (fm-watch's own resurface_after_downtime comment:
    // a non-successor re-announce is "an unbounded recovery loop"). The initial announced episode
    // is still published by arm_check when a wake is pending, so buried rows are still presented.
    "export FM_WATCH_HANDLING_SUCCESSOR=1",
    `PID=${shQuote(pid)}`,
    `ARM=${shQuote(arm)}`,
    `LOG=${shQuote(log)}`,
    `OWNER_BEAT=${shQuote(ownerBeat)}`,
    `OWNER_TTL=${ttl}`,
    'echo $$ > "$PID"',
    `trap 'rm -f "$PID"' EXIT`,
    // Loop while BOTH hold: (a) the pidfile still names this process (fast teardown
    // removes/overwrites it), and (b) the owner beat is fresh (D7 self-exit — the owner
    // stopped refreshing it, so the plugin is gone even if it never reached this host).
    'while [ "$(cat "$PID" 2>/dev/null)" = "$$" ]; do',
    '  OB=$(cat "$OWNER_BEAT" 2>/dev/null || echo 0); case "$OB" in ""|*[!0-9]*) OB=0 ;; esac',
    '  NOW=$(date +%s)',
    '  if [ "$OB" -eq 0 ] || [ $(( NOW - OB )) -gt "$OWNER_TTL" ]; then break; fi',
    '  "$ARM" >> "$LOG" 2>&1 || true',
    `  sleep ${interval}`,
    "done",
  ].join("\n");
}

// Host-side reaper for fire-and-forget steering-inbox records (state/<id>.inbox/NNN.msg). These
// ff records are write-only (never mv'd to handled/, excluded from the re-ring ladder), so
// without a bound they accumulate one-per-steer forever. Keep only the newest `max` FF records
// (by numeric sequence), delete the oldest beyond the cap. Reaps ONLY records carrying a
// `delivery=fire-and-forget` header line before the `--` separator — the exact predicate native
// fm_task_inbox_is_fire_and_forget uses — so a NORMAL (re-rung, consumed) steer is NEVER deleted,
// even if it is older. Only flat NNN.msg files in .inbox/ are considered; the handled/ subdir and
// any non-.msg file are left alone (a non-recursive glob).
export function inboxReapScript(dir: string, max: number): string {
  const q = shQuote(dir);
  return [
    `dir=${q}`,
    `[ -d "$dir" ] || exit 0`,
    // Emit basenames of FF NNN.msg records only, then keep the newest `max` and delete the rest.
    `for f in "$dir"/*.msg; do`,
    `  [ -e "$f" ] || continue`,
    `  b=\${f##*/}`,
    // exact fire-and-forget predicate: a `delivery=fire-and-forget` line in the header (before --).
    `  awk '$0=="--"{exit} $0=="delivery=fire-and-forget"{ff=1} END{exit(ff?0:1)}' "$f" || continue`,
    `  printf '%s\\n' "$b"`,
    `done | grep -E '^[0-9]+\\.msg$' | sort -t. -k1,1nr | tail -n +${max + 1} \\`,
    `  | while IFS= read -r r; do rm -f -- "$dir/$r"; done`,
  ].join("\n");
}

// B1: native fm-spawn.sh REFUSES a ship/scout brief whose `## Captain's intent`
// body has an operator-address line, via fm_brief_intent_address_line in
// fm-dod-lib.sh (line 219). The EXACT rule native refuses on is a body line that,
// after leading whitespace, opens with one of:
//   Captain: | Captain's words: | Captain's ask: | Captain's intent: | Captain,
// i.e. /^[[:space:]]*(Captain('s (words|ask|intent))?:|Captain,)/ — and native scans
// EVERY line, refusing on the first match. The `## Captain's intent` heading already
// records provenance, so captains (and the plugin's own scout-followup dispatch,
// server.ts ~5155/6203, and the captain skill SKILL.md:166) phrase task text as
// "Captain's intent: <words>" / "Captain, <words>". Written verbatim into {TASK}, that
// tripped the gate 100% of the time and every real spawn silently fell back to native.
//
// Normalise the intent body to match native's gate EXACTLY and nothing more: strip the
// operator-address label from EVERY line native would refuse (native scans them all),
// and leave every form native ACCEPTS untouched — the captain's verbatim words are the
// provenance record. Forms native accepts and this must NOT touch include the
// parenthetical spellings "Captain's intent (verbatim):" and "Captain's ask (per the
// spec):" (the parenthetical breaks native's `<label>:` match), so those keep their
// words. This never weakens native's validator; it only feeds it a compliant body.
export function normalizeCaptainIntent(task: string): string {
  // Ported verbatim from fm_brief_intent_address_line — no parenthetical, no more
  // spellings than native. Capture leading indentation so an inline label keeps it.
  const address = /^([ \t]*)(?:Captain(?:'s (?:words|ask|intent))?:|Captain,)[ \t]*/;
  const out: string[] = [];
  for (const line of task.split("\n")) {
    const m = address.exec(line);
    if (m === null) {
      out.push(line);
      continue;
    }
    const rest = line.slice(m[0].length);
    if (rest.trim() === "") continue; // a label on its own line is dropped entirely
    out.push(m[1] + rest); // inline label: keep the words (and original indentation)
  }
  return out.join("\n");
}

// B2 (D9): native wake-drain instructs the captain to run the drain at SIX printf
// sites across five code paths (fm-wake-drain.sh:715/748/752/757/782/860), each naming
// the raw `bin/fm-wake-drain.sh` — in both the CONSUMING form
// (`bin/fm-wake-drain.sh --ack-through <N> --recovery-generation <G>`, :748/:782/:860)
// and the PRESENT/re-run form (`re-run bin/fm-wake-drain.sh and use …`, :715/:752/:757).
// Pasted by hand, that raw script carries NO per-captain FM_STATE_OVERRIDE, so it
// presents/acks the UNPARTITIONED root queue and can consume ANOTHER captain's rows
// (observed live: an advisory named `--ack-through 16 --recovery-generation …` against
// the root queue). PTY merges stderr into output, so every one of these reaches the
// captain. Rewrite EVERY occurrence of the raw script to the partition-safe
// `bb firstmate wake` (drainWakes scopes it to the caller's own plane), so no surfaced
// line can ever name the raw script — the consuming form becomes
// `bb firstmate wake --ack-through <N> --recovery-generation <G>` and the present form
// becomes `re-run bb firstmate wake …`.
export function rewriteWakeAckLine(out: string): string {
  return out.replace(/bin\/fm-wake-drain\.sh/g, "bb firstmate wake");
}

function overlayBytes(rel: string): string {
  return readFileSync(join(OVERLAY_DIR, rel)).toString("base64");
}

function normalizeFmScript(raw: string): string {
  let name = raw.trim();
  if (name.startsWith("fm-")) name = name.slice(3);
  if (name.endsWith(".sh")) name = name.slice(0, -3);
  if (!FM_SCRIPT.test(name)) throw new Error(`Bad script name '${raw}'. Use a bin/fm-*.sh stem (spawn, peek, send, watch).`);
  return name;
}

function fmTimeoutMs(script: string, overrideSec: number | undefined): number {
  if (overrideSec !== undefined && Number.isFinite(overrideSec)) {
    return Math.min(1800, Math.max(15, overrideSec)) * 1000;
  }
  return ["spawn", "watch", "supervise-daemon", "session-start", "pr-merge"].includes(script) ? 600000 : 180000;
}

function parseArgs(argv: string[]): { flags: Map<string, FlagValue>; positional: string[] } {
  const flags = new Map<string, FlagValue>();
  const positional: string[] = [];
  const push = (key: string, value: string) => {
    const cur = flags.get(key);
    if (cur === undefined) flags.set(key, value);
    else if (Array.isArray(cur)) cur.push(value);
    else if (typeof cur === "string") flags.set(key, [cur, value]);
    else flags.set(key, value);
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--") {
      positional.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        push(arg.slice(2, eq), arg.slice(eq + 1));
        continue;
      }
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        push(key, next);
        i++;
      } else if (!flags.has(key)) {
        flags.set(key, true);
      }
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

function flagFromArgv(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === `--${name}`) {
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) return next;
    }
    if (arg.startsWith(prefix)) return arg.slice(prefix.length);
  }
  return undefined;
}

function parseFmArgv(argv: string[]): { script?: string; args: string[]; timeoutSec?: number } {
  const skip = new Set(["timeout", "home", "machine", "path", "project"]);
  const args: string[] = [];
  let script: string | undefined;
  let timeoutSec: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--json" || arg === "--help") continue;
    if (arg === "--") {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      const key = arg.slice(2).split("=")[0] ?? "";
      if (arg === "--timeout" || arg.startsWith("--timeout=")) {
        timeoutSec = arg === "--timeout" ? Number(argv[++i]) : Number(arg.slice("--timeout=".length));
        continue;
      }
      if (skip.has(key)) {
        if (!arg.includes("=")) i++;
        continue;
      }
      args.push(arg);
      continue;
    }
    if (script === undefined) {
      script = arg;
      continue;
    }
    args.push(arg);
  }
  return { script, args, timeoutSec };
}

function flagStr(flags: Map<string, FlagValue>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = flags.get(key);
    if (typeof value === "string" && value !== "") return value;
    if (Array.isArray(value)) {
      const first = value.find((v) => v !== "");
      if (first !== undefined) return first;
    }
  }
  return undefined;
}

function flagAll(flags: Map<string, FlagValue>, ...keys: string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const value = flags.get(key);
    if (typeof value === "string") {
      if (value !== "") out.push(value);
    } else if (Array.isArray(value)) {
      out.push(...value.filter((v) => v !== ""));
    }
  }
  return out;
}

function extractPaths(value: unknown): string[] {
  const out: string[] = [];
  const push = (entry: unknown) => {
    const rec = asRecord(entry);
    const p = rec["path"] ?? rec["file"] ?? rec["filename"];
    if (typeof p === "string" && p !== "") out.push(p);
  };
  if (Array.isArray(value)) {
    value.forEach(push);
  } else {
    const rec = asRecord(value);
    const files = rec["files"];
    if (Array.isArray(files)) files.forEach(push);
  }
  return out;
}

interface PrFacts {
  available: boolean;
  url: string;
  number: number | null;
  title: string;
  state: string;
  attention: string;
  checksState: string;
  failed: number;
  pending: number;
  passed: number;
  mergeable: string;
}

function prFacts(value: unknown): PrFacts {
  const none: PrFacts = {
    available: false, url: "", number: null, title: "", state: "",
    attention: "", checksState: "", failed: 0, pending: 0, passed: 0, mergeable: "",
  };
  const rec = asRecord(value);
  if (rec["outcome"] === "absent" || rec["outcome"] === "unavailable") return none;
  const inner = asRecord(rec["pullRequest"] ?? value);
  if (Object.keys(inner).length === 0) return none;
  const checks = asRecord(inner["checks"]);
  const mergeability = asRecord(inner["mergeability"]);
  const num = inner["number"];
  return {
    available: true,
    url: typeof inner["url"] === "string" ? inner["url"] : "",
    number: typeof num === "number" ? num : null,
    title: typeof inner["title"] === "string" ? inner["title"] : "",
    state: typeof inner["state"] === "string" ? inner["state"] : "",
    attention: typeof inner["attention"] === "string" ? inner["attention"] : "",
    checksState: typeof checks["state"] === "string" ? checks["state"] : "unknown",
    failed: typeof checks["failedCount"] === "number" ? checks["failedCount"] : 0,
    pending: typeof checks["pendingCount"] === "number" ? checks["pendingCount"] : 0,
    passed: typeof checks["passedCount"] === "number" ? checks["passedCount"] : 0,
    mergeable: typeof mergeability["mergeable"] === "string" ? mergeability["mergeable"] : "UNKNOWN",
  };
}

function summarizePR(value: unknown): string {
  const f = prFacts(value);
  if (!f.available) return "none";
  const parts = [
    f.number !== null ? `#${f.number}` : null,
    f.title !== "" ? truncate(f.title, 60) : null,
    f.state !== "" ? `(${f.state})` : null,
    f.checksState !== "" && f.checksState !== "unknown" ? `[checks ${f.checksState}]` : null,
    f.url !== "" ? f.url : null,
  ].filter((p): p is string => p !== null);
  return parts.length > 0 ? parts.join(" ") : "none";
}

const CAPTAIN_SKILLS = ["captain", "firstmate", "afk", "ahoy", "bearings", "quiet", "stow"] as const;
const CAPTAIN_TOOLS = [
  "firstmate_dispatch",
  "firstmate_deck",
  "firstmate_tell",
  "firstmate_interrupt",
  "firstmate_watch",
  "firstmate_bearings",
  "firstmate_deliver",
  "firstmate_merge",
  "firstmate_decide",
  "firstmate_crew",
  "firstmate_crews",
  "firstmate_session",
  "firstmate_stop",
  "firstmate_retry",
  "firstmate_promote",
  "firstmate_afk",
  "firstmate_quiet",
  "firstmate_queue",
  "firstmate_forget",
  "firstmate_memory",
  "firstmate_secondmate",
  "firstmate_posture",
  "firstmate_supervision",
  "firstmate_migrate_state",
  "firstmate_fm",
] as const;

function isSecondmateRoute(crew: Crew): boolean {
  return crew.posture.startsWith("secondmate:");
}

function threadIdOf(value: unknown): string {
  const rec = asRecord(value);
  const id = rec["id"];
  if (typeof id === "string" && id !== "") return id;
  throw new Error("spawn returned no thread id");
}

// Minimum tasks-axi the native backlog lib pins (fm-tasks-axi-lib.sh FM_TASKS_AXI_MIN).
const TASKS_AXI_MIN = "0.2.4";

/** True when semver `have` >= `min` (numeric x.y.z compare; missing parts = 0). */
export function versionAtLeast(have: string, min: string): boolean {
  const parse = (v: string): number[] => v.split(".").map((n) => Number.parseInt(n, 10) || 0);
  const a = parse(have);
  const b = parse(min);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return true;
}

/** Human phrase for the real toolbelt size — computed counts when known, else neutral. */
export function toolbeltPhrase(scriptCount: string, skillCount: string): string {
  const scripts = /^\d+$/.test(scriptCount) && scriptCount !== "0" ? `${scriptCount} bin/fm-*.sh scripts` : "the full bin/fm-*.sh toolbelt";
  const skills = /^\d+$/.test(skillCount) && skillCount !== "0" ? `${skillCount} skills` : "the original skills";
  return `${scripts} + ${skills} + harness adapters`;
}

export function formatFmMeta(input: {
  id: string;
  threadId: string;
  worktree: string;
  project: string;
  kind: "ship" | "scout";
  mode?: string;
  yolo?: "on" | "off";
  model?: string;
  provider?: string;
  effort?: string;
  spawnGen?: string;
}): string {
  const spawnGen =
    input.spawnGen ?? `s${Math.floor(Date.now() / 1000)}.${process.pid}.${Math.floor(Math.random() * 10000)}`;
  const lines = [
    `window=${input.threadId}`,
    `endpoint_task_id=${input.id}`,
    `worktree=${input.worktree}`,
    `project=${input.project}`,
    "harness=bb",
    `kind=${input.kind}`,
  ];
  if (input.kind === "ship" && input.mode !== undefined && input.mode !== "") {
    lines.push(`mode=${input.mode}`);
  }
  if (input.kind === "ship" && input.yolo !== undefined) {
    lines.push(`yolo=${input.yolo}`);
  }
  lines.push(`tasktmp=/tmp/fm-${input.id}`);
  lines.push(`model=${input.model ?? "default"}`);
  if (input.provider !== undefined && input.provider !== "") lines.push(`provider=${input.provider}`);
  lines.push(`effort=${input.effort !== undefined && input.effort !== "" ? input.effort : "default"}`);
  lines.push(`spawn_gen=${spawnGen}`);
  lines.push("backend=bb");
  lines.push(`bb_thread_id=${input.threadId}`);
  return `${lines.join("\n")}\n`;
}

function metaFlag(meta: Record<string, unknown>, key: string): boolean {
  const value = meta[key];
  return value === true || value === "true";
}

function looksLikeCaptainPrompt(text: string | null | undefined): boolean {
  if (typeof text !== "string") return false;
  const t = text.trim().toLowerCase();
  return (
    t === "/captain" ||
    t === "captain" ||
    t === "/skill:captain" ||
    t.startsWith("/captain ") ||
    t.startsWith("/skill:captain")
  );
}

function isBlankTitle(title: unknown): boolean {
  return typeof title !== "string" || title.trim() === "";
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const settings = bb.settings.define({
    firstmateRepo: {
      type: "string",
      label: "Firstmate repo URL (used by init --real)",
      default: "https://github.com/kunchenguid/firstmate",
    },
    fmHome: {
      type: "string",
      label: "Firstmate home on the host (bin/ + config/). Set by init --real.",
      default: "",
    },
    fmScriptCount: {
      type: "string",
      label: "Computed count of bin/fm-*.sh scripts at fmHome (set by init --real).",
      default: "",
    },
    fmSkillCount: {
      type: "string",
      label: "Computed count of .agents/skills dirs at fmHome (set by init --real).",
      default: "",
    },
    captainContract: {
      type: "string",
      label: "Captain-contract excerpt from fmHome/AGENTS.md, injected into captain sessions (set by init --real).",
      default: "",
    },
    captainMemory: {
      type: "string",
      label: "Captain memory block (data/captain.md prefs + recent data/learnings.md) injected into captain sessions so a fresh captain thread recalls stored memory (set by init/deck and refreshed on memory writes).",
      default: "",
    },
    fmSkillsManifest: {
      type: "string",
      label: "Version-pinned inventory of fmHome/.agents/skills (JSON {head,skills[]}); set by init/deck, injected into captain sessions.",
      default: "",
    },
    transport: {
      type: "select",
      label: "Crew dispatch transport: native BB spawn, or the real fm-brief.sh + fm-spawn.sh scripts (backend=bb). Falls back to native if real spawn fails before a thread exists.",
      options: ["native", "real"],
      default: "native",
    },
    watchOwner: {
      type: "select",
      label: "Crew supervision owner: native BB stuck-pass, or the real fm-watch (the plugin runs+supervises fm-watch; BB suppresses its own stuck-page only while fm-watch's heartbeat is live, else it pages as before). Falls back to native when real mode is off.",
      options: ["native", "fm-watch"],
      default: "native",
    },
    fmHostId: {
      type: "string",
      label: "Host id where fmHome lives (set by init --real; used by the fm-watch supervisor when no crew is around to resolve one).",
      default: "",
    },
    watchHeartbeatSec: {
      type: "number",
      label: "fm-watch is considered live when its state/.last-watcher-beat is fresher than this many seconds; BB only suppresses its own stuck-page while live.",
      default: 90,
    },
    readThrough: {
      type: "boolean",
      label: "Treat real state/<id>.meta as the source of truth for crew existence: on each crews/bearings/deliver read, one batched host read reconciles the KV cache and drops crews the real plane no longer tracks. Off = KV cache only.",
      default: false,
    },
    queueOwner: {
      type: "select",
      label: "Backlog owner: kv (BB KV list) or real (fm-tasks-axi.sh + data/backlog.md; needs tasks-axi on the host). Real writes through to KV as a cache; falls back to KV with a log if the real backlog is unreachable.",
      options: ["kv", "real"],
      default: "kv",
    },
    decisionsOwner: {
      type: "select",
      label: "Decisions owner: kv (BB KV list) or real (captain-held backlog tasks via fm-captain-hold.sh; answering also writes the resolved close to state/<id>.status). Real writes through to KV; falls back to KV with a log.",
      options: ["kv", "real"],
      default: "kv",
    },
    afkOwner: {
      type: "select",
      label: "AFK owner: kv (BB KV flag) or real (fm-afk-contract.sh + state/.afk-contract, so real merge/watch see the same away authority). Real writes through to KV; falls back to KV with a log.",
      options: ["kv", "real"],
      default: "kv",
    },
    quietOwner: {
      type: "select",
      label: "Quiet owner: kv (BB KV flag) or real (state/.afk flag first line = quiet, the native afk-skill quiet mode). Real writes through to KV; falls back to KV with a log.",
      options: ["kv", "real"],
      default: "kv",
    },
    memoryOwner: {
      type: "select",
      label: "Memory owner: kv (two KV blobs) or real (tiered files data/captain.md + data/learnings.md with stow markers). Real writes through to KV; falls back to KV with a log.",
      options: ["kv", "real"],
      default: "kv",
    },
    notifyOwner: {
      type: "select",
      label:
        "Crew→captain notification owner: kv (one fire-and-forget threads.send; a failed send is LOST) or real (enqueue a durable wake into the real fm-wake queue keyed <id>.status, then ring one cheap constant doorbell; the captain drains with `bb firstmate wake`, so a dropped doorbell never loses the report and repeats dedupe). Real degrades to the KV send with a log if the host/queue is unreachable.",
      options: ["kv", "real"],
      default: "kv",
    },
    tellOwner: {
      type: "select",
      label:
        "Captain→crew steering owner: kv (a bare threads.send doorbell, no durable record, no ack) or real (route through the real fm-send.sh steering inbox: durable sequenced state/<id>.inbox/NNN.msg, one constant doorbell, ack = crew mv to handled/, fm-watch re-ring ladder; refuses unresolved targets). interrupt/stop stay hard-stops, never the inbox. Real degrades to the KV doorbell with a log on infra failure.",
      options: ["kv", "real"],
      default: "kv",
    },
    turnEndGuard: {
      type: "select",
      label:
        "Captain turn-end backstop: off, or re-ring — on captain idle with undrained durable wakes, inject ONE bounded steering re-ring to drain them first. NOTE: BB exposes no blocking stop hook (unlike native firstmate's exit-2 Stop guard), so this is a post-idle backstop, NOT a guarantee — the blind window between idle and the re-ring remains.",
      options: ["off", "re-ring"],
      default: "off",
    },
    turnEndGuardBudget: {
      type: "number",
      label: "Back-to-back turn-end re-rings per captain thread before throttling to a slow floor (~15m) — it never abandons the captain with undrained wakes; resets when the queue drains.",
      default: 3,
    },
    defaultProvider: {
      type: "string",
      label: "Default crew provider id (blank = BB resolves)",
      default: "",
    },
    defaultPermissionMode: {
      type: "select",
      label: "Default crew permission mode",
      options: ["resolve", "accept-edits", "auto", "full"],
      default: "resolve",
    },
    supervisionEnabled: {
      type: "boolean",
      label: "Supervise crews: ping captain on done/failed/stuck",
      default: false,
    },
    supervisionIntervalMin: {
      type: "number",
      label: "Stuck-check interval (minutes); done/fail use thread events",
      default: 5,
    },
    supervisionStuckMin: {
      type: "number",
      label: "Stuck alert after N min with no output change",
      default: 30,
    },
    nudgeEnabled: {
      type: "boolean",
      label: "Doorbell a crew that idles without DONE:/BLOCKED:/FAILED:",
      default: true,
    },
    nudgeMaxPerCrew: {
      type: "number",
      label: "Protocol nudges per crew task before NEEDS DECISION",
      default: 3,
    },
    nudgeCooldownSeconds: {
      type: "number",
      label: "Minimum seconds between protocol nudges for one crew",
      default: 60,
    },
  });

  // The real captain contract (fmHome/AGENTS.md excerpt), cached so the sync
  // agents.configure() callback can inject it. Loaded from the persisted setting
  // at start and refreshed by initRealMode. Empty until real mode is initialized.
  let captainContractCache = "";
  try {
    captainContractCache = (await settings.get()).captainContract;
  } catch {
    // default empty
  }
  const CAPTAIN_CONTRACT_MAX = 3400;

  // Read fmHome/AGENTS.md on the host, keep a bounded excerpt, and cache+persist
  // it so captain sessions load the real contract. Best-effort.
  async function refreshCaptainContract(hostId: string, fmHome: string, signal?: AbortSignal): Promise<void> {
    try {
      const path = `${fmHome}/AGENTS.md`;
      const res = await runOnHost(hostId, `[ -f ${shQuote(path)} ] && head -c 20000 ${shQuote(path)} || true`, 20_000, signal);
      const raw = res.output.trim();
      if (raw === "") return;
      const excerpt = raw.length > CAPTAIN_CONTRACT_MAX ? `${raw.slice(0, CAPTAIN_CONTRACT_MAX)}…` : raw;
      captainContractCache = excerpt;
      try {
        await settings.experimental_set({ captainContract: excerpt });
      } catch {
        // cache still holds it for this process
      }
    } catch {
      // best-effort; captain keeps the built-in instruction
    }
  }

  // The real firstmate skills inventory (fmHome/.agents/skills), version-pinned to
  // fmHome HEAD. BB plugins cannot register a dynamic skill root from the sync
  // configure() callback (skill ids there must resolve to statically-declared
  // manifest dirs), so instead of falsely registering unmovable host content we
  // generate a version-pinned manifest and inject its inventory into captain
  // sessions — the captain learns the real skills exist and reads/runs them
  // through the toolbelt (bb firstmate fm ...). Crews still get none. Refreshed on
  // init/deck and whenever fmHome HEAD changes. Cached for the sync callback.
  const SKILLS_MANIFEST_MAX = 2400;
  let skillsManifestCache = "";
  try {
    skillsManifestCache = renderSkillsManifest((await settings.get()).fmSkillsManifest);
  } catch {
    // default empty
  }

  function renderSkillsManifest(raw: string): string {
    const trimmed = (raw ?? "").trim();
    if (trimmed === "") return "";
    try {
      const parsed = JSON.parse(trimmed) as { head?: unknown; skills?: unknown };
      const head = typeof parsed.head === "string" && parsed.head !== "" ? parsed.head.slice(0, 12) : "unknown";
      const skills = Array.isArray(parsed.skills) ? parsed.skills : [];
      if (skills.length === 0) return "";
      const lines = skills
        .map((s) => {
          const rec = asRecord(s);
          const name = typeof rec["name"] === "string" ? rec["name"] : "";
          const desc = typeof rec["desc"] === "string" ? rec["desc"] : "";
          return name === "" ? "" : `- ${name}${desc === "" ? "" : `: ${desc}`}`;
        })
        .filter((l) => l !== "");
      if (lines.length === 0) return "";
      const body = [
        `== Real firstmate skills (fmHome/.agents/skills @ ${head}; ${lines.length} available) ==`,
        "Read and run these through the toolbelt (e.g. bb firstmate fm <script>); they are the real policy skills.",
        ...lines,
      ].join("\n");
      return truncate(body, SKILLS_MANIFEST_MAX);
    } catch {
      return "";
    }
  }

  // Read fmHome HEAD + the .agents/skills inventory on the host, store a
  // version-pinned JSON manifest, and refresh the injected cache. Skips the host
  // read when HEAD is unchanged. Best-effort.
  async function refreshSkillsManifest(hostId: string, fmHome: string, signal?: AbortSignal): Promise<void> {
    try {
      const skillsDir = `${fmHome}/.agents/skills`;
      const py =
        "import json,os,sys;d=sys.argv[1];out=[];\n" +
        "dirs=sorted([n for n in os.listdir(d) if os.path.isdir(os.path.join(d,n))]) if os.path.isdir(d) else []\n" +
        "for n in dirs:\n" +
        "  desc=''\n" +
        "  p=os.path.join(d,n,'SKILL.md')\n" +
        "  try:\n" +
        "    txt=open(p,encoding='utf-8',errors='replace').read()\n" +
        "    for line in txt.splitlines():\n" +
        "      s=line.strip()\n" +
        "      if s.lower().startswith('description:'):\n" +
        "        desc=s.split(':',1)[1].strip().strip('\\'\"');break\n" +
        "  except Exception:\n" +
        "    pass\n" +
        "  out.append({'name':n,'desc':desc[:160]})\n" +
        "sys.stdout.write(json.dumps(out))";
      const cmd = [
        `HEAD=$(git -C ${shQuote(fmHome)} rev-parse HEAD 2>/dev/null || echo unknown)`,
        `printf 'FM_HEAD=%s\\n' "$HEAD"`,
        `python3 -c ${shQuote(py)} ${shQuote(skillsDir)} 2>/dev/null || echo '[]'`,
      ].join("\n");
      const res = await runOnHost(hostId, cmd, 20_000, signal);
      const headMatch = /FM_HEAD=(\S+)/.exec(res.output);
      const head = headMatch?.[1] ?? "unknown";
      const jsonStart = res.output.indexOf("[");
      if (jsonStart < 0) return;
      const skillsJson = res.output.slice(jsonStart).trim();
      let skills: unknown;
      try {
        skills = JSON.parse(skillsJson);
      } catch {
        return;
      }
      if (!Array.isArray(skills)) return;
      // Skip the persist when HEAD is unchanged and we already have a manifest.
      try {
        const prevRaw = (await settings.get()).fmSkillsManifest.trim();
        if (prevRaw !== "") {
          const prev = JSON.parse(prevRaw) as { head?: unknown };
          if (typeof prev.head === "string" && prev.head === head && skillsManifestCache !== "") return;
        }
      } catch {
        // fall through and persist
      }
      const manifest = JSON.stringify({ head, skills });
      skillsManifestCache = renderSkillsManifest(manifest);
      try {
        await settings.experimental_set({ fmSkillsManifest: manifest });
      } catch {
        // cache still holds it for this process
      }
    } catch {
      // best-effort; captain keeps the contract without the skill inventory
    }
  }

  // D4: the captain's STORED memory (data/captain.md prefs + the most recent
  // data/learnings.md lines), rendered into a bounded block and cached so the sync
  // agents.configure() callback can inject it into a FRESH captain session. Without
  // this a new captain thread received zero memory. Loaded from the persisted
  // setting at start, refreshed on init/deck and after every memory write.
  const CAPTAIN_MEMORY_MAX = 1400;
  const CAPTAIN_MEMORY_RECENT_LINES = 12;
  let captainMemoryCache = "";
  try {
    captainMemoryCache = (await settings.get()).captainMemory;
  } catch {
    // default empty
  }

  async function refreshCaptainMemory(): Promise<void> {
    try {
      const mem = await memoryShow();
      const prefs = mem.captain.trim();
      const learnLines = mem.learnings
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "");
      const recent = learnLines.slice(-CAPTAIN_MEMORY_RECENT_LINES);
      let next = "";
      if (prefs !== "" || recent.length > 0) {
        next = truncate(
          [
            "== Captain memory (recall; fmHome/data) ==",
            "-- prefs (captain.md) --",
            prefs === "" ? "(none)" : prefs,
            `-- recent learnings (learnings.md; newest ${recent.length}) --`,
            recent.length === 0 ? "(none)" : recent.join("\n"),
          ].join("\n"),
          CAPTAIN_MEMORY_MAX,
        );
      }
      if (next === captainMemoryCache) return;
      captainMemoryCache = next;
      try {
        await settings.experimental_set({ captainMemory: next });
      } catch {
        // cache still holds it for this process
      }
    } catch {
      // best-effort; keep the last cached memory block
    }
  }

  async function readList<T>(key: string, schema: z.ZodType<T>, cap: number): Promise<T[]> {
    const raw = await bb.storage.kv.get<unknown>(key);
    if (!Array.isArray(raw)) return [];
    const out: T[] = [];
    for (const entry of raw) {
      const parsed = schema.safeParse(entry);
      if (parsed.success) out.push(parsed.data);
    }
    return out.slice(0, cap);
  }

  async function writeCrews(crews: Crew[]): Promise<void> {
    await bb.storage.kv.set(CREWS_KEY, crews.slice(0, MAX_CREWS));
  }
  async function readCrews(): Promise<Crew[]> {
    return readList(CREWS_KEY, crewSchema, MAX_CREWS);
  }
  async function readQueue(): Promise<QueueItem[]> {
    return readList(QUEUE_KEY, queueItemSchema, MAX_QUEUE);
  }
  async function writeQueue(items: QueueItem[]): Promise<void> {
    await bb.storage.kv.set(QUEUE_KEY, items.slice(0, MAX_QUEUE));
  }
  async function readDecisions(): Promise<Decision[]> {
    return readList(DECISIONS_KEY, decisionSchema, MAX_DECISIONS);
  }
  async function writeDecisions(items: Decision[]): Promise<void> {
    await bb.storage.kv.set(DECISIONS_KEY, items.slice(0, MAX_DECISIONS));
  }
  async function readDone(): Promise<DoneEntry[]> {
    return readList(DONE_KEY, doneSchema, MAX_DONE);
  }
  async function recordDone(entry: Omit<DoneEntry, "id" | "at">): Promise<void> {
    const full: DoneEntry = { ...entry, id: randomUUID().slice(0, 8), at: new Date().toISOString() };
    await bb.storage.kv.set(DONE_KEY, [full, ...(await readDone())].slice(0, MAX_DONE));
  }
  async function readPostures(): Promise<Record<string, Posture>> {
    const raw = asRecord(await bb.storage.kv.get<unknown>(POSTURES_KEY));
    const out: Record<string, Posture> = {};
    for (const [key, value] of Object.entries(raw)) {
      const parsed = postureSchema.safeParse(value);
      if (parsed.success) out[key] = parsed.data;
    }
    return out;
  }
  async function postureOf(projectId: string): Promise<Posture> {
    const all = await readPostures();
    return all[projectId] ?? { mode: "direct-PR", yolo: false };
  }
  async function readSecondmates(): Promise<Secondmate[]> {
    return readList(SECONDMATES_KEY, secondmateSchema, 50);
  }
  async function writeSecondmates(items: Secondmate[]): Promise<void> {
    await bb.storage.kv.set(SECONDMATES_KEY, items.slice(0, 50));
  }
  async function readAfk(): Promise<AfkState | null> {
    const parsed = afkSchema.safeParse(await bb.storage.kv.get<unknown>(AFK_KEY));
    return parsed.success && parsed.data.on ? parsed.data : parsed.success ? parsed.data : null;
  }
  async function writeAfk(state: AfkState | null): Promise<void> {
    await bb.storage.kv.set(AFK_KEY, state);
  }
  async function readQuiet(): Promise<QuietState> {
    const raw = await bb.storage.kv.get<unknown>(QUIET_KEY);
    if (raw === true) return { on: true, held: [] };
    const parsed = quietSchema.safeParse(raw);
    return parsed.success ? parsed.data : { on: false, held: [] };
  }
  async function writeQuiet(state: QuietState): Promise<void> {
    await bb.storage.kv.set(QUIET_KEY, state);
  }
  async function isQuiet(): Promise<boolean> {
    return (await readQuiet()).on;
  }
  async function setQuiet(action: "on" | "off", captainThreadId?: string): Promise<string> {
    const prev = await readQuiet();
    if (action === "on") {
      await writeQuiet({ on: true, held: prev.held });
      await projectQuiet(true);
      return "Quiet on";
    }
    await writeQuiet({ on: false, held: [] });
    await projectQuiet(false);
    const wake = await wakeResumeBrief(captainThreadId);
    if (prev.held.length === 0) return `Quiet off${wake}`;
    return `Quiet off\nHeld while quiet:\n${prev.held.join("\n---\n")}${wake}`;
  }
  async function markQueueForCrew(crewId: string, status: "done"): Promise<void> {
    const items = await readQueue();
    let changed = false;
    for (const item of items) {
      if (item.crewId === crewId && item.status === "dispatched") {
        item.status = status;
        changed = true;
      }
    }
    if (changed) await writeQueue(items);
  }

  const watchStateSchema = z.record(
    z.string(),
    z.object({
      status: z.string(),
      hash: z.string(),
      at: z.number(),
      stuck: z.boolean(),
      activityAt: z.number().optional(),
      alerted: z.string().optional(),
    }),
  );
  type WatchState = z.infer<typeof watchStateSchema>;

  async function publishFleet(): Promise<void> {
    try {
      await bb.realtime.publish("fleet", { at: Date.now() });
    } catch {
      // best effort
    }
  }

  async function deliverToCaptain(parentThreadId: string, text: string, crewId: string): Promise<void> {
    try {
      await bb.sdk.threads.send({
        threadId: parentThreadId,
        mode: "auto",
        input: [{ type: "text", text, mentions: [] }],
      });
    } catch {
      bb.log.warn(`notify failed for crew ${crewId}`);
    }
  }

  // F5: after the turn-end re-ring budget, keep re-ringing at this slow floor rather
  // than abandoning the captain idle-with-undrained-wakes.
  const TURN_END_FLOOR_MS = 15 * 60_000;

  // Enqueue a durable crew→captain report. F1: the wake row is only a POINTER —
  // `fm-wake-drain` collapses rows per (kind,key) and acks the older unseen ones
  // away, so distinct reports for one crew would be LOST if the text lived in the
  // payload. Native firstmate keeps the content in the crew's append-only
  // `state/<id>.status` file (a `note:` line — the fm-classify unread-surface
  // grammar) which drain reads cursor-backed and presents in full (never deduped);
  // the `signal <id>.status` wake is the pointer that tells drain the file has news.
  // So we append the report as a note line, THEN enqueue the pointer. Both distinct
  // reports then survive presentation + ack (proven live). Best-effort: returns
  // false so the caller keeps the KV fire-and-forget send on any failure. The note
  // is base64'd and decoded on the host into a shell var, never interpolated.
  // D6: partition the durable wake plane PER OWNING CAPTAIN. The native fm-wake-lib
  // honors FM_STATE_OVERRIDE (default $FM_HOME/state), which scopes the ENTIRE wake
  // subsystem for one invocation — the queue file + lock + seq, the unread-status
  // surface scan ($STATE/*.status), the open-decisions fold, AND the recovery marker.
  // Without this every captain shared ONE global state dir, so captain A's `bb
  // firstmate wake` (and its --ack-through) drained/consumed captain B's queue rows
  // AND surfaced captain B's crew note lines. Giving each captain its own state
  // subdir (verified live: A never sees/consumes B's rows or notes, and vice-versa)
  // makes a drain/ack only ever touch that captain's own plane. A missing/empty
  // captain id falls back to the legacy global state dir (single-captain case), so
  // existing behavior is preserved when there is no owning captain.
  function wakeStateDir(fmHome: string, captainThreadId: string | undefined): string {
    const base = `${fmHome}/state`;
    if (captainThreadId === undefined || captainThreadId === "") return base;
    return `${base}/cap-${captainThreadId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  }
  function wakeStateEnv(fmHome: string, captainThreadId: string | undefined): Record<string, string> {
    if (captainThreadId === undefined || captainThreadId === "") return {};
    return { FM_STATE_OVERRIDE: wakeStateDir(fmHome, captainThreadId) };
  }

  async function enqueueCaptainWake(crew: Crew, display: string): Promise<boolean> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "" || isSecondmateRoute(crew)) return false;
    let hostId: string;
    try {
      hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
    } catch {
      return false;
    }
    const lib = `${fmHome}/bin/fm-wake-lib.sh`;
    // D6: enqueue into the OWNING captain's scoped state dir, never the shared global
    // one, so the note + queue row + seq + recovery marker all live in that captain's
    // plane (see wakeStateDir). FM_STATE_OVERRIDE must be exported BEFORE the lib is
    // sourced (the lib resolves $STATE and the queue path at source time).
    const stateDir = wakeStateDir(fmHome, crew.parentThreadId ?? undefined);
    const statusPath = `${stateDir}/${crew.id}.status`;
    const key = `${crew.id}.status`;
    // Single-line note in fm-classify grammar (strip any leading "note:" so we don't
    // double it, collapse whitespace). `note:` is the informational unread surface.
    const note = display.replace(/[\r\n\t]+/g, " ").replace(/^\s*note:\s*/i, "").trim().slice(0, 800);
    const noteB64 = Buffer.from(note, "utf8").toString("base64");
    const script = [
      `export FM_HOME=${shQuote(fmHome)}`,
      `export FM_ROOT=${shQuote(fmHome)}`,
      `export FM_STATE_OVERRIDE=${shQuote(stateDir)}`,
      `[ -f ${shQuote(lib)} ] || { echo "error: missing ${lib}" >&2; exit 127; }`,
      `mkdir -p ${shQuote(stateDir)}`,
      `. ${shQuote(lib)}`,
      `note=$(printf '%s' ${shQuote(noteB64)} | base64 -d)`,
      `printf 'note: %s\\n' "$note" >> ${shQuote(statusPath)}`,
      `fm_wake_append signal ${shQuote(key)} ${shQuote(`crew ${crew.id} update`)}`,
    ].join("\n");
    try {
      const res = await runOnHost(hostId, script, 15_000);
      if (res.exitCode !== 0) {
        bb.log.warn(`fm wake enqueue failed crew=${crew.id} exit=${res.exitCode}`);
        return false;
      }
      bb.log.info(`fm wake enqueued crew=${crew.id} key=${key} (note→status + pointer)`);
      return true;
    } catch (error) {
      bb.log.warn(`fm wake enqueue failed crew=${crew.id} ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async function notifyCaptain(crew: Crew, event: string, output: string | null): Promise<void> {
    if (crew.parentThreadId === null) return;
    const parentThreadId = crew.parentThreadId;
    let kind = event;
    let prUrl = "";
    if (event === "idle") {
      const pr = await prForCrew(crew);
      if (pr.url !== "") {
        kind = "review";
        prUrl = pr.url;
      }
    }
    const afk = await readAfk();
    const quietState = await readQuiet();
    const postureEvent = kind === "needs-decision" ? "idle" : kind;
    const quietHold = quietState.on && !quietShouldSend(postureEvent);
    const afkHold = afk?.on === true && !afkShouldSend(postureEvent);
    const head =
      kind === "idle"
        ? `✅ crew ${crew.id} done`
        : kind === "review"
          ? `🔎 crew ${crew.id} ready for review`
          : kind === "needs-decision"
            ? `⚖️ crew ${crew.id} NEEDS DECISION`
            : kind === "error"
              ? `❌ crew ${crew.id} failed`
              : kind === "unknown"
                ? `❓ crew ${crew.id} gone`
                : kind === "interaction"
                  ? `✋ crew ${crew.id} needs input`
                  : `⏳ crew ${crew.id} ${kind}`;
    const lines = [`${head} [${crew.shape}] :: ${truncate(crew.task, 100)}`];
    if (prUrl !== "") lines.push(prUrl);
    const outcome = parseOutcome(output);
    if (outcome !== null) lines.push(outcome);
    else if (output !== null && output !== "") lines.push(truncate(output.replace(/\n/g, " "), 400));
    lines.push(
      kind === "error"
        ? `next: bb firstmate retry|tell|forget ${crew.id}`
        : kind === "needs-decision"
          ? `next: bb firstmate tell|stop|forget ${crew.id}`
          : kind === "idle" || kind === "review"
            ? `next: bb firstmate deliver ${crew.id}`
            : `next: bb firstmate crew ${crew.id}`,
    );
    const text = lines.join("\n").slice(0, 1500);
    // notifyOwner=real: persist the report into the durable wake queue first, then the
    // chat send becomes a compact doorbell carrying the crew id + a one-line outcome
    // (not just a generic pointer), so the captain sees WHAT happened without a second
    // `bb firstmate wake`. A dropped doorbell can no longer lose the report — the full
    // report and open decisions survive in the durable queue and surface on drain.
    // Default kv is byte-for-byte the previous fire-and-forget behavior.
    const durable = (await settings.get()).notifyOwner === "real" ? await enqueueCaptainWake(crew, text) : false;
    const summary = outcome ?? (output !== null && output !== "" ? truncate(output.replace(/\n/g, " "), 160) : "");
    const doorbell = durable ? captainWakeDoorbell(head, summary) : text;
    if (quietHold || afkHold) {
      // The durable wake already persisted the report; do not also hold a redundant
      // doorbell (the captain drains the queue on return). KV path unchanged.
      if (durable) return;
      const evicted: string[] = [];
      if (quietHold) {
        const pushed = pushHeld(quietState.held, text);
        quietState.held = pushed.held;
        evicted.push(...pushed.evicted);
        await writeQuiet(quietState);
      }
      if (afkHold && afk !== null) {
        const pushed = pushHeld(afk.held, text);
        afk.held = pushed.held;
        for (const line of pushed.evicted) {
          if (!evicted.includes(line)) evicted.push(line);
        }
        await writeAfk(afk);
      }
      for (const line of evicted) await deliverToCaptain(parentThreadId, line, crew.id);
      if (evicted.length > 0) await publishFleet();
      return;
    }
    await deliverToCaptain(parentThreadId, doorbell, crew.id);
    await publishFleet();
  }

  async function crewStatus(crew: Crew): Promise<string> {
    try {
      const thread = await bb.sdk.threads.get({ threadId: crew.threadId });
      return threadField(thread, "status");
    } catch {
      return "unknown";
    }
  }

  async function crewOutput(crew: Crew, max = MAX_OUTPUT): Promise<string | null> {
    try {
      const result = await bb.sdk.threads.output({ threadId: crew.threadId });
      const text = asRecord(result)["output"];
      return typeof text === "string" ? truncate(text, max) : null;
    } catch {
      return null;
    }
  }

  async function threadEnv(threadId: string): Promise<string | null> {
    try {
      const thread = await bb.sdk.threads.get({ threadId });
      const envId = asRecord(thread)["environmentId"];
      return typeof envId === "string" ? envId : null;
    } catch {
      return null;
    }
  }

  // A crew's append-only status stream, folded by the full protocol. When real
  // mode is active the authoritative source is the on-host state/<id>.status file
  // the worker appends to; otherwise (native path, or an unreachable host) fall
  // back to the status-protocol lines the crew emitted in its BB chat output.
  async function crewStatusLines(crew: Crew, output?: string | null): Promise<string[]> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome !== "" && !isSecondmateRoute(crew)) {
      try {
        const hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
        const path = `${fmHome}/state/${crew.id}.status`;
        const res = await runOnHost(hostId, `[ -f ${shQuote(path)} ] && cat -- ${shQuote(path)} || true`, 15_000);
        if (res.exitCode === 0 && res.output.trim() !== "") return res.output.split(/\r?\n/);
      } catch {
        // fall through to chat output
      }
    }
    return statusLinesFrom(output === undefined ? await crewOutput(crew) : output);
  }

  // Close a crew's open keyed decision when the captain answers it. Native
  // firstmate writes the closing `resolved [key=...]` line via `fm send
  // --resolve-key`; the BB plugin's steer is a plain thread message, so without
  // this the on-host state/<id>.status keeps the decision open forever (and
  // `crew <id>` reads it as stale). Best-effort, real-mode only; a bad key or an
  // unreachable host is a silent no-op — the steer message itself still lands.
  async function appendResolvedStatus(crew: Crew, key: string, note: string): Promise<boolean> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return false;
    if (isSecondmateRoute(crew)) return false;
    if (!/^[A-Za-z0-9._-]+$/.test(key)) return false; // fm-classify-lib slug charset
    let hostId: string;
    try {
      hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
    } catch {
      return false;
    }
    const path = `${fmHome}/state/${crew.id}.status`;
    // Matches fm-classify-lib grammar: `resolved [key=<slug>]: <note>`.
    const line = `resolved [key=${key}]: ${note.replace(/[\r\n]+/g, " ").trim().slice(0, 200)}`;
    const script = [
      `mkdir -p ${shQuote(`${fmHome}/state`)}`,
      `printf '%s\\n' ${shQuote(line)} >> ${shQuote(path)}`,
    ].join("\n");
    try {
      const res = await runOnHost(hostId, script, 15_000);
      if (res.exitCode !== 0) {
        bb.log.warn(`fm resolve append failed crew=${crew.id} key=${key} exit=${res.exitCode}`);
        return false;
      }
      bb.log.info(`fm decision resolved crew=${crew.id} key=${key}`);
      return true;
    } catch (error) {
      bb.log.warn(`fm resolve append failed crew=${crew.id} key=${key} ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async function waitThreadPath(threadId: string, timeoutMs: number): Promise<string | null> {
    if (timeoutMs <= 0) return null;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const envId = await threadEnv(threadId);
      if (envId !== null) {
        try {
          const env = await bb.sdk.environments.get({ environmentId: envId });
          const path = env.path;
          if (typeof path === "string" && path !== "") return path;
        } catch {
          // keep polling
        }
      }
      if (Date.now() >= deadline) return null;
      await sleep(1000);
    }
  }

  async function projectCheckoutPath(projectId: string): Promise<string | null> {
    try {
      const listed = await bb.sdk.environments.list({ projectId });
      const preferred = listed.find((e) => !e.isWorktree && e.status === "ready" && typeof e.path === "string" && e.path !== "");
      if (preferred?.path) return preferred.path;
    } catch {
      // try project sources
    }
    try {
      const project = await bb.sdk.projects.get({ projectId });
      const def = project.sources.find((s) => s.isDefault) ?? project.sources[0];
      if (def !== undefined && def.path !== "") return def.path;
    } catch {
      // none
    }
    return null;
  }

  async function publishFmMeta(input: {
    crew: Crew;
    hostId?: string;
    scheduled: boolean;
    model?: string;
    provider?: string;
  }): Promise<boolean> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return false;
    let hostId = input.hostId;
    if (hostId === undefined || hostId === "") {
      try {
        hostId = await resolveHostForProject(input.crew.projectId, input.crew.parentThreadId ?? undefined);
      } catch (error) {
        bb.log.warn(
          `fm meta skipped: no host crew=${input.crew.id} ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
    }
    const worktree = input.crew.worktree && !input.scheduled
      ? ((await waitThreadPath(input.crew.threadId, 45_000)) ?? "")
      : "";
    const project = (await projectCheckoutPath(input.crew.projectId)) ?? worktree;
    const posture = await postureOf(input.crew.projectId);
    const body = formatFmMeta({
      id: input.crew.id,
      threadId: input.crew.threadId,
      worktree,
      project,
      kind: input.crew.shape,
      mode: input.crew.shape === "ship" ? input.crew.posture : undefined,
      yolo: input.crew.shape === "ship" ? (posture.yolo ? "on" : "off") : undefined,
      model: input.model ?? input.crew.model ?? undefined,
      provider: input.provider ?? input.crew.providerId ?? undefined,
      effort: input.crew.reasoningLevel ?? undefined,
    });
    const stateDir = `${fmHome}/state`;
    const dest = `${stateDir}/${input.crew.id}.meta`;
    const tmp = `${stateDir}/.${input.crew.id}.meta.dispatch.${process.pid}.${Date.now()}`;
    const tasktmp = `/tmp/fm-${input.crew.id}`;
    const script = [
      `mkdir -p ${shQuote(stateDir)} ${shQuote(tasktmp)}`,
      `printf '%s' ${shQuote(body)} > ${shQuote(tmp)}`,
      `mv -f ${shQuote(tmp)} ${shQuote(dest)}`,
    ].join("\n");
    try {
      const result = await runOnHost(hostId, script, 20_000);
      if (result.exitCode !== 0) {
        bb.log.warn(
          `fm meta write failed crew=${input.crew.id} exit=${result.exitCode} ${result.output.slice(0, 500)}`,
        );
        return false;
      }
      bb.log.info(`fm meta written crew=${input.crew.id} path=${dest}`);
      return true;
    } catch (error) {
      bb.log.warn(
        `fm meta write failed crew=${input.crew.id} ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  // Scaffold the authoritative structured brief (data/<id>/brief.md) via the real
  // fm-brief.sh, then fill its {TASK}/{FIRSTMATE_SPEC} placeholders so real tools
  // (fm-bearings-snapshot, teardown, a manual `fm` relaunch) see a Captain-intent /
  // Firstmate-spec brief for a BB-dispatched crew, not just a synthetic prompt.
  // Best-effort and idempotent (never overwrites an existing brief); a missing
  // script or host failure is silent — the crew already has the structured prompt.
  async function publishFmBrief(crew: Crew, hostId: string | undefined, task: string): Promise<boolean> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return false;
    if (isSecondmateRoute(crew)) return false;
    let host = hostId;
    if (host === undefined || host === "") {
      try {
        host = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
      } catch {
        return false;
      }
    }
    const brief = `${fmHome}/data/${crew.id}/brief.md`;
    const briefScript = `${fmHome}/bin/fm-brief.sh`;
    // Strip a leading Captain-label/address line so native fm-spawn.sh's
    // fm_brief_intent_address_line does not refuse the brief (B1).
    const intentB64 = Buffer.from(normalizeCaptainIntent(task.trim()).slice(0, 3000), "utf8").toString("base64");
    // fm-brief refuses --mode on scouts and requires it on ships; a ship's posture
    // is exactly the delivery mode the brief records.
    const scaffold =
      crew.shape === "scout"
        ? `${shQuote(briefScript)} ${shQuote(crew.id)} crew --scout`
        : `${shQuote(briefScript)} ${shQuote(crew.id)} crew --mode ${shQuote(crew.posture)}`;
    const py =
      "import base64,os,sys;p=sys.argv[1];" +
      'intent=base64.b64decode(os.environ["FM_INTENT"]).decode();' +
      'spec="Implement the captain\'s intent above exactly; do not widen scope. Small diff, own branch, deliver per the mode contract, then report DONE/BLOCKED/FAILED.";' +
      "s=open(p).read();s=s.replace('{TASK}',intent).replace('{FIRSTMATE_SPEC}',spec);open(p,'w').write(s)";
    const script = [
      `export FM_HOME=${shQuote(fmHome)}`,
      `export FM_ROOT=${shQuote(fmHome)}`,
      `[ -f ${shQuote(briefScript)} ] || exit 0`,
      `[ -f ${shQuote(brief)} ] && exit 0`,
      `${scaffold} >/dev/null 2>&1 || exit 0`,
      `FM_INTENT=${intentB64} python3 -c ${shQuote(py)} ${shQuote(brief)} || exit 0`,
    ].join("\n");
    try {
      const res = await runOnHost(host, script, 30_000);
      if (res.exitCode !== 0) {
        bb.log.warn(`fm brief scaffold failed crew=${crew.id} exit=${res.exitCode}`);
        return false;
      }
      bb.log.info(`fm brief scaffolded crew=${crew.id} path=${brief}`);
      return true;
    } catch (error) {
      bb.log.warn(`fm brief scaffold failed crew=${crew.id} ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async function dropFmMeta(crew: Crew): Promise<void> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return;
    let hostId: string;
    try {
      hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
    } catch {
      return;
    }
    const dest = `${fmHome}/state/${crew.id}.meta`;
    try {
      const result = await runOnHost(hostId, `rm -f ${shQuote(dest)}`, 15_000);
      if (result.exitCode !== 0) {
        bb.log.warn(`fm meta drop failed crew=${crew.id} exit=${result.exitCode}`);
      }
    } catch (error) {
      bb.log.warn(
        `fm meta drop failed crew=${crew.id} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  // True when a crew already has an authoritative state/<id>.meta on its host.
  // Used by the migration so it never overwrites the real state of active work.
  async function fmMetaExists(crew: Crew): Promise<boolean | null> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return null;
    let hostId: string;
    try {
      hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
    } catch {
      return null;
    }
    const dest = `${fmHome}/state/${crew.id}.meta`;
    try {
      const res = await runOnHost(hostId, `[ -f ${shQuote(dest)} ] && echo FM_META_EXISTS || echo FM_META_ABSENT`, 15_000);
      if (res.output.includes("FM_META_EXISTS")) return true;
      if (res.output.includes("FM_META_ABSENT")) return false;
      return null;
    } catch {
      return null;
    }
  }

  // Read a single key from a real state/<id>.meta on the host. Returns the value,
  // "" when the key is absent, or null when the host/state is unreadable. Used by
  // the real transport to learn the thread id the real fm-spawn.sh created.
  async function readFmMetaField(hostId: string, crewId: string, key: string): Promise<string | null> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return null;
    const dest = `${fmHome}/state/${crewId}.meta`;
    try {
      const res = await runOnHost(
        hostId,
        `[ -f ${shQuote(dest)} ] && grep ${shQuote(`^${key}=`)} ${shQuote(dest)} | tail -1 | cut -d= -f2- || echo FM_META_ABSENT`,
        15_000,
      );
      const out = res.output.trim();
      if (out === "" || out.includes("FM_META_ABSENT")) return "";
      return out;
    } catch {
      return null;
    }
  }

  // One batched host read of the real ledger: the set of task ids that currently
  // have a state/<id>.meta. Used to reconcile the KV crew cache against the real
  // plane's authoritative existence (item 3). null on any host/read failure, so a
  // read failure never drops a crew. One `ls`-style read per call, never per-crew.
  async function existingFmMetaIds(hostId: string, fmHome: string, signal?: AbortSignal): Promise<Set<string> | null> {
    const dir = `${fmHome}/state`;
    try {
      const res = await runOnHost(
        hostId,
        `for f in ${shQuote(dir)}/*.meta; do [ -e "$f" ] || continue; b=$(basename "$f" .meta); printf '%s\\n' "$b"; done`,
        15_000,
        signal,
      );
      const ids = res.output
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s !== "" && !s.startsWith(".") && !s.includes("*"));
      return new Set(ids);
    } catch {
      return null;
    }
  }

  // Find a BB thread the real fm-spawn.sh created for this task but did not record
  // in state/<id>.meta — the narrow hard-kill window between `bb thread spawn` and
  // the meta write (fm-spawn's own BB_ABORT_CLEANUP trap handles graceful failures,
  // so this only fires on a SIGKILL / host death). Matched by the deterministic
  // thread title `fm-<taskId>` or the crewId recorded by `mark-crew --task`. Only
  // threads not already tracked as crews are considered, so this never steals a
  // live crew's thread. Returns the thread id to adopt, or null.
  async function findOrphanThreadForTask(taskId: string): Promise<string | null> {
    const known = new Set((await readCrews()).map((c) => c.threadId).filter((t) => t !== ""));
    const wantTitle = `fm-${taskId}`;
    // R4: the orphan is created by the `bb thread spawn` CLI inside fm-spawn and
    // tagged by a SEPARATE `bb firstmate mark-crew` call. In the SIGKILL window
    // between those two, BB may not yet attribute originPluginId=firstmate to the
    // thread, so a filtered list would miss it. Do a filtered pass first (cheap),
    // then, only if it finds nothing, a broad unfiltered pass — both matched by
    // the deterministic title `fm-<taskId>` (set by the overlay at spawn time) or
    // the crewId metadata. This makes adoption independent of the origin filter.
    const match = async (rows: unknown[]): Promise<string | null> => {
      for (const row of rows) {
        const rec = asRecord(row);
        const tid = rec["id"];
        if (typeof tid !== "string" || known.has(tid)) continue;
        const title = rec["title"];
        if (typeof title === "string" && (title === wantTitle || title.startsWith(`${wantTitle} `))) return tid;
        try {
          const meta = asRecord(await bb.sdk.threads.getPluginMetadata({ threadId: tid, pluginId: "firstmate" }));
          if (meta["crewId"] === taskId) return tid;
        } catch {
          // metadata unreadable; title match already tried
        }
      }
      return null;
    };
    const rowsOf = (found: unknown): unknown[] =>
      Array.isArray(found)
        ? found
        : Array.isArray(asRecord(found)["threads"])
          ? (asRecord(found)["threads"] as unknown[])
          : [];
    try {
      const filtered = await match(rowsOf(await bb.sdk.threads.list({ originPluginId: "firstmate", includeHidden: true, limit: 50 })));
      if (filtered !== null) return filtered;
      // Broad fallback: no origin filter (catches a not-yet-tagged CLI spawn).
      return await match(rowsOf(await bb.sdk.threads.list({ includeHidden: true, limit: 50 })));
    } catch {
      // list unavailable → caller native-spawns
    }
    return null;
  }

  // The real transport swap: dispatch a crew end-to-end through the real
  // fm-brief.sh + fm-spawn.sh (backend=bb) so the real scripts create the brief,
  // the worktree, the thread and state/<id>.meta — with harness/provider/model/
  // effort all threaded into the BB thread. Returns the thread id the real spawn
  // created, or null when the spawn failed BEFORE any thread existed (the caller
  // then falls back to native dispatch). Never double-spawns: if a bb_thread_id
  // is already recorded (even on a later partial failure) that id is returned.
  async function dispatchViaRealTransport(
    crew: Crew,
    input: {
      task: string;
      projectId: string;
      parentThreadId?: string;
      permissionMode?: PermissionMode;
    },
    hostId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return null;
    // A crew may already carry a real thread (idempotent re-dispatch). Never spawn twice.
    const existing = await readFmMetaField(hostId, crew.id, "bb_thread_id");
    if (existing !== null && existing !== "") return existing;
    const projectDir = await projectCheckoutPath(input.projectId);
    if (projectDir === null || projectDir === "") {
      bb.log.warn(`real transport: no project checkout for crew=${crew.id}; falling back to native`);
      return null;
    }
    // Scaffold the authoritative brief first — a ship spawn reads its recorded
    // "Delivery contract: mode=" line and refuses a mismatch, so the brief must
    // exist (with the right mode) before fm-spawn.sh runs.
    await publishFmBrief(crew, hostId, input.task);
    const posture = await postureOf(input.projectId);
    // Pin the harness to the bb backend explicitly. fm-spawn.sh resolves the crew
    // harness from config/crew-harness → fm-harness.sh's own-runtime detection, which
    // returns `unknown` inside a BB host terminal (no harness env markers) — so a
    // ship/scout with no --harness aborts with "no launch template for harness
    // 'unknown'" and BB silently falls back to native. backend=bb has a launch
    // template, so `--harness bb` makes the real transport actually spawn.
    const args =
      crew.shape === "scout"
        ? [crew.id, projectDir, "--scout", "--backend", "bb", "--harness", "bb"]
        : [crew.id, projectDir, "--mode", crew.posture, "--yolo", posture.yolo ? "on" : "off", "--backend", "bb", "--harness", "bb"];
    if (crew.model !== null && crew.model !== "") args.push("--model", crew.model);
    if (crew.reasoningLevel !== null) args.push("--effort", crew.reasoningLevel);
    const capped = capPermission(input.permissionMode, await parentPermission(input.parentThreadId));
    const env: Record<string, string> = {};
    if (crew.providerId !== null && crew.providerId !== "") env.FM_BB_PROVIDER = crew.providerId;
    if (capped !== undefined) env.FM_BB_PERMISSION_MODE = capped;
    let spawnFailed = false;
    try {
      const res = await runFmScript({
        script: "spawn",
        args,
        hostId,
        fmHome,
        projectId: input.projectId,
        parentThreadId: input.parentThreadId,
        env,
        timeoutMs: fmTimeoutMs("spawn", undefined),
        signal,
      });
      if (res.exitCode !== 0) {
        spawnFailed = true;
        // LOUD (B1): a non-zero fm-spawn exit (e.g. the brief-refusal that made every
        // real spawn fail) must be an error, not a muffled warn.
        bb.log.error(`real transport spawn crew=${crew.id} exit=${res.exitCode} ${res.output.slice(0, 600)}`);
      } else {
        bb.log.info(`real transport spawn crew=${crew.id} ok`);
      }
    } catch (error) {
      spawnFailed = true;
      bb.log.warn(`real transport spawn crew=${crew.id} ${error instanceof Error ? error.message : String(error)}`);
    }
    // Even on a non-zero exit, a thread may already exist — read the meta and
    // honour it rather than native-spawning a duplicate.
    const threadId = await readFmMetaField(hostId, crew.id, "bb_thread_id");
    if (threadId !== null && threadId !== "") return threadId;
    // No recorded thread. fm-spawn may still have created one and been hard-killed
    // before writing bb_thread_id. Adopt that orphan instead of native-spawning a
    // duplicate; only when none exists do we fall back to native (return null).
    const orphan = await findOrphanThreadForTask(crew.id);
    if (orphan !== null) {
      bb.log.info(`real transport adopted orphan thread ${orphan} for crew=${crew.id} (fm-spawn left no bb_thread_id; spawnFailed=${spawnFailed})`);
      return orphan;
    }
    return null;
  }

  // A crew is terminal — its task is over — when its turn failed, its thread is
  // gone/archived, or its last words / status carry a DONE/FAILED verdict.
  // migrate-state skips these so backfilling a meta cannot make the real watcher
  // (which iterates state/*.meta and supervises each) try to resurrect dead work.
  async function crewIsTerminal(crew: Crew): Promise<boolean> {
    const status = await crewStatus(crew);
    if (status === "unknown" || status === "error") return true; // thread gone/failed
    const output = await crewOutput(crew);
    const outcome = parseOutcome(output);
    if (outcome !== null && (outcome.startsWith("DONE") || outcome.startsWith("FAILED"))) return true;
    const latest = latestStatus(statusLinesFrom(output));
    return latest !== null && (latest.verb === "done" || latest.verb === "failed");
  }

  // Idempotently import the KV crew cache into the authoritative real state:
  // write state/<id>.meta + a structured brief for every tracked, still-active
  // crew that does not already have one. Existing real state is never overwritten
  // (active work is left intact) and terminal/dead crews are skipped, so a re-run
  // is a no-op and the watcher cannot resurrect finished work. KV is left
  // untouched — it stays the rebuildable cache this only backfills.
  async function migrateState(): Promise<{
    total: number;
    imported: string[];
    skippedExisting: string[];
    skippedSecondmate: string[];
    skippedTerminal: string[];
    failed: string[];
  }> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") {
      throw new Error("Real mode is off (no fmHome). Run: bb firstmate init --real");
    }
    const crews = await readCrews();
    const imported: string[] = [];
    const skippedExisting: string[] = [];
    const skippedSecondmate: string[] = [];
    const skippedTerminal: string[] = [];
    const failed: string[] = [];
    for (const crew of crews) {
      if (isSecondmateRoute(crew)) {
        skippedSecondmate.push(crew.id);
        continue;
      }
      const exists = await fmMetaExists(crew);
      if (exists === true) {
        skippedExisting.push(crew.id);
        continue;
      }
      if (exists === null) {
        failed.push(crew.id);
        continue;
      }
      if (await crewIsTerminal(crew)) {
        skippedTerminal.push(crew.id);
        continue;
      }
      // scheduled:true keeps the meta write from blocking on a (possibly gone)
      // worktree path — a historical crew's meta records identity, not live path.
      const okMeta = await publishFmMeta({ crew, scheduled: true, model: crew.model ?? undefined, provider: crew.providerId ?? undefined });
      if (!okMeta) {
        failed.push(crew.id);
        continue;
      }
      // The meta now exists — clear any known-failed flag so read-through can reap
      // it normally once the real plane tears it down.
      if (crew.metaWritten === false) {
        await writeCrews((await readCrews()).map((c) => (c.id === crew.id ? { ...c, metaWritten: undefined } : c)));
      }
      await publishFmBrief(crew, undefined, crew.task);
      imported.push(crew.id);
    }
    return { total: crews.length, imported, skippedExisting, skippedSecondmate, skippedTerminal, failed };
  }

  // Idempotent migration of the KV cache for the five owners (queue/decisions/afk/
  // quiet/memory) into the real files, for the owners currently set to "real".
  // Safe to re-run: queue/decisions rows already projected (have a backlogId / are
  // terminal) are skipped; memory/afk/quiet writes are overwrites. project* helpers
  // no-op unless their owner flag is "real", so this only touches enabled planes.
  async function migrateOwners(): Promise<{
    queue: { projected: number; skipped: number };
    decisions: { projected: number; skipped: number };
    afk: boolean;
    quiet: boolean;
    memory: boolean;
  }> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") throw new Error("Real mode is off (no fmHome). Run: bb firstmate init --real");
    const out = {
      queue: { projected: 0, skipped: 0 },
      decisions: { projected: 0, skipped: 0 },
      afk: false,
      quiet: false,
      memory: false,
    };

    if (await queueIsReal()) {
      const items = await readQueue();
      let dirty = false;
      for (const item of items) {
        if (item.status === "done" || item.status === "dropped") { out.queue.skipped++; continue; }
        // Already projected (has a row id): never re-add — keeps migrate-owners
        // idempotent. We reuse the KV item id as the backlog row id (native
        // caller-owns-the-id convention), so the row is deterministic.
        if (item.backlogId !== undefined && item.backlogId !== "") { out.queue.skipped++; continue; }
        const proj = await projectQueueAdd(item.id, item.title, item.shape, item.projectId);
        if (!proj.ok) { out.queue.skipped++; continue; }
        item.backlogId = item.id;
        if (item.status === "dispatched") await projectQueueTransition(item, "start");
        out.queue.projected++;
        dirty = true;
      }
      if (dirty) await writeQueue(items);
    }

    if (await decisionsIsReal()) {
      for (const d of await readDecisions()) {
        if (d.status === "answered") { out.decisions.skipped++; continue; }
        if (d.status === "deferred") await projectDecisionDefer(d, d.deferredUntil);
        else await projectDecisionAsk(d);
        out.decisions.projected++;
      }
    }

    if (await afkIsReal()) {
      const afk = await readAfk();
      if (afk?.on === true) { await projectAfkOn(afk.words, []); out.afk = true; }
    }
    if (await quietIsReal()) {
      if ((await readQuiet()).on) { await projectQuiet(true); out.quiet = true; }
    }
    if (await memoryIsReal()) {
      // D1: under memoryOwner=real the tiered FILES are authoritative — the KV blobs
      // are only a lossy cache. Projecting KV→file unconditionally (the old bug) let
      // a re-run of the documented-"safe" migrate clobber the head of learnings.md
      // with the truncated cache, unrecoverably. migrateMemoryTier reverses the
      // direction: it mirrors file→KV when the real file has content, and only ever
      // seeds KV→file when the real file is empty/absent (which can never shrink real
      // data). A shrinking overwrite of non-empty real content is refused outright.
      const okCap = await migrateMemoryTier(MEM_CAPTAIN_FILE, MEM_CAPTAIN_KEY);
      const okLearn = await migrateMemoryTier(MEM_LEARNINGS_FILE, MEM_LEARNINGS_KEY);
      out.memory = okCap && okLearn;
    }
    return out;
  }

  async function parentPermission(parentThreadId: string | undefined): Promise<PermissionMode | undefined> {
    if (parentThreadId === undefined) return undefined;
    try {
      const opts = await bb.sdk.threads.defaultExecutionOptions({ threadId: parentThreadId });
      return toPermissionMode(asRecord(opts)["permissionMode"]);
    } catch {
      return undefined;
    }
  }

  async function prForCrew(crew: Crew): Promise<PrFacts> {
    const envId = await threadEnv(crew.threadId);
    if (envId === null) return prFacts(null);
    try {
      return prFacts(await bb.sdk.environments.pullRequest({ environmentId: envId }));
    } catch {
      return prFacts(null);
    }
  }

  // The exact names of a PR's non-green checks, via gh (mirrors fm-pr-merge's
  // statusCheckRollup read). null when they cannot be read — a failed read is
  // never an empty red set, so the caller must refuse rather than merge.
  async function redCheckNames(crew: Crew, prUrl: string): Promise<string[] | null> {
    if (prUrl === "") return null;
    let hostId: string;
    try {
      hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
    } catch {
      return null;
    }
    try {
      const res = await runOnHost(
        hostId,
        `gh pr checks ${shQuote(prUrl)} --json name,bucket 2>/dev/null || true`,
        30_000,
      );
      const parsed: unknown = JSON.parse(res.output.trim() || "[]");
      if (!Array.isArray(parsed)) return null;
      const red: string[] = [];
      for (const row of parsed) {
        const rec = asRecord(row);
        const bucket = rec["bucket"];
        const name = rec["name"];
        if (typeof name === "string" && (bucket === "fail" || bucket === "cancel")) red.push(name);
      }
      return red;
    } catch {
      return null;
    }
  }

  async function listCrews(): Promise<Crew[]> {
    const crews = await readCrews();
    const known = new Set(crews.map((c) => c.threadId));
    try {
      const found = await bb.sdk.threads.list({
        originPluginId: "firstmate",
        includeHidden: true,
        limit: 50,
      });
      const rows: unknown[] = Array.isArray(found)
        ? found
        : Array.isArray(asRecord(found)["threads"])
          ? (asRecord(found)["threads"] as unknown[])
          : [];
      const missing = rows
        .map((row) => ({
          threadId: asRecord(row)["id"],
          projectId: asRecord(row)["projectId"],
          parentThreadId: asRecord(row)["parentThreadId"],
        }))
        .filter(
          (r): r is { threadId: string; projectId: string; parentThreadId: unknown } =>
            typeof r.threadId === "string" && typeof r.projectId === "string" && !known.has(r.threadId),
        )
        .slice(0, 20);
      const recovered = await Promise.all(
        missing.map(async (row): Promise<Crew | null> => {
          try {
            const meta = asRecord(
              await bb.sdk.threads.getPluginMetadata({ threadId: row.threadId, pluginId: "firstmate" }),
            );
            if (!metaFlag(meta, "crew")) return null;
            const id = typeof meta["crewId"] === "string" ? meta["crewId"] : row.threadId.slice(0, 8);
            return {
              id,
              task: typeof meta["task"] === "string" ? meta["task"] : "(recovered crew)",
              projectId: row.projectId,
              threadId: row.threadId,
              parentThreadId: typeof row.parentThreadId === "string" ? row.parentThreadId : null,
              providerId: null,
              model: null,
              reasoningLevel: null,
              worktree: metaFlag(meta, "worktree"),
              shape: toShape(meta["shape"]),
              posture: typeof meta["posture"] === "string" ? meta["posture"] : "direct-PR",
              createdAt: "",
            };
          } catch {
            return null;
          }
        }),
      );
      let dirty = false;
      for (const crew of recovered) {
        if (crew !== null && !crews.some((c) => c.id === crew.id)) {
          crews.push(crew);
          dirty = true;
        }
      }
      if (dirty) await writeCrews(crews);
    } catch {
      // kv alone still works
    }
    // Read-through reconciliation (item 3, opt-in): real state/<id>.meta is the
    // source of truth for crew existence. One batched host read; drop KV crews the
    // real plane no longer tracks (torn down). Secondmate routes have no meta and
    // are exempt; a failed read (null) never drops anything.
    try {
      const s = await settings.get();
      if (s.readThrough === true && s.fmHome.trim() !== "") {
        const hostId = await resolveFmWatchHostId();
        if (hostId !== null) {
          const ids = await existingFmMetaIds(hostId, s.fmHome.trim());
          if (ids !== null) {
            // R5: never reap a crew whose dispatch-time meta write is known to have
            // failed (metaWritten===false) — its current absence is not proof of
            // teardown. Secondmate routes have no meta and are always exempt.
            const kept = crews.filter((c) => isSecondmateRoute(c) || ids.has(c.id) || c.metaWritten === false);
            if (kept.length !== crews.length) {
              for (const gone of crews) {
                if (!kept.includes(gone)) {
                  bb.log.info(`read-through: crew ${gone.id} dropped (no real state/<id>.meta)`);
                  await markQueueForCrew(gone.id, "done").catch(() => {});
                }
              }
              await writeCrews(kept);
              return kept;
            }
          }
        }
      }
    } catch {
      // reconciliation is best-effort; the KV cache still serves
    }
    return crews;
  }

  async function findCrew(id: string): Promise<Crew | undefined> {
    return (await listCrews()).find((entry) => entry.id === id);
  }

  async function findCrewByThread(threadId: string): Promise<Crew | undefined> {
    return (await listCrews()).find((entry) => entry.threadId === threadId);
  }

  function formatCrew(crew: Crew, status: string): string {
    return `${crew.id} [${status}] ${crew.shape} ${crew.threadId} ${crew.worktree ? "worktree" : "shared-env"} :: ${truncate(crew.task, 80)}`;
  }

  async function resolveHostForProject(projectId: string, parentThreadId?: string): Promise<string> {
    if (parentThreadId !== undefined) {
      const envId = await threadEnv(parentThreadId);
      if (envId !== null) {
        try {
          const env = await bb.sdk.environments.get({ environmentId: envId });
          const hostId = asRecord(env)["hostId"];
          if (typeof hostId === "string" && hostId !== "") return hostId;
        } catch {
          // fall through to project environments
        }
      }
    }
    const listed = await bb.sdk.environments.list({ projectId });
    const preferred = listed.find((e) => e.isWorktree === false && e.status === "ready" && e.hostId !== "");
    const any = listed.find((e) => e.status === "ready" && e.hostId !== "");
    const pick = preferred ?? any;
    if (pick === undefined) {
      throw new Error("No host for an isolated worktree. Run dispatch from a thread on a machine, or use --shared-env.");
    }
    return pick.hostId;
  }

  async function dispatchCrew(input: {
    task: string;
    projectId: string;
    parentThreadId?: string;
    title?: string;
    providerId?: string;
    model?: string;
    reasoningLevel?: ReasoningLevel;
    permissionMode?: PermissionMode;
    worktree: boolean;
    visible: boolean;
    shape: Shape;
    mode: DeliveryMode;
    sendAt?: number;
  }): Promise<Crew> {
    const task = input.task.trim().slice(0, MAX_TASK);
    if (task === "") throw new Error("Empty task.");
    const mates = await readSecondmates();
    const mate = pickSecondmate(mates, input.projectId, task);
    if (mate !== undefined && mate.threadId !== input.parentThreadId) {
      // The mate thread may be dead/archived — if the routing send throws, do NOT
      // fail the dispatch: log and fall through to a normal native spawn so the
      // task is never lost. (The captain can re-register a live secondmate later.)
      try {
        await bb.sdk.threads.send({
          threadId: mate.threadId,
          mode: "auto",
          input: [
            {
              type: "text",
              text: `Routed work from main captain.\nShape: ${input.shape}\nMode: ${input.mode}\n\n${task}\n\nDispatch a crew for this. Reply with the crew id when underway.`,
              mentions: [],
            },
          ],
        });
        const routed: Crew = {
          id: `sm-${randomUUID().slice(0, 6)}`,
          task: `[secondmate ${mate.threadId}] ${task}`,
          projectId: input.projectId,
          threadId: mate.threadId,
          parentThreadId: input.parentThreadId ?? null,
          providerId: null,
          model: null,
          reasoningLevel: null,
          worktree: false,
          shape: input.shape,
          posture: `secondmate:${input.mode}`,
          createdAt: new Date().toISOString(),
        };
        await writeCrews([routed, ...(await readCrews())]);
        return routed;
      } catch (error) {
        bb.log.warn(
          `secondmate route to ${mate.threadId} failed (${error instanceof Error ? error.message : String(error)}); spawning a normal crew instead.`,
        );
      }
    }
    const crew: Crew = {
      id: randomUUID().slice(0, 8),
      task,
      projectId: input.projectId,
      threadId: "",
      parentThreadId: input.parentThreadId ?? null,
      providerId: input.providerId ?? null,
      model: input.model ?? null,
      reasoningLevel: input.reasoningLevel ?? null,
      worktree: input.worktree,
      shape: input.shape,
      posture: input.shape === "scout" ? "scout" : input.mode,
      createdAt: new Date().toISOString(),
    };
    // Transport swap: when the real transport is selected and real mode is active,
    // dispatch through the real fm-brief.sh + fm-spawn.sh (backend=bb) so the real
    // scripts own the brief/worktree/thread/meta/profile. Native BB dispatch is the
    // automatic fallback if the real spawn fails before a thread exists — and a
    // future-scheduled send always uses native (fm-spawn has no sendAt).
    const cur = await settings.get();
    const scheduledFuture = input.sendAt !== undefined && input.sendAt > Date.now();
    if (cur.transport === "real" && cur.fmHome.trim() !== "" && !scheduledFuture) {
      try {
        const rtHost = await resolveHostForProject(input.projectId, input.parentThreadId);
        const realThreadId = await dispatchViaRealTransport(
          crew,
          {
            task: input.task,
            projectId: input.projectId,
            parentThreadId: input.parentThreadId,
            permissionMode: input.permissionMode,
          },
          rtHost,
        );
        if (realThreadId !== null && realThreadId !== "") {
          crew.threadId = realThreadId;
          await writeCrews([crew, ...(await readCrews())]);
          await publishFleet();
          // The real fm-spawn.sh already wrote state/<id>.meta + the brief; the
          // native publishFmMeta/publishFmBrief backfills would only duplicate.
          return crew;
        }
        // LOUD (B1): a real-transport dispatch that produced no thread is a
        // degradation, not routine info — a permanent silent fallback must never be
        // able to masquerade as a working real transport again.
        bb.log.error(
          `real transport FAILED for crew=${crew.id} (fm-spawn produced no bb_thread_id); falling back to native dispatch — real transport is NOT working`,
        );
      } catch (error) {
        bb.log.warn(
          `real transport error crew=${crew.id}; using native dispatch: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const capped = capPermission(input.permissionMode, await parentPermission(input.parentThreadId));
    let hostId: string | undefined;
    let environment: Parameters<typeof bb.sdk.threads.spawn>[0]["environment"];
    if (input.worktree) {
      hostId = await resolveHostForProject(input.projectId, input.parentThreadId);
      environment = {
        type: "host",
        hostId,
        workspace: { type: "managed-worktree", baseBranch: { kind: "default" } },
      };
    } else {
      environment = { type: "project-default" };
    }
    const spawned = await bb.sdk.threads.spawn({
      projectId: input.projectId,
      environment,
      prompt: crewPrompt({
        task,
        parentThreadId: input.parentThreadId,
        shape: input.shape,
        mode: input.mode,
        isolated: input.worktree,
      }),
      title: input.title ?? `Crew: ${truncate(task, 60)}`,
      parentThreadId: input.parentThreadId,
      providerId: input.providerId,
      model: input.model,
      reasoningLevel: input.reasoningLevel,
      permissionMode: capped,
      visibility: input.visible ? "visible" : "hidden",
      sendAt: input.sendAt,
      pluginMetadata: {
        crew: "true",
        crewId: crew.id,
        task: task.slice(0, 500),
        shape: input.shape,
        posture: crew.posture,
        worktree: input.worktree,
      },
    });
    crew.threadId = threadIdOf(spawned);
    await writeCrews([crew, ...(await readCrews())]);
    await publishFleet();
    const scheduled = input.sendAt !== undefined && input.sendAt > Date.now();
    const okMeta = await publishFmMeta({ crew, hostId, scheduled, model: input.model, provider: input.providerId });
    // R5: only record a known-failed write. undefined (write succeeded, or real
    // mode is off) stays reapable; false marks "meta write failed, do not reap on
    // absence" so read-through can't reap a live crew whose meta never landed.
    if ((await settings.get()).fmHome.trim() !== "" && !okMeta) {
      crew.metaWritten = false;
      await writeCrews((await readCrews()).map((c) => (c.id === crew.id ? crew : c)));
    }
    await publishFmBrief(crew, hostId, input.task);
    return crew;
  }

  // Recovery-grade relaunch: reuse the crew's own environment/worktree but start a
  // fresh thread that may switch provider/model/reasoning. Unlike threads.retry
  // (a same-thread failed-turn resubmit), this mirrors fm-control relaunch —
  // the new thread runs at the requested reasoning from turn 1.
  async function relaunchCrew(
    crew: Crew,
    opts: { providerId?: string; model?: string; reasoningLevel?: ReasoningLevel; note?: string },
  ): Promise<Crew> {
    if (isSecondmateRoute(crew)) {
      throw new Error(`Crew ${crew.id} is a secondmate route — relaunch the domain captain thread directly.`);
    }
    if (await isCaptainThread(crew.threadId)) {
      throw new Error("Refusing to relaunch the captain thread.");
    }
    const envId = await threadEnv(crew.threadId);
    if (envId === null) throw new Error(`Crew ${crew.id} has no environment to reuse.`);
    const providerId = opts.providerId ?? crew.providerId ?? undefined;
    const model = opts.model ?? crew.model ?? undefined;
    const reasoningLevel = opts.reasoningLevel ?? toReasoningLevel(crew.reasoningLevel);
    const capped = capPermission(undefined, await parentPermission(crew.parentThreadId ?? undefined));
    // Release the old thread first so the environment is free to reuse.
    try { await bb.sdk.threads.stop({ threadId: crew.threadId }); } catch { /* best effort */ }
    const note = (opts.note ?? "").trim();
    const prompt = [
      crewPrompt({
        task: crew.task,
        parentThreadId: crew.parentThreadId ?? undefined,
        shape: crew.shape,
        mode: toMode(crew.posture, "direct-PR"),
        isolated: crew.worktree,
      }),
      "",
      `RELAUNCH: the prior thread was replaced. Continue the same task in this same worktree.${note !== "" ? ` Progress note: ${note}` : ""}`,
    ].join("\n");
    const spawned = await bb.sdk.threads.spawn({
      projectId: crew.projectId,
      environment: { type: "reuse", environmentId: envId },
      prompt,
      title: `Crew: ${truncate(crew.task, 60)}`,
      parentThreadId: crew.parentThreadId ?? undefined,
      providerId,
      model,
      reasoningLevel,
      permissionMode: capped,
      visibility: "visible",
      pluginMetadata: {
        crew: "true",
        crewId: crew.id,
        task: crew.task.slice(0, 500),
        shape: crew.shape,
        posture: crew.posture,
        worktree: crew.worktree,
      },
    });
    const oldThreadId = crew.threadId;
    const next: Crew = {
      ...crew,
      threadId: threadIdOf(spawned),
      providerId: providerId ?? null,
      model: model ?? null,
      reasoningLevel: reasoningLevel ?? null,
    };
    await writeCrews((await readCrews()).map((c) => (c.id === crew.id ? next : c)));
    if (oldThreadId !== next.threadId) {
      try { await bb.sdk.threads.archive({ threadId: oldThreadId }); } catch { /* best effort */ }
    }
    await publishFleet();
    await publishFmMeta({ crew: next, scheduled: false });
    return next;
  }

  // Write a captain→crew steer as a durable, sequenced steering-inbox record via the
  // real fm-task-inbox-lib primitive. F4: `fm-send.sh` has NO literal-body form
  // (MESSAGE=$*), so a body starting with `--resolve-key`/`--fire-and-forget`/`--key`
  // is eaten by its option loop and a leading `/` or `$` is diverted to the crew
  // harness's own parser — none of which the captain intends for a chat steer.
  // `fm_task_inbox_write <state> <id> <body> fire-and-forget` takes the body as ONE
  // positional arg, so every prefix is stored verbatim (proven). F3: it needs no
  // state/<id>.meta, so a crew created before real transport is never rendered
  // unsteerable. Base64 keeps the body out of the command text entirely.
  //
  // The record is written `fire-and-forget` DELIBERATELY (re-review HIGH): a BB thread
  // crew is steered over the BB send and never reads its inbox, so it never `mv`s the
  // record into handled/ to ack it. A normal record would leave fm-watch's
  // inbox_steer_check seeing a permanently-unhandled steer and escalate it into a
  // FALSE stuck-crewmate-recovery (immediately for an idle crew, since the bb backend
  // maps idle→dead). fire-and-forget records are excluded from the re-ring ladder
  // (fm_task_inbox_oldest_unhandled skips them → due_action stays `quiet`), so the
  // record stays a durable audit trail without ever being weaponized by the watcher.
  // Best-effort: false ⇒ no durable record (caller still delivers the doorbell).
  async function writeInboxRecord(hostId: string, fmHome: string, crewId: string, body: string): Promise<boolean> {
    const lib = `${fmHome}/bin/fm-task-inbox-lib.sh`;
    const stateDir = `${fmHome}/state`;
    const b64 = Buffer.from(body.slice(0, MAX_TASK), "utf8").toString("base64");
    const script = [
      `export FM_HOME=${shQuote(fmHome)}`,
      `export FM_ROOT=${shQuote(fmHome)}`,
      `[ -f ${shQuote(lib)} ] || { echo "error: missing ${lib}" >&2; exit 127; }`,
      `. ${shQuote(lib)}`,
      `mkdir -p ${shQuote(stateDir)}`,
      `body=$(printf '%s' ${shQuote(b64)} | base64 -d)`,
      `fm_task_inbox_write ${shQuote(stateDir)} ${shQuote(crewId)} "$body" fire-and-forget >/dev/null`,
    ].join("\n");
    try {
      const res = await runOnHost(hostId, script, 20_000);
      if (res.exitCode !== 0) {
        bb.log.warn(`fm inbox record crew=${crewId} exit=${res.exitCode}`);
        return false;
      }
      return true;
    } catch (error) {
      bb.log.warn(`fm inbox record crew=${crewId} ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  // Bounded reaper for the FIRE-AND-FORGET steering-inbox records. Best-effort and bounded: a
  // failure just leaves the records in place (the doorbell already delivered). The pure script
  // builder (inboxReapScript) reaps ONLY records carrying delivery=fire-and-forget and leaves
  // handled/ and non-.msg files alone; see its comment.
  async function reapInboxRecords(hostId: string, fmHome: string, crewId: string): Promise<void> {
    const dir = `${fmHome}/state/${crewId}.inbox`;
    try {
      await runOnHost(hostId, inboxReapScript(dir, MAX_INBOX_RECORDS), 15_000);
    } catch (error) {
      bb.log.warn(`fm inbox reap crew=${crewId} ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // tellOwner=real: a captain→crew steer gets a durable fire-and-forget steering-inbox
  // record (verbatim audit trail; NOT re-rung — the crew is steered over BB, not by
  // reading its inbox) AND is delivered as the literal doorbell over BB — identical to
  // the KV path, so no crew regresses. Delivery never depends on fm-send target
  // resolution or state/<id>.meta (F3), and the body is stored/delivered verbatim
  // regardless of prefix (F4). interrupt/stop stay hard steers, never this path.
  // Returns a status string once the literal doorbell is delivered; null when
  // tellOwner=kv, fmHome unset, or the BB send itself fails (so tellCrew's own send is
  // the last-resort fallback).
  async function sendViaInbox(crew: Crew, message: string): Promise<string | null> {
    const current = await settings.get();
    if (current.tellOwner !== "real") return null;
    const fmHome = current.fmHome.trim();
    if (fmHome === "" || isSecondmateRoute(crew)) return null;
    let hostId: string | null = null;
    try {
      hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
    } catch {
      hostId = null;
    }
    const durable = hostId === null ? false : await writeInboxRecord(hostId, fmHome, crew.id, message);
    if (durable && hostId !== null) await reapInboxRecords(hostId, fmHome, crew.id);
    try {
      await bb.sdk.threads.send({
        threadId: crew.threadId,
        mode: "queue-if-active",
        input: [{ type: "text", text: message.slice(0, MAX_TASK), mentions: [] }],
      });
    } catch (error) {
      // Couldn't even deliver the literal doorbell — let tellCrew's own send try.
      bb.log.warn(`fm inbox doorbell crew=${crew.id} ${error instanceof Error ? error.message : String(error)}; falling back`);
      return null;
    }
    bb.log.info(`fm inbox steer crew=${crew.id} ${durable ? "durable record + literal doorbell" : "literal doorbell (no durable record)"}`);
    return durable
      ? `Told crew ${crew.id} (delivered over BB + durable fire-and-forget inbox record for audit; not re-rung)`
      : `Told crew ${crew.id} (delivered over BB; durable record unavailable — logged)`;
  }

  async function tellCrew(crew: Crew, message: string, interrupt: boolean): Promise<string> {
    if (isSecondmateRoute(crew) && interrupt) {
      throw new Error(`Crew ${crew.id} is a secondmate route — do not interrupt the domain captain thread.`);
    }
    // Steer (not interrupt) routes through the durable inbox when tellOwner=real.
    // interrupt/stop always stay a hard bb steer — never the inbox — so an interrupt
    // is never misread as a queued instruction.
    if (!interrupt) {
      const routed = await sendViaInbox(crew, message);
      if (routed !== null) return routed;
    }
    await bb.sdk.threads.send({
      threadId: crew.threadId,
      mode: interrupt ? "steer" : "queue-if-active",
      input: [{ type: "text", text: message.slice(0, MAX_TASK), mentions: [] }],
    });
    if (interrupt) return `Interrupted crew ${crew.id}`;
    const status = await crewStatus(crew);
    return status === "active" || status === "starting" || status === "pending"
      ? `Queued for crew ${crew.id} (doorbell; not interrupting)`
      : `Told crew ${crew.id}`;
  }

  async function waitOne(crew: Crew, timeoutMs: number, signal?: AbortSignal): Promise<string> {
    const st = await crewStatus(crew);
    if (st === "idle" || st === "error" || st === "unknown") return st;
    try {
      await Promise.race([
        bb.sdk.threads.wait({ threadId: crew.threadId, status: "idle", timeoutMs, signal }),
        bb.sdk.threads.wait({ threadId: crew.threadId, status: "error", timeoutMs, signal }),
      ]);
      return await crewStatus(crew);
    } catch {
      return "timeout";
    }
  }

  async function deliverLines(crew: Crew): Promise<{ text: string; json: Record<string, unknown> }> {
    const status = await crewStatus(crew);
    const output = await crewOutput(crew, 500);
    const envId = await threadEnv(crew.threadId);
    if (envId === null) {
      return {
        json: { ...crew, status, output, env: null },
        text: `${formatCrew(crew, status)}\nNo environment yet (thread starting?).`,
      };
    }
    const [envRes, uncommittedRes, prRes] = await Promise.allSettled([
      bb.sdk.environments.get({ environmentId: envId }),
      bb.sdk.environments.diffFiles({ environmentId: envId, target: "uncommitted" }),
      bb.sdk.environments.pullRequest({ environmentId: envId }),
    ]);
    const envRec = envRes.status === "fulfilled" ? asRecord(envRes.value) : {};
    const branch = envRec["branchName"] ?? envRec["branch"] ?? envRec["name"] ?? "unknown";
    const base =
      (typeof envRec["mergeBaseBranch"] === "string" && envRec["mergeBaseBranch"]) ||
      (typeof envRec["defaultBranch"] === "string" && envRec["defaultBranch"]) ||
      (typeof envRec["baseBranch"] === "string" && envRec["baseBranch"]) ||
      null;
    let committed: string[] = [];
    if (base !== null) {
      const committedRes = await bb.sdk.environments
        .diffFiles({ environmentId: envId, target: "branch_committed", mergeBaseBranch: base })
        .catch(() => null);
      committed = committedRes === null ? [] : extractPaths(committedRes);
    }
    const uncommitted = uncommittedRes.status === "fulfilled" ? extractPaths(uncommittedRes.value) : [];
    const pr = prRes.status === "fulfilled" ? summarizePR(prRes.value) : "unknown";
    const prF = prRes.status === "fulfilled" ? prFacts(prRes.value) : prFacts(null);
    const posture = await postureOf(crew.projectId);
    const files = [...new Set([...committed, ...uncommitted])];
    const lines = [
      formatCrew(crew, status),
      `env: ${envId} branch: ${typeof branch === "string" ? branch : "unknown"}`,
      committed.length === 0
        ? "committed vs base: none"
        : `committed (${committed.length}): ${committed.slice(0, 20).join(", ")}${committed.length > 20 ? "…" : ""}`,
      uncommitted.length === 0
        ? "uncommitted: none"
        : `uncommitted (${uncommitted.length}): ${uncommitted.slice(0, 20).join(", ")}`,
      `PR: ${pr}`,
      `posture: ${crew.posture}${posture.yolo ? "+yolo" : ""} — merge: bb firstmate merge ${crew.id}${posture.yolo ? "" : " --yes"}`,
    ];
    try {
      const thread = await bb.sdk.threads.get({ threadId: crew.threadId });
      const queued = asRecord(thread)["queuedMessageCount"];
      if (typeof queued === "number" && queued > 0) {
        lines.push(`inbox: ${queued} queued message(s)`);
      }
    } catch {
      // best effort
    }
    if (pr === "none" && crew.shape === "ship" && crew.posture !== "local-only") {
      lines.push(`create: open a PR from the crew branch, or bb environment pull-request show ${envId}`);
    }
    if (output !== null) {
      const outcome = parseOutcome(output);
      lines.push(
        outcome === null ? `last words: ${truncate(output.replace(/\n/g, " "), 300)}` : `outcome: ${outcome}`,
      );
    }
    return {
      json: {
        ...crew, status, output, envId, branch, files, committed, uncommitted, pr, prUrl: prF.url,
      },
      text: lines.join("\n"),
    };
  }

  async function bearingsSnapshot(): Promise<{
    text: string;
    json: Record<string, unknown>;
    rpc: {
      head: string;
      calls: string[];
      landed: string[];
      ready: Array<{
        id: string; status: string; shape: string; posture: string;
        task: string; threadId: string; prUrl: string; worktree: boolean;
      }>;
      running: Array<{
        id: string; status: string; shape: string; posture: string;
        task: string; threadId: string; prUrl: string; worktree: boolean;
      }>;
      next: string[];
      afk: boolean;
      quiet: boolean;
      supervision: boolean;
    };
  }> {
    const tracked = (await listCrews()).slice(0, 20);
    const retired = await reconcileExternallyLanded(tracked);
    const crews = retired.size === 0 ? tracked : tracked.filter((c) => !retired.has(c.id));
    const rows = await Promise.all(
      crews.map(async (crew) => {
        const status = await crewStatus(crew);
        const pr = status === "idle" || status === "error" ? await prForCrew(crew) : prFacts(null);
        // Fold the crew's own status protocol for idle crews: an idle crew that
        // emitted needs-decision/blocked is a captain call, not a review-ready
        // ship. Chat output only (no host read) keeps the deck render cheap —
        // but chat transcripts never carry the resolved/captain-held closes (those
        // land in the on-host state/<id>.status), so a crew that raised a decision,
        // got answered, and then finished DONE would fold to a stale-open decision.
        // Guard on the latest verb not being terminal: once a crew's last status is
        // done/failed the task is over, so any earlier decision is moot here.
        const lines = status === "idle" && !isSecondmateRoute(crew) ? statusLinesFrom(await crewOutput(crew)) : [];
        const latest = latestStatus(lines);
        const openDecisions =
          latest !== null && latest.verb !== "done" && latest.verb !== "failed" ? foldOpenDecisions(lines) : [];
        return { ...crew, status, prUrl: pr.url, openDecisions, prSummary: summarizePR({ pullRequest: { url: pr.url, number: pr.number, title: pr.title, state: pr.state, checks: { state: pr.checksState } } }) };
      }),
    );
    const now = Date.now();
    const decisions = await readDecisions();
    const queue = await readQueue();
    const done = await readDone();
    const count = (s: string) => rows.filter((r) => r.status === s).length;
    const idle = count("idle");
    const active = rows.filter((r) => r.status !== "idle" && r.status !== "error").length;
    const errors = count("error");
    const due = decisions.filter((d) => decisionDue(d, now));
    const dispatchable = queue.filter((q) => q.status === "queued" && queueGate(q, queue, now) === null);
    const calls = [
      ...due.map(
        (d) =>
          `? ${d.id} :: ${truncate(d.question, 90)}${d.options.length > 0 ? ` (${d.options.join(" / ")})` : ""}${d.crewId !== null ? ` [crew ${d.crewId}]` : ""} — answer: decide answer ${d.id} -- "<answer>"`,
      ),
      ...rows
        .filter((row) => row.status === "error")
        .map((row) => `! ${formatCrew(row, row.status)} — NEEDS DECISION: turn failed (retry? tell? forget?)`),
      ...rows
        .filter((row) => row.status === "idle" && row.openDecisions.length > 0)
        .map((row) => {
          const d = row.openDecisions[row.openDecisions.length - 1]!;
          return `? ${row.id} — ${d.verb.toUpperCase()} [${d.key}]: ${truncate(d.note, 80)} — steer: bb firstmate tell ${row.id} -- "<answer>"`;
        }),
      ...rows
        .filter((row) => row.status === "idle" && row.openDecisions.length === 0 && row.prUrl !== "")
        .map(
          (row) =>
            `PR ready ${row.id}: ${row.prUrl} — merge: bb firstmate merge ${row.id} --yes`,
        ),
      ...dispatchable.map(
        (q) => `○ ${q.id} [${q.shape}] :: ${truncate(q.title, 70)} — dispatchable: bb firstmate queue dispatch ${q.id}`,
      ),
    ];
    const landed = done.map(
      (d) =>
        `✓ ${truncate(d.task.split("\n")[0] ?? d.task, 80)}${d.pr !== "" ? ` — ${d.pr}` : ""}${d.outcome !== "" ? ` (${truncate(d.outcome, 60)})` : ""}`,
    );
    const readyRows = rows.filter((row) => row.status === "idle" && row.openDecisions.length === 0);
    const ready = readyRows.map((row) => {
      const pr = row.prUrl !== "" ? ` ${row.prUrl}` : "";
      return `• ${formatCrew(row, row.status)}${pr} — ready to review (crew/deliver)`;
    });
    const runningRows = rows.filter((row) => row.status !== "idle" && row.status !== "error");
    const running = runningRows.map((row) => `• ${formatCrew(row, row.status)} — running`);
    const next = [
      ...queue
        .filter((q) => q.status === "queued")
        .map((q) => {
          const gate = queueGate(q, queue, now);
          return `○ ${q.id} [${q.shape}] :: ${truncate(q.title, 70)}${gate !== null ? ` — ${gate}` : " — dispatchable"}`;
        }),
      ...decisions
        .filter((d) => d.status === "deferred" && !decisionDue(d, now))
        .map(
          (d) =>
            `○ deferred ${d.id} :: ${truncate(d.question, 70)}${d.deferredUntil !== null ? ` (until ${d.deferredUntil})` : ""}`,
        ),
    ];
    const text = bearingsText({
      rows: rows.map((r) => ({ id: r.id, status: r.status, shape: r.shape, task: r.task, prUrl: r.prUrl })),
      calls, landed, ready, running, next, idle, active, errors,
      decisionsDue: due.length,
      queued: queue.filter((q) => q.status === "queued").length,
    });
    const toRow = (row: (typeof rows)[number]) => ({
      id: row.id,
      status: row.status,
      shape: row.shape,
      posture: row.posture,
      task: truncate(row.task, 120),
      threadId: row.threadId,
      prUrl: row.prUrl,
      worktree: row.worktree,
    });
    const rpc = {
      head: text.split("\n")[0] ?? text,
      calls,
      landed,
      ready: readyRows.map(toRow),
      running: runningRows.map(toRow),
      next,
      afk: (await readAfk())?.on === true,
      quiet: await isQuiet(),
      supervision: (await settings.get()).supervisionEnabled === true,
    };
    return {
      text,
      json: {
        total: rows.length, idle, active, errors, crews: rows, decisionsDue: due, queue: queue.filter((q) => q.status === "queued"), done,
      },
      rpc,
    };
  }

  async function sessionDigest(): Promise<string> {
    // D3: recall must reflect the authoritative files, not the KV cache. When
    // memoryOwner=real, memoryShow reads data/captain.md + data/learnings.md
    // directly (and degrades to KV only if the host read fails), so /captain,
    // deck and session never serve a truncated/stale view — including after a
    // native `/stow` edit that never touches KV. In kv mode this is the KV read.
    const mem = await memoryShow();
    const capText = mem.captain !== "" ? mem.captain : "(empty)";
    const learnText = mem.learnings !== "" ? mem.learnings : "(empty)";
    const afk = await readAfk();
    const snap = await bearingsSnapshot();
    return [
      "== session ==",
      `afk: ${afk?.on === true ? `on since ${afk.since}` : "off"} · quiet: ${(await isQuiet()) ? "on" : "off"}`,
      snap.text,
      "== captain prefs ==",
      capText,
      "== learnings ==",
      learnText,
    ].join("\n");
  }

  async function captainLabel(projectId: unknown): Promise<string> {
    if (typeof projectId !== "string" || projectId === "") return "Captain";
    try {
      const project = await bb.sdk.projects.get({ projectId });
      if (project.kind !== "personal" && project.name.trim() !== "") {
        return `Captain · ${project.name}`;
      }
    } catch {
      // keep generic
    }
    return "Captain";
  }

  async function isCaptainThread(threadId: string): Promise<boolean> {
    try {
      const meta = asRecord(
        await bb.sdk.threads.getPluginMetadata({ threadId, pluginId: "firstmate" }),
      );
      return metaFlag(meta, "captain");
    } catch {
      return false;
    }
  }

  async function settleDeck(threadId: string): Promise<void> {
    await bb.sdk.threads.updatePluginMetadata({
      threadId,
      set: { captain: "true" },
    });
    try {
      await settings.experimental_set({ supervisionEnabled: true });
    } catch {
      // settings may already be on
    }
    try {
      const thread = asRecord(await bb.sdk.threads.get({ threadId }));
      const patch: { threadId: string; title?: string; visibility?: "visible" } = { threadId };
      if (isBlankTitle(thread["title"])) {
        patch.title = await captainLabel(thread["projectId"]);
      }
      if (thread["visibility"] !== "visible") patch.visibility = "visible";
      if (patch.title !== undefined || patch.visibility !== undefined) {
        await bb.sdk.threads.update(patch);
      }
      if (thread["pinnedAt"] == null) {
        await bb.sdk.threads.pin({ threadId });
      }
    } catch (error) {
      bb.log.warn(
        `deck settle failed thread=${threadId} ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function markDeck(threadId: string): Promise<void> {
    await settleDeck(threadId);
  }

  function isCaptainSpawn(thread: { title?: string | null; titleFallback?: string | null }): boolean {
    return looksLikeCaptainPrompt(thread.titleFallback) || looksLikeCaptainPrompt(thread.title);
  }

  async function mergeCrew(crew: Crew, yes: boolean, allowRedCheck?: string): Promise<string> {
    const posture = await postureOf(crew.projectId);
    // Captain authority (yes/yolo) and an allowRedCheck waiver are separate: the
    // waiver never grants authority, so a --allow-red without --yes still refuses.
    if (!posture.yolo && !yes) {
      throw new Error(
        `Needs captain's word: re-run with --yes, or set yolo (bb firstmate posture set --project ${crew.projectId} --yolo on).`,
      );
    }
    const envId = await threadEnv(crew.threadId);
    if (envId === null) throw new Error(`Crew ${crew.id} has no environment yet.`);
    if (isSecondmateRoute(crew)) {
      throw new Error(`Crew ${crew.id} is a secondmate route, not a ship to merge.`);
    }
    const local = crew.posture === "local-only" || (crew.shape === "ship" && posture.mode === "local-only");
    if (local) return mergeLocal(crew, envId);
    if (crew.posture === "no-mistakes" || posture.mode === "no-mistakes") {
      const dirty = extractPaths(
        await bb.sdk.environments.diffFiles({ environmentId: envId, target: "uncommitted" }).catch(() => null),
      );
      if (dirty.length > 0) {
        throw new Error(`no-mistakes: ${dirty.length} uncommitted file(s) remain (${dirty.slice(0, 5).join(", ")}).`);
      }
    }
    const f = prFacts(await bb.sdk.environments.pullRequest({ environmentId: envId }));
    if (!f.available) throw new Error(`No PR for crew ${crew.id}. For local-only: bb firstmate posture set --project ${crew.projectId} --mode local-only then merge.`);
    if (f.state === "merged") {
      await retireLanded(crew, "merged (already landed)", f.url);
      return `Already merged: ${f.url}\nCrew ${crew.id} retired.`;
    }
    const waive = (allowRedCheck ?? "").trim();
    const redChecks = waive !== "" && f.checksState === "failing" ? await redCheckNames(crew, f.url) : null;
    const gate = mergeGate({
      prState: f.state,
      checksState: f.checksState,
      mergeable: f.mergeable,
      failed: f.failed,
      pending: f.pending,
      allowRedCheck: waive,
      redChecks,
    });
    if (!gate.ok) throw new Error(`Refusing: ${gate.reason}`);
    await bb.sdk.environments.mergePullRequest({ environmentId: envId, method: "merge" });
    const output = await crewOutput(crew, 300);
    const waived = gate.waived.length > 0 ? ` (waived red check: ${gate.waived.join(", ")})` : "";
    await retireLanded(crew, `${parseOutcome(output) ?? "merged"}${waived}`, f.url);
    return `Merged ${f.url}${waived}\nCrew ${crew.id} retired (landed).`;
  }

  async function mergeLocal(crew: Crew, envId: string): Promise<string> {
    const env = asRecord(await bb.sdk.environments.get({ environmentId: envId }));
    const branch = typeof env["branchName"] === "string" ? env["branchName"] : "";
    if (branch === "") throw new Error("Crew environment has no branch.");
    const projectId = crew.projectId;
    const listed = await bb.sdk.environments.list({ projectId });
    const main = listed.find((e) => e.isWorktree === false && e.status === "ready" && e.path);
    if (main === undefined || main.path === null) {
      throw new Error("No project checkout to fast-forward (need a non-worktree ready environment).");
    }
    const hostId = main.hostId;
    const result = await runOnHost(
      hostId,
      `git -C ${shQuote(main.path)} merge --ff-only ${shQuote(branch)}`,
      120000,
    );
    if (result.exitCode !== 0) {
      throw new Error(`local ff-only merge failed:\n${truncate(result.output, 800)}`);
    }
    await retireLanded(crew, `local ff-only ${branch} → ${main.path}`, "");
    return `Landed locally (ff-only) ${branch}\nCrew ${crew.id} retired.`;
  }

  async function retireLanded(crew: Crew, outcome: string, pr: string): Promise<void> {
    await recordDone({ task: crew.task.slice(0, 200), shape: crew.shape, crewId: crew.id, outcome, pr });
    await markQueueForCrew(crew.id, "done");
    await writeCrews((await readCrews()).filter((c) => c.id !== crew.id));
    if (!(await isCaptainThread(crew.threadId))) {
      try { await bb.sdk.threads.archive({ threadId: crew.threadId }); } catch { /* best effort */ }
      try { await bb.sdk.threads.stop({ threadId: crew.threadId }); } catch { /* best effort */ }
    }
    // Retire both representations atomically: without this the real state/<id>.meta
    // ledger keeps a landed crew that GitHub and the KV cache have both dropped.
    await dropFmMeta(crew);
    await publishFleet();
  }

  // Live-check tracked crews against the forge and retire any whose PR was
  // merged or closed outside BB (e.g. the captain merged it on GitHub). Without
  // this, an external merge leaves the crew stale in both the KV cache and the
  // real state/<id>.meta ledger. Only idle/error crews are checked — an active
  // crew's PR is not landed yet — so this adds no PR reads beyond bearings.
  async function reconcileExternallyLanded(crews: Crew[]): Promise<Set<string>> {
    const retired = new Set<string>();
    for (const crew of crews) {
      if (isSecondmateRoute(crew)) continue;
      const status = await crewStatus(crew);
      if (status !== "idle" && status !== "error") continue;
      const pr = await prForCrew(crew);
      if (!pr.available) continue;
      if (pr.state === "merged") {
        await retireLanded(crew, "merged externally", pr.url);
        retired.add(crew.id);
      } else if (pr.state === "closed") {
        await retireLanded(crew, "PR closed externally", pr.url);
        retired.add(crew.id);
      }
    }
    return retired;
  }

  async function forgetCrew(id: string, stop: boolean, force: boolean): Promise<string> {
    const crews = await readCrews();
    let crew = crews.find((entry) => entry.id === id);
    if (crew === undefined) {
      const recovered = await findCrew(id);
      if (recovered === undefined) throw new Error(`No crew ${id}. Run "bb firstmate crews".`);
      if (stop && (await isCaptainThread(recovered.threadId))) {
        throw new Error(
          "Refusing to archive the captain thread. Forget the crew without --stop.",
        );
      }
      try {
        await bb.sdk.threads.updatePluginMetadata({
          threadId: recovered.threadId,
          set: { crew: "false" },
          remove: ["crewId"],
        });
      } catch {
        // metadata-only
      }
      if (stop) {
        try { await bb.sdk.threads.archive({ threadId: recovered.threadId }); } catch { /* */ }
        try { await bb.sdk.threads.stop({ threadId: recovered.threadId }); } catch { /* */ }
      }
      await dropFmMeta(recovered);
      await dropNudge(id);
      return `Forgot crew ${id} (was metadata-only)`;
    }
    await writeCrews(crews.filter((entry) => entry.id !== id));
    if (stop && isSecondmateRoute(crew) && !force) {
      await writeCrews([crew, ...(await readCrews())]);
      throw new Error(`Refusing: ${id} is a secondmate route. Drop with forget (no --stop), or --force to also stop that thread.`);
    }
    if (stop) {
      if (await isCaptainThread(crew.threadId)) {
        await writeCrews([crew, ...(await readCrews())]);
        throw new Error(
          "Refusing to archive the captain thread. Forget the crew without --stop.",
        );
      }
      if (!force) {
        const envId = await threadEnv(crew.threadId);
        if (envId !== null) {
          const diff = await bb.sdk.environments
            .diffFiles({ environmentId: envId, target: "uncommitted" })
            .catch(() => null);
          const dirty = diff === null ? [] : extractPaths(diff);
          if (dirty.length > 0) {
            await writeCrews([crew, ...(await readCrews())]);
            throw new Error(
              `Refusing: crew ${id} has ${dirty.length} uncommitted file(s) (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? "…" : ""}). Deliver first, or re-run with --force to discard.`,
            );
          }
        }
      }
      try { await bb.sdk.threads.archive({ threadId: crew.threadId }); } catch { /* */ }
      try { await bb.sdk.threads.stop({ threadId: crew.threadId }); } catch { /* */ }
    }
    try {
      if ((await crewStatus(crew)) === "idle") {
        const out = await crewOutput(crew, 300);
        const f = await prForCrew(crew);
        await recordDone({
          task: crew.task.slice(0, 200),
          shape: crew.shape,
          crewId: crew.id,
          outcome: parseOutcome(out) ?? "",
          pr: f.url,
        });
        await markQueueForCrew(crew.id, "done");
      }
    } catch {
      // best effort
    }
    await publishFleet();
    await dropFmMeta(crew);
    await dropNudge(id);
    return `Forgot crew ${id}`;
  }

  async function resolveHostId(machineFlag: string | undefined, ctx: unknown): Promise<string> {
    if (machineFlag !== undefined) {
      const hosts = await bb.sdk.hosts.list();
      const rows: unknown[] = Array.isArray(hosts)
        ? hosts
        : Array.isArray(asRecord(hosts)["hosts"])
          ? (asRecord(hosts)["hosts"] as unknown[])
          : [];
      const match = rows.find((h) => {
        const rec = asRecord(h);
        return rec["id"] === machineFlag || rec["name"] === machineFlag;
      });
      const id = match === undefined ? undefined : asRecord(match)["id"];
      if (typeof id !== "string") throw new Error(`No machine ${machineFlag}. See bb machine list.`);
      return id;
    }
    const threadId = asRecord(ctx)["threadId"];
    if (typeof threadId !== "string") throw new Error("No machine: pass --machine <id-or-name> (see bb machine list).");
    const envId = await threadEnv(threadId);
    if (envId === null) throw new Error("No machine: pass --machine <id-or-name>.");
    const env = await bb.sdk.environments.get({ environmentId: envId });
    const hostId = asRecord(env)["hostId"];
    if (typeof hostId !== "string") throw new Error("No machine: pass --machine <id-or-name>.");
    return hostId;
  }

  function decodeChunks(value: unknown): string {
    const chunks = asRecord(value)["chunks"];
    if (!Array.isArray(chunks)) return "";
    return chunks
      .map((c) => {
        const b64 = asRecord(c)["dataBase64"];
        if (typeof b64 !== "string") return "";
        try {
          return Buffer.from(b64, "base64").toString("utf-8");
        } catch {
          return "";
        }
      })
      .join("");
  }

  // Run one command in a fresh host terminal and return its exit code + output.
  // No stdin: the payload path (`stdin`) is handled by runOnHost, which stages the
  // bytes to a host file and redirects them in — never through the PTY, whose
  // canonical-mode line discipline never delivers un-newlined input to the reader.
  async function runHostCommand(
    hostId: string,
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<{ exitCode: number | null; output: string }> {
    const session = await bb.sdk.terminals.create({
      cols: 120,
      rows: 30,
      scope: { kind: "host_path", hostId, cwd: "/tmp" },
      start: { mode: "command", command: wrapHostCommand(command) },
      title: "firstmate-host",
    });
    const terminalId = asRecord(session)["id"] as string;
    let nextSeq = 0;
    let output = "";
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (signal?.aborted) throw new Error("Aborted.");
        if (Date.now() >= deadline) throw new Error("Timed out waiting for host command.");
        const cur = await bb.sdk.terminals.get({ terminalId });
        const status = asRecord(cur)["status"];
        if (status === "disconnected") throw new Error("Terminal disconnected.");
        try {
          const chunk = await bb.sdk.terminals.output({
            terminalId,
            sinceSeq: nextSeq,
            tailBytes: 65536,
          });
          const rec = asRecord(chunk);
          if (typeof rec["nextSeq"] === "number") nextSeq = rec["nextSeq"];
          output += decodeChunks(chunk);
        } catch (error) {
          bb.log.debug(
            `host terminal output terminal=${terminalId} status=${status} ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const parsed = parseHostRc(output);
        if (parsed !== null) return parsed;
        if (status === "exited") {
          const exitCode = asRecord(cur)["exitCode"];
          return { exitCode: typeof exitCode === "number" ? exitCode : 1, output: stripAnsi(output) };
        }
        await sleep(250);
      }
    } finally {
      try {
        await bb.sdk.terminals.close({ terminalId, mode: "force" });
      } catch {
        // best effort
      }
    }
  }

  // Run a command on the host, optionally feeding it `stdin`. Stdin is NOT sent
  // through the terminal (the PTY line discipline buffers+echoes un-newlined input
  // without ever delivering it to the reading process, so `head`/`cat < -` hangs
  // until timeout — even for 10 bytes). Instead the bytes are staged to a host file
  // with the injection-safe chunked writer and redirected into the command group.
  async function runOnHost(
    hostId: string,
    command: string,
    timeoutMs: number,
    signal?: AbortSignal,
    stdin?: string,
  ): Promise<{ exitCode: number | null; output: string }> {
    if (stdin === undefined) return runHostCommand(hostId, command, timeoutMs, signal);
    const tmp = `/tmp/.fm-stdin-${randomUUID()}`;
    if (!(await writeHostBytes(hostId, tmp, stdin, timeoutMs, signal))) {
      throw new Error("Failed to stage host stdin.");
    }
    try {
      // Group so the redirect feeds the whole (possibly multi-line) command its stdin.
      return await runHostCommand(hostId, `{\n${command}\n} < ${shQuote(tmp)}`, timeoutMs, signal);
    } finally {
      await runHostCommand(hostId, `rm -f ${shQuote(tmp)}`, 10_000).catch(() => {});
    }
  }

  // Write raw bytes to a host file WITHOUT ever placing the content in the shell
  // command text as executable syntax (F1). The payload is base64 (charset
  // [A-Za-z0-9+/=]: no quotes, newlines, spaces, or heredoc delimiters) and appended
  // to a temp file in bounded chunks — each `printf '%s' '<chunk>' >> tmp` stays
  // under HOST_COMMAND_MAX, so there is no size ceiling and no terminal-stdin path.
  // The temp file is decoded to a sibling and atomically renamed over the target, so
  // a failed or interrupted write never truncates an existing file (the old
  // `base64 -d > path` truncated the target before reading a single byte).
  async function writeHostBytes(
    hostId: string,
    path: string,
    content: string,
    timeoutMs = 15_000,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const dir = path.replace(/\/[^/]*$/, "") || "/";
    const nonce = randomUUID();
    const tmpB64 = `${path}.fm-b64-${nonce}`;
    const tmpOut = `${path}.fm-out-${nonce}`;
    const qB64 = shQuote(tmpB64);
    const qOut = shQuote(tmpOut);
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const cleanup = async () => {
      await runHostCommand(hostId, `rm -f ${qB64} ${qOut}`, 10_000, signal).catch(() => {});
    };
    try {
      let res = await runHostCommand(hostId, `mkdir -p ${shQuote(dir)} && : > ${qB64}`, timeoutMs, signal);
      if (res.exitCode !== 0) {
        await cleanup();
        return false;
      }
      // Each append command must fit under HOST_COMMAND_MAX after wrapping/quoting;
      // size the chunk from the temp path length with generous headroom.
      const chunkSize = Math.max(1000, HOST_COMMAND_MAX - Buffer.byteLength(tmpB64, "utf8") - 300);
      for (let i = 0; i < b64.length; i += chunkSize) {
        const chunk = b64.slice(i, i + chunkSize);
        res = await runHostCommand(hostId, `printf '%s' ${shQuote(chunk)} >> ${qB64}`, timeoutMs, signal);
        if (res.exitCode !== 0) {
          await cleanup();
          return false;
        }
      }
      res = await runHostCommand(
        hostId,
        `base64 -d ${qB64} > ${qOut} && mv -f ${qOut} ${shQuote(path)}`,
        timeoutMs,
        signal,
      );
      await cleanup();
      return res.exitCode === 0;
    } catch (error) {
      await cleanup();
      bb.log.warn(`host file write ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async function installBbBackend(
    hostId: string,
    home: string,
    projectId: string | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<string> {
    const overlayHome = OVERLAY_DIR;
    const installer = join(overlayHome, "install-bb-backend.py");
    const localProbe = await runOnHost(
      hostId,
      `[ -f ${shQuote(installer)} ] && echo FM_OVERLAY_LOCAL || echo FM_OVERLAY_REMOTE`,
      Math.min(30000, timeoutMs),
      signal,
    );
    if (localProbe.output.includes("FM_OVERLAY_LOCAL")) {
      const result = await runOnHost(
        hostId,
        `python3 ${shQuote(installer)} --home ${shQuote(home)} --overlay ${shQuote(overlayHome)}${projectId === undefined ? "" : ` --project-id ${shQuote(projectId)}`}`,
        timeoutMs,
        signal,
      );
      if (result.exitCode !== 0) {
        throw new Error(`BB backend overlay failed:\n${truncate(result.output, 1500)}`);
      }
      return result.output;
    }
    const files: Record<string, string> = {
      "bin/backends/bb.sh": overlayBytes("bin/backends/bb.sh"),
      "docs/bb-backend.md": overlayBytes("docs/bb-backend.md"),
      "firstmate-bb-backend.patch": overlayBytes("firstmate-bb-backend.patch"),
      "firstmate-bb-teardown.patch": overlayBytes("firstmate-bb-teardown.patch"),
      "install-bb-backend.py": overlayBytes("install-bb-backend.py"),
    };
    const py = [
      "import base64, json, os, pathlib, subprocess, sys, tempfile",
      "home = pathlib.Path(sys.argv[1])",
      "project_id = sys.argv[2] if len(sys.argv) > 2 else ''",
      "files = json.loads(sys.stdin.read())",
      "overlay = pathlib.Path(tempfile.mkdtemp(prefix='fm-bb-overlay-'))",
      "for rel, b64 in files.items():",
      "    dest = overlay / rel",
      "    dest.parent.mkdir(parents=True, exist_ok=True)",
      "    dest.write_bytes(base64.b64decode(b64))",
      "os.chmod(overlay / 'bin/backends/bb.sh', 0o755)",
      "os.chmod(overlay / 'install-bb-backend.py', 0o755)",
      "cmd = [sys.executable, str(overlay / 'install-bb-backend.py'), '--home', str(home), '--overlay', str(overlay)]",
      "if project_id:",
      "    cmd += ['--project-id', project_id]",
      "raise SystemExit(subprocess.call(cmd))",
    ].join("\n");
    const command = `python3 -c ${shQuote(py)} ${shQuote(home)}${projectId === undefined ? "" : ` ${shQuote(projectId)}`}`;
    const result = await runOnHost(hostId, command, timeoutMs, signal, JSON.stringify(files));
    if (result.exitCode !== 0) {
      throw new Error(`BB backend overlay failed:\n${truncate(result.output, 1500)}`);
    }
    return result.output;
  }

  // Clone + overlay the real firstmate toolbelt on the host and persist fmHome.
  // Idempotent: an existing clone is reused (FM_EXISTS) and the overlay re-applies
  // safely. Shared by `init --real` and the auto-init on first captain deck.
  async function initRealMode(
    ctx: unknown,
    signal: AbortSignal | undefined,
    opts: { machine?: string; path?: string; name?: string; timeoutMs?: number },
  ): Promise<{
    hostId: string;
    path: string;
    existed: boolean;
    projectId: string;
    overlay: string;
    tools: string;
    summary: string;
  }> {
    const current = await settings.get();
    const repo = current.firstmateRepo !== "" ? current.firstmateRepo : "https://github.com/kunchenguid/firstmate";
    const name = opts.name ?? "firstmate";
    const timeoutMs = opts.timeoutMs ?? 180000;
    const hostId = await resolveHostId(opts.machine, ctx);
    const home = (await runOnHost(hostId, `printf '%s' "$HOME"`, 30000, signal)).output.trim();
    if (home === "") throw new Error("Could not resolve $HOME on host.");
    const path = opts.path ?? `${home}/firstmate`;
    const tools = await runOnHost(
      hostId,
      "command -v git; command -v gh; command -v bb; command -v python3; " +
        "printf 'FM_AXI='; command -v tasks-axi || true; printf 'FM_AXI_VER='; tasks-axi --version 2>/dev/null || true; " +
        "gh auth status 2>&1 | head -n 3",
      30000,
      signal,
    );
    if (!tools.output.includes("git")) throw new Error(`git missing on host. Tools:\n${tools.output}`);
    // queueOwner=real drives the home's tasks-axi backlog. It is resolved purely
    // from PATH (npm package `tasks-axi`, min 0.2.4) and is NOT bundled. Verify it
    // and, if absent, surface the exact install command rather than silently
    // degrading — queue-real still degrades safely to the KV cache until it's there.
    const axiPresent = /FM_AXI=\S/.test(tools.output);
    const axiVer = /FM_AXI_VER=v?(\d+\.\d+\.\d+)/.exec(tools.output)?.[1] ?? "";
    const queueNote = !axiPresent
      ? "tasks-axi MISSING — install with 'npm install -g tasks-axi' on this host; queueOwner=real degrades to the KV cache until then"
      : axiVer !== "" && !versionAtLeast(axiVer, TASKS_AXI_MIN)
        ? `tasks-axi v${axiVer} is BELOW the required ${TASKS_AXI_MIN} — upgrade with 'npm install -g tasks-axi'; queueOwner=real degrades to the KV cache until then`
        : `tasks-axi present${axiVer !== "" ? ` (v${axiVer}; needs >=${TASKS_AXI_MIN})` : ` (version unknown; needs >=${TASKS_AXI_MIN})`}`;
    const clone = await runOnHost(
      hostId,
      `[ -d ${shQuote(`${path}/.git`)} ] && echo FM_EXISTS || git clone ${shQuote(repo)} ${shQuote(path)}`,
      timeoutMs,
      signal,
    );
    if (clone.exitCode !== 0) throw new Error(`Clone failed:\n${truncate(clone.output, 1000)}`);
    const existed = clone.output.includes("FM_EXISTS");
    // Version skew: a reused clone can lag the referenced source. Fast-forward it
    // (ff-only, and only when the tree is clean so a dirty overlay is never lost).
    let ffNote = existed ? "reused clone: no fast-forward attempted" : "fresh clone";
    if (existed) {
      const q = shQuote(path);
      const ff = await runOnHost(
        hostId,
        [
          `if [ -n "$(git -C ${q} status --porcelain 2>/dev/null)" ]; then echo FM_FF_SKIP_DIRTY; else`,
          `git -C ${q} fetch --quiet origin 2>&1 || echo FM_FF_FETCH_FAIL;`,
          `up=$(git -C ${q} rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true);`,
          `if [ -n "$up" ]; then git -C ${q} merge --ff-only "$up" 2>&1 && echo FM_FF_OK || echo FM_FF_NOFF; else echo FM_FF_NO_UPSTREAM; fi; fi`,
        ].join("\n"),
        timeoutMs,
        signal,
      );
      const out = ff.output;
      ffNote = out.includes("FM_FF_SKIP_DIRTY")
        ? "reused clone: fast-forward skipped (working tree dirty)"
        : out.includes("FM_FF_OK")
          ? "reused clone: fast-forwarded to origin"
          : out.includes("FM_FF_NOFF")
            ? "reused clone: not fast-forwardable (diverged); left as-is"
            : out.includes("FM_FF_NO_UPSTREAM")
              ? "reused clone: no upstream to fast-forward"
              : "reused clone: fast-forward attempted";
    }
    let projectId: string;
    try {
      const created = await bb.sdk.projects.create({ name, source: { type: "local_path", hostId, path } });
      projectId = asRecord(created)["id"] as string;
    } catch {
      const projects = await bb.sdk.projects.list();
      const rows: unknown[] = Array.isArray(projects) ? projects : [];
      const match = rows.find((p) => asRecord(p)["name"] === name);
      const id = match === undefined ? undefined : asRecord(match)["id"];
      if (typeof id !== "string") throw new Error(`Project create failed and no project named ${name} found.`);
      projectId = id;
    }
    const overlayOut = await installBbBackend(hostId, path, projectId, timeoutMs, signal);
    // Replace the stale hardcoded 194/21 with the counts of the actual clone.
    const q = shQuote(path);
    const counts = await runOnHost(
      hostId,
      `printf 'FM_SCRIPTS=%s\\nFM_SKILLS=%s\\n' "$(ls ${q}/bin/fm-*.sh 2>/dev/null | wc -l | tr -d ' ')" "$(ls -d ${q}/.agents/skills/*/ 2>/dev/null | wc -l | tr -d ' ')"`,
      Math.min(30000, timeoutMs),
      signal,
    ).catch(() => ({ output: "" }));
    const scriptCount = /FM_SCRIPTS=(\d+)/.exec(counts.output)?.[1] ?? "";
    const skillCount = /FM_SKILLS=(\d+)/.exec(counts.output)?.[1] ?? "";
    try {
      await settings.experimental_set({ fmHome: path, fmScriptCount: scriptCount, fmSkillCount: skillCount, fmHostId: hostId });
    } catch {
      // persist best-effort
    }
    // Load the real captain contract (AGENTS.md) so captain sessions run it, and
    // the version-pinned skills inventory (fmHome/.agents/skills @ HEAD).
    await refreshCaptainContract(hostId, path, signal);
    await refreshSkillsManifest(hostId, path, signal);
    await refreshCaptainMemory();
    const summary = [
      `host: ${hostId}`,
      `path: ${path} (${existed ? "existed" : "cloned"}; ${ffNote})`,
      `project: ${projectId}`,
      `backend: bb (overlay installed; config/backend=bb)`,
      `queue: ${queueNote}`,
      `toolbelt: ${toolbeltPhrase(scriptCount, skillCount)}`,
      `fm: bb firstmate fm spawn -- --mode direct-PR -- ship "<task>"`,
      `overlay:\n${truncate(overlayOut, 800)}`,
      `tools:\n${truncate(tools.output, 500)}`,
    ].join("\n");
    return { hostId, path, existed, projectId, overlay: overlayOut, tools: tools.output, summary };
  }

  // Real firstmate is the default. On deck, if it is not already initialized,
  // clone + overlay it now (best-effort); on any failure, surface the single
  // one-time command the captain must run. Returns a line for the deck digest.
  async function ensureRealModeForDeck(ctx: unknown, signal: AbortSignal | undefined): Promise<string> {
    const current = await settings.get();
    if (current.fmHome.trim() !== "") {
      // Refresh the version-pinned skills inventory when HEAD moved (best-effort).
      try {
        const hostId = await resolveHostId(undefined, ctx);
        await refreshSkillsManifest(hostId, current.fmHome, signal);
        await refreshCaptainMemory();
      } catch {
        // deck still renders; captain keeps the cached inventory
      }
      return [
        `Real firstmate: active (fmHome ${current.fmHome}; ${toolbeltPhrase(current.fmScriptCount, current.fmSkillCount)}).`,
        `Dispatch through the full toolbelt: bb firstmate fm spawn -- --mode direct-PR -- ship "<task>".`,
      ].join("\n");
    }
    try {
      const res = await initRealMode(ctx, signal, {});
      return [
        `Real firstmate: initialized now (${res.existed ? "reused clone" : "cloned"}).`,
        res.summary,
      ].join("\n");
    } catch (error) {
      return [
        "Real firstmate: not active yet. Run this once to unlock the full toolbelt",
        `(${toolbeltPhrase(current.fmScriptCount, current.fmSkillCount)}):`,
        "  bb firstmate init --real",
        `(auto-init skipped: ${error instanceof Error ? error.message : String(error)})`,
        "Native BB dispatch/deliver/merge still works in the meantime.",
      ].join("\n");
    }
  }

  // Real-mode bearings for the deck: the authoritative fm-bearings-snapshot
  // projection (main/secondmate ledgers, decisions, reports, gates). Returns a
  // labelled block, or "" when real mode is off / the script is unavailable, so
  // the caller falls back to the native KV digest (which is labelled cache).
  async function realBearingsForDeck(ctx: unknown, signal: AbortSignal | undefined): Promise<string> {
    const current = await settings.get();
    if (current.fmHome.trim() === "") return "";
    try {
      const hostId = await resolveHostId(undefined, ctx);
      const result = await runFmScript({
        script: "bearings-snapshot",
        args: [],
        hostId,
        fmHome: current.fmHome,
        projectId: undefined,
        parentThreadId: ctxString(ctx, "threadId"),
        timeoutMs: fmTimeoutMs("bearings-snapshot", undefined),
        signal,
      });
      if (result.exitCode !== 0 || result.output.trim() === "") return "";
      return ["== real bearings (fm-bearings-snapshot; authoritative) ==", result.output.trim()].join("\n");
    } catch {
      return "";
    }
  }

  // The deck digest: real bearings first (authoritative when active), then the
  // native KV digest explicitly labelled as a cache/fallback view.
  async function deckDigest(ctx: unknown, signal: AbortSignal | undefined): Promise<string> {
    const realBearings = await realBearingsForDeck(ctx, signal);
    const native = await sessionDigest();
    const nativeBlock = realBearings === ""
      ? native
      : ["== native digest (BB KV cache / fallback) ==", native].join("\n");
    return [realBearings, nativeBlock].filter((s) => s !== "").join("\n");
  }

  async function runFmScript(input: {
    script: string;
    args: string[];
    hostId: string;
    fmHome: string;
    projectId?: string;
    parentThreadId?: string;
    env?: Record<string, string>;
    timeoutMs: number;
    signal?: AbortSignal;
  }): Promise<{ exitCode: number | null; output: string; scriptPath: string }> {
    const script = normalizeFmScript(input.script);
    const scriptPath = `${input.fmHome}/bin/fm-${script}.sh`;
    const extraEnv = Object.entries(input.env ?? {})
      .filter(([, v]) => v !== "")
      .map(([k, v]) => `export ${k}=${shQuote(v)}`);
    const prelude = [
      ...fmBackendEnv({
        fmHome: input.fmHome,
        hostId: input.hostId,
        projectId: input.projectId,
        parentThreadId: input.parentThreadId,
      }),
      ...extraEnv,
      `if [ ! -f ${shQuote(scriptPath)} ]; then echo "error: missing ${scriptPath}" >&2; exit 127; fi`,
      `${shQuote(scriptPath)} ${input.args.map(shQuote).join(" ")}`,
    ]
      .filter((line) => line !== "")
      .join("\n");
    const result = await runOnHost(input.hostId, prelude, input.timeoutMs, input.signal);
    return { ...result, scriptPath };
  }

  // --- Real-plane owners (A1-A5) -----------------------------------------------
  // Each existing tool/CLI keeps its signature. When its owner flag is "real" the
  // op is routed through the native owner (script or state file) so real
  // merge/watch/bearings see the same authority, then written through to the KV
  // cache. Any host/read failure degrades to the existing KV behavior with a clear
  // log — defaults ("kv") are byte-for-byte the current behavior.

  // A fleet-global host to reach fmHome for the fleet-wide owners (afk/quiet/memory
  // and the backlog when no per-item project is known). fmHostId, else a crew host.
  async function fleetHost(): Promise<string | null> {
    return resolveFmWatchHostId();
  }

  // Prefer an explicit host, else the item's project host, else the fleet host.
  // Empty strings are treated as unresolved. null when nothing resolves.
  async function resolveOwnerHost(explicit?: string, projectId?: string): Promise<string | null> {
    if (explicit !== undefined && explicit !== "") return explicit;
    if (projectId !== undefined) {
      const h = await resolveHostForProject(projectId).catch(() => "");
      if (h !== "") return h;
    }
    return fleetHost();
  }

  // Present or acknowledge the real fm-wake queue (the durable crew→captain plane).
  // Present (no ack args) prints the pending wake rows + UNREAD STATUS / OPEN
  // DECISIONS sections and the `WAKE_ACK_REQUIRED: ... --ack-through <SEQ>
  // --recovery-generation <GEN>` line; it does NOT consume. Ack mode consumes rows
  // at/below the sequence. Returns null when fmHome/host is unset (caller reports
  // plainly). Drives the real fm-wake-drain.sh — no policy is reimplemented here.
  async function drainWakes(captainThreadId: string | undefined, ackThrough?: number, recoveryGeneration?: string): Promise<string | null> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return null;
    const hostId = await fleetHost();
    if (hostId === null || hostId === "") return null;
    const args: string[] = [];
    if (
      ackThrough !== undefined &&
      recoveryGeneration !== undefined &&
      /^[A-Za-z0-9._-]+$/.test(recoveryGeneration)
    ) {
      args.push("--ack-through", String(Math.max(0, Math.trunc(ackThrough))), "--recovery-generation", recoveryGeneration);
    }
    try {
      // D6: drain/ack only the CALLER captain's own scoped state plane.
      const res = await runFmScript({ script: "wake-drain", args, hostId, fmHome, env: wakeStateEnv(fmHome, captainThreadId), timeoutMs: 30_000 });
      // B2: the native WAKE_ACK_REQUIRED line names the raw `bin/fm-wake-drain.sh
      // --ack-through`, which pasted verbatim acks the UNPARTITIONED root queue and can
      // consume another captain's rows. Rewrite it to the partition-safe bb command so
      // the emitted instruction can only ever touch the caller's own plane.
      const out = rewriteWakeAckLine(res.output).trim();
      if (res.exitCode !== 0 && out === "") return `wake drain exit ${res.exitCode}`;
      return out === "" ? "Wake queue empty." : out;
    } catch (error) {
      bb.log.warn(`fm wake drain failed ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // Count actionable (signal/stale) undrained wakes, deduped on (kind,key) to match
  // fm-wake-drain's presentation. 0 when the queue is absent/unreadable.
  async function countUndrainedWakes(hostId: string, fmHome: string, captainThreadId: string | undefined): Promise<number> {
    const q = `${wakeStateDir(fmHome, captainThreadId)}/.wake-queue`;
    const cmd =
      `[ -f ${shQuote(q)} ] && awk -F '\\t' 'NF>=5 && $2 ~ /^[0-9]+$/ && ($3=="signal"||$3=="stale"){seen[$3"\\t"$4]=1} END{printf "FMWAKES=%d\\n", length(seen)}' ${shQuote(q)} || printf 'FMWAKES=0\\n'`;
    try {
      const res = await runOnHost(hostId, cmd, 15_000);
      const m = /FMWAKES=(\d+)/.exec(res.output);
      return m ? parseInt(m[1]!, 10) : 0;
    } catch {
      return 0;
    }
  }

  // F2: surface durable wakes that arrived while quiet/afk was on. notifyOwner=real
  // deliberately does not add to the KV `held` list (the report lives in the wake
  // queue), so quiet-off / afk-off — which only print the KV held list — would never
  // resurface a report enqueued while held. Present (not ack) the queue at resume so
  // the captain sees them; the rows stay until acked via `bb firstmate wake`.
  async function wakeResumeBrief(captainThreadId: string | undefined): Promise<string> {
    const s = await settings.get();
    if (s.notifyOwner !== "real") return "";
    const fmHome = s.fmHome.trim();
    if (fmHome === "") return "";
    const hostId = await fleetHost();
    if (hostId === null || hostId === "") return "";
    const pending = await countUndrainedWakes(hostId, fmHome, captainThreadId);
    if (pending <= 0) return "";
    const out = await drainWakes(captainThreadId);
    if (out === null) return "";
    return `\n== ${pending} durable wake(s) held while away/quiet — run \`bb firstmate wake\` to drain/ack ==\n${out}`;
  }

  // Non-blocking turn-end backstop (item 4). BB exposes NO blocking stop hook — the
  // PluginEvents.on("thread.idle") handler fires AFTER the thread is already idle and
  // returns void, so it cannot veto the turn the way native firstmate's Stop hook
  // does with exit 2. The strongest honest equivalent: when the captain idles with
  // undrained durable wakes, inject ONE bounded steer re-ring so the captain drains
  // them instead of going blind. The blind window between idle and the re-ring
  // remains — this is a backstop, not a guarantee (see the feature request in the PR).
  async function captainTurnEndGuard(threadId: string): Promise<void> {
    const s = await settings.get();
    if (s.turnEndGuard !== "re-ring") return;
    const fmHome = s.fmHome.trim();
    if (fmHome === "") return;
    if (!(await isCaptainThread(threadId))) return;
    const hostId = await fleetHost();
    if (hostId === null || hostId === "") return;
    const pending = await countUndrainedWakes(hostId, fmHome, threadId);
    const budgetKey = `turnend-budget:${threadId}`;
    if (pending === 0) {
      await bb.storage.kv.set(budgetKey, { count: 0, lastRingAt: 0 });
      return;
    }
    const max = Number.isFinite(s.turnEndGuardBudget) ? Math.max(1, Math.trunc(s.turnEndGuardBudget)) : 3;
    // F5: never silently abandon. The first `max` idles re-ring back-to-back; after
    // that we keep re-ringing but throttled to a slow floor, so the captain is never
    // left idle-forever with undrained wakes (it just nags less often). Reset on drain.
    const raw = await bb.storage.kv.get(budgetKey);
    const state =
      raw !== null && typeof raw === "object"
        ? (raw as { count?: number; lastRingAt?: number })
        : { count: typeof raw === "number" ? raw : 0, lastRingAt: 0 };
    const count = typeof state.count === "number" ? state.count : 0;
    const lastRingAt = typeof state.lastRingAt === "number" ? state.lastRingAt : 0;
    const now = Date.now();
    let floor = false;
    let nextCount = count;
    if (count < max) {
      nextCount = count + 1;
    } else if (now - lastRingAt >= TURN_END_FLOOR_MS) {
      floor = true; // keep re-ringing, throttled — do NOT abandon
    } else {
      bb.log.info(`turn-end guard: ${pending} undrained for captain ${threadId}; slow-floor cooldown (next in ${Math.ceil((TURN_END_FLOOR_MS - (now - lastRingAt)) / 60000)}m)`);
      return;
    }
    await bb.storage.kv.set(budgetKey, { count: nextCount, lastRingAt: now });
    const tag = floor ? `slow-floor reminder` : `${nextCount}/${max}`;
    try {
      await bb.sdk.threads.send({
        // Evidence (b), proven live: `mode: steer` to an IDLE thread STARTS a fresh
        // turn (status idle→active); `queue-if-active` only queues without starting
        // one. The captain is idle here (this fires on thread.idle), and the whole
        // point is to make it take another turn to drain — so steer is required.
        threadId,
        mode: "steer",
        input: [
          {
            type: "text",
            text:
              `🔔 Firstmate turn-end backstop (${tag}): ${pending} undrained crew wake(s)/decision(s). ` +
              "Run `bb firstmate wake` and handle them before ending your turn.\n" +
              "(Best-effort re-ring — BB has no blocking stop hook, so this is not a guaranteed block.)",
            mentions: [],
          },
        ],
      });
      bb.log.info(`turn-end guard re-rang captain ${threadId} (${pending} pending, ${tag})`);
    } catch (error) {
      bb.log.warn(`turn-end guard re-ring failed ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // Run bin/fm-tasks-axi.sh <args> at fmHome. Returns null when fmHome/host is
  // unset or the run throws (caller falls back to KV). A non-zero exit (e.g.
  // tasks-axi missing → exit 2) is returned so the caller can log + fall back.
  async function runTasksAxi(
    args: string[],
    opts: { hostId?: string; projectId?: string } = {},
  ): Promise<{ exitCode: number | null; output: string } | null> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return null;
    const hostId = await resolveOwnerHost(opts.hostId, opts.projectId);
    if (hostId === null) return null;
    try {
      return await runFmScript({ script: "tasks-axi", args, hostId, fmHome, projectId: opts.projectId, timeoutMs: 30_000 });
    } catch (error) {
      bb.log.warn(`real backlog: fm-tasks-axi.sh ${args[0] ?? ""} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // Run bin/fm-captain-hold.sh <args> at fmHome (decisions as captain-held rows).
  async function runCaptainHold(
    args: string[],
    opts: { hostId?: string; projectId?: string } = {},
  ): Promise<{ exitCode: number | null; output: string } | null> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return null;
    const hostId = await resolveOwnerHost(opts.hostId, opts.projectId);
    if (hostId === null) return null;
    try {
      return await runFmScript({ script: "captain-hold", args, hostId, fmHome, projectId: opts.projectId, timeoutMs: 30_000 });
    } catch (error) {
      bb.log.warn(`real decisions: fm-captain-hold.sh ${args[0] ?? ""} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // Run bin/fm-afk-contract.sh <args> at fmHome. Reads/writes state/.afk-contract.
  async function runAfkContract(
    args: string[],
    stdin?: string,
  ): Promise<{ exitCode: number | null; output: string } | null> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return null;
    const hostId = await fleetHost();
    if (hostId === null || hostId === "") return null;
    const scriptPath = `${fmHome}/bin/fm-afk-contract.sh`;
    const prelude = [
      `export FM_HOME=${shQuote(fmHome)}`,
      `export FM_ROOT=${shQuote(fmHome)}`,
      `if [ ! -f ${shQuote(scriptPath)} ]; then echo "error: missing ${scriptPath}" >&2; exit 127; fi`,
      `${shQuote(scriptPath)} ${args.map(shQuote).join(" ")}`,
    ].join("\n");
    try {
      return await runOnHost(hostId, prelude, 30_000, undefined, stdin);
    } catch (error) {
      bb.log.warn(`real afk: fm-afk-contract.sh ${args[0] ?? ""} failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // Write/read the native away/quiet flag state/.afk (first line away|quiet). The
  // afk skill treats the flag file's first line as the mode; quiet is that mode.
  async function writeAfkFlag(mode: "away" | "quiet" | null): Promise<boolean> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return false;
    const hostId = await fleetHost();
    if (hostId === null || hostId === "") return false;
    const flag = `${fmHome}/state/.afk`;
    const script = mode === null
      ? `rm -f ${shQuote(flag)}`
      : [`mkdir -p ${shQuote(`${fmHome}/state`)}`, `printf '%s\\n' ${shQuote(mode)} > ${shQuote(flag)}`].join("\n");
    try {
      const res = await runOnHost(hostId, script, 15_000);
      return res.exitCode === 0;
    } catch (error) {
      bb.log.warn(`real ${mode === "quiet" ? "quiet" : "afk"}: state/.afk write failed: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

  async function readAfkFlagMode(): Promise<"away" | "quiet" | null> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return null;
    const hostId = await fleetHost();
    if (hostId === null || hostId === "") return null;
    const flag = `${fmHome}/state/.afk`;
    try {
      const res = await runOnHost(hostId, `[ -f ${shQuote(flag)} ] && head -1 ${shQuote(flag)} || echo FM_AFK_ABSENT`, 15_000);
      const line = res.output.trim().split(/\r?\n/)[0]?.trim();
      if (line === "quiet") return "quiet";
      if (line === "away") return "away";
      return null;
    } catch {
      return null;
    }
  }

  // Tiered memory files (stow): data/captain.md (pinned), data/learnings.md (aging,
  // each line carries the <!--a:YYYY-MM-DD--> reinforced-date marker). Plain file
  // ops via the host (there is no fm-stow.sh; stow is agent file edits).
  const MEM_CAPTAIN_FILE = "data/captain.md";
  const MEM_LEARNINGS_FILE = "data/learnings.md";
  const MEM_LEARNINGS_ARCHIVE_FILE = "data/learnings.archive.md";
  const MEM_CAPTAIN_ARCHIVE_FILE = "data/captain.archive.md";
  // Cap the live learnings tier so it stays a working set (mirrors stow's decay:
  // the freshest reinforced lines stay hot). Overflow is not lost — it rotates to
  // an append-only archive file. ~64 KB keeps hundreds of lines; well under any
  // practical limit now that writes stream via stdin.
  const MEM_LEARNINGS_MAX_BYTES = 64_000;
  // Split a learnings body into {kept, overflow}: kept = the most recent lines that
  // fit under MEM_LEARNINGS_MAX_BYTES, overflow = the oldest lines pushed out.
  function capLearnings(body: string): { kept: string; overflow: string } {
    if (Buffer.byteLength(body, "utf8") <= MEM_LEARNINGS_MAX_BYTES) return { kept: body, overflow: "" };
    const lines = body.split("\n");
    const kept: string[] = [];
    let bytes = 0;
    for (let i = lines.length - 1; i >= 0; i--) {
      const add = Buffer.byteLength(lines[i], "utf8") + 1;
      if (bytes + add > MEM_LEARNINGS_MAX_BYTES && kept.length > 0) {
        return { kept: kept.join("\n"), overflow: lines.slice(0, i + 1).join("\n") };
      }
      bytes += add;
      kept.unshift(lines[i]);
    }
    return { kept: kept.join("\n"), overflow: "" };
  }

  // Absence is signalled OUT-OF-BAND via a dedicated exit code, never a sentinel
  // string inside stdout. The old `|| echo FM_MEM_ABSENT` + `out.includes(...)` meant
  // a real memory line merely CONTAINING that literal made the whole file read as
  // empty — a genuine data-loss path (an empty read makes migrateMemoryTier take the
  // seed-KV→file branch and overwrite a real file that has MORE content than KV). The
  // command now exits 0 with the file's exact bytes when present, exits FM_MEM_ABSENT_RC
  // when the file does not exist, and exits anything else on a real host/read failure.
  // File CONTENT is therefore never scanned for a control token.
  const FM_MEM_ABSENT_RC = 42;
  async function readMemoryFile(rel: string): Promise<string | null> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return null;
    const hostId = await fleetHost();
    if (hostId === null || hostId === "") return null;
    const path = `${fmHome}/${rel}`;
    try {
      const q = shQuote(path);
      const res = await runOnHost(hostId, `if [ -f ${q} ]; then cat ${q}; else exit ${FM_MEM_ABSENT_RC}; fi`, 15_000);
      if (res.exitCode === FM_MEM_ABSENT_RC) return ""; // file absent → empty (unambiguous)
      if (res.exitCode !== 0) return null; // host command / cat failed → unreadable
      return res.output.replace(/\n$/, "");
    } catch {
      return null;
    }
  }

  // Write arbitrary content to a host file. Injection-safe (F1: base64, never in the
  // shell command as executable syntax), size-unbounded (chunked appends, no
  // HOST_COMMAND_MAX ceiling), and atomic (temp + rename, so a failed write never
  // truncates the target). See writeHostBytes for the mechanism and why the old
  // terminal-stdin path (`base64 -d > path` fed via PTY input) timed out.
  async function writeHostFile(hostId: string, path: string, content: string): Promise<boolean> {
    return writeHostBytes(hostId, path, content);
  }

  async function writeMemoryFile(rel: string, content: string): Promise<boolean> {
    const fmHome = (await settings.get()).fmHome.trim();
    if (fmHome === "") return false;
    const hostId = await fleetHost();
    if (hostId === null || hostId === "") return false;
    const ok = await writeHostFile(hostId, `${fmHome}/${rel}`, content);
    if (!ok) bb.log.warn(`real memory: write ${rel} failed`);
    return ok;
  }

  async function memoryIsReal(): Promise<boolean> {
    return (await settings.get()).memoryOwner === "real" && (await settings.get()).fmHome.trim() !== "";
  }

  // D1: idempotent, direction-safe migration of one memory tier under
  // memoryOwner=real. The real file is authoritative; the KV blob is a cache.
  //  - real file unreadable  → refuse (touch nothing; never risk a clobber)
  //  - real file non-empty   → mirror file→KV (source of truth into the cache)
  //  - real file empty/absent + KV non-empty → seed KV→file (cannot shrink real data)
  //  - both empty            → no-op
  // It NEVER writes KV→file over a non-empty real file, so a re-run cannot destroy
  // authoritative memory the way the old unconditional writeMemoryFile(<KV>) did.
  async function migrateMemoryTier(fileRel: string, kvKey: string): Promise<boolean> {
    const file = await readMemoryFile(fileRel);
    if (file === null) {
      bb.log.warn(`real memory migrate: ${fileRel} unreadable; skipped (KV + file left intact)`);
      return false;
    }
    if (file.trim() !== "") {
      await bb.storage.kv.set(kvKey, file);
      return true;
    }
    const kvRaw = await bb.storage.kv.get<unknown>(kvKey);
    const kv = typeof kvRaw === "string" ? kvRaw : "";
    if (kv !== "") return writeMemoryFile(fileRel, kv);
    return true;
  }

  // The learnings/captain real path is a read-modify-write across two host round
  // trips; serialize all memory mutations in-process so the plugin's own concurrent
  // tool/CLI calls can't interleave and lose an update. (Cross-process contention
  // is out of scope — one plugin process owns the KV + the projection.)
  let memoryChain: Promise<unknown> = Promise.resolve();
  function withMemoryLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = memoryChain.then(fn, fn);
    memoryChain = run.then(() => undefined, () => undefined);
    return run;
  }

  // Shared memory ops behind firstmate_memory (tool + CLI). Owner=real routes the
  // tiered stow files, writing through to the KV cache; a host/read failure logs
  // and degrades to KV so nothing is lost and the signature is unchanged.
  async function memoryShow(): Promise<{ captain: string; learnings: string; source: "real" | "kv" }> {
    if (await memoryIsReal()) {
      const cap = await readMemoryFile(MEM_CAPTAIN_FILE);
      const learn = await readMemoryFile(MEM_LEARNINGS_FILE);
      if (cap !== null && learn !== null) return { captain: cap, learnings: learn, source: "real" };
      bb.log.warn("real memory: read unavailable; showing KV cache");
    }
    const cap = await bb.storage.kv.get<unknown>(MEM_CAPTAIN_KEY);
    const learn = await bb.storage.kv.get<unknown>(MEM_LEARNINGS_KEY);
    return { captain: typeof cap === "string" ? cap : "", learnings: typeof learn === "string" ? learn : "", source: "kv" };
  }

  async function memorySetCaptain(text: string): Promise<void> {
    return withMemoryLock(async () => {
      if (await memoryIsReal()) {
        if (await writeMemoryFile(MEM_CAPTAIN_FILE, text)) {
          // D2: KV mirrors the real file EXACTLY (cache/projection) — never a raw
          // byte-slice that could desync the mirror from the authoritative file.
          await bb.storage.kv.set(MEM_CAPTAIN_KEY, text);
          await refreshCaptainMemory();
          return;
        }
        bb.log.warn("real memory: captain write failed; KV cache only");
      }
      await bb.storage.kv.set(MEM_CAPTAIN_KEY, text);
    });
  }

  async function memoryAddLearning(text: string): Promise<void> {
    return withMemoryLock(async () => {
    const date = new Date().toISOString().slice(0, 10);
    if (await memoryIsReal()) {
      const cur = await readMemoryFile(MEM_LEARNINGS_FILE);
      if (cur !== null) {
        // stow "aging" tier: date marker = last reinforced.
        const line = `- ${date}: ${text.replace(/[\r\n]+/g, " ").trim()} <!--a:${date}-->`;
        const raw = `${cur !== "" ? `${cur}\n` : ""}${line}`;
        const { kept, overflow } = capLearnings(raw);
        // Only trim the live file to `kept` once the overflow is safely archived.
        // If the archive write fails we keep the FULL `raw` in the live file so
        // overflowed (oldest) learnings are never dropped from both files — the
        // cap re-applies on the next successful add. (No overflow → write raw.)
        let next = raw;
        if (overflow !== "") {
          const arch = await readMemoryFile(MEM_LEARNINGS_ARCHIVE_FILE);
          const archNext = `${arch !== null && arch !== "" ? `${arch}\n` : ""}${overflow}`;
          if (await writeMemoryFile(MEM_LEARNINGS_ARCHIVE_FILE, archNext)) {
            next = kept; // archived → safe to trim the live file
          } else {
            bb.log.warn("real memory: learnings archive rotate failed; keeping overflow in the live file (not trimmed)");
          }
        }
        if (await writeMemoryFile(MEM_LEARNINGS_FILE, next)) {
          // D2: KV mirrors the FULL live file (cache/projection). The live file is
          // already line-capped + archived (capLearnings), so this is bounded and
          // never a raw byte-slice that would decapitate the first learning.
          await bb.storage.kv.set(MEM_LEARNINGS_KEY, next);
          await refreshCaptainMemory();
          return;
        }
        bb.log.warn("real memory: learning write failed; KV cache only");
      } else {
        bb.log.warn("real memory: learnings read unavailable; KV cache only");
      }
    }
    const prev = await bb.storage.kv.get<unknown>(MEM_LEARNINGS_KEY);
    const line = `- ${date}: ${text}`;
    const raw = `${typeof prev === "string" && prev !== "" ? `${prev}\n` : ""}${line}`;
    // D2: kv-only mode has no archive, so overflow (oldest WHOLE lines) is dropped,
    // but the boundary is always a full line — never a mid-line byte-slice.
    const { kept } = capLearnings(raw);
    await bb.storage.kv.set(MEM_LEARNINGS_KEY, kept);
    });
  }

  // Returns the resulting line count, or -1 when n is out of range.
  async function memoryDropLearning(n: number): Promise<number> {
    return withMemoryLock(async () => {
    if (await memoryIsReal()) {
      const cur = await readMemoryFile(MEM_LEARNINGS_FILE);
      if (cur !== null) {
        const lines = cur.split("\n").filter((l) => l.trim() !== "");
        if (!Number.isInteger(n) || n < 1 || n > lines.length) return -1;
        lines.splice(n - 1, 1);
        if (await writeMemoryFile(MEM_LEARNINGS_FILE, lines.join("\n"))) {
          // D2: mirror the full file exactly (no raw byte-slice).
          await bb.storage.kv.set(MEM_LEARNINGS_KEY, lines.join("\n"));
          await refreshCaptainMemory();
          return lines.length;
        }
        bb.log.warn("real memory: learning drop write failed; KV cache only");
      } else {
        bb.log.warn("real memory: learnings read unavailable; KV cache only");
      }
    }
    const prev = await bb.storage.kv.get<unknown>(MEM_LEARNINGS_KEY);
    const lines = typeof prev === "string" ? prev.split("\n").filter((l) => l !== "") : [];
    if (!Number.isInteger(n) || n < 1 || n > lines.length) return -1;
    lines.splice(n - 1, 1);
    await bb.storage.kv.set(MEM_LEARNINGS_KEY, lines.join("\n"));
    return lines.length;
    });
  }

  // D5: clear must never destroy non-empty real memory without an archive. In real
  // mode we append the current contents to the tier's archive file FIRST and only
  // truncate the live file if that archive write succeeds; a failed archive aborts
  // the clear (nothing lost) and leaves the KV cache untouched. Returns false when
  // the clear was refused because the archive could not be written.
  async function memoryClear(which: "captain" | "learnings"): Promise<boolean> {
    return withMemoryLock(async () => {
      const rel = which === "captain" ? MEM_CAPTAIN_FILE : MEM_LEARNINGS_FILE;
      const archiveRel = which === "captain" ? MEM_CAPTAIN_ARCHIVE_FILE : MEM_LEARNINGS_ARCHIVE_FILE;
      if (await memoryIsReal()) {
        const cur = await readMemoryFile(rel);
        if (cur !== null && cur.trim() !== "") {
          const stamp = new Date().toISOString();
          const prevArch = await readMemoryFile(archiveRel);
          const archNext = `${prevArch !== null && prevArch !== "" ? `${prevArch}\n` : ""}<!--cleared:${stamp}-->\n${cur}`;
          if (!(await writeMemoryFile(archiveRel, archNext))) {
            bb.log.warn(`real memory: clear ${which} refused — archive write failed (nothing cleared)`);
            return false;
          }
        } else if (cur === null) {
          bb.log.warn(`real memory: clear ${which} refused — current contents unreadable (nothing cleared)`);
          return false;
        }
        if (!(await writeMemoryFile(rel, ""))) {
          bb.log.warn(`real memory: clear ${which} failed after archive; KV cache only`);
        }
      }
      await bb.storage.kv.set(which === "captain" ? MEM_CAPTAIN_KEY : MEM_LEARNINGS_KEY, "");
      await refreshCaptainMemory();
      return true;
    });
  }

  async function afkIsReal(): Promise<boolean> {
    const s = await settings.get();
    return s.afkOwner === "real" && s.fmHome.trim() !== "";
  }
  async function quietIsReal(): Promise<boolean> {
    const s = await settings.get();
    return s.quietOwner === "real" && s.fmHome.trim() !== "";
  }

  // F2: away and quiet share the ONE native flag file state/.afk (quiet is a mode
  // of away in native firstmate). BB models them as two independent KV states, so
  // the flag is always recomputed from BOTH — never blindly overwritten or deleted
  // by one owner. away outranks quiet (the durable, stronger posture); each owner
  // only contributes when its own flag is "real". This keeps toggles of one from
  // clobbering the other, and matches what the real fm scripts read (a single
  // first-line mode).
  async function syncAfkFlag(): Promise<boolean> {
    const afkReal = await afkIsReal();
    const quietReal = await quietIsReal();
    if (!afkReal && !quietReal) return true; // neither projects to .afk
    const away = afkReal && (await readAfk())?.on === true;
    const quiet = quietReal && (await readQuiet()).on;
    const mode = away ? "away" : quiet ? "quiet" : null;
    return writeAfkFlag(mode);
  }

  // Project AFK on/off into the real durable contract (state/.afk-contract) so
  // fm-merge-authority-lib and fm-watch see the same away authority, plus the
  // shared state/.afk flag. KV still owns held-ping delivery. Grants list =
  // task ids the captain pre-authorized for away merges. Best-effort + logged.
  // (Callers update KV afk state BEFORE calling, so syncAfkFlag reads the new value.)
  async function projectAfkOn(words: string, grants: string[]): Promise<{ contract: boolean }> {
    if (!(await afkIsReal())) return { contract: false };
    const args = ["propose"];
    if (words.trim() !== "") args.push("--words", words.slice(0, 2000));
    for (const g of grants) if (/^[A-Za-z0-9._-]+$/.test(g)) args.push("--grant", g);
    const proposed = await runAfkContract(args);
    if (proposed === null || proposed.exitCode !== 0) {
      bb.log.warn(`real afk: contract propose ${proposed === null ? "unreachable" : `exit=${proposed.exitCode}`}; KV flag only`);
      await syncAfkFlag();
      return { contract: false };
    }
    const confirmed = await runAfkContract(["confirm"]);
    await syncAfkFlag();
    if (confirmed === null || confirmed.exitCode !== 0) {
      bb.log.warn(`real afk: contract confirm ${confirmed === null ? "unreachable" : `exit=${confirmed.exitCode}`}`);
      return { contract: false };
    }
    return { contract: true };
  }

  async function projectAfkOff(): Promise<void> {
    if (!(await afkIsReal())) return;
    const archived = await runAfkContract(["archive"]);
    if (archived === null || archived.exitCode !== 0) {
      bb.log.warn(`real afk: contract archive ${archived === null ? "unreachable" : `exit=${archived.exitCode}`}`);
    }
    // Recompute the shared flag: if quiet is still on it stays "quiet", not deleted.
    await syncAfkFlag();
  }

  // Real contract away authority (validate exits 0 iff readable + confirmed) and
  // its granted task ids, for status/bearings. null when unreadable.
  async function realAfkAuthority(): Promise<{ confirmed: boolean; grants: string[] } | null> {
    if (!(await afkIsReal())) return null;
    const valid = await runAfkContract(["validate"]);
    if (valid === null) return null;
    if (valid.exitCode !== 0) return { confirmed: false, grants: [] };
    const g = await runAfkContract(["grants"]);
    const grants = g === null ? [] : g.output.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && /^[A-Za-z0-9._-]+$/.test(l));
    return { confirmed: true, grants };
  }

  // Project quiet on/off into the shared native state/.afk flag. Recomputed from
  // both owners (F2), so turning quiet off never deletes an active away flag, and
  // turning quiet on never overwrites away. (Caller updates KV quiet state first.)
  async function projectQuiet(on: boolean): Promise<void> {
    if (!(await quietIsReal())) return;
    const ok = await syncAfkFlag();
    if (!ok) bb.log.warn(`real quiet: state/.afk ${on ? "quiet write" : "clear"} failed; KV flag only`);
  }

  async function queueIsReal(): Promise<boolean> {
    const s = await settings.get();
    return s.queueOwner === "real" && s.fmHome.trim() !== "";
  }

  // Project a backlog add into the real data/backlog.md. We follow native
  // firstmate's convention: the CALLER owns the row id and passes it in
  // (`tasks-axi add <id> <title> --kind <kind>`), then never reads an id back.
  // Native code does exactly this (fm-spawn.sh: `add $ID '<title>' --kind $KIND`)
  // and discards add stdout — the add-output format belongs to the external
  // `tasks-axi` binary and is undocumented, so parsing it was a bet on a format we
  // don't control. Owning the id makes real backlog rows work regardless of that
  // output, and the paired start/done/rm transitions target the same id we chose.
  // Returns ok=false (KV-cache only) when queueOwner!=real, the host/tool is
  // unreachable, or tasks-axi is missing/failed. Only issues a command when real.
  async function projectQueueAdd(id: string, title: string, shape: Shape, projectId: string): Promise<{ ok: boolean }> {
    if (!(await queueIsReal())) return { ok: false };
    const res = await runTasksAxi(["add", id, title.slice(0, 500), "--kind", shape], { projectId });
    if (res === null) {
      bb.log.warn("real backlog: add unreachable (tasks-axi/host); KV cache only");
      return { ok: false };
    }
    if (res.exitCode !== 0) {
      bb.log.warn(
        `real backlog: add exit=${res.exitCode} (tasks-axi missing? install with 'npm install -g tasks-axi' on the fleet host); KV cache only`,
      );
      return { ok: false };
    }
    return { ok: true };
  }

  // Drive the paired backlog transition for a KV queue item. verb: start|done|rm.
  async function projectQueueTransition(item: QueueItem, verb: "start" | "done" | "rm"): Promise<void> {
    if (!(await queueIsReal())) return;
    if (item.backlogId === undefined || item.backlogId === "") {
      bb.log.warn(`real backlog: ${verb} skipped for queue ${item.id} (no backlog row id)`);
      return;
    }
    const res = await runTasksAxi([verb, item.backlogId], { projectId: item.projectId });
    if (res === null || res.exitCode !== 0) {
      bb.log.warn(`real backlog: ${verb} ${item.backlogId} ${res === null ? "unreachable" : `exit=${res.exitCode}`}`);
    }
  }

  async function decisionsIsReal(): Promise<boolean> {
    const s = await settings.get();
    return s.decisionsOwner === "real" && s.fmHome.trim() !== "";
  }

  // A decision is an ordinary captain-held backlog task (captain-hold-lifecycle):
  // its identity is the decision id, reused as the backlog task id. Best-effort.
  async function projectDecisionAsk(d: Decision): Promise<void> {
    if (!(await decisionsIsReal())) return;
    if (!/^[A-Za-z0-9._-]+$/.test(d.id)) return;
    const res = await runCaptainHold(
      ["hold", d.id, "--title", d.question.slice(0, 200), "--reason", "captain decision (BB firstmate_decide)"],
    );
    if (res === null || res.exitCode !== 0) {
      bb.log.warn(`real decisions: hold ${d.id} ${res === null ? "unreachable" : `exit=${res.exitCode}`}; KV cache only`);
    }
  }

  // Answer closes the captain-held row and writes the resolved close to the linked
  // crew's state/<id>.status via the existing appendResolvedStatus.
  async function projectDecisionAnswer(d: Decision, answer: string): Promise<void> {
    if (!(await decisionsIsReal())) return;
    if (!/^[A-Za-z0-9._-]+$/.test(d.id)) return;
    const fmHome = (await settings.get()).fmHome.trim();
    const hostId = await fleetHost();
    if (fmHome === "" || hostId === null) {
      bb.log.warn(`real decisions: answer ${d.id} no host; KV cache only`);
      return;
    }
    const tmp = `${fmHome}/state/.bb-decision-${d.id}.answer`;
    // F1: base64 payload, never in the command text (no heredoc-delimiter injection).
    if (!(await writeHostFile(hostId, tmp, answer.slice(0, 2000)))) {
      bb.log.warn(`real decisions: answer ${d.id} tmp write failed; KV cache only`);
      return;
    }
    const res = await runCaptainHold(["answer", d.id, "--decision-file", tmp]);
    await runOnHost(hostId, `rm -f ${shQuote(tmp)}`, 10_000).catch(() => {});
    if (res === null || res.exitCode !== 0) {
      bb.log.warn(`real decisions: answer ${d.id} ${res === null ? "unreachable" : `exit=${res.exitCode}`}`);
    }
    // Also write the resolved close on the linked crew's own status log.
    if (d.crewId !== null) {
      const crew = await findCrew(d.crewId);
      if (crew !== undefined) await appendResolvedStatus(crew, d.id, answer);
    }
  }

  async function projectDecisionDefer(d: Decision, until: string | null): Promise<void> {
    if (!(await decisionsIsReal())) return;
    if (!/^[A-Za-z0-9._-]+$/.test(d.id)) return;
    const args = ["hold", d.id, "--reason", "deferred (BB firstmate_decide)"];
    if (until !== null && /^\d{4}-\d{2}-\d{2}$/.test(until)) args.push("--until", until);
    const res = await runCaptainHold(args);
    if (res === null || res.exitCode !== 0) {
      bb.log.warn(`real decisions: defer ${d.id} ${res === null ? "unreachable" : `exit=${res.exitCode}`}`);
    }
  }

  async function projectDecisionDrop(id: string): Promise<void> {
    if (!(await decisionsIsReal())) return;
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return;
    const res = await runTasksAxi(["rm", id]);
    if (res === null || res.exitCode !== 0) {
      bb.log.warn(`real decisions: drop ${id} ${res === null ? "unreachable" : `exit=${res.exitCode}`}`);
    }
  }

  async function readToolActivity(threadId: string): Promise<{ ok: true; at: number | null } | { ok: false }> {
    try {
      const rows = await bb.sdk.threads.events.list({
        threadId,
        order: "desc",
        limit: "1",
        types: TOOL_ACTIVITY_TYPES,
      });
      if (!Array.isArray(rows)) return { ok: false };
      const row = rows[0];
      if (row === undefined) return { ok: true, at: null };
      const createdAt = asRecord(row)["createdAt"];
      return typeof createdAt === "number" && Number.isFinite(createdAt)
        ? { ok: true, at: createdAt }
        : { ok: false };
    } catch (error) {
      bb.log.warn(
        `stuck activity read failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { ok: false };
    }
  }

  let stuckRebased = false;

  async function crewExcerpt(crew: Crew): Promise<{ ok: true; text: string } | { ok: false }> {
    try {
      const result = await bb.sdk.threads.output({ threadId: crew.threadId });
      const text = asRecord(result)["output"];
      return { ok: true, text: typeof text === "string" ? truncate(text, 300) : "" };
    } catch {
      return { ok: false };
    }
  }

  // --- fm-watch supervisor (F1) ------------------------------------------------
  // When watchOwner=fm-watch, the plugin runs and keeps alive the REAL fm-watch
  // (via bin/fm-watch-arm.sh, backend=bb) against fmHome, and reads its liveness
  // beacon (state/.last-watcher-beat). BB only suppresses its own stuck-page while
  // that beat is live; a dead/stale watcher makes BB page as before. This closes
  // the "flag on, nothing supervises" gap.
  // R1: one beacon record per host, so a live watcher on host A never suppresses
  // BB's stuck-page for crews on host B that no fm-watch supervises. The legacy
  // single global key is still written for one release so an old UI keeps reading.
  const FM_WATCH_BEAT_KEY = "fm-watch-beat";
  function fmWatchBeatKey(hostId: string): string {
    return `fm-watch-beat:${hostId}`;
  }
  const fmWatchBeatSchema = z.object({
    beatAge: z.number(),
    checkedAt: z.number(),
    grace: z.number(),
    relaunched: z.boolean(),
    backoffUntil: z.number().optional(),
    consecutiveRelaunch: z.number().optional(),
  });

  // The on-host beacon (for THIS host) is fresh within `freshSec` AND the
  // supervisor itself checked recently (so a dead supervisor cannot leave
  // suppression latched on). Per-host: suppression is scoped to the host whose
  // watcher is proven live.
  async function fmWatchLive(hostId: string, freshSec: number): Promise<boolean> {
    const gate = Number.isFinite(freshSec) ? Math.max(30, Math.trunc(freshSec)) : 90;
    const parsed = fmWatchBeatSchema.safeParse(await bb.storage.kv.get(fmWatchBeatKey(hostId)));
    if (!parsed.success) return false;
    const beat = parsed.data;
    if (Date.now() - beat.checkedAt > (gate + 60) * 1000) return false;
    if (beat.beatAge < 0) return false;
    return beat.beatAge <= gate;
  }

  async function resolveFmWatchHostId(): Promise<string | null> {
    const s = await settings.get();
    if (s.fmHostId.trim() !== "") return s.fmHostId.trim();
    try {
      for (const crew of await readCrews()) {
        if (isSecondmateRoute(crew)) continue;
        try {
          const hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
          if (hostId !== "") return hostId;
        } catch {
          // try next crew
        }
      }
    } catch {
      // none
    }
    return null;
  }

  // R1: every distinct host that hosts a crew, plus the configured fmHostId. The
  // supervisor runs (and beats) fm-watch on each, so multi-host fleets get
  // per-host liveness instead of one global suppression switch.
  async function resolveFmWatchHosts(): Promise<string[]> {
    const hosts = new Set<string>();
    const s = await settings.get();
    if (s.fmHostId.trim() !== "") hosts.add(s.fmHostId.trim());
    try {
      for (const crew of await readCrews()) {
        if (isSecondmateRoute(crew)) continue;
        try {
          const hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
          if (hostId !== "") hosts.add(hostId);
        } catch {
          // skip this crew
        }
      }
    } catch {
      // fmHostId alone (if any)
    }
    return [...hosts];
  }

  // fm-watch keeper paths/cadence/script are module-level pure builders (see above):
  // FM_WATCH_KEEPER_PID, FM_WATCH_KEEPER_SH, fmWatchKeeperInterval, fmWatchKeeperScript.

  // One supervision cycle on the host. fm-watch is a one-shot that BLOCKS until an
  // actionable wake then EXITS (by design, to be re-armed) — so re-arming only when
  // the beacon goes stale, then backing off, starved the watcher: after every wake
  // it stayed down for the (growing) backoff window. Instead a durable KEEPER script
  // owns continuous re-arming, launched detached (setsid+nohup survives the terminal
  // force-close, verified on the live host) and tracked by a pidfile. This cycle only
  // (re)launches the keeper when it is not alive; the beacon age is still read +
  // reported so BB pages during any gap while the watcher is down.
  async function superviseFmWatch(
    hostId: string,
    fmHome: string,
    graceSec: number,
    allowRelaunch: boolean,
    signal?: AbortSignal,
  ): Promise<{ beatAge: number; relaunched: boolean; keeperAlive: boolean; logTail: string } | null> {
    const beat = `${fmHome}/state/.last-watcher-beat`;
    const log = `${fmHome}/state/.bb-watch-arm.log`;
    const arm = `${fmHome}/bin/fm-watch-arm.sh`;
    const pid = `${fmHome}/${FM_WATCH_KEEPER_PID}`;
    const keeperScript = `${fmHome}/${FM_WATCH_KEEPER_SH}`;
    const ownerBeat = `${fmHome}/${FM_WATCH_OWNER_BEAT}`;
    const interval = fmWatchKeeperInterval(graceSec);
    // Phase 1: refresh the owner beat (D7 self-exit heartbeat — written BEFORE any
    // keeper launch so a freshly launched keeper always sees a fresh beat), then read
    // beacon age + keeper liveness + a log tail (no other side effects).
    const readScript = [
      `mkdir -p ${shQuote(`${fmHome}/state`)}`,
      // B3(b): the owner-beat write is a silent SPOF — a non-writable or full state dir
      // makes it fail, the keeper then sees a stale/absent beat and self-exits while the
      // plugin still believes supervision is healthy. Detect the write outcome and emit a
      // marker so the plugin can surface it instead of going quietly blind.
      `if date +%s > ${shQuote(ownerBeat)} 2>/dev/null; then echo FM_OWNER_BEAT=ok; else echo FM_OWNER_BEAT=fail; fi`,
      "AGE=-1",
      `if [ -f ${shQuote(beat)} ]; then AGE=$(( $(date +%s) - $(stat -c %Y ${shQuote(beat)} 2>/dev/null || echo 0) )); fi`,
      "KEEPER=dead",
      `if [ -f ${shQuote(pid)} ]; then KP=$(cat ${shQuote(pid)} 2>/dev/null || echo); if [ -n "$KP" ] && kill -0 "$KP" 2>/dev/null; then KEEPER=alive; fi; fi`,
      `[ -x ${shQuote(arm)} ] || echo FM_WATCH_NO_ARM`,
      `printf 'FM_BEAT_AGE=%s\\nFM_KEEPER=%s\\n' "$AGE" "$KEEPER"`,
      "echo '---FM_LOGTAIL---'",
      `[ -f ${shQuote(log)} ] && tail -c 4000 ${shQuote(log)} || true`,
    ].join("\n");
    try {
      const res = await runOnHost(hostId, readScript, 30_000, signal);
      const ageMatch = /FM_BEAT_AGE=(-?\d+)/.exec(res.output);
      const beatAge = ageMatch ? Number(ageMatch[1]) : -1;
      const keeperAlive = /FM_KEEPER=alive/.test(res.output);
      const noArm = res.output.includes("FM_WATCH_NO_ARM");
      // B3(b): surface a failed owner-beat write loudly — the keeper is about to
      // self-exit even though the plugin thinks it is healthy. Treat an explicit
      // FM_OWNER_BEAT=fail as unwritable; absence of the marker (a truncated read) is
      // not asserted as a failure.
      // Log-only surfacing (accepted by the captain): a failed beat write means the
      // keeper is about to self-exit while the plugin thinks it is healthy. Absence of
      // the marker (a truncated read) is not asserted as a failure.
      if (res.output.includes("FM_OWNER_BEAT=fail")) {
        bb.log.error(
          `fm-watch-supervisor: owner-beat write FAILED on host ${hostId} (${ownerBeat} not writable — full/read-only state dir?); the keeper will self-exit and real supervision will stop. Fix the state dir.`,
        );
      }
      const tailIdx = res.output.indexOf("---FM_LOGTAIL---");
      const logTail = tailIdx < 0 ? "" : res.output.slice(tailIdx + "---FM_LOGTAIL---".length).trim();
      if (noArm) {
        bb.log.warn("fm-watch-supervisor: no fm-watch-arm.sh at fmHome; cannot run the real watcher.");
      }
      let relaunched = false;
      // Phase 2: (re)launch the keeper only when it is down (and arm exists, and we
      // are not in crash-loop backoff). Write the keeper script as a file, then
      // detach-launch it.
      if (!keeperAlive && allowRelaunch && !noArm) {
        const wrote = await writeHostFile(hostId, keeperScript, fmWatchKeeperScript(hostId, fmHome, interval));
        if (wrote) {
          const launch = [
            `mkdir -p ${shQuote(`${fmHome}/state`)}`,
            `setsid nohup bash ${shQuote(keeperScript)} >> ${shQuote(log)} 2>&1 </dev/null &`,
            "echo FM_KEEPER_LAUNCHED",
          ].join("\n");
          const launchRes = await runOnHost(hostId, launch, 20_000, signal);
          relaunched = launchRes.exitCode === 0;
        } else {
          bb.log.warn("fm-watch-supervisor: could not write the keeper script; will retry next cycle.");
        }
      }
      return { beatAge, relaunched, keeperAlive, logTail };
    } catch (error) {
      bb.log.warn(`fm-watch-supervisor cycle failed: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  // D7: the set of hosts where we launched a keeper, persisted to KV so a plugin
  // RELOAD (which resets the supervisor's in-memory state to empty) still knows which
  // hosts to tear down when it comes back up with watchOwner already flipped to native.
  // Without this the teardown branch was gated on in-memory state the reload had lost,
  // so a keeper started before the reload kept re-arming fm-watch forever.
  const FM_WATCH_KEEPER_HOSTS_KEY = "fm-watch-keeper-hosts";
  async function loadKeeperHosts(): Promise<string[]> {
    const raw = await bb.storage.kv.get<unknown>(FM_WATCH_KEEPER_HOSTS_KEY);
    return Array.isArray(raw) ? raw.filter((h): h is string => typeof h === "string" && h !== "") : [];
  }
  async function saveKeeperHosts(hosts: Set<string>): Promise<void> {
    try {
      await bb.storage.kv.set(FM_WATCH_KEEPER_HOSTS_KEY, [...hosts]);
    } catch {
      // best-effort; in-memory set still drives teardown this process
    }
  }

  // Stop the on-host keeper when watchOwner is turned off: remove its pidfile so the
  // loop self-exits on its next iteration, and best-effort kill the recorded pid.
  async function stopFmWatchKeeper(hostId: string, fmHome: string, signal?: AbortSignal): Promise<void> {
    const pid = `${fmHome}/${FM_WATCH_KEEPER_PID}`;
    const ownerBeat = `${fmHome}/${FM_WATCH_OWNER_BEAT}`;
    // Remove the pidfile (loop self-exits next iteration) AND the owner beat (a
    // relaunch cannot be kept alive by a stale-fresh beat), then best-effort kill the
    // recorded pid for an immediate stop rather than waiting one re-arm interval.
    const script =
      `KP=$(cat ${shQuote(pid)} 2>/dev/null || echo); rm -f ${shQuote(pid)} ${shQuote(ownerBeat)}; ` +
      `[ -n "$KP" ] && kill "$KP" 2>/dev/null || true`;
    try {
      await runOnHost(hostId, script, 15_000, signal);
    } catch (error) {
      bb.log.warn(`fm-watch-supervisor: keeper teardown failed on ${hostId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // R2: only fm-watch's ACTIONABLE page lines (signal: a wedge/steering re-ring,
  // stale: a heartbeat backstop). check:/heartbeat/watcher: are routine high-rate
  // trace and must never be relayed to the captain. Newest few only.
  function extractWatchReasons(logTail: string): string[] {
    return logTail
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^(signal:|stale:)/.test(l))
      .slice(-8);
  }

  // R2 dedup key: drop volatile counters/timestamps so the same wedge is not
  // re-paged every cycle just because a "3m→4m" or epoch changed. Keeps crew ids
  // (hex tokens are preserved by only stripping pure-digit runs).
  function relayDedupKey(line: string): string {
    return line.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  }

  // Redact from a page line every whitespace token that names a crew NOT owned by the
  // target captain (D8). One fm-watch signal line can reference SEVERAL crews (e.g.
  // "signal: …/1f4c7c2a.status …/79da4929.status"); delivering it whole leaks other
  // captains' crew ids. Each status/path token carries at most one crew id, so dropping
  // the tokens that contain a foreign id yields a line mentioning only this captain's
  // crews while keeping the label and any generic tokens. Returns "" if nothing but the
  // label survives (no own-crew reference left).
  function filterLineForOwner(line: string, foreignIds: string[]): string {
    if (foreignIds.length === 0) return line;
    return line
      .split(/\s+/)
      .filter((tok) => tok !== "" && !foreignIds.some((id) => tok.includes(id)))
      .join(" ");
  }

  // R2/D6/D8: deliver each actionable fm-watch page ONLY to the captain(s) that own the
  // crews it names, and to each such captain a copy FILTERED to only their own crew ids.
  // The plugin's settings and fmHome are host-global, so one supervisor cycle sees crews
  // of MANY captains: a multi-crew line must be split/filtered per owner, never fanned
  // whole (that leak was D8), and a line naming no crew is delivered only when the host
  // has exactly ONE owning captain (unambiguous), else dropped (not broadcast). `seen`
  // carries dedup keys across cycles. fm-watch owns wedge policy; BB is its
  // per-captain-scoped delivery transport.
  async function relayWatchReasons(lines: string[], hostId: string, seen: Set<string>): Promise<void> {
    if (lines.length === 0) return;
    const crews = await readCrews();
    const crewsOnHost: Crew[] = [];
    for (const crew of crews) {
      if (isSecondmateRoute(crew)) continue;
      try {
        if ((await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined)) === hostId) crewsOnHost.push(crew);
      } catch {
        // unresolved host → not attributed to this host's fallback set
      }
    }
    const hostParents = new Set(crewsOnHost.map((c) => c.parentThreadId).filter((p): p is string => p !== null && p !== ""));
    // Only fall back to a host captain when it is unambiguous (a single captain owns
    // crews on this host). Otherwise an unattributable line is dropped, never fanned.
    const soleHostParent = hostParents.size === 1 ? [...hostParents][0]! : undefined;
    const ownedCrews = crews.filter((c) => c.parentThreadId !== null && c.parentThreadId !== "");
    // Group per target parent so each captain gets one message.
    const byParent = new Map<string, string[]>();
    for (const line of lines) {
      const key = `${hostId}|${relayDedupKey(line)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Every known crew whose id appears in this line, grouped by owning captain.
      const mentioned = ownedCrews.filter((c) => line.includes(c.id));
      if (mentioned.length === 0) {
        // No crew named: deliver only to a lone host captain, else drop (never fan).
        if (soleHostParent === undefined) {
          bb.log.info(`fm-watch relay: dropping unattributable line on host ${hostId} (${hostParents.size} captains; no crew in line)`);
          continue;
        }
        const arr = byParent.get(soleHostParent) ?? [];
        arr.push(line);
        byParent.set(soleHostParent, arr);
        continue;
      }
      const owners = new Set(mentioned.map((c) => c.parentThreadId!));
      for (const parent of owners) {
        // Redact tokens naming OTHER captains' crews before delivering to this captain.
        const foreignIds = mentioned.filter((c) => c.parentThreadId !== parent).map((c) => c.id);
        const filtered = filterLineForOwner(line, foreignIds);
        if (filtered === "") continue;
        const arr = byParent.get(parent) ?? [];
        arr.push(filtered);
        byParent.set(parent, arr);
      }
    }
    for (const [parent, ls] of byParent) {
      await deliverToCaptain(parent, `🛰️ fm-watch:\n${ls.join("\n")}`, "fm-watch");
    }
    // Bound the dedup memory.
    if (seen.size > 200) {
      const keep = [...seen].slice(-100);
      seen.clear();
      for (const k of keep) seen.add(k);
    }
  }

  async function stuckPass(): Promise<{ checked: number; notified: number }> {
    const current = await settings.get();
    const stuckMs = Math.min(480, Math.max(5, Number(current.supervisionStuckMin) || 30)) * 60000;
    const intervalMs = Math.min(60, Math.max(1, Number(current.supervisionIntervalMin) || 5)) * 60000;
    // Watch ownership: when the real fm-watch owns policy AND its heartbeat is
    // live, it owns wedge evidence and steering re-rings — BB must not also page
    // the captain about a stuck crew (double-paging). But suppression is gated on a
    // FRESH fm-watch beat: if the watcher is stale/absent, BB pages as before so a
    // dead watcher never opens a silent supervision gap. BB idle/error/done events
    // always flow (delivery, not policy).
    const fmWatchOwns = current.watchOwner === "fm-watch" && current.fmHome.trim() !== "";
    // R1: suppression is per crew's HOST. A live watcher on host A must not
    // suppress BB's stuck-page for a crew on host B that no fm-watch supervises.
    // Cache host resolution + liveness per host within this pass.
    const hostForCrew = new Map<string, string | null>();
    const liveByHost = new Map<string, boolean>();
    const warnedStaleHost = new Set<string>();
    async function suppressForCrew(crew: Crew): Promise<boolean> {
      if (!fmWatchOwns) return false;
      let host = hostForCrew.get(crew.id);
      if (host === undefined) {
        try {
          host = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
        } catch {
          host = null;
        }
        hostForCrew.set(crew.id, host ?? null);
      }
      if (host === null || host === "") return false;
      let live = liveByHost.get(host);
      if (live === undefined) {
        live = await fmWatchLive(host, current.watchHeartbeatSec);
        liveByHost.set(host, live);
      }
      if (!live && !warnedStaleHost.has(host)) {
        warnedStaleHost.add(host);
        bb.log.warn(
          `watchOwner=fm-watch but fm-watch heartbeat is stale/absent on host ${host}; BB stuck-pass is paging as fallback (no supervision gap).`,
        );
      }
      return live;
    }
    const meta = asRecord(await bb.storage.kv.get<unknown>("watch-meta"));
    const lastPassAt = meta["lastPassAt"];
    const now = Date.now();
    const rebase = !stuckRebased && (typeof lastPassAt !== "number" || now - lastPassAt > intervalMs);
    stuckRebased = true;
    const crews = (await listCrews())
      .filter((c) => c.parentThreadId !== null && !isSecondmateRoute(c))
      .slice(0, MAX_CREWS);
    const parsed = watchStateSchema.safeParse(await bb.storage.kv.get<unknown>("watch"));
    const state: WatchState = parsed.success ? parsed.data : {};
    const seen = new Set<string>();
    let notified = 0;
    for (const crew of crews) {
      seen.add(crew.id);
      const status = await crewStatus(crew);
      const prev = state[crew.id];
      if (prev === undefined) {
        if (status === "error" || status === "unknown") {
          const detail = status === "error" ? await crewOutput(crew, 300) : null;
          await notifyCaptain(crew, status, detail);
          notified++;
          state[crew.id] = { status, hash: "", at: now, stuck: false, alerted: status };
          continue;
        }
        state[crew.id] = { status, hash: "", at: now, stuck: false };
        continue;
      }
      if (status === "idle") {
        state[crew.id] = { status, hash: "", at: now, stuck: false };
        continue;
      }
      if (status === "error" || status === "unknown") {
        if (prev.alerted !== status) {
          const detail = status === "error" ? await crewOutput(crew, 300) : null;
          await notifyCaptain(crew, status, detail);
          notified++;
        }
        state[crew.id] = { status, hash: "", at: now, stuck: false, alerted: status };
        continue;
      }
      if (rebase) {
        state[crew.id] = {
          status,
          hash: prev.hash,
          at: now,
          stuck: false,
          ...(prev.activityAt !== undefined ? { activityAt: prev.activityAt } : {}),
        };
        continue;
      }
      const excerpt = await crewExcerpt(crew);
      if (!excerpt.ok) {
        if (prev.alerted !== "unknown") {
          await notifyCaptain(crew, "unknown", null);
          notified++;
        }
        state[crew.id] = {
          status,
          hash: prev.hash,
          at: prev.at,
          stuck: prev.stuck,
          alerted: "unknown",
          ...(prev.activityAt !== undefined ? { activityAt: prev.activityAt } : {}),
        };
        continue;
      }
      if (excerpt.text !== prev.hash) {
        state[crew.id] = { status, hash: excerpt.text, at: now, stuck: false };
        continue;
      }
      const activity = await readToolActivity(crew.threadId);
      if (!activity.ok) {
        state[crew.id] = { ...prev, status, hash: excerpt.text };
        continue;
      }
      const activityAt = activity.at ?? undefined;
      const activityStale = activityAt === undefined || now - activityAt >= stuckMs;
      if (!activityStale) {
        state[crew.id] = {
          status,
          hash: excerpt.text,
          at: prev.at,
          stuck: false,
          ...(activityAt !== undefined ? { activityAt } : {}),
        };
        continue;
      }
      const outMin = Math.max(0, Math.round((now - prev.at) / 60000));
      const actMin = activityAt === undefined ? outMin : Math.max(0, Math.round((now - activityAt) / 60000));
      const row = {
        status,
        hash: excerpt.text,
        at: prev.at,
        stuck: prev.stuck,
        ...(activityAt !== undefined ? { activityAt } : {}),
      };
      if (!(await suppressForCrew(crew)) && !prev.stuck && now - prev.at >= stuckMs) {
        await notifyCaptain(
          crew,
          `stuck (${outMin}m no output change, no tool/file activity ${actMin}m)`,
          excerpt.text === "" ? null : excerpt.text,
        );
        notified++;
        row.stuck = true;
      }
      state[crew.id] = row;
    }
    for (const id of Object.keys(state)) {
      if (!seen.has(id)) delete state[id];
    }
    await bb.storage.kv.set("watch", state);
    await bb.storage.kv.set("watch-meta", { lastPassAt: now, checked: crews.length, notified });
    return { checked: crews.length, notified };
  }

  function guideText(repo: string, scriptCount = "", skillCount = ""): string {
    return [
      "firstmate inside BB — real mode is the default, two planes over one runtime:",
      "1. Real firstmate bin/ scripts (the full toolbelt): bb firstmate fm <script> …",
      `   ${toolbeltPhrase(scriptCount, skillCount)} keep policy`,
      "   (brief, gate, inbox, watch, merge, afk, bearings, backlog). `/captain` (deck)",
      "   auto-clones + overlays this on first run; no manual step if the host has git/gh.",
      "2. Native deck (plugin SDK / Fleet UI): bb firstmate deck, then dispatch/tell/watch/merge.",
      "   BB is the session backend (threads + managed-worktree), like tmux/orca — not a rewrite of bin/.",
      "Primary dispatch (real toolbelt, after deck/init --real):",
      "  bb firstmate fm spawn -- --mode direct-PR -- ship \"fix flaky login test\"",
      "Native dispatch (BB transport; writes state/<id>.meta when fmHome is set, so the scripts see Fleet crews):",
      "  bb firstmate dispatch --project <proj> -- \"fix flaky login test\"",
      `One-time activation if auto-init was skipped: bb firstmate init --real  (repo ${repo}; overlays backends/bb.sh, sets config/backend=bb, persists fmHome)`,
    ].join("\n");
  }

  const usage = [
    "Usage:",
    "  bb firstmate guide [--json]",
    "  bb firstmate init [--real] [--machine m] [--path p] [--name n] [--json]",
    "  bb firstmate fm [--timeout s] <script> [args...]   # real bin/fm-<script>.sh with FM_BACKEND=bb",
    "  bb firstmate deck | session [--json]",
    '  bb firstmate dispatch --project <id> [--task t ...] [--shape ship|scout] [--mode m] [--title t] [--provider p] [--model m] [--reasoning-level low|medium|high|xhigh|max] [--permission-mode m] [--shared-env] [--worktree] [--hidden] [--send-at ms] -- "<task>"',
    "  bb firstmate crews | crew <id> | watch [id ...] [--timeout s] [--json]",
    '  bb firstmate tell <id> -- "<message>" | interrupt <id> | stop <id> | retry <id> [--model m] [--provider p] [--reasoning-level l] [--reason r]',
    "  bb firstmate bearings | deliver <id> | merge <id> [--yes] [--allow-red <check-name>] | promote <id>",
    '  bb firstmate queue add --project <id> [--shape s] [--mode m] [--after <qid>] [--wait-until <iso>] -- "<title>"',
    "  bb firstmate queue [list|next|dispatch <qid>|done <qid>|drop <qid>]",
    '  bb firstmate decide ask [--option o ...] [--crew <id>] -- "<question>"',
    "  bb firstmate decide [list|answer <id>|defer <id>|drop <id>]",
    "  bb firstmate posture [set --project <id> [--mode m] [--yolo on|off]]",
    "  bb firstmate memory [show|set-captain|add-learning|drop-learning <n>|clear <captain|learnings>]",
    "  bb firstmate afk [on|off|status] [-- \"words\"]",
    "  bb firstmate quiet [on|off|status]",
    "  bb firstmate secondmate [list|register --project <id> --thread <id> [--scope <text>] [--projects a,b]|drop <project>]",
    "  bb firstmate supervision [on|off|status]",
    "  bb firstmate forget <id> [--stop] [--force]",
    "  bb firstmate mark-crew <thread-id> [--shape ship|scout]",
  ].join("\n");

  const dispatchParams = z.object({
    task: z.string().min(1).max(MAX_TASK),
    projectId: z.string().optional().describe("BB project id; defaults to the current thread's project"),
    title: z.string().max(120).optional(),
    providerId: z.string().optional(),
    model: z.string().optional(),
    reasoningLevel: z.enum(["low", "medium", "high", "xhigh", "max"]).optional()
      .describe("Reasoning effort applied to the crew from turn 1"),
    permissionMode: z.enum(["accept-edits", "auto", "full"]).optional(),
    shape: shapeSchema.optional(),
    mode: modeSchema.optional(),
    worktree: z.boolean().optional(),
    sharedEnv: z.boolean().optional().describe("Ship on the project checkout instead of an isolated worktree"),
    visible: z.boolean().optional().describe("Show in the BB sidebar as a nested subagent (default true)"),
    sendAt: z.number().int().optional().describe("Epoch ms to start the crew (queued until then)"),
  });

  function toolError(text: string) {
    return { content: [{ type: "text" as const, text }], isError: true };
  }

  bb.agents.registerTool({
    name: "firstmate_dispatch",
    description:
      "Dispatch a firstmate-style crewmate: spawns a child BB thread for one task (ship crews get an isolated worktree by default) and records it as a crew.",
    presentation: { label: { pending: "Dispatching crewmate", completed: "Dispatched crewmate" } },
    parameters: dispatchParams,
    async execute({ task, projectId, title, providerId, model, reasoningLevel, permissionMode, shape, mode, worktree, sharedEnv, visible, sendAt }, ctx) {
      const ctxRecord = asRecord(ctx);
      const resolvedProject =
        projectId ?? (typeof ctxRecord["projectId"] === "string" ? ctxRecord["projectId"] : undefined);
      if (resolvedProject === undefined) return toolError("No project: pass projectId.");
      const current = await settings.get();
      const resolvedShape = shape ?? "ship";
      const posture = await postureOf(resolvedProject);
      const wt = resolveWorktree({
        shape: resolvedShape,
        sharedEnv: sharedEnv === true,
        worktreeFlag: worktree === true,
        explicit: worktree,
      });
      const crew = await dispatchCrew({
        task,
        projectId: resolvedProject,
        parentThreadId: typeof ctxRecord["threadId"] === "string" ? ctxRecord["threadId"] : undefined,
        title,
        providerId: providerId ?? (current.defaultProvider !== "" ? current.defaultProvider : undefined),
        model,
        reasoningLevel: toReasoningLevel(reasoningLevel),
        permissionMode: toPermissionMode(permissionMode ?? current.defaultPermissionMode),
        worktree: wt.worktree,
        visible: visible !== false,
        shape: resolvedShape,
        mode: toMode(mode, posture.mode),
        sendAt,
      });
      const warn = wt.sharedOverride ? " WARN: ship crew on shared env." : "";
      return `Dispatched ${crew.shape} crew ${crew.id} as thread ${crew.threadId} (${await crewStatus(crew)}, ${crew.posture}).${warn} Track with: bb firstmate crew ${crew.id}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_deck",
    description: "Mark this thread as the firstmate captain and return the session digest (memory, bearings, afk).",
    presentation: { label: { pending: "Taking the deck", completed: "On deck" } },
    parameters: z.object({}),
    async execute(_args, ctx) {
      const record = asRecord(ctx);
      const threadId = record["threadId"];
      if (typeof threadId !== "string") return toolError("No thread to mark as captain.");
      await markDeck(threadId);
      const signal = record["signal"] as AbortSignal | undefined;
      const real = await ensureRealModeForDeck(ctx, signal);
      return `Captain, on deck.\n${real}\n${await deckDigest(ctx, signal)}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_tell",
    description:
      "Doorbell a crew: queues if the turn is active, starts a turn if idle. Use firstmate_interrupt to hard-stop. Pass resolveKey to also close that crew's open needs-decision/blocked (writes the resolved line to the real state/<id>.status, matching fm-classify-lib) when this steer is your answer to it.",
    parameters: z.object({
      crewId: z.string(),
      message: z.string().min(1).max(MAX_TASK),
      resolveKey: z.string().optional().describe("Key of the crew's open decision this steer answers (from crew/bearings); closes it in real state"),
    }),
    async execute({ crewId, message, resolveKey }) {
      const crew = await findCrew(crewId);
      if (crew === undefined) return toolError(`No crew ${crewId}.`);
      try {
        const sent = await tellCrew(crew, message, false);
        if (resolveKey !== undefined && resolveKey.trim() !== "") {
          const closed = await appendResolvedStatus(crew, resolveKey.trim(), message);
          return `${sent}${closed ? ` (resolved [key=${resolveKey.trim()}] in real state)` : ""}`;
        }
        return sent;
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "Tell failed.");
      }
    },
  });

  bb.agents.registerTool({
    name: "firstmate_watch",
    description: "Wait until the given crews finish (idle or error) using BB thread wait — do not poll.",
    parameters: z.object({
      crewIds: z.array(z.string()).max(MAX_WATCH_CREWS).optional(),
      timeoutSec: z.number().int().min(10).max(1800).optional(),
    }),
    async execute({ crewIds, timeoutSec }, ctx) {
      const all = await listCrews();
      const targets = (crewIds === undefined ? all : all.filter((c) => crewIds.includes(c.id))).slice(0, MAX_WATCH_CREWS);
      if (targets.length === 0) return toolError("No matching crews.");
      const timeoutMs = (timeoutSec ?? 600) * 1000;
      const signal = asRecord(ctx)["signal"] as AbortSignal | undefined;
      const rows = await Promise.all(
        targets.map(async (crew) => {
          const status = await waitOne(crew, timeoutMs, signal);
          const output = status === "idle" || status === "error" ? await crewOutput(crew, 800) : null;
          return { ...crew, status, outcome: parseOutcome(output), output };
        }),
      );
      return rows.map((r) => `${formatCrew(r, r.status)}${r.outcome !== null ? `\n  ${r.outcome}` : ""}`).join("\n");
    },
  });

  bb.agents.registerTool({
    name: "firstmate_bearings",
    description: "Fleet digest: Captain's Call, Recently Landed, Ready, Underway, Charted Next.",
    parameters: z.object({}),
    async execute() {
      return (await bearingsSnapshot()).text;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_wake",
    description:
      "Drain the real firstmate wake queue: durable crew→captain notifications, unread crew statuses, and open decisions that a dropped doorbell would otherwise lose. Run this when doorbelled (notifyOwner=real) or on deck. After handling, pass ackThrough + recoveryGeneration (from the WAKE_ACK_REQUIRED line) to consume the rows.",
    parameters: z.object({
      ackThrough: z.number().int().min(0).optional().describe("Consume wakes at/below this sequence (from WAKE_ACK_REQUIRED)"),
      recoveryGeneration: z.string().optional().describe("Recovery generation token (from WAKE_ACK_REQUIRED)"),
    }),
    async execute({ ackThrough, recoveryGeneration }, ctx) {
      // D6: the caller thread IS the captain — scope the drain/ack to its own queue.
      const out = await drainWakes(ctxString(ctx, "threadId"), ackThrough, recoveryGeneration);
      if (out === null) return toolError("No real fm-wake queue reachable (need real mode initialized + a host for fmHome).");
      return out;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_deliver",
    description: "Crew delivery: outcome + committed/uncommitted diff + PR state.",
    parameters: z.object({ crewId: z.string() }),
    async execute({ crewId }) {
      const crew = await findCrew(crewId);
      if (crew === undefined) return toolError(`No crew ${crewId}.`);
      return (await deliverLines(crew)).text;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_merge",
    description:
      "Merge a crew PR (green+mergeable, or zero checks) or ff-only local-only land. Needs yes=true or yolo posture. allowRedCheck names one exact failing check to land past — separate from yes, and never silent.",
    parameters: z.object({
      crewId: z.string(),
      yes: z.boolean().optional(),
      allowRedCheck: z.string().optional()
        .describe("Exact name of one failing check to waive; every other check must be green"),
    }),
    async execute({ crewId, yes, allowRedCheck }) {
      const crew = await findCrew(crewId);
      if (crew === undefined) return toolError(`No crew ${crewId}.`);
      try {
        return await mergeCrew(crew, yes === true, allowRedCheck);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "Merge failed.");
      }
    },
  });

  bb.agents.registerTool({
    name: "firstmate_decide",
    description: "Durable captain decisions. ask stores a question; answer tells the linked crew.",
    parameters: z.object({
      action: z.enum(["ask", "list", "answer", "defer", "drop"]),
      question: z.string().optional(),
      decisionId: z.string().optional(),
      answer: z.string().optional(),
      options: z.array(z.string()).optional(),
      crewId: z.string().optional(),
    }),
    async execute({ action, question, decisionId, answer, options, crewId }) {
      const all = await readDecisions();
      if (action === "list") {
        if (all.length === 0) return "No decisions.";
        return all.map((d) => `${d.id} [${d.status}] :: ${truncate(d.question, 80)}`).join("\n");
      }
      if (action === "ask") {
        if (question === undefined || question.trim() === "") return toolError("Need question.");
        const d: Decision = {
          id: randomUUID().slice(0, 8),
          question: question.slice(0, 500),
          options: (options ?? []).slice(0, 10),
          context: "",
          crewId: crewId ?? null,
          status: "open",
          deferredUntil: null,
          answer: "",
          createdAt: new Date().toISOString(),
        };
        await writeDecisions([d, ...all]);
        await projectDecisionAsk(d);
        return `Decision ${d.id}: ${truncate(question, 100)}. Prefer AskUserQuestion to collect the captain's choice, then firstmate_decide action=answer.`;
      }
      if (action === "answer") {
        const d = all.find((x) => x.id === decisionId);
        if (d === undefined || answer === undefined) return toolError("Need decisionId + answer.");
        d.status = "answered";
        d.answer = answer.slice(0, 500);
        await writeDecisions(all);
        if (d.crewId !== null) {
          const crew = await findCrew(d.crewId);
          if (crew !== undefined) {
            await bb.sdk.threads.send({
              threadId: crew.threadId,
              mode: "steer",
              input: [{ type: "text", text: `Captain's decision: ${answer.slice(0, MAX_TASK)}`, mentions: [] }],
            });
          }
        }
        await projectDecisionAnswer(d, answer);
        return `Answered ${d.id}`;
      }
      if (action === "defer") {
        const d = all.find((x) => x.id === decisionId);
        if (d === undefined) return toolError("Need decisionId.");
        d.status = "deferred";
        await writeDecisions(all);
        await projectDecisionDefer(d, d.deferredUntil);
        return `Deferred ${d.id}`;
      }
      if (action === "drop") {
        await writeDecisions(all.filter((x) => x.id !== decisionId));
        if (decisionId !== undefined) await projectDecisionDrop(decisionId);
        return `Dropped ${decisionId ?? ""}`;
      }
      return toolError("Unknown action.");
    },
  });

  bb.agents.registerTool({
    name: "firstmate_crew",
    description:
      "Show one crew: thread status, folded status protocol (state + open needs-decision/blocked), parsed DONE/BLOCKED/FAILED, last output.",
    parameters: z.object({ crewId: z.string() }),
    async execute({ crewId }) {
      const crew = await findCrew(crewId);
      if (crew === undefined) return toolError(`No crew ${crewId}.`);
      const status = await crewStatus(crew);
      const output = await crewOutput(crew);
      const outcome = parseOutcome(output);
      const protocol = statusProtocolSummary(await crewStatusLines(crew, output));
      return [
        formatCrew(crew, status),
        protocol ?? "",
        outcome === null ? "" : `outcome: ${outcome}`,
        output ?? "(no output yet)",
      ]
        .filter((l) => l !== "")
        .join("\n");
    },
  });

  bb.agents.registerTool({
    name: "firstmate_stop",
    description: "Stop a crew thread (keeps the record).",
    parameters: z.object({ crewId: z.string() }),
    async execute({ crewId }) {
      const crew = await findCrew(crewId);
      if (crew === undefined) return toolError(`No crew ${crewId}.`);
      if (isSecondmateRoute(crew)) return toolError(`Crew ${crewId} is a secondmate route — do not stop the domain captain.`);
      if (await isCaptainThread(crew.threadId)) return toolError("Refusing to stop the captain thread.");
      await bb.sdk.threads.stop({ threadId: crew.threadId });
      return `Stopped crew ${crewId}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_retry",
    description:
      "Re-run a crew. With no provider/model/reasoning override, re-submits the failed turn on the same thread. With any override, relaunches a fresh thread in the SAME worktree at the new provider/model/reasoning (recovery relaunch).",
    parameters: z.object({
      crewId: z.string(),
      reason: z.string().optional(),
      model: z.string().optional().describe("Replacement model — triggers a relaunch reusing the worktree"),
      providerId: z.string().optional().describe("Replacement provider — triggers a relaunch reusing the worktree"),
      reasoningLevel: z.enum(["low", "medium", "high", "xhigh", "max"]).optional()
        .describe("Replacement reasoning effort — triggers a relaunch reusing the worktree"),
    }),
    async execute({ crewId, reason, model, providerId, reasoningLevel }) {
      const crew = await findCrew(crewId);
      if (crew === undefined) return toolError(`No crew ${crewId}.`);
      const replace = model !== undefined || providerId !== undefined || reasoningLevel !== undefined;
      try {
        if (!replace) {
          await bb.sdk.threads.retry({ threadId: crew.threadId, reason: reason ?? `firstmate retry crew ${crewId}` });
          return `Retried crew ${crewId}`;
        }
        const next = await relaunchCrew(crew, {
          model,
          providerId,
          reasoningLevel: toReasoningLevel(reasoningLevel),
          note: reason,
        });
        return `Relaunched crew ${crewId} as thread ${next.threadId} (${next.providerId ?? "default provider"}/${next.model ?? "default model"}/${next.reasoningLevel ?? "default reasoning"}), same worktree.`;
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "Retry failed.");
      }
    },
  });

  bb.agents.registerTool({
    name: "firstmate_promote",
    description: "Promote a finished scout into a new ship crew carrying the scout report. Never expand the scout in place.",
    parameters: z.object({ crewId: z.string(), mode: modeSchema.optional() }),
    async execute({ crewId, mode }, ctx) {
      const scout = await findCrew(crewId);
      if (scout === undefined) return toolError(`No crew ${crewId}.`);
      if (scout.shape !== "scout") return toolError(`Crew ${crewId} is ${scout.shape}, not scout.`);
      const report = (await crewOutput(scout, 2000)) ?? "(no scout report)";
      const current = await settings.get();
      const posture = await postureOf(scout.projectId);
      const ctxRecord = asRecord(ctx);
      const ship = await dispatchCrew({
        task: `Captain's intent: implement the scout's recommended path. Do not reopen the investigation.\nAcceptance: the scout report's recommendation, nothing else.\n\nFirstmate spec: follow the report. Out of scope: extra hardening not named there.\n\nScout report (crew ${scout.id}):\n${report}`,
        projectId: scout.projectId,
        parentThreadId: typeof ctxRecord["threadId"] === "string" ? ctxRecord["threadId"] : scout.parentThreadId ?? undefined,
        title: `Ship from scout ${scout.id}`,
        providerId: current.defaultProvider !== "" ? current.defaultProvider : undefined,
        permissionMode: toPermissionMode(current.defaultPermissionMode),
        worktree: true,
        visible: true,
        shape: "ship",
        mode: toMode(mode, posture.mode),
      });
      await recordDone({
        task: scout.task.slice(0, 200),
        shape: "scout",
        crewId: scout.id,
        outcome: `promoted → ship ${ship.id}`,
        pr: "",
      });
      return `Promoted scout ${scout.id} → ship ${ship.id} (${ship.threadId}). Scout record kept until forget.`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_afk",
    description: "Away posture: on holds routine done-pings for the return brief; off prints the brief then clears.",
    parameters: z.object({
      action: z.enum(["on", "off", "status"]),
      words: z.string().optional(),
    }),
    async execute({ action, words }, ctx) {
      if (action === "on") {
        await writeAfk({
          on: true,
          words: words ?? "",
          since: new Date().toISOString(),
          held: (await readAfk())?.held ?? [],
        });
        try { await settings.experimental_set({ supervisionEnabled: true }); } catch { /* */ }
        const proj = await projectAfkOn(words ?? "", []);
        const contractNote = (await afkIsReal()) ? ` Durable contract ${proj.contract ? "confirmed" : "not confirmed (KV flag only)"}.` : "";
        return `AFK on. Words recorded, not executed as authority. Failures/credentials still surface.${contractNote}`;
      }
      if (action === "off") {
        const prev = await readAfk();
        await writeAfk({ on: false, words: "", since: new Date().toISOString(), held: [] });
        await projectAfkOff();
        const held = prev?.held ?? [];
        const snap = await bearingsSnapshot();
        return [
          "== return brief ==",
          snap.text,
          held.length === 0 ? "Nothing held." : `Held while away:\n${held.join("\n---\n")}`,
          await wakeResumeBrief(ctxString(ctx, "threadId")),
        ].join("\n");
      }
      const afk = await readAfk();
      const auth = await realAfkAuthority();
      const authNote = auth === null ? "" : ` contract:${auth.confirmed ? "confirmed" : "off"} grants=${auth.grants.length}`;
      return `afk: ${afk?.on === true ? "on" : "off"}${afk?.words ? ` words: ${afk.words}` : ""} held=${afk?.held.length ?? 0}${authNote}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_interrupt",
    description: "Hard-stop a crew's current action without teardown. Doorbell/tell does not interrupt.",
    parameters: z.object({ crewId: z.string() }),
    async execute({ crewId }) {
      const crew = await findCrew(crewId);
      if (crew === undefined) return toolError(`No crew ${crewId}.`);
      try {
        return await tellCrew(
          crew,
          "INTERRUPT: stop the current action. Await new orders. Do not teardown or discard work.",
          true,
        );
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "Interrupt failed.");
      }
    },
  });

  bb.agents.registerTool({
    name: "firstmate_crews",
    description: "List recorded crews with live thread status.",
    parameters: z.object({}),
    async execute() {
      const crews = (await listCrews()).slice(0, 20);
      if (crews.length === 0) return "No crews.";
      const rows = await Promise.all(crews.map(async (crew) => formatCrew(crew, await crewStatus(crew))));
      return rows.join("\n");
    },
  });

  bb.agents.registerTool({
    name: "firstmate_session",
    description: "Session digest: memory, bearings, afk/quiet.",
    parameters: z.object({}),
    async execute() {
      return sessionDigest();
    },
  });

  bb.agents.registerTool({
    name: "firstmate_quiet",
    description: "Batch routine done-pings while the captain is present. Failures and review-ready PRs still surface.",
    parameters: z.object({ action: z.enum(["on", "off", "status"]) }),
    async execute({ action }, ctx) {
      if (action === "on" || action === "off") {
        return await setQuiet(action, ctxString(ctx, "threadId"));
      }
      return `quiet: ${(await isQuiet()) ? "on" : "off"}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_queue",
    description: "Backlog with deps/time gates. add files work; dispatch starts a crew when ungated.",
    parameters: z.object({
      action: z.enum(["add", "list", "next", "dispatch", "done", "drop"]),
      title: z.string().optional(),
      projectId: z.string().optional(),
      queueId: z.string().optional(),
      shape: shapeSchema.optional(),
      mode: modeSchema.optional(),
      after: z.array(z.string()).optional(),
      waitUntil: z.string().optional(),
      detail: z.string().optional(),
    }),
    async execute({ action, title, projectId, queueId, shape, mode, after, waitUntil, detail }, ctx) {
      const items = await readQueue();
      const ctxProject = ctxString(ctx, "projectId");
      if (action === "list") {
        if (items.length === 0) return "Queue empty.";
        const now = Date.now();
        return items
          .map((q) => {
            const gate = q.status === "queued" ? queueGate(q, items, now) : null;
            return `${q.id} [${q.status}] ${q.shape} :: ${truncate(q.title, 70)}${gate !== null ? ` — ${gate}` : ""}${q.crewId !== null ? ` (crew ${q.crewId})` : ""}`;
          })
          .join("\n");
      }
      if (action === "next") {
        const now = Date.now();
        const open = items.filter((q) => q.status === "queued" && queueGate(q, items, now) === null);
        if (open.length === 0) return "Nothing dispatchable.";
        const first = [...open].reverse()[0] as QueueItem;
        return `${first.id} [${first.shape}] ${first.projectId} :: ${first.title}`;
      }
      if (action === "add") {
        if (title === undefined || title.trim() === "") return toolError("Need title.");
        const pid = projectId ?? ctxProject;
        if (pid === undefined) return toolError("Need projectId.");
        const newId = randomUUID().slice(0, 8);
        const proj = await projectQueueAdd(newId, title, shape ?? "ship", pid);
        const item: QueueItem = {
          id: newId,
          title: title.slice(0, 500),
          detail: (detail ?? "").slice(0, MAX_TASK),
          projectId: pid,
          shape: shape ?? "ship",
          mode: mode ?? "",
          blockedBy: after ?? [],
          waitUntil: waitUntil ?? null,
          status: "queued",
          crewId: null,
          ...(proj.ok ? { backlogId: newId } : {}),
          createdAt: new Date().toISOString(),
        };
        await writeQueue([item, ...items]);
        await publishFleet();
        return `Queued ${item.id} [${item.shape}] :: ${truncate(item.title, 80)}`;
      }
      const item = items.find((q) => q.id === queueId);
      if (queueId === undefined || item === undefined) return toolError(`No queued item ${queueId ?? ""}.`);
      if (action === "drop" || action === "done") {
        item.status = action === "drop" ? "dropped" : "done";
        await projectQueueTransition(item, action === "drop" ? "rm" : "done");
        await writeQueue(items);
        await publishFleet();
        return `Queue ${queueId} ${item.status}`;
      }
      const gate = queueGate(item, items, Date.now());
      if (gate !== null) return toolError(`Item ${queueId} gated: ${gate}.`);
      const registry = await postureOf(item.projectId);
      const brief = item.detail !== "" ? `${item.title}\n\n${item.detail}` : item.title;
      const crew = await dispatchCrew({
        task: brief,
        projectId: item.projectId,
        parentThreadId: ctxString(ctx, "threadId"),
        title: `Crew: ${truncate(item.title, 60)}`,
        worktree: resolveWorktree({ shape: item.shape }).worktree,
        visible: true,
        shape: item.shape,
        mode: toMode(item.mode !== "" ? item.mode : undefined, registry.mode),
      });
      item.status = "dispatched";
      item.crewId = crew.id;
      await projectQueueTransition(item, "start");
      await writeQueue(items);
      await publishFleet();
      return `Dispatched queue ${queueId} as ${crew.shape} crew ${crew.id}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_forget",
    description: "Drop a crew record. stop=true archives the thread (refuses dirty work unless force).",
    parameters: z.object({
      crewId: z.string(),
      stop: z.boolean().optional(),
      force: z.boolean().optional(),
    }),
    async execute({ crewId, stop, force }) {
      try {
        return await forgetCrew(crewId, stop === true, force === true);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "Forget failed.");
      }
    },
  });

  bb.agents.registerTool({
    name: "firstmate_memory",
    description: "Captain prefs and dated fleet learnings.",
    parameters: z.object({
      action: z.enum(["show", "set-captain", "add-learning", "drop-learning", "clear"]),
      text: z.string().optional(),
      n: z.number().int().optional(),
      which: z.enum(["captain", "learnings"]).optional(),
    }),
    async execute({ action, text, n, which }) {
      if (action === "show") {
        const m = await memoryShow();
        return `== captain ==\n${m.captain !== "" ? m.captain : "(empty)"}\n== learnings ==\n${m.learnings !== "" ? m.learnings : "(empty)"}`;
      }
      if (action === "set-captain") {
        if (text === undefined || text.trim() === "") return toolError("Need text.");
        await memorySetCaptain(text);
        return "Captain preferences saved.";
      }
      if (action === "add-learning") {
        if (text === undefined || text.trim() === "") return toolError("Need text.");
        await memoryAddLearning(text);
        return "Learning stored.";
      }
      if (action === "drop-learning") {
        const left = await memoryDropLearning(n ?? 0);
        if (left < 0) return toolError(`No learning #${n ?? ""}.`);
        return `Dropped learning #${n}.`;
      }
      if (which !== "captain" && which !== "learnings") return toolError("Need which=captain|learnings.");
      if (!(await memoryClear(which))) return toolError(`Refused to clear ${which}: could not archive current contents first (nothing changed).`);
      return `Cleared ${which} (previous contents archived).`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_secondmate",
    description: "Register a domain-captain thread. Dispatch routes there by scope + project clone list instead of spawning.",
    parameters: z.object({
      action: z.enum(["list", "register", "drop"]),
      projectId: z.string().optional(),
      threadId: z.string().optional(),
      scope: z.string().optional(),
      // Non-exclusive clone list: extra project ids this secondmate also handles.
      projects: z.array(z.string()).optional(),
    }),
    async execute({ action, projectId, threadId, scope, projects }, ctx) {
      const items = await readSecondmates();
      const ctxRecord = asRecord(ctx);
      if (action === "list") {
        if (items.length === 0) return "No secondmates.";
        return items.map(formatSecondmate).join("\n");
      }
      if (action === "register") {
        const pid = projectId ?? (typeof ctxRecord["projectId"] === "string" ? ctxRecord["projectId"] : undefined);
        const tid = threadId ?? (typeof ctxRecord["threadId"] === "string" ? ctxRecord["threadId"] : undefined);
        if (pid === undefined || tid === undefined) return toolError("Need projectId and threadId.");
        const next = items.filter((m) => m.projectId !== pid);
        const row: Secondmate = {
          projectId: pid,
          threadId: tid,
          scope: scope ?? "",
          projects: (projects ?? []).map((p) => p.trim()).filter((p) => p !== ""),
          createdAt: new Date().toISOString(),
        };
        next.push(row);
        await writeSecondmates(next);
        return `Secondmate ${pid} → ${tid}${row.scope !== "" ? ` (${row.scope})` : ""}`;
      }
      const pid = projectId;
      if (pid === undefined) return toolError("Need projectId.");
      await writeSecondmates(items.filter((m) => m.projectId !== pid));
      return `Dropped secondmate ${pid}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_posture",
    description: "Per-project delivery mode (direct-PR / no-mistakes / local-only) and yolo merge authority.",
    parameters: z.object({
      action: z.enum(["get", "set"]),
      projectId: z.string().optional(),
      mode: modeSchema.optional(),
      yolo: z.boolean().optional(),
    }),
    async execute({ action, projectId, mode, yolo }, ctx) {
      const pid = projectId ?? ctxString(ctx, "projectId");
      const all = await readPostures();
      if (action === "get") {
        if (pid === undefined) {
          const keys = Object.keys(all);
          if (keys.length === 0) return "No postures set (default everywhere: direct-PR, yolo off).";
          return keys.map((k) => `${k}: ${all[k]?.mode}${all[k]?.yolo ? "+yolo" : ""}`).join("\n");
        }
        const p = all[pid] ?? { mode: "direct-PR" as DeliveryMode, yolo: false };
        return `Posture ${pid}: ${p.mode}${p.yolo ? "+yolo" : ""}`;
      }
      if (pid === undefined) return toolError("Need projectId.");
      const cur = all[pid] ?? { mode: "direct-PR" as DeliveryMode, yolo: false };
      const next = { mode: toMode(mode, cur.mode), yolo: yolo ?? cur.yolo };
      all[pid] = next;
      await bb.storage.kv.set(POSTURES_KEY, all);
      return `Posture ${pid}: ${next.mode}${next.yolo ? "+yolo" : ""}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_supervision",
    description: "Event pings (idle/fail/interaction) plus stuck checker. Deck turns this on.",
    parameters: z.object({ action: z.enum(["on", "off", "status"]) }),
    async execute({ action }) {
      if (action === "on" || action === "off") {
        await settings.experimental_set({ supervisionEnabled: action === "on" });
        return `Supervision ${action}`;
      }
      const current = await settings.get();
      const meta = asRecord(await bb.storage.kv.get<unknown>("watch-meta"));
      return `supervision: ${current.supervisionEnabled === true ? "on" : "off"} (events for done/fail, stuck every ${current.supervisionIntervalMin}m after ${current.supervisionStuckMin}m)\nlast stuck pass: ${typeof meta["lastPassAt"] === "number" ? new Date(meta["lastPassAt"]).toISOString() : "never"}`;
    },
  });

  bb.agents.registerTool({
    name: "firstmate_migrate_state",
    description:
      "Import the KV crew cache into the authoritative real firstmate state (state/<id>.meta + structured brief). Idempotent; never overwrites existing real state, never touches KV. Requires init --real.",
    parameters: z.object({}),
    async execute() {
      try {
        const r = await migrateState();
        return [
          `Migration complete: ${r.imported.length} imported, ${r.skippedExisting.length} already present, ${r.skippedSecondmate.length} secondmate routes skipped, ${r.skippedTerminal.length} terminal skipped, ${r.failed.length} failed (of ${r.total} crews).`,
          r.imported.length > 0 ? `imported: ${r.imported.join(", ")}` : "",
          r.failed.length > 0 ? `failed (host/state unreachable): ${r.failed.join(", ")}` : "",
        ]
          .filter((l) => l !== "")
          .join("\n");
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "Migration failed.");
      }
    },
  });

  bb.agents.registerTool({
    name: "firstmate_fm",
    description:
      "Run a real firstmate bin/fm-<script>.sh with FM_BACKEND=bb (policy scripts, not a TypeScript port). Requires init --real.",
    parameters: z.object({
      script: z.string().min(1).max(80).describe("Stem of bin/fm-<script>.sh, e.g. spawn, peek, send, watch, bearings-snapshot"),
      args: z.array(z.string()).max(40).optional(),
      timeoutSec: z.number().int().min(15).max(1800).optional(),
    }),
    async execute({ script, args, timeoutSec }, ctx) {
      const current = await settings.get();
      if (current.fmHome === "") return toolError("No firstmate home. Run bb firstmate init --real.");
      try {
        const hostId = await resolveHostId(undefined, ctx);
        const result = await runFmScript({
          script,
          args: args ?? [],
          hostId,
          fmHome: current.fmHome,
          parentThreadId: ctxString(ctx, "threadId"),
          timeoutMs: fmTimeoutMs(normalizeFmScript(script), timeoutSec),
          signal: asRecord(ctx)["signal"] as AbortSignal | undefined,
        });
        const text = result.output === "" ? `(exit ${result.exitCode ?? "?"})` : result.output;
        return result.exitCode === 0 ? text : toolError(text);
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "fm failed");
      }
    },
  });

  bb.agents.configure((context) => {
    const meta = asRecord(context.pluginMetadata);
    if (metaFlag(meta, "crew")) {
      return {
        tools: [],
        skills: [],
        instructions:
          "You are a firstmate crewmate. Do not dispatch other crews. Finish this one task, then report DONE, BLOCKED, or FAILED.",
      };
    }
    const marked = metaFlag(meta, "captain");
    const base = marked
      ? "You are the first mate. The user is the captain. Never do crew work in this thread — dispatch with firstmate_dispatch. Parent permission is a ceiling."
      : "Firstmate crews are available. Run /captain or firstmate_deck to take the deck.";
    // D4: budget the 4096-char captain instruction window DELIBERATELY across the
    // injected blocks instead of first-come truncation (which used to starve memory
    // entirely and scissor the skills list down to ~500 chars). Per-block char
    // allotments, ordered by recall value (memory first so a fresh captain always
    // recalls stored prefs/learnings):
    //   captain memory (prefs + recent learnings): 1400
    //   captain contract (AGENTS.md excerpt):       1600
    //   skills manifest:                             900
    // base(~180) + blocks + headers stay under 4096; the final truncate is a backstop.
    const CAP_MEMORY_BUDGET = 1400;
    const CAP_CONTRACT_BUDGET = 1600;
    const CAP_SKILLS_BUDGET = 900;
    const memoryBlock =
      marked && captainMemoryCache !== "" ? `\n\n${truncate(captainMemoryCache, CAP_MEMORY_BUDGET)}` : "";
    const contractBlock =
      marked && captainContractCache !== ""
        ? `\n\n== Real firstmate captain contract (fmHome/AGENTS.md) ==\n${truncate(captainContractCache, CAP_CONTRACT_BUDGET)}`
        : "";
    const skillsBlock =
      marked && skillsManifestCache !== "" ? `\n\n${truncate(skillsManifestCache, CAP_SKILLS_BUDGET)}` : "";
    const instructions =
      memoryBlock === "" && contractBlock === "" && skillsBlock === ""
        ? base
        : truncate(`${base}${memoryBlock}${contractBlock}${skillsBlock}`, 4096);
    return {
      tools: [...CAPTAIN_TOOLS],
      skills: marked ? [...CAPTAIN_SKILLS] : ["firstmate"],
      instructions,
    };
  });

  bb.rpc.register(rpcContract, {
    async fleet() {
      return (await bearingsSnapshot()).rpc;
    },
  });

  bb.ui.registerMentionProvider({
    id: "crew",
    label: "Crews",
    triggers: ["@"],
    async search({ query }) {
      const crews = (await listCrews()).slice(0, 20);
      const q = query.toLowerCase();
      return crews
        .filter((c) => q === "" || c.id.includes(q) || c.task.toLowerCase().includes(q))
        .slice(0, 8)
        .map((c) => ({ id: c.id, title: c.id, subtitle: truncate(c.task, 60) }));
    },
    async resolve(itemId) {
      const crew = await findCrew(itemId);
      if (crew === undefined) throw new Error(`No crew ${itemId}`);
      const status = await crewStatus(crew);
      return { context: `Crew ${crew.id} [${status}] ${crew.shape} thread ${crew.threadId}: ${crew.task}` };
    },
  });

  const nudgeRowSchema = z.object({
    generation: z.string(),
    count: z.number(),
    lastAt: z.number(),
    exhausted: z.boolean(),
    dueAt: z.number().optional(),
  });
  const nudgeStateSchema = z.record(z.string(), nudgeRowSchema);
  type NudgeRow = z.infer<typeof nudgeRowSchema>;
  const nudgeTimers = new Map<string, ReturnType<typeof setTimeout>>();

  function clearNudgeTimer(crewId: string): void {
    const timer = nudgeTimers.get(crewId);
    if (timer === undefined) return;
    clearTimeout(timer);
    nudgeTimers.delete(crewId);
  }

  function nudgeLimits(current: Awaited<ReturnType<typeof settings.get>>): {
    enabled: boolean;
    max: number;
    cooldownMs: number;
  } {
    const maxRaw = current.nudgeMaxPerCrew;
    const coolRaw = current.nudgeCooldownSeconds;
    const max = Number.isFinite(maxRaw) ? Math.max(0, Math.trunc(maxRaw)) : 3;
    const seconds = Number.isFinite(coolRaw) ? Math.max(0, Math.trunc(coolRaw)) : 60;
    return { enabled: current.nudgeEnabled === true, max, cooldownMs: seconds * 1000 };
  }

  async function readNudgeState(): Promise<Record<string, NudgeRow>> {
    const parsed = nudgeStateSchema.safeParse(await bb.storage.kv.get<unknown>(NUDGE_KEY));
    return parsed.success ? parsed.data : {};
  }

  function taskGeneration(crew: Crew): string {
    return crew.createdAt !== "" ? crew.createdAt : crew.threadId;
  }

  async function dropNudge(crewId: string): Promise<void> {
    clearNudgeTimer(crewId);
    const state = await readNudgeState();
    if (state[crewId] === undefined) return;
    delete state[crewId];
    await bb.storage.kv.set(NUDGE_KEY, state);
  }

  function armNudgeTimer(crewId: string, waitMs: number): void {
    clearNudgeTimer(crewId);
    const timer = setTimeout(() => {
      nudgeTimers.delete(crewId);
      void runDeferredNudge(crewId);
    }, Math.max(0, waitMs));
    (timer as unknown as { unref?: () => void }).unref?.();
    nudgeTimers.set(crewId, timer);
  }

  let nudgesRearmed = false;
  async function rearmDeferredNudges(): Promise<void> {
    if (nudgesRearmed) return;
    nudgesRearmed = true;
    const limits = nudgeLimits(await settings.get());
    if (!limits.enabled) return;
    const state = await readNudgeState();
    const now = Date.now();
    for (const [crewId, row] of Object.entries(state)) {
      if (row.exhausted || row.dueAt === undefined || !(row.dueAt > 0)) continue;
      armNudgeTimer(crewId, row.dueAt - now);
    }
  }

  async function refreshWatchAfterNudge(crewId: string): Promise<void> {
    const raw = await bb.storage.kv.get<unknown>("watch");
    const parsed = watchStateSchema.safeParse(raw);
    if (!parsed.success && raw != null) return;
    const state: WatchState = parsed.success ? { ...parsed.data } : {};
    const prev = state[crewId];
    state[crewId] = {
      status: prev?.status ?? "active",
      hash: prev?.hash ?? "",
      at: Date.now(),
      stuck: false,
      ...(prev?.activityAt !== undefined ? { activityAt: prev.activityAt } : {}),
    };
    await bb.storage.kv.set("watch", state);
  }

  async function turnWasStopped(thread: {
    id: string;
    status: string;
    runtime?: { displayStatus?: string };
  }): Promise<boolean> {
    if (thread.status === "stopping" || thread.runtime?.displayStatus === "stopping") return true;
    try {
      const interrupts = await bb.sdk.threads.events.list({
        threadId: thread.id,
        order: "desc",
        limit: "8",
        types: ["system/thread/interrupted"],
      });
      let interruptAt: number | null = null;
      for (const row of interrupts) {
        const reason = asRecord(row.data)["reason"];
        if (reason !== "manual-stop" && reason !== "host-daemon-restarted") continue;
        if (typeof row.createdAt === "number") {
          interruptAt = row.createdAt;
          break;
        }
      }
      if (interruptAt === null) return false;
      const turns = await bb.sdk.threads.events.list({
        threadId: thread.id,
        order: "desc",
        limit: "1",
        types: ["turn/started"],
      });
      const started = turns[0]?.createdAt;
      return typeof started === "number" && interruptAt > started;
    } catch {
      return false;
    }
  }

  async function applyProtocolNudge(crew: Crew): Promise<"off" | "nudged" | "cooling" | "exhausted" | "spent"> {
    if (isSecondmateRoute(crew)) return "spent";
    const current = await settings.get();
    const limits = nudgeLimits(current);
    if (!limits.enabled) return "off";
    const generation = taskGeneration(crew);
    const state = await readNudgeState();
    const prev = state[crew.id];
    const row: NudgeRow =
      prev === undefined || prev.generation !== generation
        ? { generation, count: 0, lastAt: 0, exhausted: false }
        : { ...prev };
    if (row.exhausted) return "spent";
    if (row.count >= limits.max) {
      row.exhausted = true;
      state[crew.id] = row;
      await bb.storage.kv.set(NUDGE_KEY, state);
      await notifyCaptain(
        crew,
        "needs-decision",
        `NEEDS DECISION: crew ${crew.id} idled without DONE:/BLOCKED:/FAILED: after ${limits.max} protocol nudges`,
      );
      return "exhausted";
    }
    const now = Date.now();
    if (row.lastAt > 0 && now - row.lastAt < limits.cooldownMs) {
      const dueAt = row.lastAt + limits.cooldownMs;
      state[crew.id] = { ...row, dueAt };
      await bb.storage.kv.set(NUDGE_KEY, state);
      armNudgeTimer(crew.id, dueAt - now);
      return "cooling";
    }
    clearNudgeTimer(crew.id);
    try {
      await tellCrew(crew, protocolNudgeText(row.count + 1, limits.max), false);
    } catch (error) {
      bb.log.warn(
        `protocol nudge failed for crew ${crew.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return "cooling";
    }
    state[crew.id] = { generation: row.generation, count: row.count + 1, lastAt: now, exhausted: false };
    await bb.storage.kv.set(NUDGE_KEY, state);
    try {
      await refreshWatchAfterNudge(crew.id);
    } catch {
      // nudge already landed; a stale watch row must not undo the send
    }
    return "nudged";
  }

  async function runDeferredNudge(crewId: string): Promise<void> {
    const crew = await findCrew(crewId);
    if (crew === undefined || isSecondmateRoute(crew)) return;
    try {
      const thread = await bb.sdk.threads.get({ threadId: crew.threadId });
      if (await turnWasStopped(thread)) return;
      if (thread.status === "active" || thread.status === "starting") return;
    } catch {
      return;
    }
    const output = await crewOutput(crew);
    if (hasStatusProtocol(output)) return;
    await applyProtocolNudge(crew);
  }

  bb.events.on("thread.created", async ({ thread }) => {
    if (!isCaptainSpawn(thread)) return;
    await settleDeck(thread.id);
  });
  bb.events.on("thread.active", async ({ thread }) => {
    if (!isCaptainSpawn(thread)) return;
    await settleDeck(thread.id);
  });
  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    // Turn-end backstop for the captain (no-op unless turnEndGuard=re-ring and this
    // is the captain thread). Runs before the crew path; captains are not crews.
    await captainTurnEndGuard(thread.id).catch(() => {});
    const crew = await findCrewByThread(thread.id);
    if (crew === undefined || isSecondmateRoute(crew)) return;
    const stopped = await turnWasStopped(thread);
    if (!stopped && !hasStatusProtocol(lastAssistantText)) {
      const outcome = await applyProtocolNudge(crew);
      if (outcome !== "off") return;
    }
    const current = await settings.get();
    if (current.supervisionEnabled !== true) return;
    await notifyCaptain(crew, "idle", lastAssistantText);
  });
  bb.events.on("thread.failed", async ({ thread, error }) => {
    const current = await settings.get();
    if (current.supervisionEnabled !== true) return;
    const crew = await findCrewByThread(thread.id);
    if (crew === undefined || isSecondmateRoute(crew)) return;
    await notifyCaptain(crew, "error", error);
  });
  bb.events.on("interaction.pending", async ({ thread }) => {
    const current = await settings.get();
    if (current.supervisionEnabled !== true) return;
    const crew = await findCrewByThread(thread.id);
    if (crew === undefined || isSecondmateRoute(crew)) return;
    await notifyCaptain(crew, "interaction", "crew is waiting on an approval or credential");
  });
  bb.events.on("turn.failed", async ({ threadId }) => {
    const crew = await findCrewByThread(threadId);
    if (crew === undefined || isSecondmateRoute(crew)) return;
    // thread.failed already paged the lifecycle error; this fires after the thread is in error.
  });

  bb.cli.register({
    name: "firstmate",
    summary: "Run firstmate-style crews: dispatch crewmate threads, track them, bring back results",
    commands: [
      { name: "guide", summary: "Setup guide for firstmate inside BB", usage: "bb firstmate guide [--json]" },
      { name: "init", summary: "Native deck setup (add --real to clone firstmate and overlay the BB backend)", usage: "bb firstmate init [--real] [--json]" },
      { name: "fm", summary: "Run a real firstmate bin/ script with FM_BACKEND=bb", usage: "bb firstmate fm [--timeout s] <script> [args...]" },
      { name: "deck", summary: "Mark this thread captain + session digest", usage: "bb firstmate deck [--json]" },
      { name: "session", summary: "Session digest: memory + bearings + afk", usage: "bb firstmate session [--json]" },
      { name: "dispatch", summary: "Dispatch crewmate child threads", usage: 'bb firstmate dispatch --project <id> -- "<task>"' },
      { name: "crews", summary: "List recorded crews with live status", usage: "bb firstmate crews [--json]" },
      { name: "crew", summary: "Show one crew with last output", usage: "bb firstmate crew <crew-id> [--json]" },
      { name: "watch", summary: "Wait for crews via bb thread wait", usage: "bb firstmate watch [crew-id ...] [--timeout <sec>] [--json]" },
      { name: "tell", summary: "Steer a running crew", usage: 'bb firstmate tell <crew-id> [--resolve-key <key>] -- "<message>"' },
      { name: "interrupt", summary: "Steer a hard stop without teardown", usage: "bb firstmate interrupt <crew-id>" },
      { name: "stop", summary: "Stop a crew thread", usage: "bb firstmate stop <crew-id>" },
      { name: "retry", summary: "Re-submit a failed turn, or relaunch with a new model/provider/reasoning", usage: "bb firstmate retry <crew-id> [--model m] [--provider p] [--reasoning-level l]" },
      { name: "bearings", summary: "Fleet digest", usage: "bb firstmate bearings [--json]" },
      { name: "wake", summary: "Drain the durable crew→captain wake queue (present, or --ack-through <seq> --recovery-generation <gen>)", usage: "bb firstmate wake [--ack-through <seq> --recovery-generation <gen>]" },
      { name: "deliver", summary: "Outcome + committed/uncommitted diff + PR", usage: "bb firstmate deliver <crew-id>" },
      { name: "merge", summary: "Merge PR or local-only ff-only land", usage: "bb firstmate merge <crew-id> [--yes]" },
      { name: "promote", summary: "Scout → new ship carrying the report", usage: "bb firstmate promote <crew-id>" },
      { name: "queue", summary: "Backlog with deps/time gates", usage: 'bb firstmate queue add --project <id> -- "<title>"' },
      { name: "decide", summary: "Durable decisions", usage: 'bb firstmate decide ask -- "<question>"' },
      { name: "posture", summary: "Per-project delivery mode + yolo", usage: "bb firstmate posture set --project <id> [--mode m]" },
      { name: "memory", summary: "Captain prefs + learnings", usage: "bb firstmate memory show" },
      { name: "afk", summary: "Away posture", usage: "bb firstmate afk on|off|status" },
      { name: "quiet", summary: "Batch routine pings while present", usage: "bb firstmate quiet on|off|status" },
      { name: "secondmate", summary: "Register a domain captain thread", usage: "bb firstmate secondmate list|register|drop" },
      { name: "supervision", summary: "Event pings + stuck checker", usage: "bb firstmate supervision on|off|status" },
      { name: "forget", summary: "Drop a crew record", usage: "bb firstmate forget <crew-id> [--stop] [--force]" },
      { name: "mark-crew", summary: "Tag a thread as a firstmate crew (used by the real-mode bb backend)", usage: "bb firstmate mark-crew <thread-id> [--shape ship|scout]" },
      { name: "migrate-state", summary: "Import the KV crew cache into authoritative real state (idempotent)", usage: "bb firstmate migrate-state [--json]" },
      { name: "migrate-owners", summary: "Project KV queue/decisions/afk/quiet/memory into the real files for owners set to real (idempotent)", usage: "bb firstmate migrate-owners [--json]" },
    ],
    async run(argv, ctx) {
      if (argv[0] === "fm") {
        const json = argv.includes("--json");
        const fail = (message: string) => ({ exitCode: 1, stderr: message });
        const signal = asRecord(ctx)["signal"] as AbortSignal | undefined;
        try {
          const current = await settings.get();
          const fmHome = flagFromArgv(argv, "home") ?? (current.fmHome !== "" ? current.fmHome : undefined);
          if (fmHome === undefined) return fail("No firstmate home. Run: bb firstmate init --real");
          const parsed = parseFmArgv(argv.slice(1));
          if (parsed.script === undefined) return fail("Usage: bb firstmate fm [--timeout s] <script> [args...]\nExample: bb firstmate fm spawn -- --mode direct-PR -- ship \"fix login\"");
          const hostId = await resolveHostId(flagFromArgv(argv, "machine"), ctx);
          const ctxRecord = asRecord(ctx);
          const result = await runFmScript({
            script: parsed.script,
            args: parsed.args,
            hostId,
            fmHome,
            projectId: flagFromArgv(argv, "project"),
            parentThreadId: typeof ctxRecord["threadId"] === "string" ? ctxRecord["threadId"] : undefined,
            timeoutMs: fmTimeoutMs(normalizeFmScript(parsed.script), parsed.timeoutSec),
            signal,
          });
          const body = json
            ? JSON.stringify({ script: result.scriptPath, exitCode: result.exitCode, output: result.output })
            : result.output;
          return { exitCode: result.exitCode ?? 1, stdout: result.exitCode === 0 ? body : "", stderr: result.exitCode === 0 ? "" : body };
        } catch (error) {
          return fail(error instanceof Error ? error.message : "fm failed");
        }
      }
      const { flags, positional } = parseArgs(argv);
      const json = flags.has("json");
      const signal = asRecord(ctx)["signal"] as AbortSignal | undefined;
      const reply = (value: unknown, text: string) => ({
        exitCode: 0,
        stdout: json ? JSON.stringify(value) : text,
      });
      const fail = (message: string) => ({ exitCode: 1, stderr: message });
      const [command, ...rest] = positional;
      const current = await settings.get();
      const ctxRecord = asRecord(ctx);
      const ctxProject = typeof ctxRecord["projectId"] === "string" ? ctxRecord["projectId"] : undefined;
      const ctxThread = typeof ctxRecord["threadId"] === "string" ? ctxRecord["threadId"] : undefined;

      try {
        switch (command) {
          case undefined:
          case "help":
          case "--help":
            return { exitCode: 0, stdout: usage };
          case "guide": {
            const repo = current.firstmateRepo !== "" ? current.firstmateRepo : "https://github.com/kunchenguid/firstmate";
            const text = guideText(repo, current.fmScriptCount, current.fmSkillCount);
            return reply({ guide: text }, text);
          }
          case "deck": {
            if (ctxThread === undefined) return fail("No thread: run this from a BB thread.");
            await markDeck(ctxThread);
            const real = await ensureRealModeForDeck(ctx, signal);
            const realMode = (await settings.get()).fmHome.trim() !== "";
            const digest = await deckDigest(ctx, signal);
            return reply(
              { captain: true, threadId: ctxThread, realMode, digest },
              `Captain, on deck.\n${real}\n${digest}`,
            );
          }
          case "session": {
            const digest = await sessionDigest();
            return reply({ digest }, digest);
          }
          case "init": {
            if (!flags.has("real")) {
              if (ctxThread !== undefined) await markDeck(ctxThread);
              else await settings.experimental_set({ supervisionEnabled: true });
              const repo = current.firstmateRepo !== "" ? current.firstmateRepo : "https://github.com/kunchenguid/firstmate";
              const text = [
                "Native firstmate is ready. This thread is the captain (if run from a thread).",
                guideText(repo, current.fmScriptCount, current.fmSkillCount),
              ].join("\n");
              return reply({ native: true, threadId: ctxThread ?? null }, text);
            }
            const res = await initRealMode(ctx, signal, {
              machine: flagStr(flags, "machine"),
              path: flagStr(flags, "path"),
              name: flagStr(flags, "name"),
              timeoutMs: Math.min(600, Math.max(30, Number(flagStr(flags, "timeout") ?? "180"))) * 1000,
            });
            return reply(
              { hostId: res.hostId, path: res.path, existed: res.existed, projectId: res.projectId, backend: "bb", tools: res.tools, overlay: res.overlay },
              res.summary,
            );
          }
          case "dispatch": {
            const tasks =
              flagAll(flags, "task").length > 0
                ? flagAll(flags, "task")
                : [rest.join(" ").trim()].filter((t) => t !== "");
            if (tasks.length === 0) return fail(`Empty task.\n${usage}`);
            if (tasks.length > MAX_FANOUT) return fail(`Too many tasks (max ${MAX_FANOUT}).`);
            const projectId = flagStr(flags, "project") ?? ctxProject;
            if (projectId === undefined) return fail("No project: pass --project <id> (see bb project list).");
            const shape = toShape(flagStr(flags, "shape"));
            const wt = resolveWorktree({
              shape,
              sharedEnv: flags.has("shared-env"),
              worktreeFlag: flags.has("worktree"),
            });
            const registry = await postureOf(projectId);
            const mode = toMode(flagStr(flags, "mode"), registry.mode);
            const titleFlag = flagStr(flags, "title");
            const sendAtRaw = flagStr(flags, "send-at");
            const sendAt = sendAtRaw === undefined ? undefined : Number(sendAtRaw);
            if (sendAt !== undefined && !Number.isFinite(sendAt)) return fail("Bad --send-at (epoch ms).");
            const dispatched = [];
            for (let i = 0; i < tasks.length; i++) {
              const crew = await dispatchCrew({
                task: tasks[i] as string,
                projectId,
                parentThreadId: ctxThread,
                title: titleFlag === undefined ? undefined : tasks.length === 1 ? titleFlag : `${titleFlag} #${i + 1}`,
                providerId: flagStr(flags, "provider") ?? (current.defaultProvider !== "" ? current.defaultProvider : undefined),
                model: flagStr(flags, "model"),
                reasoningLevel: toReasoningLevel(flagStr(flags, "reasoning-level")),
                permissionMode: toPermissionMode(flagStr(flags, "permission-mode") ?? current.defaultPermissionMode),
                worktree: wt.worktree,
                visible: !flags.has("hidden"),
                shape,
                mode,
                sendAt,
              });
              dispatched.push({ ...crew, status: await crewStatus(crew) });
            }
            const hints: string[] = [];
            if (wt.sharedOverride) {
              hints.push("WARN: ship crew on shared env (--shared-env). Prefer the default isolated worktree.");
            }
            if (shape === "ship" && tasks.some((t) => looksReadOnly(t))) {
              hints.push("Hint: task looks read-only — consider --shape scout.");
            }
            if (current.fmHome.trim() !== "") {
              hints.push(
                `fm: bb firstmate fm peek -- ${dispatched.map((c) => c.id).join(" ")}`,
              );
            }
            return reply(
              dispatched,
              [
                ...dispatched.map(
                  (c) =>
                    `Dispatched ${c.shape} crew ${c.id} as thread ${c.threadId} [${c.status}] (${c.worktree ? "worktree" : "shared-env"}, ${c.posture})\nTrack: bb firstmate crew ${c.id}`,
                ),
                ...hints,
              ].join("\n"),
            );
          }
          case "crews": {
            const crews = (await listCrews()).slice(0, 20);
            const rows = await Promise.all(crews.map(async (crew) => ({ ...crew, status: await crewStatus(crew) })));
            return reply(rows, rows.length === 0 ? "No crews." : rows.map((row) => formatCrew(row, row.status)).join("\n"));
          }
          case "crew": {
            const id = rest[0];
            if (id === undefined || rest.length !== 1) return fail(usage);
            const crew = await findCrew(id);
            if (crew === undefined) return fail(`No crew ${id}. Run "bb firstmate crews".`);
            const status = await crewStatus(crew);
            const output = await crewOutput(crew);
            const outcome = parseOutcome(output);
            const lines = await crewStatusLines(crew, output);
            const protocol = statusProtocolSummary(lines);
            const latest = latestStatus(lines);
            const openDecisions =
              latest !== null && latest.verb !== "done" && latest.verb !== "failed" ? foldOpenDecisions(lines) : [];
            return reply(
              { ...crew, status, outcome, protocol, openDecisions, output },
              [
                formatCrew(crew, status),
                protocol ?? "",
                outcome === null ? "" : `outcome: ${outcome}`,
                output === null ? "(no output yet)" : "",
                output ?? "",
              ]
                .filter((line) => line !== "")
                .join("\n"),
            );
          }
          case "watch": {
            const ids = rest.length > 0 ? rest : null;
            const timeoutMs = Math.min(1800, Math.max(10, Number(flagStr(flags, "timeout") ?? "600"))) * 1000;
            const all = await listCrews();
            const targets = (ids === null ? all : all.filter((c) => ids.includes(c.id))).slice(0, MAX_WATCH_CREWS);
            if (targets.length === 0) return fail("No matching crews.");
            if (ids !== null) {
              const missing = ids.filter((id) => !targets.some((c) => c.id === id));
              if (missing.length > 0) return fail(`No crew ${missing[0]}. Run "bb firstmate crews".`);
            }
            const rows = await Promise.all(
              targets.map(async (crew) => {
                const status = await waitOne(crew, timeoutMs, signal);
                const output = status === "idle" || status === "error" ? await crewOutput(crew, 800) : null;
                return { ...crew, status, outcome: parseOutcome(output), output };
              }),
            );
            const timedOut = rows.filter((r) => r.status === "timeout").map((r) => r.id);
            const text = rows
              .map((row) => {
                const head = formatCrew(row, row.status);
                if (row.outcome !== null) return `${head}\n  ${row.outcome}`;
                if (row.output === null) {
                  return row.status === "timeout" ? `${head}\n  (still running, timed out)` : head;
                }
                return `${head}\n  ${truncate(row.output.replace(/\n/g, " "), 300)}`;
              })
              .join("\n");
            return reply({ crews: rows, timedOut }, timedOut.length > 0 ? `${text}\nTimed out: ${timedOut.join(", ")}` : text);
          }
          case "tell":
          case "interrupt": {
            const id = rest[0];
            const message =
              command === "interrupt"
                ? "INTERRUPT: stop the current action. Await new orders. Do not teardown or discard work."
                : (flagStr(flags, "message") ?? rest.slice(1).join(" ").trim());
            if (id === undefined || message === "") return fail(usage);
            const crew = await findCrew(id);
            if (crew === undefined) return fail(`No crew ${id}. Run "bb firstmate crews".`);
            const text = await tellCrew(crew, message, command === "interrupt");
            const resolveKey = command === "tell" ? (flagStr(flags, "resolve-key") ?? "").trim() : "";
            const resolved = resolveKey !== "" ? await appendResolvedStatus(crew, resolveKey, message) : false;
            return reply(
              { told: true, id, interrupt: command === "interrupt", resolved: resolved ? resolveKey : null },
              resolved ? `${text} (resolved [key=${resolveKey}] in real state)` : text,
            );
          }
          case "stop": {
            const id = rest[0];
            if (id === undefined) return fail(usage);
            const crew = await findCrew(id);
            if (crew === undefined) return fail(`No crew ${id}.`);
            if (isSecondmateRoute(crew)) return fail(`Crew ${id} is a secondmate route — do not stop the domain captain.`);
            if (await isCaptainThread(crew.threadId)) return fail("Refusing to stop the captain thread.");
            await bb.sdk.threads.stop({ threadId: crew.threadId });
            return reply({ stopped: true, id }, `Stopped crew ${id}`);
          }
          case "retry": {
            const id = rest[0];
            if (id === undefined) return fail(usage);
            const crew = await findCrew(id);
            if (crew === undefined) return fail(`No crew ${id}.`);
            const model = flagStr(flags, "model");
            const providerId = flagStr(flags, "provider");
            const reasoningLevel = toReasoningLevel(flagStr(flags, "reasoning-level"));
            const reason = flagStr(flags, "reason");
            if (model === undefined && providerId === undefined && reasoningLevel === undefined) {
              await bb.sdk.threads.retry({
                threadId: crew.threadId,
                reason: reason ?? `firstmate retry crew ${id}`,
              });
              return reply({ retried: true, id }, `Retried crew ${id}`);
            }
            const next = await relaunchCrew(crew, { model, providerId, reasoningLevel, note: reason });
            return reply(
              { relaunched: true, id, threadId: next.threadId, model: next.model, providerId: next.providerId, reasoningLevel: next.reasoningLevel },
              `Relaunched crew ${id} as thread ${next.threadId} (${next.providerId ?? "default provider"}/${next.model ?? "default model"}/${next.reasoningLevel ?? "default reasoning"}), same worktree.`,
            );
          }
          case "mark-crew": {
            const id = rest[0];
            if (id === undefined) return fail("Usage: bb firstmate mark-crew <thread-id> [--shape ship|scout] [--task <id>]");
            const shape = toShape(flagStr(flags, "shape"));
            const taskId = (flagStr(flags, "task") ?? "").trim();
            // Record the fm task id as crewId so a plugin-side fallback can find and
            // adopt an orphan thread (created by fm-spawn but not yet recorded) by id.
            const set: Record<string, string> = { crew: "true", shape };
            if (taskId !== "") set["crewId"] = taskId;
            await bb.sdk.threads.updatePluginMetadata({ threadId: id, set });
            return reply({ marked: true, threadId: id, shape, task: taskId || null }, `Marked thread ${id} as ${shape} crew.`);
          }
          case "bearings": {
            const snap = await bearingsSnapshot();
            return reply(snap.json, snap.text);
          }
          case "wake": {
            const ackRaw = flagStr(flags, "ack-through");
            const gen = flagStr(flags, "recovery-generation");
            const ackThrough = ackRaw !== undefined && /^\d+$/.test(ackRaw) ? Number(ackRaw) : undefined;
            const out = await drainWakes(ctxString(ctx, "threadId"), ackThrough, gen);
            if (out === null) return fail("No real fm-wake queue reachable (need real mode initialized + a host for fmHome).");
            return reply({ drained: true, acked: ackThrough ?? null }, out);
          }
          case "deliver": {
            const id = rest[0];
            if (id === undefined) return fail(usage);
            const crew = await findCrew(id);
            if (crew === undefined) return fail(`No crew ${id}.`);
            const d = await deliverLines(crew);
            return reply(d.json, d.text);
          }
          case "merge": {
            const id = rest[0];
            if (id === undefined) return fail(usage);
            const crew = await findCrew(id);
            if (crew === undefined) return fail(`No crew ${id}.`);
            const text = await mergeCrew(crew, flags.has("yes"), flagStr(flags, "allow-red"));
            return reply({ merged: true, id }, text);
          }
          case "promote": {
            const id = rest[0];
            if (id === undefined) return fail(usage);
            const scout = await findCrew(id);
            if (scout === undefined) return fail(`No crew ${id}.`);
            if (scout.shape !== "scout") return fail(`Crew ${id} is ${scout.shape}, not scout.`);
            const report = (await crewOutput(scout, 2000)) ?? "(no scout report)";
            const registry = await postureOf(scout.projectId);
            const ship = await dispatchCrew({
              task: `Captain's intent: implement the scout's recommended path.\n\nScout report (crew ${scout.id}):\n${report}`,
              projectId: scout.projectId,
              parentThreadId: ctxThread ?? scout.parentThreadId ?? undefined,
              title: `Ship from scout ${scout.id}`,
              providerId: current.defaultProvider !== "" ? current.defaultProvider : undefined,
              permissionMode: toPermissionMode(current.defaultPermissionMode),
              worktree: true,
              visible: !flags.has("hidden"),
              shape: "ship",
              mode: toMode(flagStr(flags, "mode"), registry.mode),
            });
            await recordDone({
              task: scout.task.slice(0, 200),
              shape: "scout",
              crewId: scout.id,
              outcome: `promoted → ship ${ship.id}`,
              pr: "",
            });
            return reply({ scout: scout.id, ship: ship.id }, `Promoted scout ${scout.id} → ship ${ship.id}`);
          }
          case "supervision": {
            const sub = rest[0] ?? "status";
            if (sub === "on" || sub === "off") {
              await settings.experimental_set({ supervisionEnabled: sub === "on" });
              return reply(
                { supervision: sub },
                `Supervision ${sub}${sub === "on" ? " (done/fail via thread events; stuck checker still polls output)" : ""}`,
              );
            }
            const meta = asRecord(await bb.storage.kv.get<unknown>("watch-meta"));
            const tracked = Object.keys(asRecord(await bb.storage.kv.get<unknown>("watch"))).length;
            const lastPass = meta["lastPassAt"];
            const info = {
              enabled: current.supervisionEnabled,
              intervalMin: current.supervisionIntervalMin,
              stuckMin: current.supervisionStuckMin,
              lastPassAt: typeof lastPass === "number" ? new Date(lastPass).toISOString() : null,
              lastChecked: meta["checked"] ?? null,
              lastNotified: meta["notified"] ?? null,
              tracked,
            };
            return reply(
              info,
              [
                `supervision: ${info.enabled === true ? "on" : "off"} (events for done/fail, stuck every ${info.intervalMin}m after ${info.stuckMin}m)`,
                `last stuck pass: ${info.lastPassAt ?? "never"} checked=${info.lastChecked ?? "?"} notified=${info.lastNotified ?? "?"} tracked=${tracked}`,
              ].join("\n"),
            );
          }
          case "afk": {
            const sub = rest[0] ?? "status";
            if (sub === "on") {
              const words = flagStr(flags, "words") ?? rest.slice(1).join(" ").trim();
              await writeAfk({
                on: true,
                words,
                since: new Date().toISOString(),
                held: (await readAfk())?.held ?? [],
              });
              await settings.experimental_set({ supervisionEnabled: true });
              const proj = await projectAfkOn(words, flagAll(flags, "grant"));
              return reply({ afk: true, words, contract: proj.contract }, `AFK on. Words recorded, not executed as authority.${(await afkIsReal()) ? ` Durable contract ${proj.contract ? "confirmed" : "not confirmed (KV flag only)"}.` : ""}`);
            }
            if (sub === "off") {
              const prev = await readAfk();
              await writeAfk({ on: false, words: "", since: new Date().toISOString(), held: [] });
              await projectAfkOff();
              const snap = await bearingsSnapshot();
              const held = prev?.held ?? [];
              const text = [
                "== return brief ==",
                snap.text,
                held.length === 0 ? "Nothing held." : `Held while away:\n${held.join("\n---\n")}`,
                await wakeResumeBrief(ctxString(ctx, "threadId")),
              ].join("\n");
              return reply({ afk: false, held, bearings: snap.json }, text);
            }
            const afk = await readAfk();
            const auth = await realAfkAuthority();
            const authNote = auth === null ? "" : ` contract:${auth.confirmed ? "confirmed" : "off"} grants=${auth.grants.length}`;
            return reply({ ...afk, contract: auth }, `afk: ${afk?.on === true ? "on" : "off"} held=${afk?.held.length ?? 0}${authNote}`);
          }
          case "quiet": {
            const sub = rest[0] ?? "status";
            if (sub === "on" || sub === "off") {
              const text = await setQuiet(sub, ctxString(ctx, "threadId"));
              return reply({ quiet: sub === "on" }, text);
            }
            const q = await isQuiet();
            return reply({ quiet: q }, `quiet: ${q ? "on" : "off"}`);
          }
          case "secondmate": {
            const sub = rest[0] ?? "list";
            const items = await readSecondmates();
            if (sub === "list") {
              if (items.length === 0) return reply([], "No secondmates.");
              return reply(items, items.map(formatSecondmate).join("\n"));
            }
            if (sub === "register") {
              const projectId = flagStr(flags, "project") ?? ctxProject;
              const threadId = flagStr(flags, "thread") ?? ctxThread;
              if (projectId === undefined || threadId === undefined) {
                return fail("Need --project and --thread (or run from that thread).");
              }
              const next = items.filter((m) => m.projectId !== projectId);
              const row: Secondmate = {
                projectId,
                threadId,
                scope: flagStr(flags, "scope") ?? "",
                projects: (flagStr(flags, "projects") ?? "").split(",").map((p) => p.trim()).filter((p) => p !== ""),
                createdAt: new Date().toISOString(),
              };
              next.push(row);
              await writeSecondmates(next);
              return reply(row, `Secondmate ${projectId} → ${threadId}`);
            }
            if (sub === "drop") {
              const projectId = rest[1] ?? flagStr(flags, "project");
              if (projectId === undefined) return fail("Need project id.");
              await writeSecondmates(items.filter((m) => m.projectId !== projectId));
              return reply({ dropped: projectId }, `Dropped secondmate ${projectId}`);
            }
            return fail(usage);
          }
          case "queue": {
            const sub = rest[0] ?? "list";
            const items = await readQueue();
            if (sub === "add") {
              const title = rest.slice(1).join(" ").trim();
              if (title === "") return fail(usage);
              const projectId = flagStr(flags, "project") ?? ctxProject;
              if (projectId === undefined) return fail("No project: pass --project <id>.");
              const newId = randomUUID().slice(0, 8);
              const shapeVal = toShape(flagStr(flags, "shape"));
              const proj = await projectQueueAdd(newId, title, shapeVal, projectId);
              const item: QueueItem = {
                id: newId,
                title: title.slice(0, 500),
                detail: (flagStr(flags, "detail") ?? "").slice(0, MAX_TASK),
                projectId,
                shape: shapeVal,
                mode: flagStr(flags, "mode") ?? "",
                blockedBy: flagAll(flags, "after"),
                waitUntil: flagStr(flags, "wait-until") ?? null,
                status: "queued",
                crewId: null,
                ...(proj.ok ? { backlogId: newId } : {}),
                createdAt: new Date().toISOString(),
              };
              await writeQueue([item, ...items]);
              return reply(item, `Queued ${item.id} [${item.shape}] :: ${truncate(item.title, 80)}`);
            }
            if (sub === "list") {
              if (items.length === 0) return reply([], "Queue empty.");
              const now = Date.now();
              const lines = items.map((q) => {
                const gate = q.status === "queued" ? queueGate(q, items, now) : null;
                return `${q.id} [${q.status}] ${q.shape} :: ${truncate(q.title, 70)}${gate !== null ? ` — ${gate}` : ""}${q.crewId !== null ? ` (crew ${q.crewId})` : ""}`;
              });
              return reply(items, lines.join("\n"));
            }
            if (sub === "next") {
              const now = Date.now();
              const open = items.filter((q) => q.status === "queued" && queueGate(q, items, now) === null);
              if (open.length === 0) return reply([], "Nothing dispatchable.");
              const first = [...open].reverse()[0] as QueueItem;
              return reply(first, `${first.id} [${first.shape}] ${first.projectId} :: ${first.title}\nDispatch: bb firstmate queue dispatch ${first.id}`);
            }
            if (sub === "dispatch") {
              const qid = rest[1];
              const item = items.find((q) => q.id === qid);
              if (qid === undefined || item === undefined) return fail(`No queued item ${qid ?? ""}.`);
              const gate = queueGate(item, items, Date.now());
              if (gate !== null) return fail(`Item ${qid} gated: ${gate}.`);
              const registry = await postureOf(item.projectId);
              const brief = item.detail !== "" ? `${item.title}\n\n${item.detail}` : item.title;
              const crew = await dispatchCrew({
                task: brief,
                projectId: item.projectId,
                parentThreadId: ctxThread,
                title: `Crew: ${truncate(item.title, 60)}`,
                providerId: flagStr(flags, "provider") ?? (current.defaultProvider !== "" ? current.defaultProvider : undefined),
                model: flagStr(flags, "model"),
                reasoningLevel: toReasoningLevel(flagStr(flags, "reasoning-level")),
                permissionMode: toPermissionMode(flagStr(flags, "permission-mode") ?? current.defaultPermissionMode),
                worktree: resolveWorktree({ shape: item.shape, sharedEnv: flags.has("shared-env"), worktreeFlag: flags.has("worktree") }).worktree,
                visible: !flags.has("hidden"),
                shape: item.shape,
                mode: toMode(item.mode !== "" ? item.mode : undefined, registry.mode),
              });
              item.status = "dispatched";
              item.crewId = crew.id;
              await projectQueueTransition(item, "start");
              await writeQueue(items);
              return reply({ ...crew, status: await crewStatus(crew), queueId: qid }, `Dispatched queue ${qid} as ${crew.shape} crew ${crew.id}`);
            }
            if (sub === "drop" || sub === "done") {
              const qid = rest[1];
              const item = items.find((q) => q.id === qid);
              if (qid === undefined || item === undefined) return fail(`No queued item ${qid ?? ""}.`);
              item.status = sub === "drop" ? "dropped" : "done";
              await projectQueueTransition(item, sub === "drop" ? "rm" : "done");
              await writeQueue(items);
              return reply({ id: qid, status: item.status }, `Queue ${qid} ${item.status}`);
            }
            return fail(usage);
          }
          case "decide": {
            const sub = rest[0] ?? "list";
            const all = await readDecisions();
            if (sub === "ask") {
              const question = rest.slice(1).join(" ").trim();
              if (question === "") return fail(usage);
              const d: Decision = {
                id: randomUUID().slice(0, 8),
                question: question.slice(0, 500),
                options: flagAll(flags, "option").slice(0, 10),
                context: flagStr(flags, "context") ?? "",
                crewId: flagStr(flags, "crew") ?? null,
                status: "open",
                deferredUntil: null,
                answer: "",
                createdAt: new Date().toISOString(),
              };
              await writeDecisions([d, ...all]);
              await projectDecisionAsk(d);
              return reply(
                d,
                `Decision ${d.id}: ${truncate(question, 100)}${d.options.length > 0 ? `\nOptions: ${d.options.join(" / ")}` : ""}\nAsk the captain with AskUserQuestion, then: bb firstmate decide answer ${d.id} -- "<answer>"`,
              );
            }
            if (sub === "list") {
              if (all.length === 0) return reply([], "No decisions.");
              const now = Date.now();
              const fmt = (d: Decision) =>
                `${d.id} [${d.status}] :: ${truncate(d.question, 80)}${d.options.length > 0 ? ` (${d.options.join(" / ")})` : ""}`;
              return reply(all, ["== Due ==", ...all.filter((d) => decisionDue(d, now)).map(fmt), "== Waiting ==", ...all.filter((d) => !decisionDue(d, now) && d.status !== "answered").map(fmt)].join("\n"));
            }
            if (sub === "answer") {
              const did = rest[1];
              const answer = (flagStr(flags, "message") ?? rest.slice(2).join(" ")).trim();
              const d = all.find((x) => x.id === did);
              if (did === undefined || d === undefined) return fail(`No decision ${did ?? ""}.`);
              if (answer === "") return fail(usage);
              d.status = "answered";
              d.answer = answer.slice(0, 500);
              await writeDecisions(all);
              let told = "";
              if (d.crewId !== null) {
                const crew = await findCrew(d.crewId);
                if (crew !== undefined) {
                  await bb.sdk.threads.send({
                    threadId: crew.threadId,
                    mode: "steer",
                    input: [{ type: "text", text: `Captain's decision: ${answer.slice(0, MAX_TASK)}`, mentions: [] }],
                  });
                  told = ` (told crew ${d.crewId})`;
                }
              }
              await projectDecisionAnswer(d, answer);
              return reply({ answered: true, id: did }, `Answered ${did}${told}`);
            }
            if (sub === "defer") {
              const did = rest[1];
              const d = all.find((x) => x.id === did);
              if (did === undefined || d === undefined) return fail(`No decision ${did ?? ""}.`);
              d.status = "deferred";
              d.deferredUntil = flagStr(flags, "until") ?? null;
              await writeDecisions(all);
              await projectDecisionDefer(d, d.deferredUntil);
              return reply({ deferred: true, id: did }, `Deferred ${did}`);
            }
            if (sub === "drop") {
              const did = rest[1];
              if (did === undefined) return fail(usage);
              await writeDecisions(all.filter((x) => x.id !== did));
              await projectDecisionDrop(did);
              return reply({ dropped: true, id: did }, `Dropped decision ${did}`);
            }
            return fail(usage);
          }
          case "posture": {
            const sub = rest[0];
            if (sub === "set") {
              const projectId = flagStr(flags, "project") ?? ctxProject;
              if (projectId === undefined) return fail("No project: pass --project <id>.");
              const all = await readPostures();
              const cur = all[projectId] ?? { mode: "direct-PR" as DeliveryMode, yolo: false };
              const mode = toMode(flagStr(flags, "mode"), cur.mode);
              const yoloRaw = flagStr(flags, "yolo");
              const yolo = yoloRaw === undefined ? cur.yolo : yoloRaw === "on" || yoloRaw === "true";
              all[projectId] = { mode, yolo };
              await bb.storage.kv.set(POSTURES_KEY, all);
              return reply({ projectId, mode, yolo }, `Posture ${projectId}: ${mode}${yolo ? "+yolo" : ""}`);
            }
            const all = await readPostures();
            const projectId = flagStr(flags, "project") ?? ctxProject ?? null;
            if (projectId !== null) {
              const p = all[projectId] ?? { mode: "direct-PR" as DeliveryMode, yolo: false };
              return reply({ projectId, ...p }, `Posture ${projectId}: ${p.mode}${p.yolo ? "+yolo" : ""}`);
            }
            const keys = Object.keys(all);
            if (keys.length === 0) return reply({}, "No postures set (default everywhere: direct-PR, yolo off).");
            return reply(all, keys.map((k) => `${k}: ${all[k]?.mode}${all[k]?.yolo ? "+yolo" : ""}`).join("\n"));
          }
          case "memory": {
            const sub = rest[0] ?? "show";
            if (sub === "show") {
              const m = await memoryShow();
              return reply(
                { captain: m.captain, learnings: m.learnings, source: m.source },
                `== captain ==\n${m.captain !== "" ? m.captain : "(empty)"}\n== learnings ==\n${m.learnings !== "" ? m.learnings : "(empty)"}`,
              );
            }
            if (sub === "set-captain") {
              const text = rest.slice(1).join(" ").trim();
              if (text === "") return fail(usage);
              await memorySetCaptain(text);
              return reply({ set: true }, "Captain preferences saved.");
            }
            if (sub === "add-learning") {
              const text = rest.slice(1).join(" ").trim();
              if (text === "") return fail(usage);
              await memoryAddLearning(text);
              return reply({ added: true }, "Learning stored.");
            }
            if (sub === "drop-learning") {
              const n = Number(rest[1]);
              const left = await memoryDropLearning(n);
              if (left < 0) return fail(`No learning #${rest[1] ?? ""}.`);
              return reply({ dropped: true }, `Dropped learning #${n}.`);
            }
            if (sub === "clear") {
              const which = rest[1];
              if (which !== "captain" && which !== "learnings") return fail(usage);
              if (!(await memoryClear(which))) return fail(`Refused to clear ${which}: could not archive current contents first (nothing changed).`);
              return reply({ cleared: true }, `Cleared ${which} (previous contents archived).`);
            }
            return fail(usage);
          }
          case "forget": {
            const id = rest[0];
            if (id === undefined) return fail(usage);
            const text = await forgetCrew(id, flags.has("stop"), flags.has("force"));
            return reply({ forgotten: true, id }, text);
          }
          case "migrate-state": {
            const r = await migrateState();
            const text = [
              `Migration complete: ${r.imported.length} imported, ${r.skippedExisting.length} already present, ${r.skippedSecondmate.length} secondmate routes skipped, ${r.skippedTerminal.length} terminal skipped, ${r.failed.length} failed (of ${r.total} crews).`,
              r.imported.length > 0 ? `imported: ${r.imported.join(", ")}` : "",
              r.failed.length > 0 ? `failed (host/state unreachable): ${r.failed.join(", ")}` : "",
            ]
              .filter((l) => l !== "")
              .join("\n");
            return reply({ ...r }, text);
          }
          case "migrate-owners": {
            const r = await migrateOwners();
            const text = [
              `Owner migration (real planes only):`,
              `queue: ${r.queue.projected} projected, ${r.queue.skipped} skipped`,
              `decisions: ${r.decisions.projected} projected, ${r.decisions.skipped} skipped`,
              `afk: ${r.afk ? "projected" : "off/none"}`,
              `quiet: ${r.quiet ? "projected" : "off/none"}`,
              `memory: ${r.memory ? "projected" : "off/none"}`,
            ].join("\n");
            return reply({ ...r }, text);
          }
          default:
            return fail(usage);
        }
      } catch (error) {
        return fail(error instanceof Error ? error.message : "failed");
      }
    },
  });

  bb.background.service("crew-watch", {
    async start(signal) {
      try {
        await rearmDeferredNudges();
      } catch (error) {
        bb.log.warn(error instanceof Error ? `nudge rearm: ${error.message}` : "nudge rearm failed");
      }
      while (!signal.aborted) {
        try {
          const s = await settings.get();
          if (s.supervisionEnabled === true) await stuckPass();
        } catch (error) {
          bb.log.warn(error instanceof Error ? `supervise: ${error.message}` : "supervise failed");
        }
        const s = await settings.get().catch(() => null);
        const mins = s === null ? 5 : Math.min(60, Math.max(1, Number(s.supervisionIntervalMin) || 5));
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, mins * 60000);
          signal.addEventListener(
            "abort",
            () => {
              clearTimeout(timer);
              resolve();
            },
            { once: true },
          );
        });
      }
    },
  });

  // Runs and keeps alive the real fm-watch when watchOwner=fm-watch (else idle).
  // A durable on-host keeper re-arms fm-watch (which self-terminates on an actionable
  // wake); this service ensures the keeper is alive and reads the heartbeat so
  // stuckPass can gate suppression on a live watcher — no gap.
  bb.background.service("fm-watch-supervisor", {
    async start(signal) {
      // R2 dedup memory across cycles (digit-normalized keys).
      const relaySeen = new Set<string>();
      // R3 exponential backoff for a keeper that will not STAY up (a genuine crash
      // loop) — NOT for the normal case of fm-watch exiting on a wake (the keeper
      // re-arms that on its own, so it must never trigger backoff).
      const RELAUNCH_BASE_MS = 60_000;
      const RELAUNCH_CAP_MS = 1_800_000; // 30 min
      // Hosts where a keeper was launched, so it can be torn down when the owner flips.
      // D7: seed from KV so a reload (which lost the in-memory set) still tears down a
      // keeper it started before the reload.
      let keeperHosts = new Set<string>(await loadKeeperHosts());
      // D7: teardown-when-off runs at most once per off-stretch (reset when the flag is
      // on), so a flag flip / reload-with-flag-off sweeps within one tick, but we don't
      // hammer the host every tick while it stays off.
      let sweptWhileOff = false;
      while (!signal.aborted) {
        let gate = 90;
        try {
          const s = await settings.get();
          gate = Number.isFinite(s.watchHeartbeatSec) ? Math.max(30, Math.trunc(s.watchHeartbeatSec)) : 90;
          if (s.watchOwner === "fm-watch" && s.fmHome.trim() !== "") {
            sweptWhileOff = false;
            const hosts = await resolveFmWatchHosts();
            if (hosts.length === 0) {
              bb.log.warn("fm-watch-supervisor: no host to reach fmHome (set fmHostId or dispatch a crew).");
            }
            for (const hostId of hosts) {
              const key = fmWatchBeatKey(hostId);
              const prior = fmWatchBeatSchema.safeParse(await bb.storage.kv.get(key));
              const now = Date.now();
              const backoffUntil = prior.success ? (prior.data.backoffUntil ?? 0) : 0;
              const priorStreak = prior.success ? (prior.data.consecutiveRelaunch ?? 0) : 0;
              const inBackoff = now < backoffUntil;
              const res = await superviseFmWatch(hostId, s.fmHome.trim(), gate, !inBackoff, signal);
              if (res === null) continue;
              if (!keeperHosts.has(hostId)) { keeperHosts.add(hostId); await saveKeeperHosts(keeperHosts); }
              let streak = priorStreak;
              let nextBackoff = backoffUntil;
              if (res.keeperAlive) {
                // The keeper is up and owns re-arming — reset the backoff ladder even
                // if the beat is momentarily stale (between a wake and the next re-arm).
                streak = 0;
                nextBackoff = 0;
              } else if (res.relaunched) {
                // Launched but not yet confirmed alive; if it keeps failing to stay
                // up across cycles the ladder climbs and BB pages through the gap.
                streak = priorStreak + 1;
                nextBackoff = now + Math.min(RELAUNCH_CAP_MS, RELAUNCH_BASE_MS * 2 ** (streak - 1));
              }
              await bb.storage.kv.set(key, {
                beatAge: res.beatAge,
                checkedAt: now,
                grace: gate,
                relaunched: res.relaunched,
                backoffUntil: nextBackoff,
                consecutiveRelaunch: streak,
              });
              await relayWatchReasons(extractWatchReasons(res.logTail), hostId, relaySeen);
            }
            // Legacy single-key mirror (one release): the first host's liveness, so
            // an older UI reading "fm-watch-beat" still sees a beat.
            if (hosts[0] !== undefined) {
              const mirror = await bb.storage.kv.get(fmWatchBeatKey(hosts[0]));
              if (mirror !== null && mirror !== undefined) await bb.storage.kv.set(FM_WATCH_BEAT_KEY, mirror);
            }
          } else if (!sweptWhileOff && s.fmHome.trim() !== "") {
            // watchOwner is off (or was flipped, possibly across a reload) — stop every
            // keeper we know about. D7: sweep the union of the KV-persisted set AND the
            // configured host, so a keeper started before a reload (whose in-memory
            // record the reload lost) is still torn down deterministically. Runs once
            // per off-stretch. The keeper's owner-beat self-exit is the second layer for
            // hosts we can no longer reach here.
            const toStop = new Set<string>(keeperHosts);
            const configured = await resolveFmWatchHostId();
            if (configured !== null) toStop.add(configured);
            for (const hostId of toStop) await stopFmWatchKeeper(hostId, s.fmHome.trim(), signal);
            keeperHosts = new Set<string>();
            await saveKeeperHosts(keeperHosts);
            sweptWhileOff = true;
          }
        } catch (error) {
          bb.log.warn(error instanceof Error ? `fm-watch-supervisor: ${error.message}` : "fm-watch-supervisor failed");
        }
        const checkMs = Math.max(15, Math.min(30, Math.floor(gate / 2))) * 1000;
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, checkMs);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    },
  });

  bb.onDispose(async () => {
    for (const timer of nudgeTimers.values()) clearTimeout(timer);
    nudgeTimers.clear();
    // B3(c): only stop the keeper when it SHOULD stop — i.e. when the feature is off
    // (watchOwner !== "fm-watch"). onDispose fires on a hot reload too (dispose +
    // re-init with the SAME config); stopping unconditionally there killed a healthy
    // keeper on every reload, which the next supervisor tick then re-launched — a flap
    // that left a supervision gap each reload. When watchOwner is still fm-watch we
    // leave the keeper running: the reloaded plugin re-adopts it (superviseFmWatch
    // no-ops while it is alive, keeperHosts is re-seeded from KV), and the owner-beat
    // self-exit is the backstop if the plugin never comes back. Best-effort (the host
    // may be unreachable during teardown).
    try {
      const s = await settings.get();
      const fmHome = s.fmHome.trim();
      if (fmHome !== "" && s.watchOwner !== "fm-watch") {
        const hosts = new Set<string>(await loadKeeperHosts());
        const configured = await resolveFmWatchHostId();
        if (configured !== null) hosts.add(configured);
        for (const hostId of hosts) await stopFmWatchKeeper(hostId, fmHome);
        await saveKeeperHosts(new Set<string>());
      }
    } catch {
      // best-effort; self-exit covers it
    }
    bb.log.info("disposed");
  });
}
