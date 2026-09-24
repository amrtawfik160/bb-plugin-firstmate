// bb-plugin-firstmate — firstmate-style crews native to BB.
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  afkShouldSend,
  AXI_TOOL_CONTRACT,
  CI_POLL_CONTRACT,
  bearingsText,
  capPermission,
  crewPrompt,
  decisionDue,
  classifyMetaKind,
  hasStatusProtocol,
  isWaitingYield,
  WAITING_PROTOCOL,
  idleVerdictPresentation,
  looksReadOnly,
  foldOpenDecisions,
  latestStatus,
  mergeGate,
  parseOutcome,
  verdictMarker,
  verdictOf,
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
  MAX_CREW_RELAUNCHES,
  DEFAULT_MAX_ACTIVE_CREWS,
  retryReason,
  type DeliveryMode,
  type PermissionMode,
  type ReasoningLevel,
  type Shape,
  type Verdict,
} from "./lib/policy.ts";
import { rpcContract } from "./rpc.ts";
import {
  UPSTREAM_FIRSTMATE_SHA,
  PINNED_SCRIPT_SUPPORT_FILES,
  UPSTREAM_SCRIPT_NAMES,
  UPSTREAM_SKILL_NAMES,
} from "./lib/upstream-surface.ts";
import {
  FIRSTMATE_ATTENTION_MARKER,
  FIRSTMATE_ROUTINE_MARKER,
} from "./lib/timeline-noise.ts";

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
  nativeHome: z.string().optional(),
  // F2: true = this crew was dispatched through the real transport and owns a
  // native backlog row keyed on its crew id (created backlog-first, started by
  // fm-spawn). The row is ownership, so its terminal close (done on land, rm on
  // forget) is gated on THIS recorded fact — not on live settings, which may flip
  // to native/kv mid-flight and would otherwise strand the row in_flight forever.
  backlogRow: z.boolean().optional(),
  // Recovery relaunches so far and the threads they replaced, so the stuck ladder
  // stops at its second failure and a replaced thread id still resolves.
  relaunches: z.number().optional(),
  priorThreadIds: z.array(z.string()).optional(),
  createdAt: z.string(),
});
type Crew = z.infer<typeof crewSchema>;

const queueItemSchema = z.object({
  nativeHome: z.string().optional(),
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
  // D4: the captain thread that queued this row. Scopes the backlog to its owner
  // (own-by-default in deck/bearings/session, host-wide under --all), matching how
  // crews/session already scope. Optional for back-compat: rows persisted before
  // this field are unattributed and surface only under --all.
  parentThreadId: z.string().nullish(),
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
  nativeTaskId: z.string().optional(),
  parentThreadId: z.string().nullish(),
  nativeHome: z.string().optional(),
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
  // D4: the captain thread that owned the landed crew. Scopes "Recently Landed"
  // to its owner (host-wide under --all). Optional for back-compat.
  parentThreadId: z.string().nullish(),
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
  lastEntryAt: z.string().optional(),
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
// D3: the KV afk/quiet NOTIFICATION posture is scoped PER CAPTAIN. This is the
// layer that drives notifyCaptain's doorbell/hold decision; on a shared fmHome a
// global key let one captain's afk/quiet change every other captain's doorbell
// behaviour. The suffix mirrors the durable wake plane (cap-<captain>); a missing
// captain id falls back to the legacy global key (single-captain case).
//
// F2 scope boundary: ONLY the KV posture is per-captain. The real durable away
// record (state/.afk-contract) and flag (state/.afk) stay HOST-LEVEL, because the
// native fm-watch keeper is one process per fmHome and reads those unscoped paths —
// scoping them would leave the keeper blind to every captain's posture and split
// the plugin's writes from native's reads. That is native firstmate's own one-home
// posture model; see runAfkContract/writeAfkFlag.
function captainScopeSuffix(captainThreadId: string | undefined): string {
  return captainThreadId === undefined || captainThreadId === ""
    ? ""
    : `:cap-${captainThreadId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
}
function afkKvKey(captainThreadId: string | undefined): string {
  return `${AFK_KEY}${captainScopeSuffix(captainThreadId)}`;
}
function quietKvKey(captainThreadId: string | undefined): string {
  return `${QUIET_KEY}${captainScopeSuffix(captainThreadId)}`;
}
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

// A stuck-pass MUST stop when the service is aborting (a plugin reload) — otherwise
// `bb plugin reload` fails with "service crew-watch did not stop" (the live incident,
// backlog 4c1b0ea5): stuckPass walks a host-global crew register (~50-67 crews) doing
// per-crew host round-trips, and a single pass was observed at 302.5s — far past the
// shutdown grace. The crew-watch loop already had an abortable sleep + a per-cycle
// `signal.aborted` check, but `await stuckPass()` had NO abort awareness inside, so a
// pass in flight when the reload arrived pinned the service open. These helpers make the
// awaited work abort-aware: `raceAbort` lets a call that has no native signal/timeout
// (the `bb.sdk.threads.*` reads) still return promptly on abort or a per-call timebox, so
// one slow/unreachable host cannot pin the whole pass.
const STUCK_PASS_BUDGET_MS = 120_000; // hard wall-clock ceiling for one stuckPass
// Per-crew host/SDK read timebox (matches runOnHost). NOTE: a healthy-but-slow read that
// exceeds this returns the degraded default, so crewStatus can yield "unknown" and page the
// captain "crew gone" for a crew that is actually fine — a NEW false-"gone" trigger. It is the
// safe direction (over-tell, never under-tell: a real wedge is never silently missed) and only
// fires when a read is pathologically slow, but it is recorded here so nobody debugs it cold.
const STUCK_HOST_CALL_MS = 15_000;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.message === "Aborted.");
}

function abortError(): Error {
  const error = new Error("Aborted.");
  error.name = "AbortError";
  return error;
}

// Await `promise`, but reject as soon as `signal` aborts (name "AbortError") or, if
// `timeoutMs` is given, after that timebox (a plain "Timed out." error). The underlying
// call may keep running in the background — the point is to stop AWAITING it so a service
// loop can return within the shutdown grace. A call with neither a signal nor a timeout is
// returned unchanged.
async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal, timeoutMs?: number): Promise<T> {
  if (signal === undefined && timeoutMs === undefined) return promise;
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = () => {
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };
    const onAbort = () => finish(() => reject(abortError()));
    if (signal?.aborted) {
      finish(() => reject(abortError()));
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== undefined) {
      timer = setTimeout(() => finish(() => reject(new Error("Timed out."))), timeoutMs);
    }
    promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
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

// The bb overlay never edits tracked firstmate files. Instead it installs a parallel
// "mirror bin" at <home>/bin-bb (config/bb-overlay marks it): the three dispatch scripts
// (fm-backend/fm-spawn/fm-teardown) are patched copies carrying the bb arms, and every
// other bin entry is a symlink to native, so scripts run bb-aware while the tracked tree
// stays clean and keeps fast-forwarding. This emits a shell statement that resolves
// FM_BINDIR to bin-bb when the overlay is present, else native bin — evaluated on the host
// so a home that is not bb-installed (or a pre-migration home) transparently uses bin.
function fmBinDirAssign(fmHome: string): string {
  const q = shQuote(fmHome);
  return `FM_BINDIR=${q}/bin; if [ -f ${q}/config/bb-overlay ] && [ -d ${q}/bin-bb ]; then FM_BINDIR=${q}/bin-bb; fi`;
}

// Loud staleness guard (F2). The plugin's own fast-forward (initRealMode) always
// re-mirrors, but an OUT-OF-BAND ff (a manual `git pull`, an external updater, the
// migration steps) advances HEAD without rebuilding bin-bb, leaving new sibling
// scripts unmirrored and the three frozen copies behind upstream — silently, because
// the tree still reads clean. This emits FM_MIRROR_STALE on stderr when the mirror's
// recorded HEAD no longer matches the clone's HEAD; the caller logs it loudly. A truly
// missing SCRIPT_DIR sibling surfaces on its own (the script errors, non-zero) since
// callers no longer swallow that. Wired into BOTH the dispatch paths (runFmScript,
// fm-brief scaffold) and the SUPERVISION paths (the watch keeper's per-re-arm check and
// checkWatcher's per-poll check), so a stale watcher-arm is loud too. Runs only when
// FM_BINDIR is the mirror. Cheap (~6ms: sed + git rev-parse). Must be emitted AFTER
// fmBinDirAssign.
function fmMirrorStaleGuard(fmHome: string): string {
  const q = shQuote(fmHome);
  return (
    `if [ "$FM_BINDIR" = ${q}/bin-bb ]; then ` +
    `__fm_mh=$(sed -n 's/^head=//p' ${q}/bin-bb/.mirror-manifest 2>/dev/null); ` +
    `__fm_ch=$(git -C ${q} rev-parse HEAD 2>/dev/null || true); ` +
    `if [ -n "$__fm_mh" ] && [ -n "$__fm_ch" ] && [ "$__fm_mh" != "$__fm_ch" ]; then ` +
    `echo "FM_MIRROR_STALE: bb mirror built at $__fm_mh but HEAD is $__fm_ch; re-run install-bb-backend.py --home ${fmHome}" >&2; ` +
    `fi; fi`
  );
}

// The drain hint appended to every real-mode doorbell. The durable wake queue stays the
// authoritative store; the chat doorbell is only a pointer to it, so a dropped doorbell can
// never lose the report (it survives in state/.wake-queue).
export const CAPTAIN_WAKE_DRAIN_HINT =
  "Use `firstmate_wake` with ack=true now; handle the durable report silently.";

function wakeOutputForCaptainTool(out: string): string {
  return out
    .replace(
      /(?:run|re-run) `?bb firstmate wake --ack-through (\d+) --recovery-generation ([A-Za-z0-9._-]+)`?/g,
      'call `firstmate_wake` with ackThrough=$1 and recoveryGeneration="$2"',
    )
    .replace(/(?:run|re-run) `?bb firstmate wake`?/g, 'call `firstmate_wake`');
}

// Build the real-mode (notifyOwner=real) doorbell: a compact summary carrying the crew id +
// a one-line outcome so the captain sees WHAT happened without a second `bb firstmate wake`,
// while the full report stays in the durable queue. `head` already names the crew and status
// (e.g. "✅ crew c1 done"); `summary` is the parsed outcome or a trimmed first line, or "".
// The drain hint is appended ONLY when draining surfaces something this line does not already
// carry (drainHint=true) — never as a fixed footer. For a plain done/review the head+summary
// plus the crew's own `next:` command is the complete actionable unit, so the "run bb firstmate
// wake" footer was pure repetition; it is kept for an open decision, where the decision context
// the captain must answer with genuinely lives in the durable queue, not in this one line.
export function captainWakeDoorbell(head: string, summary: string, opts?: { drainHint?: boolean }): string {
  const body = `🔔 ${head}${summary !== "" ? ` — ${summary}` : ""}`;
  return opts?.drainHint === true ? `${body}\n${CAPTAIN_WAKE_DRAIN_HINT}` : body;
}

// Every wake re-reads the captain's whole context once per model call, so the
// guidance aims for ONE call: firstmate_wake ack=true presents and acknowledges
// together. A wake that needs nothing from the captain must end with no text —
// the captain never saw the wake, so a "nothing new" reply is pure noise.
const INTERNAL_WAKE_GUIDANCE = [
  "FIRSTMATE INTERNAL WAKE — hidden from the captain. Do not quote, paraphrase, or announce it.",
  "Call firstmate_wake once with ack=true; it presents and acknowledges the durable reports in one call.",
  "Act only where a report needs action (review, merge, retry, decision). A stale line for a crew that already finished, or a crew WAITING: on an external run, needs nothing.",
  "If nothing needs the captain, end the turn with no reply text at all — never send 'nothing new', 'still in progress', or a status recap.",
  "Otherwise reply once with the concise material outcome, review item, needed decision, credential/login request, or blocker that remains after recovery.",
].join(" ");

function captainWakeInput(text: string) {
  return [{
    type: "text" as const,
    text: `${text}\n\n${INTERNAL_WAKE_GUIDANCE}`,
    mentions: [],
    visibility: "agent-only" as const,
  }];
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
const FM_WATCH_CAPTAIN_PREFIX = "fm-watch-captain:";
const CAPTAIN_PROJECT_PREFIX = "captain-project:";
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
    // Route to the bb mirror bin so the watcher this keeper arms is bb-dispatch-aware
    // (native fm-watch has no bb arm); falls back to native bin when not bb-installed.
    fmBinDirAssign(fmHome),
    `ARM="$FM_BINDIR/fm-watch-arm.sh"`,
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
    // F2 (re-review): the keeper re-arms fm-watch FROM the mirror, so a stale mirror here
    // (missing sibling / drifted copy after an out-of-band ff) would silently degrade
    // supervision — exactly the failure this effort removed. Check on every re-arm and
    // record FM_MIRROR_STALE into the watch log; checkWatcher reads that log tail and
    // surfaces it loudly. Cheap (~6ms: sed + git rev-parse).
    `  { ${fmMirrorStaleGuard(fmHome)} ; } >> "$LOG" 2>&1`,
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

// Derive the backlog row title for a crew from its task text. Native fm-spawn is
// backlog-first (every dispatched task must own a `data/backlog.md` row before a
// worker exists), so real-transport dispatch adds the row with `add <id> <title>
// --kind <shape>` before spawning. The title is the task's first non-empty line
// with any leading Captain-label stripped (normalizeCaptainIntent), capped so a
// long brief never bloats the one-line backlog entry.
export function backlogTitleOf(task: string): string {
  const intent = normalizeCaptainIntent(task.trim());
  const firstLine = (intent.split(/\r?\n/).find((l) => l.trim() !== "") ?? "").trim();
  return (firstLine === "" ? "crew task" : firstLine).slice(0, 200);
}

// Sidebar titles should identify the work at a glance while retaining the crew id
// operators use with peek/tell/deliver. The id suffix also gives real-transport
// orphan adoption a deterministic anchor during the narrow spawn-before-mark crash
// window. Keep the useful words first because BB truncates long sidebar titles.
export function crewThreadTitle(task: string, shape: Shape, crewId: string, requested?: string): string {
  const source = requested?.trim() !== "" && requested !== undefined ? requested : task;
  let subject = backlogTitleOf(source)
    .replace(/^\s{0,3}#{1,6}\s*/, "")
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^(?:crew|ship|scout)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (subject === "") subject = "Crew task";
  if (/^[a-z]/.test(subject)) subject = subject[0]!.toUpperCase() + subject.slice(1);
  const role = shape === "scout" ? "Scout" : "Ship";
  const suffix = crewId.trim();
  const fixedLength = role.length + suffix.length + 6;
  const maxSubject = Math.max(20, 100 - fixedLength);
  if (subject.length > maxSubject) subject = `${subject.slice(0, maxSubject - 1)}…`;
  return `${role} · ${subject} · ${suffix}`;
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

// Crew messages that join a captain's running turn interrupt it and duplicate the
// durable wake queue; native firstmate delivers wakes at turn boundaries. Hold
// them while the captain is mid-turn and release them as one batch at idle.
// BB's own child-status pings ("[bb system] @thread:<id> completed: …") never
// reach this hook: core delivers them through its parent-system-message path,
// which skips message.dispatch. notifyCaptainOnce handles that overlap instead.
const CREW_PING_RE = /^\s*(?:\[bb system\]\s*)?@thread:[A-Za-z0-9_-]+ (?:completed|failed|was interrupted|interrupted|needs attention)\b/i;
export function crewPingHoldDecision(input: {
  attempt: string;
  initiator: string;
  text: string;
  targetIsCaptain: boolean;
  senderIsCrew: boolean;
}): "hold" | "proceed" {
  if (input.attempt !== "join-turn" || input.initiator !== "system" || !input.targetIsCaptain) return "proceed";
  return input.senderIsCrew || CREW_PING_RE.test(input.text) ? "hold" : "proceed";
}

// BB posts its own "[bb system] @thread:<crew> completed/failed" ping to the parent
// captain ~2s after a crew's turn ends, through a core path no plugin hook can hold
// or drop. The plugin's doorbell for the same event is slower (it first persists the
// durable wake and looks up the PR). When BB's ping has already started a captain
// turn and that turn has ENDED, the doorbell would start a second full turn for news
// the captain just absorbed — so it is skipped; the durable wake row stays queued for
// the next drain. A running captain turn still takes the steer (it joins, no new
// turn), and needs-decision/interaction keep their doorbell (BB's ping lacks the
// open-decision context). Observed: ~37 duplicate captain turns across two captains.
export function doorbellSupersededByBbPing(input: {
  kind: string;
  durable: boolean;
  captainStatus: string | null;
  captainTurnStartedAt: number | null;
  crewFinishedAt: number;
}): boolean {
  if (!input.durable) return false;
  if (input.kind !== "idle" && input.kind !== "review" && input.kind !== "error") return false;
  if (input.captainStatus !== "idle") return false;
  return input.captainTurnStartedAt !== null && input.captainTurnStartedAt >= input.crewFinishedAt;
}

// BB core posts "[bb system] @thread:<crew> completed|failed" to the parent for EVERY turn
// end of a parent-notifiable child (parentThreadId set, originKind null), carrying the
// crew's final output (or the failure), and no plugin hook can hold or drop it. So for a
// turn-end outcome the plugin doorbell is always a SECOND captain wake for the same news.
// When the durable row holds the full report (the captain's stop hook will not let the turn
// end until it is drained), BB's ping is the one wake and the doorbell is skipped.
// Decisions and interactions keep their doorbell: the ping lacks that context.
export function bbPingCarriesOutcome(input: {
  kind: string;
  durable: boolean;
  captainThreadId: string;
  crewParentThreadId: string | null | undefined;
  crewOriginKind: string | null | undefined;
}): boolean {
  if (!input.durable) return false;
  if (input.kind !== "idle" && input.kind !== "review" && input.kind !== "error") return false;
  return input.crewParentThreadId === input.captainThreadId && input.crewOriginKind == null;
}

// The captain's provider limit, read from its recent thread events (newest first). A
// successful turn after the limit clears it; a `provider/rateLimits/updated` row carries
// the blocked window's reset time; a bare rate-limit `provider/error` has none.
export interface CaptainRateLimit { resetsAt: number | null; at: number }
export function captainRateLimitFromEvents(rows: ReadonlyArray<{ type: string; createdAt?: number; data?: unknown }>): CaptainRateLimit | null {
  let errAt: number | null = null;
  for (const row of rows) {
    const data = asRecordLoose(row.data);
    const at = typeof row.createdAt === "number" ? row.createdAt : 0;
    if (row.type === "turn/completed" && data["status"] === "completed") break;
    if (row.type === "provider/error" && asRecordLoose(data["errorInfo"])["category"] === "rate-limit") {
      errAt ??= at;
      continue;
    }
    if (row.type === "provider/rateLimits/updated") {
      const limits = asRecordLoose(data["rateLimits"]);
      if (limits["status"] === "blocked") {
        const windows = Array.isArray(limits["windows"]) ? limits["windows"] : [];
        const resets = windows
          .map(asRecordLoose)
          .filter((w) => w["status"] === "blocked" && typeof w["resetsAtMs"] === "number")
          .map((w) => w["resetsAtMs"] as number);
        return { resetsAt: resets.length > 0 ? Math.max(...resets) : null, at };
      }
      if (errAt === null) return null;
      break;
    }
  }
  return errAt === null ? null : { resetsAt: null, at: errAt };
}

// A limit with no known reset holds for this long after its last error.
export const CAPTAIN_LIMIT_HOLD_MS = 30 * 60_000;

// Every wake started for a captain whose provider is out of quota fails at once (observed:
// 11 failed turns in one session-limit window), and a steer into an errored captain is
// refused (HTTP 409). Hold wakes while either is true; the durable queue already keeps
// the reports, and the held lines go out as one consolidated wake once the captain is back.
export function captainWakeHold(input: { status: string | null; rateLimit: CaptainRateLimit | null; now: number }): { hold: boolean; reason: string } {
  const rl = input.rateLimit;
  if (rl !== null) {
    const until = rl.resetsAt ?? rl.at + CAPTAIN_LIMIT_HOLD_MS;
    if (until > input.now) return { hold: true, reason: `provider limit until ${new Date(until).toISOString().slice(11, 16)} UTC` };
  }
  if (input.status === "error") return { hold: true, reason: "captain thread is in error" };
  return { hold: false, reason: "" };
}

// One wake for everything held while the captain was unavailable.
export function heldWakesMessage(held: { since: number; reason: string; lines: string[] }, max = 3000): string {
  const head = `🔔 ${held.lines.length} crew update(s) held while you were unavailable (${held.reason}) since ${new Date(held.since).toISOString().slice(11, 16)} UTC:`;
  const out: string[] = [head];
  let used = head.length;
  let shown = 0;
  for (const line of held.lines) {
    const item = `- ${line.replace(/\s*\n\s*/g, " | ")}`;
    if (used + item.length + 1 > max) break;
    out.push(item);
    used += item.length + 1;
    shown++;
  }
  if (shown < held.lines.length) out.push(`- …${held.lines.length - shown} more; the durable queue has every report.`);
  out.push(CAPTAIN_WAKE_DRAIN_HINT);
  return out.join("\n");
}

function asRecordLoose(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

// Captain-facing tool outputs are re-read on every later model call of the session, so a
// 30k-character script dump costs far more than its one read. Longer outputs keep their
// head and tail inline and point at the full copy.
export const CAPTAIN_TOOL_OUTPUT_MAX = 12_000;
export function capToolOutput(text: string, fullPath: string | null, max = CAPTAIN_TOOL_OUTPUT_MAX): string {
  if (text.length <= max) return text;
  const headLen = Math.floor(max * 0.6);
  const tailLen = max - headLen;
  const where = fullPath !== null ? `full output (${text.length} chars) saved at ${fullPath}; read only the part you need` : `full output was ${text.length} chars and could not be saved; re-run with narrower arguments`;
  return `${text.slice(0, headLen)}\n\n[… ${text.length - headLen - tailLen} chars omitted — ${where} …]\n\n${text.slice(text.length - tailLen)}`;
}

// firstmate_contract by section. The full native AGENTS.md is ~90k characters; returned
// whole on every session start it dominated the captain's context. By default return the
// table of contents plus the always-on sections (identity, captain precedence); any other
// section, or "all", is one more call away, so nothing the captain needs is dropped.
export interface ContractSection { key: string; title: string; body: string }
export function contractSections(content: string): { preamble: string; sections: ContractSection[] } {
  const parts = content.split(/^(?=## )/m);
  const preamble = parts[0]!.startsWith("## ") ? "" : parts.shift()!;
  const sections = parts.map((body) => {
    const title = (body.split("\n", 1)[0] ?? "").replace(/^##\s+/, "").trim();
    const num = /^(\d+)\./.exec(title)?.[1];
    return { key: num ?? title.toLowerCase(), title, body };
  });
  return { preamble, sections };
}
export const CONTRACT_DEFAULT_SECTIONS = ["1", "captain instruction precedence"];
export function selectContract(content: string, section: string | undefined, threshold = 24_000): { text: string; complete: boolean } {
  const { preamble, sections } = contractSections(content);
  const want = (section ?? "").trim().toLowerCase();
  if (want === "all" || sections.length === 0 || (want === "" && content.length <= threshold)) return { text: content, complete: true };
  const toc = [
    "## Contract sections (call firstmate_contract with section=<number or title>; section=\"all\" returns everything)",
    ...sections.map((s) => `- ${s.title} (${s.body.length} chars)`),
    "Read the section for an area before acting in it: 7 before dispatch/validate/merge, 8 while supervising, 9 before messaging the captain.",
  ].join("\n");
  const keys = want === "" ? CONTRACT_DEFAULT_SECTIONS : want.split(",").map((k) => k.trim().replace(/^§\s*/, "").replace(/\.$/, "")).filter((k) => k !== "");
  const picked = sections.filter((s) => keys.some((k) => s.key === k || (!/^\d+$/.test(k) && s.title.toLowerCase().includes(k))));
  if (picked.length === 0) return { text: `No contract section matches "${section}".\n\n${toc}\n`, complete: false };
  return { text: `${want === "" ? preamble : ""}${toc}\n\n${picked.map((s) => s.body).join("")}`, complete: false };
}

// BB thread ids named in an fm-watch line ("stale: bb:thr_abc (idle 257s, …)").
export function watchLineThreadIds(line: string): string[] {
  return [...new Set([...line.matchAll(/\bthr_[A-Za-z0-9]+/g)].map((m) => m[0]))];
}

// fm-watch's wedge ladder treats an idle BB thread as alive, so a crew that simply
// FINISHED re-pages "possible wedge" every ~4 minutes, and a crew from another home
// (named only by thread id) was routed to whichever captain last took the deck.
// A stale line is relayed only when it names at least one known crew that is still
// running; a line naming only unknown threads is foreign and dropped. Lines that
// name no thread at all are left to the caller's fallback rules.
export function staleLineRelayDecision(input: {
  line: string;
  knownCrewThreads: ReadonlySet<string>;
  runningCrewThreads: ReadonlySet<string>;
}): "relay" | "drop-finished" | "drop-foreign" | "no-thread" {
  if (!/^stale:/.test(input.line)) return "relay";
  const ids = watchLineThreadIds(input.line);
  if (ids.length === 0) return "no-thread";
  const known = ids.filter((id) => input.knownCrewThreads.has(id));
  if (known.length === 0) return "drop-foreign";
  return known.some((id) => input.runningCrewThreads.has(id)) ? "relay" : "drop-finished";
}

// R2 dedup key. A check: line's numbers can be request ids or receipt sequences,
// so it is kept byte-for-byte. A stale: line normalizes digits only inside its
// parenthetical ("idle 257s, escalation 2"), so one wedge pages once per reason
// rather than once per rung, while crew ids outside it (which may differ only in
// digits) stay distinct. The demand-deep-inspection rung has its own wording and key.
export function watchRelayDedupKey(line: string): string {
  const flat = line.replace(/\s+/g, " ").trim();
  if (/^check:/.test(flat)) return flat;
  return flat.replace(/\(([^)]*)\)/g, (_m, inner: string) => `(${inner.replace(/\d+/g, "#")})`);
}

// Pull the ack pair out of a presented wake drain (native or rewritten form).
export function wakeAckFromOutput(out: string): { ackThrough: number; recoveryGeneration: string } | null {
  const m =
    /ackThrough=(\d+) and recoveryGeneration="([A-Za-z0-9._-]+)"/.exec(out) ??
    /--ack-through (\d+) --recovery-generation ([A-Za-z0-9._-]+)/.exec(out);
  return m ? { ackThrough: Number(m[1]), recoveryGeneration: m[2]! } : null;
}

// A long-lived captain's context only grows, and every wake re-reads all of it, so
// a 500k-token captain paid ~500k tokens per model call just to absorb a doorbell.
// Compact an idle captain once it passes the budget, at most once per cooldown.
export function captainCompactDue(input: {
  usedTokens: number | null;
  budget: number;
  lastCompactAt: number | null;
  now: number;
  cooldownMs: number;
}): boolean {
  if (!(input.budget > 0) || input.usedTokens === null || input.usedTokens < input.budget) return false;
  return input.lastCompactAt === null || input.now - input.lastCompactAt >= input.cooldownMs;
}

// Captain providers that run the user-level Stop/SessionStart hooks this plugin installs.
export const HOOKED_CAPTAIN_PROVIDERS: ReadonlySet<string> = new Set(["claude-code", "codex"]);

// Extra deck guidance for a captain whose harness skips those hooks (ACP providers
// such as Grok): nothing enforces the wake guard or runs session start there, so the
// rules the hooks would have enforced are stated explicitly.
export function unhookedCaptainNote(providerId: string): string {
  if (providerId === "" || HOOKED_CAPTAIN_PROVIDERS.has(providerId)) return "";
  return [
    `Captain harness note: this captain runs on ${providerId}, which does not load firstmate's turn-end and session-start hooks. Claude Code or Codex captains are recommended; ${providerId} works best as a crew provider.`,
    "Your only state is the firstmate_* tools. Never read bb.db, BB server logs, other captains' homes, or another project's files to reconstruct state.",
    "Report crew status only from a firstmate_crews/bearings/crew result from this turn; never from memory.",
    "On a hidden wake, call firstmate_wake with ack=true; if nothing needs the captain, end the turn with no reply text.",
  ].join("\n");
}

// The base home's root wake queue is fed by the native watcher, whose output the
// plugin relays to each owning captain; captains drain only their own partition
// (state/cap-<thread>), so nothing ever acknowledged the root rows. They piled up
// (1,824 rows in two days) and native guards then refused teardown. This acks
// root rows older than a grace window, after the relay has had them.
export function rootWakePruneScript(fmHome: string, graceSec: number): string {
  const home = `'${fmHome.replace(/'/g, `'\\''`)}'`;
  return [
    "set -u",
    `cd ${home} || exit 0`,
    "q=state/.wake-queue",
    '[ -s "$q" ] || { echo "root-wake-prune rows=0"; exit 0; }',
    `cutoff=$(( $(date +%s) - ${Math.max(60, Math.trunc(graceSec))} ))`,
    "through=$(awk -F'\\t' -v c=\"$cutoff\" '$1 < c && $2 > m { m = $2 } END { print m + 0 }' \"$q\")",
    '[ "$through" -gt 0 ] || { echo "root-wake-prune nothing-old"; exit 0; }',
    // Native drain prints the ack line promptly, then may linger; cap it.
    'out=$(FM_BACKEND=bb timeout 90 bin/fm-wake-drain.sh 2>&1 </dev/null || true)',
    "gen=$(printf '%s\\n' \"$out\" | sed -n 's/.*--recovery-generation \\([A-Za-z0-9._-]*\\).*/\\1/p' | tail -n 1)",
    '[ -n "$gen" ] || { echo "root-wake-prune no-generation"; exit 0; }',
    'FM_BACKEND=bb timeout 240 bin/fm-wake-drain.sh --ack-through "$through" --recovery-generation "$gen" >/dev/null 2>&1 </dev/null || { echo "root-wake-prune ack-failed through=$through"; exit 0; }',
    'echo "root-wake-prune through=$through left=$(awk \'END { print NR }\' "$q")"',
  ].join("\n");
}

// User-level harness hooks for captain threads (overlay/bin/bb-captain-hook.sh).
// BB captains run inside product repos, so upstream's project-level Stop and
// SessionStart hooks never load; these entries restore them, gated on a
// per-captain marker so every other thread is a silent no-op.
export const CAPTAIN_HOOK_MARK = "bb-firstmate/bin/bb-captain-hook.sh";
export function captainHookCommand(mode: "stop" | "session-start"): string {
  return `h="$HOME/.${CAPTAIN_HOOK_MARK}"; [ -n "\${BB_THREAD_ID:-}" ] && [ -x "$h" ] && exec "$h" ${mode}; exit 0`;
}
export function captainHookInstallScript(input: {
  threadId: string;
  home: string;
  state: string;
  ownHome: boolean;
  scriptB64: string;
}): string {
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const merge = (file: string, event: "Stop" | "SessionStart", mode: "stop" | "session-start", timeout: number) =>
    `f=${file}; [ -f "$f" ] || printf '{}\n' > "$f"; ` +
    `if ! jq -e --arg c ${q(captainHookCommand(mode))} 'any(.hooks.${event}[]?.hooks[]?; .command == $c)' "$f" >/dev/null 2>&1; then ` +
    `[ -f "$f.bak-bb-firstmate" ] || cp "$f" "$f.bak-bb-firstmate"; ` +
    `t=$(mktemp) && jq --arg c ${q(captainHookCommand(mode))} ` +
    `'.hooks.${event} = ((.hooks.${event} // []) + [{"hooks":[{"type":"command","command":$c,"timeout":${timeout}}]}])' "$f" > "$t" ` +
    `&& cat "$t" > "$f"; rm -f "$t"; fi`;
  return [
    "set -e",
    "command -v jq >/dev/null",
    'd="$HOME/.bb-firstmate"; mkdir -p "$d/bin" "$d/captains"',
    `printf %s ${q(input.scriptB64)} | base64 -d > "$d/bin/bb-captain-hook.sh.tmp" && chmod 0755 "$d/bin/bb-captain-hook.sh.tmp" && mv "$d/bin/bb-captain-hook.sh.tmp" "$d/bin/bb-captain-hook.sh"`,
    `printf 'home=%s\nstate=%s\nown_home=%s\n' ${q(input.home)} ${q(input.state)} ${input.ownHome ? "1" : "0"} > "$d/captains/${input.threadId}"`,
    'mkdir -p "$HOME/.claude" "$HOME/.codex"',
    merge('"$HOME/.claude/settings.json"', "Stop", "stop", 30),
    merge('"$HOME/.claude/settings.json"', "SessionStart", "session-start", 180),
    merge('"$HOME/.codex/hooks.json"', "Stop", "stop", 30),
    merge('"$HOME/.codex/hooks.json"', "SessionStart", "session-start", 180),
    "echo captain-hooks-ok",
  ].join("\n");
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
  // A native drain can spend over 30 seconds folding a busy fleet's status logs.
  // Short agent-selected budgets kill useful work and invite repeated drains.
  const minimumSec = script === "wake-drain" ? 180 : 15;
  if (overrideSec !== undefined && Number.isFinite(overrideSec)) {
    return Math.min(1800, Math.max(minimumSec, overrideSec)) * 1000;
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

function checkedDiffPaths(value: unknown): string[] {
  const files = Array.isArray(value) ? value : asRecord(value)["files"];
  if (!Array.isArray(files) || files.some(file => extractPaths([file]).length !== 1)) {
    throw new Error("Cannot verify worktree contents: invalid diff response. Crew retained.");
  }
  return extractPaths(files);
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

const CAPTAIN_SKILLS = ["captain", "firstmate", ...UPSTREAM_SKILL_NAMES] as const;
const CAPTAIN_TOOLS = [
  "firstmate_dispatch",
  "firstmate_deck",
  "firstmate_tell",
  "firstmate_interrupt",
  "firstmate_watch",
  "firstmate_contract",
  "firstmate_bearings",
  "firstmate_wake",
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
  "firstmate_scripts",
  "firstmate_toolchain",
  "firstmate_fm",
] as const;

const CAPTAIN_VISIBILITY_CONTRACT = [
  "You are the first mate. The user is the captain.",
  "Before orchestrating, read firstmate_contract and run firstmate_toolchain once per session. Missing essential dependencies block their workflows; Lavish is required only for visual work.",
  "Never do crew work in this thread; dispatch it. Parent permission is a ceiling.",
  "Captain-facing visibility follows real firstmate section 9: talk in outcomes, not mechanics.",
  "Do not narrate tool calls or surface successful bookkeeping, automatic fixes, retries, routine progress, waiting, or internal supervision mechanics.",
  "Stay silent while tools and crews run: do not send commentary or progress updates. Send one concise captain-facing response only when an outcome, review, decision, approval, credential, login, blocker, or recovered failure needs the captain.",
  "Use the native firstmate_* tool whenever it exists. Never shell out to bb firstmate or call generic command tools for routine orchestration; those rows bypass the clean captain timeline. Use firstmate_fm for real scripts that have no native tool.",
  "Never paste tool output, worker reports, status lines, or internal records. Translate them into the project outcome, consequence, and next decision.",
  "Speak when requested work finishes; work is ready for review; findings are ready; a decision, approval, credential, or login is needed; or a real blocker or failure remains after recovery.",
  "A crew wake delivered during your turn is live input: absorb it before continuing, call firstmate_wake with ack=true when it points to durable state, and repeat only if it reports more unread wakes. Treat several crew wakes as one batch and leave none queued for a later turn.",
  "Keep each captain-facing message concise. The final response must stand alone with every material outcome, consequence, needed decision, and full recorded PR URL.",
  "Your state is the firstmate_* tools and your own fmHome. Never read bb.db, BB server logs, other captains' homes, or another project's records.",
].join(" ");

const BB_SKILL_RUNTIME_CONTRACT = [
  "BB adapter for every upstream firstmate skill:",
  "keep its policy and decision rules, but execute through BB.",
  "Translate bin/fm-<name>.sh calls to firstmate_fm with script=<name> and the same arguments; use bb firstmate fm <name> only when a shell command is required.",
  "In imported skills, ../../../AGENTS.md means the complete contract returned by firstmate_contract, and ../../../bin, data, state, config, and docs refer to fmHome rather than this plugin directory.",
  "Map workers, panes, and tabs to BB crew threads via firstmate_dispatch/tell/interrupt/retry/stop. Call firstmate_watch once per batch; it hands off to private durable wakes. End the turn; never retry or poll.",
  "Use BB interactions for captain questions and approvals.",
  AXI_TOOL_CONTRACT,
  "Treat tmux, herdr, zellij, cmux, orca, and harness-specific hook setup as reference material unless the active backend explicitly names that runtime.",
].join(" ");

export function compareUpstreamScriptSurface(
  installed: readonly string[],
  query = "",
  installedSupport: readonly string[] = [],
) {
  const actual = [...new Set(installed.map((name) => normalizeFmScript(name)))].sort();
  const expected = [...UPSTREAM_SCRIPT_NAMES];
  const have = new Set(actual);
  const want = new Set<string>(expected);
  const missing = expected.filter((name) => !have.has(name));
  const extra = actual.filter((name) => !want.has(name));
  const support = [...new Set(installedSupport)].sort();
  const supportHave = new Set(support);
  const supportWant = new Set<string>(PINNED_SCRIPT_SUPPORT_FILES);
  const missingSupport = PINNED_SCRIPT_SUPPORT_FILES.filter((name) => !supportHave.has(name));
  const extraSupport = support.filter((name) => !supportWant.has(name));
  const needle = query.trim().toLowerCase();
  const matches = actual.filter((name) => needle === "" || name.includes(needle));
  return {
    sha: UPSTREAM_FIRSTMATE_SHA,
    expected: expected.length,
    installed: actual.length,
    missing,
    extra,
    matches,
    expectedSupport: PINNED_SCRIPT_SUPPORT_FILES.length,
    installedSupport: support.length,
    missingSupport,
    extraSupport,
  };
}

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
const TASKS_AXI_MIN = "0.2.6";

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
    // Same `bb:<thread>` window fm-spawn records; a bare id makes fm-watch see a new window after retry.
    `window=${input.threadId.startsWith("bb:") ? input.threadId : `bb:${input.threadId}`}`,
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

  const baseSettings = bb.settings.define({
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
      label: "Legacy contract excerpt (unused). Captains read the current full contract through firstmate_contract.",
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
    fullParityOnDeck: {
      type: "boolean",
      label: "Make /captain activate the complete real Firstmate profile: real dispatch, blocking watcher, backlog, decisions, AFK/quiet, memory, durable agent-only messaging, and read-through.",
      default: true,
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
      label: "Decisions owner: kv (BB KV list) or real (captain-held backlog tasks via fm-captain-hold.sh; answering also writes the resolved close to state/<id>.status). Native mutations must succeed before BB acknowledges them.",
      options: ["kv", "real"],
      default: "kv",
    },
    afkOwner: {
      type: "select",
      label: "AFK owner: kv (BB KV flag) or real (fm-afk-contract.sh + state/.afk-contract, so real merge/watch see the same away authority). Native mutations must succeed before BB acknowledges them.",
      options: ["kv", "real"],
      default: "kv",
    },
    quietOwner: {
      type: "select",
      label: "Quiet owner: kv (BB KV flag) or real (state/.afk flag first line = quiet, the native afk-skill quiet mode). Native mutations must succeed before BB acknowledges them.",
      options: ["kv", "real"],
      default: "kv",
    },
    memoryOwner: {
      type: "select",
      label: "Memory owner: kv (two KV blobs) or real (tiered files data/captain.md + data/learnings.md with stow markers). Native mutations must succeed before BB acknowledges them.",
      options: ["kv", "real"],
      default: "kv",
    },
    notifyOwner: {
      type: "select",
      label:
        "Crew→captain notification owner: kv (one live threads.send) or real (enqueue a durable wake, then steer an agent-only trigger into the active captain turn or start one when idle; raw crew status stays hidden and the durable queue prevents loss). /captain selects real under the full-parity profile.",
      options: ["kv", "real"],
      default: "kv",
    },
    tellOwner: {
      type: "select",
      label:
        "Captain→crew steering owner: kv (a bare threads.send) or real (write a normal durable state/<id>.inbox/NNN.msg record, steer it live, and move it to handled/ on confirmed delivery; failures remain for fm-watch recovery). A non-urgent tell may opt into queue-if-active; interrupt/stop stay hard-stops. /captain selects real under the full-parity profile.",
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
      label: "Maximum automatic turn-end re-rings for unchanged wake contents; new contents reset the budget.",
      default: 3,
    },
    captainCompactAtTokens: {
      type: "number",
      label: "Compact an idle captain thread once its context passes this many tokens (at most every 20 minutes). Every crew wake re-reads the captain's whole context, so a small captain context is the main token saving. 0 = off.",
      default: 200000,
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
    maxActiveCrews: {
      type: "number",
      label: "Max running crews per captain before dispatch refuses (0 = no cap)",
      default: DEFAULT_MAX_ACTIVE_CREWS,
    },
  });

  const knownCaptainsRef = new Set<string>();
  type HomeScope = { captain?: string; home?: string; host?: string };
  const homeScope = new AsyncLocalStorage<HomeScope>();
  const captainHomes = new Map<string, string>();
  for (const key of await bb.storage.kv.list("native-home:")) {
    const home = await bb.storage.kv.get<string>(key);
    if (typeof home === "string") captainHomes.set(key.slice("native-home:".length), home);
  }
  const settings = {
    ...baseSettings,
    async get() {
      const value = await baseSettings.get();
      const scope = homeScope.getStore();
      return scope?.home ? { ...value, fmHome: scope.home, ...(scope.host ? { fmHostId: scope.host } : {}) } : value;
    },
  };
  async function inCaptainHome<T>(captain: string | undefined, fn: () => Promise<T>): Promise<T> {
    const home = captain ? await bb.storage.kv.get<string>(`native-home:${captain}`) : null;
    const host = captain ? await bb.storage.kv.get<string>(`native-home-host:${captain}`) : null;
    if (captain && typeof home === "string") captainHomes.set(captain, home);
    return homeScope.run({ captain, home: typeof home === "string" ? home : undefined, host: typeof host === "string" ? host : undefined }, fn);
  }
  const homeProvisioners = new Map<string, Promise<string | null>>();
  async function ensureCaptainHome(ctx: unknown, signal?: AbortSignal): Promise<string | null> {
    const captain = ctxString(ctx, "threadId") ?? "";
    let provision = homeProvisioners.get(captain);
    if (!provision) {
      provision = provisionCaptainHome(ctx, signal).finally(() => homeProvisioners.delete(captain));
      homeProvisioners.set(captain, provision);
    }
    const home = await provision;
    const scope = homeScope.getStore();
    if (scope && scope.captain === captain && home) {
      scope.home = home;
      scope.host = await bb.storage.kv.get<string>(`native-home-host:${captain}`) ?? undefined;
    }
    return home;
  }
  async function provisionCaptainHome(ctx: unknown, signal?: AbortSignal): Promise<string | null> {
    const captain = ctxString(ctx, "threadId");
    const base = (await baseSettings.get()).fmHome.trim();
    if (!captain || !base) return null;
    if (!/^[A-Za-z0-9_-]+$/.test(captain)) throw new Error("Invalid captain identity.");
    const existing = await bb.storage.kv.get<string>(`native-home:${captain}`);
    if (typeof existing === "string" && existing) {
      const scope = homeScope.getStore();
      if (scope) scope.home = existing;
      return existing;
    }
    // Never detach an active away mandate from its native authority record.
    if ((await readAfk(captain))?.on) throw new Error("Return from away mode before isolating this captain's home.");
    const hostId = await resolveHostId(undefined, ctx);
    const home = `${base}-bb-homes/${captain}`;
    const clone = await runOnHost(hostId, [
      "set -eu",
      `mkdir -p ${shQuote(`${base}-bb-homes`)}`,
      `if [ ! -d ${shQuote(`${home}/.git`)} ]; then git clone --shared --no-hardlinks ${shQuote(base)} ${shQuote(home)}; fi`,
      `mkdir -p ${shQuote(`${home}/config`)} ${shQuote(`${home}/state`)} ${shQuote(`${home}/data`)}`,
      // Copy configuration once; runtime records and backlog are never inherited.
      `if [ ! -f ${shQuote(`${home}/config/bb-captain`)} ]; then`,
      `  if [ -d ${shQuote(`${base}/config`)} ]; then cp -a ${shQuote(`${base}/config/.`)} ${shQuote(`${home}/config/`)}; fi`,
      `  printf '%s\\n' ${shQuote(captain)} > ${shQuote(`${home}/config/bb-captain`)}`,
      `fi`,
    ].join("\n"), 180_000, signal);
    requireNativeSuccess(clone, "captain home initialization");
    await installBbBackend(hostId, home, ctxString(ctx, "projectId"), 180_000, signal);
    // Old worker prompts still name the old home; pin them there before activating
    // this home. Never move records underneath a running worker.
    await mutateCrews(crews => crews.map(crew => ({ ...crew, nativeHome: crew.nativeHome ?? base })));
    await writeQueue((await readQueue()).map(row => ({ ...row, nativeHome: row.nativeHome ?? base })));
    await writeDecisions((await readDecisions()).map(row => ({ ...row, nativeHome: row.nativeHome ?? base })));
    await bb.storage.kv.set(`native-home:${captain}`, home);
    captainHomes.set(captain, home);
    await bb.storage.kv.set(`native-home-host:${captain}`, hostId);
    await bb.sdk.threads.updatePluginMetadata({ threadId: captain, set: { nativeHome: home, captain: "true" } });
    const scope = homeScope.getStore();
    if (scope) scope.home = home;
    return home;
  }

  // The real firstmate skills inventory (fmHome/.agents/skills), version-pinned to
  // fmHome HEAD. BB plugins cannot register a dynamic skill root from the sync
  // configure() callback (skill ids there must resolve to statically-declared
  // manifest dirs). The pinned upstream skills are now statically bundled and
  // registered from this plugin's skill root; this live manifest remains drift
  // evidence for the installed fmHome (new/removed upstream skills). Crews still
  // get none. Refreshed on init/deck and whenever fmHome HEAD changes.
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
        "Pinned copies are registered as BB skills; this live inventory reports fmHome drift.",
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
      if (homeScope.getStore()?.home) {
        await bb.storage.kv.set(memoryCacheKey("captain-recall"), next);
        return;
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

  let crewMutation = Promise.resolve();
  async function mutateCrews(update: (crews: Crew[]) => Crew[] | Promise<Crew[]>): Promise<Crew[]> {
    const previous = crewMutation;
    let release!: () => void;
    crewMutation = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try {
      const crews = await update(await readCrews());
      await bb.storage.kv.set(CREWS_KEY, crews);
      return crews;
    } finally { release(); }
  }
  async function readCrews(): Promise<Crew[]> {
    // MAX_CREWS bounds one supervision pass, never the durable register.
    return readList(CREWS_KEY, crewSchema, Number.POSITIVE_INFINITY);
  }
  async function removeCrew(crew: Crew): Promise<void> {
    await mutateCrews(async crews => {
      // A sweep may already have read the old thread metadata. Keep a durable
      // tombstone so that result cannot resurrect an explicitly retired thread.
      await bb.storage.kv.set(`crew-retired:${crew.threadId}`, true);
      return crews.filter(c => c.id !== crew.id || c.threadId !== crew.threadId);
    });
    if (!isSecondmateRoute(crew)) {
      try {
        await bb.sdk.threads.updatePluginMetadata({ threadId: crew.threadId, set: { crew: "false" }, remove: ["crewId"] });
      } catch (error) {
        bb.log.warn(`retired crew ${crew.id}: thread metadata cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }
  async function readQueue(): Promise<QueueItem[]> {
    return readList(QUEUE_KEY, queueItemSchema, Number.POSITIVE_INFINITY);
  }
  const ledgerMutations = new Map<string, Promise<void>>();
  async function serializeLedger<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = ledgerMutations.get(key) ?? Promise.resolve();
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    ledgerMutations.set(key, pending);
    await previous;
    try { return await operation(); } finally {
      release();
      if (ledgerMutations.get(key) === pending) ledgerMutations.delete(key);
    }
  }
  function withLedgerOperation<T>(name: string, captain: string | undefined, operation: () => Promise<T>): Promise<T> {
    return ["queue", "decide", "firstmate_queue", "firstmate_decide"].includes(name)
      ? serializeLedger(`operation:${captain ?? "legacy"}`, operation)
      : operation();
  }
  async function writeQueue(items: QueueItem[]): Promise<void> {
    await serializeLedger(QUEUE_KEY, async () => {
      const owner = homeScope.getStore();
      if (owner?.home && owner.captain) {
        const foreign = (await readQueue()).filter(row => row.parentThreadId !== owner.captain);
        items = [...items.filter(row => row.parentThreadId === owner.captain), ...foreign];
      }
      await bb.storage.kv.set(QUEUE_KEY, items);
    });
  }
  async function readDecisions(): Promise<Decision[]> {
    return readList(DECISIONS_KEY, decisionSchema, Number.POSITIVE_INFINITY);
  }
  async function writeDecisions(items: Decision[]): Promise<void> {
    await serializeLedger(DECISIONS_KEY, async () => {
      const owner = homeScope.getStore();
      if (owner?.home && owner.captain) {
        const foreign = (await readDecisions()).filter(row => row.parentThreadId !== owner.captain);
        items = [...items.filter(row => row.parentThreadId === owner.captain), ...foreign];
      }
      await bb.storage.kv.set(DECISIONS_KEY, items);
    });
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
  async function readAfk(captainThreadId?: string): Promise<AfkState | null> {
    const parsed = afkSchema.safeParse(await bb.storage.kv.get<unknown>(afkKvKey(captainThreadId)));
    return parsed.success && parsed.data.on ? parsed.data : parsed.success ? parsed.data : null;
  }
  async function writeAfk(state: AfkState | null, captainThreadId?: string): Promise<void> {
    await bb.storage.kv.set(afkKvKey(captainThreadId), state);
  }
  async function readQuiet(captainThreadId?: string): Promise<QuietState> {
    const raw = await bb.storage.kv.get<unknown>(quietKvKey(captainThreadId));
    if (raw === true) return { on: true, held: [] };
    const parsed = quietSchema.safeParse(raw);
    return parsed.success ? parsed.data : { on: false, held: [] };
  }
  async function writeQuiet(state: QuietState, captainThreadId?: string): Promise<void> {
    await bb.storage.kv.set(quietKvKey(captainThreadId), state);
  }
  async function isQuiet(captainThreadId?: string): Promise<boolean> {
    return (await readQuiet(captainThreadId)).on;
  }
  function setQuiet(action: "on" | "off", captainThreadId?: string): Promise<string> {
    return withAfkTransition(() => setQuietLocked(action, captainThreadId));
  }
  async function setQuietLocked(action: "on" | "off", captainThreadId?: string): Promise<string> {
    const prev = await readQuiet(captainThreadId);
    if (action === "on") {
      await projectQuiet(true, captainThreadId);
      await writeQuiet({ on: true, held: prev.held }, captainThreadId);
      return "Quiet on";
    }
    await projectQuiet(false, captainThreadId);
    await writeQuiet({ on: false, held: [] }, captainThreadId);
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

  // Wakes held while a captain cannot take a turn (provider limit, errored thread).
  // KV-backed so a reload keeps them; released as ONE wake when the captain is back.
  const CAPTAIN_WAKE_HOLD_PREFIX = "captain-wake-hold:";
  const MAX_HELD_WAKES = 40;
  const heldWakeSchema = z.object({ since: z.number(), reason: z.string(), lines: z.array(z.string()) });
  const heldWakeLocks = new Map<string, Promise<unknown>>();
  function withHeldWakeLock<T>(captain: string, fn: () => Promise<T>): Promise<T> {
    const prev = heldWakeLocks.get(captain) ?? Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    heldWakeLocks.set(captain, run);
    void run.finally(() => { if (heldWakeLocks.get(captain) === run) heldWakeLocks.delete(captain); }).catch(() => {});
    return run;
  }
  async function captainHoldState(parentThreadId: string, signal?: AbortSignal): Promise<{ hold: boolean; reason: string; status: string | null }> {
    let status: string | null = null;
    try {
      status = (await raceAbort(bb.sdk.threads.get({ threadId: parentThreadId }), signal, STUCK_HOST_CALL_MS)).status;
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
    let rateLimit: CaptainRateLimit | null = null;
    try {
      const rows = await raceAbort(bb.sdk.threads.events.list({
        threadId: parentThreadId,
        order: "desc",
        limit: "20",
        types: ["provider/rateLimits/updated", "provider/error", "turn/completed"],
      }), signal, STUCK_HOST_CALL_MS);
      rateLimit = captainRateLimitFromEvents(Array.isArray(rows) ? rows : []);
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
    return { ...captainWakeHold({ status, rateLimit, now: Date.now() }), status };
  }
  async function holdCaptainWake(parentThreadId: string, text: string, reason: string): Promise<void> {
    await withHeldWakeLock(parentThreadId, async () => {
      const key = `${CAPTAIN_WAKE_HOLD_PREFIX}${parentThreadId}`;
      const prev = heldWakeSchema.safeParse(await bb.storage.kv.get<unknown>(key));
      const lines = [...(prev.success ? prev.data.lines : []), truncate(text, 600)].slice(-MAX_HELD_WAKES);
      await bb.storage.kv.set(key, { since: prev.success ? prev.data.since : Date.now(), reason, lines });
    });
  }
  // Release a captain's held wakes as one message once nothing holds it. Returns true when
  // a consolidated wake went out.
  async function releaseHeldCaptainWakes(parentThreadId: string, signal?: AbortSignal): Promise<boolean> {
    return withHeldWakeLock(parentThreadId, async () => {
      const key = `${CAPTAIN_WAKE_HOLD_PREFIX}${parentThreadId}`;
      const held = heldWakeSchema.safeParse(await bb.storage.kv.get<unknown>(key));
      if (!held.success) {
        if ((await bb.storage.kv.get<unknown>(key)) != null) await bb.storage.kv.delete(key);
        return false;
      }
      if (held.data.lines.length === 0) { await bb.storage.kv.delete(key); return false; }
      const state = await captainHoldState(parentThreadId, signal);
      if (state.hold) return false;
      if (!(await sendCaptainWake(parentThreadId, heldWakesMessage(held.data), "held-wakes", signal))) return false;
      await bb.storage.kv.delete(key);
      bb.log.info(`captain ${parentThreadId}: released ${held.data.lines.length} held wake(s) as one`);
      return true;
    });
  }

  // Deliver a wake to a captain, or hold it while the captain cannot take a turn. A held
  // wake counts as delivered: it is persisted and released as one consolidated wake.
  async function deliverToCaptain(parentThreadId: string, text: string, crewId: string, signal?: AbortSignal): Promise<boolean> {
    const state = await captainHoldState(parentThreadId, signal);
    if (state.hold) {
      await holdCaptainWake(parentThreadId, text, state.reason);
      bb.log.info(`captain ${parentThreadId} wake held for crew ${crewId}: ${state.reason}`);
      return true;
    }
    return sendCaptainWake(parentThreadId, text, crewId, signal);
  }

  async function sendCaptainWake(parentThreadId: string, text: string, crewId: string, signal?: AbortSignal): Promise<boolean> {
    try {
      // Abort-RESPONSIVE (no artificial timeout): a healthy send completes as before; only a
      // reload (signal abort) abandons the await so the supervisor can stop within its grace.
      // An abandoned send re-throws AbortError so the caller can DEFER (not commit the crew's
      // alerted/stuck state) and re-page next pass — the alert is never dropped.
      const result = await raceAbort(
        bb.sdk.threads.send({
          threadId: parentThreadId,
          // Upstream Firstmate wakes the active supervisor loop immediately. BB's
          // `auto` mode may queue behind that loop, which can strand a crew report
          // until the captain happens to start another turn. `steer` has the exact
          // shape we need: inject into the running turn, or start one when idle.
          // Multiple concurrent crew reports are each steered into the same turn;
          // the durable wake plane remains the ordered recovery source.
          mode: "steer",
          input: captainWakeInput(text),
        }),
        signal,
      );
      // BB queues a steer it cannot inject yet (a turn still starting, a context
      // mutation) and dispatches it as soon as the captain is ready: the wake is
      // delivered, just later, so this is not a failure.
      if (asRecord(result)["delivery"] === "queued") {
        bb.log.info(`captain ${parentThreadId} wake for crew ${crewId} queued by BB until the captain is ready`);
      }
      return true;
    } catch (error) {
      if (isAbortError(error)) throw error;
      bb.log.warn(`notify failed for crew ${crewId}: ${error instanceof Error ? error.message : String(error)}`);
      return false;
    }
  }

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
    if (captainThreadId && (captainHomes.get(captainThreadId) === fmHome || fmHome.endsWith(`-bb-homes/${captainThreadId}`))) return base;
    if (captainThreadId === undefined || captainThreadId === "") return base;
    return `${base}/cap-${captainThreadId.replace(/[^A-Za-z0-9._-]/g, "_")}`;
  }
  function wakeStateEnv(fmHome: string, captainThreadId: string | undefined): Record<string, string> {
    if (captainThreadId === undefined || captainThreadId === "") return {};
    return { FM_STATE_OVERRIDE: wakeStateDir(fmHome, captainThreadId) };
  }

  async function enqueueCaptainWake(
    crew: Crew,
    display: string,
    signal?: AbortSignal,
  ): Promise<{ durable: boolean }> {
    const fmHome = (crew.parentThreadId ? await bb.storage.kv.get<string>(`native-home:${crew.parentThreadId}`) : null) || await crewNativeHome(crew);
    if (fmHome === "" || isSecondmateRoute(crew)) return { durable: false };
    let hostId: string;
    try {
      hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined, signal);
    } catch (error) {
      if (isAbortError(error)) throw error;
      return { durable: false };
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
      `fm_lock_acquire_wait "$FM_WAKE_QUEUE_LOCK" || exit 1`,
      `fm_wake_append_locked signal ${shQuote(key)} ${shQuote(`crew ${crew.id} update`)} || { fm_lock_release "$FM_WAKE_QUEUE_LOCK"; exit 1; }`,
      `seq=$(cat ${shQuote(`${stateDir}/.wake-queue.seq`)} 2>/dev/null || true)`,
      `fm_lock_release "$FM_WAKE_QUEUE_LOCK"`,
      `printf 'FM_BB_WAKE_SEQ=%s\\n' "$seq"`,
    ].join("\n");
    try {
      const res = await runOnHost(hostId, script, 15_000, signal);
      if (res.exitCode !== 0) {
        bb.log.warn(`fm wake enqueue failed crew=${crew.id} exit=${res.exitCode}`);
        return { durable: false };
      }
      bb.log.info(`fm wake enqueued crew=${crew.id} key=${key} (note→status + pointer)`);
      return { durable: true };
    } catch (error) {
      if (isAbortError(error)) throw error;
      bb.log.warn(`fm wake enqueue failed crew=${crew.id} ${error instanceof Error ? error.message : String(error)}`);
      return { durable: false };
    }
  }

  const notificationChains = new Map<string, Promise<void>>();
  // When each captain last went active (a turn started), fed by thread.active.
  const captainTurnStartedAt = new Map<string, number>();
  async function notifyCaptain(crew: Crew, event: string, output: string | null, signal?: AbortSignal): Promise<void> {
    const crewFinishedAt = Date.now();
    const previous = notificationChains.get(crew.threadId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(() => notifyCaptainOnce(crew, event, output, signal, crewFinishedAt));
    notificationChains.set(crew.threadId, run);
    try { await run; } finally { if (notificationChains.get(crew.threadId) === run) notificationChains.delete(crew.threadId); }
  }
  async function notifyCaptainOnce(crew: Crew, event: string, output: string | null, signal?: AbortSignal, crewFinishedAt = Date.now()): Promise<void> {
    if (crew.parentThreadId === null) return;
    const parentThreadId = crew.parentThreadId;
    const deliveryKey = `captain-delivery:${crew.threadId}`;
    const signature = createHash("sha256").update(`${event}\n${output ?? ""}`).digest("hex");
    if (await bb.storage.kv.get(deliveryKey) === signature) return;
    let kind = event;
    let prUrl = "";
    const outcome = parseOutcome(output);
    // A PR can exist while the crew is blocked, failed, or still working.
    if (event === "idle" && verdictOf(outcome) === "DONE") {
      const pr = await prForCrew(crew);
      if (pr.url !== "") {
        kind = "review";
        prUrl = pr.url;
      }
    }
    const afk = await readAfk(parentThreadId);
    const quietState = await readQuiet(parentThreadId);
    const verdict = verdictOf(outcome);
    const postureEvent = kind === "idle" && (verdict === "BLOCKED" || verdict === "FAILED")
      ? "error"
      : kind === "needs-decision" ? "idle" : kind;
    const quietHold = quietState.on && !quietShouldSend(postureEvent);
    const afkHold = afk?.on === true && !afkShouldSend(postureEvent);
    // An in-band BLOCKED/FAILED ends the turn as thread.idle → kind "idle", so the
    // head/glyph/next MUST come from the PARSED VERDICT, not the raw kind — else a
    // failure renders as "✅ … done" and a FAILED crew is offered `deliver`. Only
    // the idle kind is verdict-driven; review/needs-decision/error/unknown/
    // interaction carry their own harness-signalled meaning.
    const idlePresent = kind === "idle" ? idleVerdictPresentation(crew.id, verdictOf(outcome)) : null;
    const head =
      idlePresent !== null
        ? idlePresent.head
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
    if (outcome !== null) lines.push(outcome);
    else if (output !== null && output !== "") lines.push(truncate(output.replace(/\n/g, " "), 400));
    lines.push(
      idlePresent !== null
        ? idlePresent.next
        : kind === "error"
          ? `next: bb firstmate retry|tell|forget ${crew.id}`
          : kind === "needs-decision"
            ? `next: bb firstmate tell|stop|forget ${crew.id}`
            : kind === "review"
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
    const wake = (await settings.get()).notifyOwner === "real"
      ? await enqueueCaptainWake(crew, text, signal)
      : { durable: false };
    const durable = wake.durable;
    if (durable) await bb.storage.kv.set(deliveryKey, signature);
    const summary = outcome ?? (output !== null && output !== "" ? truncate(output.replace(/\n/g, " "), 160) : "");
    // Part C: the drain hint adds something only when the durable queue holds context this
    // doorbell does not already carry — an open decision the captain must answer. For a plain
    // done/review/error the head+summary+next: line is self-sufficient.
    const doorbell = durable ? captainWakeDoorbell(head, summary, { drainHint: kind === "needs-decision" }) : text;
    // Every terminal/request outcome gets one plugin-owned live wake. Relying on a
    // parent/child transcript projection for plain DONE left the only actionable
    // copy queued behind a busy captain on some providers. The durable queue is the
    // recovery source; this concise steer is the immediate delivery source.
    if (quietHold || afkHold) {
      // The durable wake already persisted the report; do not also hold a redundant
      // doorbell (the captain drains the queue on return). KV path unchanged.
      if (durable) { await bb.storage.kv.set(deliveryKey, signature); return; }
      const evicted: string[] = [];
      if (quietHold) {
        const pushed = pushHeld(quietState.held, text);
        quietState.held = pushed.held;
        evicted.push(...pushed.evicted);
        await writeQuiet(quietState, parentThreadId);
      }
      if (afkHold && afk !== null) {
        const pushed = pushHeld(afk.held, text);
        afk.held = pushed.held;
        for (const line of pushed.evicted) {
          if (!evicted.includes(line)) evicted.push(line);
        }
        await writeAfk(afk, parentThreadId);
      }
      for (const line of evicted) await deliverToCaptain(parentThreadId, line, crew.id, signal);
      if (evicted.length > 0) await publishFleet();
      return;
    }
    if (durable && (kind === "idle" || kind === "review" || kind === "error")) {
      let crewThread: Record<string, unknown> | null = null;
      try { crewThread = asRecord(await bb.sdk.threads.get({ threadId: crew.threadId })); } catch { /* unknown: ring */ }
      if (crewThread !== null && bbPingCarriesOutcome({
        kind,
        durable,
        captainThreadId: parentThreadId,
        crewParentThreadId: typeof crewThread["parentThreadId"] === "string" ? crewThread["parentThreadId"] : null,
        crewOriginKind: typeof crewThread["originKind"] === "string" ? crewThread["originKind"] : null,
      })) {
        bb.log.info(`doorbell skipped crew=${crew.id} captain=${parentThreadId}: BB's own child ${kind === "error" ? "failed" : "completed"} message is the wake; durable wake kept`);
        await publishFleet();
        return;
      }
    }
    let captainStatus: string | null = null;
    try { captainStatus = (await bb.sdk.threads.get({ threadId: parentThreadId })).status; } catch { /* unknown: ring */ }
    if (doorbellSupersededByBbPing({
      kind,
      durable,
      captainStatus,
      captainTurnStartedAt: captainTurnStartedAt.get(parentThreadId) ?? null,
      crewFinishedAt,
    })) {
      bb.log.info(`doorbell skipped crew=${crew.id} captain=${parentThreadId}: BB's completion ping already woke the captain; durable wake kept`);
      await publishFleet();
      return;
    }
    if (await deliverToCaptain(parentThreadId, doorbell, crew.id, signal)) {
      await bb.storage.kv.set(deliveryKey, signature);
    }
    await publishFleet();
  }

  async function crewNativeHome(crew: Crew): Promise<string> {
    return crew.nativeHome ?? (await baseSettings.get()).fmHome.trim();
  }

  async function crewStatus(crew: Crew, signal?: AbortSignal): Promise<string> {
    try {
      const thread = await raceAbort(bb.sdk.threads.get({ threadId: crew.threadId }), signal, STUCK_HOST_CALL_MS);
      return threadField(thread, "status");
    } catch {
      return "unknown";
    }
  }

  async function crewOutput(crew: Crew, max = MAX_OUTPUT, signal?: AbortSignal): Promise<string | null> {
    try {
      const result = await raceAbort(bb.sdk.threads.output({ threadId: crew.threadId }), signal, STUCK_HOST_CALL_MS);
      const text = asRecord(result)["output"];
      return typeof text === "string" ? truncate(text, max) : null;
    } catch {
      return null;
    }
  }

  async function threadEnv(threadId: string, signal?: AbortSignal): Promise<string | null> {
    try {
      const thread = await raceAbort(bb.sdk.threads.get({ threadId }), signal, STUCK_HOST_CALL_MS);
      const envId = asRecord(thread)["environmentId"];
      return typeof envId === "string" ? envId : null;
    } catch {
      return null;
    }
  }

  // The crew kind the fold must terminal-collapse under, resolved the way native
  // `_fm_status_kind` does — NOT hardcoded. Native reads the crew's sibling
  // state/<id>.meta and classifies a metaless/unreadable/symlink meta as
  // `unknown` (which does NOT collapse); hardcoding `ship` would collapse
  // decisions native keeps open on the 58% of live crews that have no `.meta`,
  // SUPPRESSING a real captain call. A secondmate route never collapses. Without
  // an fmHome there is no native plane to mirror, so trust the crew's own shape.
  async function foldKind(crew: Crew, hostId?: string): Promise<string> {
    if (isSecondmateRoute(crew)) return "secondmate";
    const fmHome = await crewNativeHome(crew);
    if (fmHome === "") return crew.shape;
    try {
      const hid = hostId ?? (await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined));
      const meta = shQuote(`${fmHome}/state/${crew.id}.meta`);
      // Native requires a regular, readable, non-symlink meta; anything else is
      // `unknown`. exit 3 = that absent/rejected case; a clean cat = the content.
      const res = await runOnHost(
        hid,
        `if [ -f ${meta} ] && [ -r ${meta} ] && [ ! -L ${meta} ]; then cat -- ${meta}; else exit 3; fi`,
        15_000,
      );
      if (res.exitCode === 3) return classifyMetaKind(null);
      if (res.exitCode !== 0) return "unknown"; // unreadable → native `unknown`
      return classifyMetaKind(res.output);
    } catch {
      return "unknown";
    }
  }

  // A crew's append-only status stream + the kind to fold it under. When real
  // mode is active the authoritative source is the on-host state/<id>.status file
  // the worker appends to (folded under the kind native reads from the sibling
  // .meta); otherwise (native path, or an unreachable host) fall back to the
  // status-protocol lines the crew emitted in its BB chat output (its own shape,
  // or `secondmate` for a secondmate route).
  async function crewStatusLines(
    crew: Crew,
    output?: string | null,
  ): Promise<{ lines: string[]; kind: string }> {
    const fmHome = await crewNativeHome(crew);
    if (fmHome !== "" && !isSecondmateRoute(crew)) {
      try {
        const hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
        const path = `${fmHome}/state/${crew.id}.status`;
        const res = await runOnHost(hostId, `[ -f ${shQuote(path)} ] && cat -- ${shQuote(path)} || true`, 15_000);
        if (res.exitCode === 0 && res.output.trim() !== "") {
          return { lines: res.output.split(/\r?\n/), kind: await foldKind(crew, hostId) };
        }
      } catch {
        // fall through to chat output
      }
    }
    const kind = isSecondmateRoute(crew) ? "secondmate" : crew.shape;
    return { lines: statusLinesFrom(output === undefined ? await crewOutput(crew) : output), kind };
  }

  // Close a crew's open keyed decision when the captain answers it. Native
  // firstmate writes the closing `resolved [key=...]` line via `fm send
  // --resolve-key`; the BB plugin's steer is a plain thread message, so without
  // this the on-host state/<id>.status keeps the decision open forever (and
  // `crew <id>` reads it as stale). Best-effort, real-mode only; a bad key or an
  // unreachable host is a silent no-op — the steer message itself still lands.
  async function appendResolvedStatus(crew: Crew, key: string, note: string): Promise<boolean> {
    const fmHome = await crewNativeHome(crew);
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
    const fmHome = await crewNativeHome(input.crew);
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
    const fmHome = await crewNativeHome(crew);
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
    // fm-brief.sh is resolved to "$FM_BINDIR/fm-brief.sh" (the bb mirror bin when the
    // overlay is installed) inside the host script below.
    const briefRef = `"$FM_BINDIR/fm-brief.sh"`;
    // Strip a leading Captain-label/address line so native fm-spawn.sh's
    // fm_brief_intent_address_line does not refuse the brief (B1).
    const intentB64 = Buffer.from(normalizeCaptainIntent(task.trim()).slice(0, 3000), "utf8").toString("base64");
    // fm-brief refuses --mode on scouts and requires it on ships; a ship's posture
    // is exactly the delivery mode the brief records.
    const scaffold =
      crew.shape === "scout"
        ? `${briefRef} ${shQuote(crew.id)} crew --scout`
        : `${briefRef} ${shQuote(crew.id)} crew --mode ${shQuote(crew.posture)}`;
    const py =
      "import base64,os,sys;p=sys.argv[1];" +
      'intent=base64.b64decode(os.environ["FM_INTENT"]).decode();' +
      'spec="Implement the captain\'s intent above exactly; do not widen scope. Small diff, own branch, deliver per the mode contract, then report DONE/BLOCKED/FAILED.";' +
      "s=open(p).read();s=s.replace('{TASK}',intent).replace('{FIRSTMATE_SPEC}',spec);open(p,'w').write(s)";
    const script = [
      `export FM_HOME=${shQuote(fmHome)}`,
      `export FM_ROOT=${shQuote(fmHome)}`,
      fmBinDirAssign(fmHome),
      fmMirrorStaleGuard(fmHome),
      `[ -f ${briefRef} ] || exit 0`,
      `[ -f ${shQuote(brief)} ] && exit 0`,
      // F2: do NOT `>/dev/null 2>&1 || exit 0` here — that swallowed a stale-mirror
      // failure (e.g. a missing SCRIPT_DIR sibling in bin-bb) whole. Capture the
      // scaffold's stderr and surface it so publishFmBrief logs it (best-effort still:
      // the crew already has the structured prompt, so a failure only logs, not throws).
      `if ! __fm_err=$(${scaffold} 2>&1); then echo "fm-brief scaffold failed: $__fm_err" >&2; exit 1; fi`,
      `FM_INTENT=${intentB64} python3 -c ${shQuote(py)} ${shQuote(brief)} || { echo "fm-brief fill failed" >&2; exit 1; }`,
    ].join("\n");
    try {
      const res = await runOnHost(host, script, 30_000);
      if (res.output.includes("FM_MIRROR_STALE")) {
        const line = res.output.split("\n").find((l) => l.includes("FM_MIRROR_STALE"))?.trim() ?? "FM_MIRROR_STALE";
        bb.log.error(`bb mirror is STALE while scaffolding brief crew=${crew.id}: ${line}. Re-run the overlay installer against ${fmHome}.`);
      }
      if (res.exitCode !== 0) {
        bb.log.warn(`fm brief scaffold failed crew=${crew.id} exit=${res.exitCode}: ${res.output.trim().slice(-400)}`);
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
    const fmHome = await crewNativeHome(crew);
    if (fmHome === "") return;
    let hostId: string;
    try {
      hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
    } catch (error) {
      throw new Error(`Cannot remove native metadata for ${crew.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const dest = `${fmHome}/state/${crew.id}.meta`;
    try {
      const result = await runOnHost(hostId, `rm -f ${shQuote(dest)}`, 15_000);
      if (result.exitCode !== 0) {
        throw new Error(`exit ${result.exitCode}`);
      }
    } catch (error) {
      throw new Error(`Native metadata cleanup failed for ${crew.id}; crew retained for retry: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // True when a crew already has an authoritative state/<id>.meta on its host.
  // Used by the migration so it never overwrites the real state of active work.
  async function fmMetaExists(crew: Crew): Promise<boolean | null> {
    const fmHome = await crewNativeHome(crew);
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
  async function readFmMetaField(hostId: string, crewId: string, key: string, home?: string): Promise<string | null> {
    const fmHome = home ?? (await settings.get()).fmHome.trim();
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
  // thread title suffix ` · <taskId>` (legacy `fm-<taskId>` is also accepted) or
  // the crewId recorded by `mark-crew --task`. Only
  // threads not already tracked as crews are considered, so this never steals a
  // live crew's thread. Returns the thread id to adopt, or null.
  async function findOrphanThreadForTask(taskId: string): Promise<string | null> {
    const known = new Set((await readCrews()).map((c) => c.threadId).filter((t) => t !== ""));
    const legacyTitle = `fm-${taskId}`;
    const titleSuffix = ` · ${taskId}`;
    // R4: the orphan is created by the `bb thread spawn` CLI inside fm-spawn and
    // tagged by a SEPARATE `bb firstmate mark-crew` call. In the SIGKILL window
    // between those two, BB may not yet attribute originPluginId=firstmate to the
    // thread, so a filtered list would miss it. Do a filtered pass first (cheap),
    // then, only if it finds nothing, a broad unfiltered pass — both matched by
    // the deterministic task-id suffix (set by the overlay at spawn time), its
    // legacy `fm-<taskId>` prefix, or the crewId metadata. This makes adoption
    // independent of the origin filter.
    const match = async (rows: unknown[]): Promise<string | null> => {
      for (const row of rows) {
        const rec = asRecord(row);
        const tid = rec["id"];
        if (typeof tid !== "string" || known.has(tid)) continue;
        const title = rec["title"];
        if (
          typeof title === "string"
          && (title.endsWith(titleSuffix) || title === legacyTitle || title.startsWith(`${legacyTitle} `))
        ) return tid;
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
      // Leave dispatch refused when orphan discovery is unavailable.
    }
    return null;
  }

  // The real transport swap: dispatch a crew end-to-end through the real
  // fm-brief.sh + fm-spawn.sh (backend=bb) so the real scripts create the brief,
  // the worktree, the thread and state/<id>.meta — with harness/provider/model/
  // effort all threaded into the BB thread. Returns the thread id the real spawn
  // created; failures remain refusals. Never double-spawns: if a bb_thread_id
  // is already recorded (even on a later partial failure) that id is returned.
  async function dispatchViaRealTransport(
    crew: Crew,
    input: {
      task: string;
      projectId: string;
      parentThreadId?: string;
      title?: string;
      permissionMode?: PermissionMode;
    },
    hostId: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const fmHome = await crewNativeHome(crew);
    if (fmHome === "") return null;
    // A crew may already carry a real thread (idempotent re-dispatch). Never spawn twice.
    const existing = await readFmMetaField(hostId, crew.id, "bb_thread_id", await crewNativeHome(crew));
    if (existing !== null && existing !== "") return existing;
    // C1: native fm-spawn.sh is BACKLOG-FIRST — it refuses a task with no
    // `data/backlog.md` row ("task <id> has no backlog item in this home, so
    // dispatching it would leave a worker no record owns"), because the row is what
    // owns the worker. Creating and owning that row is the queue plane's job, so
    // real transport REQUIRES queueOwner=real: only then can the plugin add the row
    // before spawning and drive its done/rm on land/forget. Without it the two
    // planes disagree and dispatch must stop at the ownership boundary.
    if (!(await queueIsReal())) {
      bb.log.error(
        `real transport requires queueOwner=real: native fm-spawn.sh refuses to dispatch a task with no backlog record, and only queueOwner=real lets the plugin create+own that row (add <id> --kind <shape>, then done/rm on land/forget). queueOwner is currently kv — set queueOwner=real in the Firstmate plugin settings. Dispatch refused for crew=${crew.id}.`,
      );
      throw new Error("Real transport requires queueOwner=real.");
    }
    const projectDir = await projectCheckoutPath(input.projectId);
    if (projectDir === null || projectDir === "") {
      throw new Error(`No project checkout for real dispatch ${crew.id}.`);
    }
    // C2: a ship whose delivery mode carries less rigor than the project's native
    // standing posture makes fm-spawn print an advisory deviation notice. We do NOT
    // write a plugin-side "intake judgement" onto the brief: any fixed text the
    // plugin can synthesize is boilerplate that merely attests an instruction
    // exists (and would be untrue for a mode like local-only, which has no PR). The
    // honest record is native's own stderr notice, which we leave intact — the
    // plugin never suppresses it. The mode itself already reconciles with native:
    // fm-brief records the "Delivery contract: mode=" line and fm-spawn refuses a
    // mismatch, so brief/spawn/backlog agree on the mode the captain dispatched.
    // Scaffold the authoritative brief first — a ship spawn reads its recorded
    // "Delivery contract: mode=" line and refuses a mismatch, so the brief must
    // exist (with the right mode) before fm-spawn.sh runs.
    await publishFmBrief(crew, hostId, input.task);
    // C1: create the backlog row (id = crew id, so meta/brief/backlog/thread all
    // agree) BEFORE spawning. tasks-axi add is idempotent (repeat returns
    // ok/already), so a retry or a queue-dispatched crew whose row already exists
    // is a no-op. fm-spawn.sh performs the queued→In-flight start itself once its
    // endpoint exists; the plugin only seeds the queued row and later closes it.
    const backlogAdd = await projectQueueAdd(crew.id, backlogTitleOf(input.task), crew.shape, input.projectId);
    if (!backlogAdd.ok) {
      throw new Error(`Backlog add failed for ${crew.id}; repair tasks-axi before dispatching a worker.`);
    }
    // D5: emit a positive signature for the backlog-FIRST step, paired with the
    // `real transport spawn crew=<id> ok` line the spawn emits below. Together they
    // let a captain (and acceptance) SEE that the row was seeded before the spawn,
    // rather than inferring the ordering from a successful spawn with no fallback.
    bb.log.info(`real transport backlog add crew=${crew.id} ok`);
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
    const env: Record<string, string> = {
      FM_BB_THREAD_TITLE: crewThreadTitle(input.task, crew.shape, crew.id, input.title),
    };
    if (crew.providerId !== null && crew.providerId !== "") env.FM_BB_PROVIDER = crew.providerId;
    if (capped !== undefined) env.FM_BB_PERMISSION_MODE = capped;
    let spawnFailed = false;
    let spawnFailure = "Native spawn returned without a recorded worker.";
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
        spawnFailure = `fm-spawn exit ${res.exitCode}: ${res.output.slice(-2000)}`;
        // LOUD (B1): a non-zero fm-spawn exit (e.g. the brief-refusal that made every
        // real spawn fail) must be an error, not a muffled warn.
        bb.log.error(`real transport spawn crew=${crew.id} exit=${res.exitCode} ${res.output.slice(0, 600)}`);
      } else {
        bb.log.info(`real transport spawn crew=${crew.id} ok`);
      }
    } catch (error) {
      spawnFailed = true;
      spawnFailure = error instanceof Error ? error.message : String(error);
      bb.log.warn(`real transport spawn crew=${crew.id} ${error instanceof Error ? error.message : String(error)}`);
    }
    // Even on a non-zero exit, a thread may already exist — read the meta and
    // honour it rather than native-spawning a duplicate.
    const threadId = await readFmMetaField(hostId, crew.id, "bb_thread_id", await crewNativeHome(crew));
    if (threadId !== null && threadId !== "") return threadId;
    // No recorded thread. fm-spawn may still have created one and been hard-killed
    // before writing bb_thread_id. Adopt that orphan instead of native-spawning a
    // duplicate; only when none exists do we fall back to native (return null).
    const orphan = await findOrphanThreadForTask(crew.id);
    if (orphan !== null) {
      bb.log.info(`real transport adopted orphan thread ${orphan} for crew=${crew.id} (fm-spawn left no bb_thread_id; spawnFailed=${spawnFailed})`);
      return orphan;
    }
    // Native retains queued work when policy refuses a spawn (for example an AFK cap).
    // Keep that row available for reconciliation instead of deleting it and bypassing the gate.
    throw new Error(`${spawnFailure} Task ${crew.id} remains in the native backlog.`);
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
    const crews = (await readCrews()).filter(crew => !homeScope.getStore()?.captain || crew.parentThreadId === homeScope.getStore()?.captain);
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
        await mutateCrews(crews => crews.map((c) => (c.id === crew.id ? { ...c, metaWritten: undefined } : c)));
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
  async function migrateOwners(captainThreadId?: string): Promise<{
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
        if (homeScope.getStore()?.home && (item.parentThreadId !== captainThreadId || (item.nativeHome && item.nativeHome !== fmHome))) continue;
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
        if (homeScope.getStore()?.home && (d.parentThreadId !== captainThreadId || (d.nativeHome && d.nativeHome !== fmHome))) continue;
        if (d.status === "answered") { out.decisions.skipped++; continue; }
        if (d.status === "deferred") await projectDecisionDefer(d, d.deferredUntil);
        else await projectDecisionAsk(d);
        out.decisions.projected++;
      }
    }

    if (await afkIsReal()) {
      const afk = await readAfk(captainThreadId);
      if (afk?.on === true) { await projectAfkOn(afk.words, [], captainThreadId); out.afk = true; }
    }
    if (await quietIsReal()) {
      if ((await readQuiet(captainThreadId)).on) { await projectQuiet(true, captainThreadId); out.quiet = true; }
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

  // Compare commit reachability, not changed files or the existence of a PR.
  // A crew can commit again after opening a PR, including an empty commit.
  async function committedUnpushedCommits(envId: string): Promise<string[]> {
    const env = asRecord(await bb.sdk.environments.get({ environmentId: envId }));
    const base =
      (typeof env["mergeBaseBranch"] === "string" && env["mergeBaseBranch"]) ||
      (typeof env["defaultBranch"] === "string" && env["defaultBranch"]) ||
      (typeof env["baseBranch"] === "string" && env["baseBranch"]) || null;
    const host = env["hostId"];
    const path = env["path"];
    if (!base || typeof host !== "string" || !host || typeof path !== "string" || !path) {
      throw new Error("Cannot verify committed work: environment has no host, path, or base branch.");
    }
    // The base permits clean local-only worktrees without a remote. Use local
    // remote-tracking refs; teardown does not fetch or require network access.
    const result = await runOnHost(host,
      `git -C ${shQuote(path)} rev-list --max-count=20 HEAD --not --remotes ${shQuote(base)} --`, 15_000);
    if (result.exitCode !== 0) throw new Error("Cannot verify committed work: Git reachability check failed. Crew retained.");
    const commits = result.output.trim().split(/\r?\n/).filter(Boolean);
    if (commits.some(sha => !/^[a-f0-9]{40,64}$/.test(sha))) {
      throw new Error("Cannot verify committed work: invalid Git response. Crew retained.");
    }
    return commits;
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

  // Host-wide crew list: the shared KV register PLUS a sweep of every firstmate-origin
  // thread on the host, and (opt-in) real state/<id>.meta read-through reconciliation.
  // This is the register + eviction machinery and MUST stay host-wide — the supervisor's
  // stuck-pass, read-through teardown and every by-id lookup depend on seeing all crews.
  // Captain-facing VIEWS never call this directly; they call listCrews({ owner }) so one
  // captain never sees another's crews by default (D8). Write/eviction is unchanged: the
  // owner filter is a pure view over the returned array, applied after all KV writes.
  async function listCrewsAll(signal?: AbortSignal): Promise<Crew[]> {
    let crews = await readCrews();
    const known = new Set(crews.map((c) => c.threadId));
    try {
      const savedOffset = await bb.storage.kv.get<unknown>("crew-recovery-offset");
      const offset = typeof savedOffset === "number" && Number.isSafeInteger(savedOffset) && savedOffset >= 0 ? savedOffset : 0;
      // Abort-aware + timeboxed prologue: the supervisor calls this BEFORE its per-crew
      // abort loop, so an un-guarded threads.list / getPluginMetadata sweep here (host
      // round-trips, worse under a degraded BB API) would pin crew-watch past the shutdown
      // grace on a reload — the same "service did not stop" class we are fixing.
      const found = await raceAbort(
        bb.sdk.threads.list({
          originPluginId: "firstmate",
          includeHidden: true,
          limit: 50,
          offset,
        }),
        signal,
        STUCK_HOST_CALL_MS,
      );
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
        );
      const recovered = await Promise.all(
        missing.map(async (row): Promise<Crew | null> => {
          try {
            const meta = asRecord(
              await raceAbort(
                bb.sdk.threads.getPluginMetadata({ threadId: row.threadId, pluginId: "firstmate" }),
                signal,
                STUCK_HOST_CALL_MS,
              ),
            );
            if (!metaFlag(meta, "crew")) return null;
            const id = typeof meta["crewId"] === "string" ? meta["crewId"] : row.threadId.slice(0, 8);
            return {
              id,
              nativeHome: typeof meta["nativeHome"] === "string" ? meta["nativeHome"] : (await baseSettings.get()).fmHome.trim(),
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
      if (recovered.some(c => c !== null)) {
        crews = await mutateCrews(async current => {
          for (const crew of recovered) {
            if (crew !== null && !current.some(c => c.id === crew.id) &&
                await bb.storage.kv.get(`crew-retired:${crew.threadId}`) !== true) current.push(crew);
          }
          return current;
        });
      } else crews = await readCrews();
      // One bounded page per pass; new threads reset the order, so wrap after
      // the last page instead of permanently stranding older metadata.
      if (!signal?.aborted) await bb.storage.kv.set("crew-recovery-offset", rows.length === 50 ? offset + 50 : 0);
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
        const hostId = await resolveFmWatchHostId(signal);
        if (hostId !== null) {
          const ids = await existingFmMetaIds(hostId, s.fmHome.trim(), signal);
          if (ids !== null) {
            // R5: never reap a crew whose dispatch-time meta write is known to have
            // failed (metaWritten===false) — its current absence is not proof of
            // teardown. Secondmate routes have no meta and are always exempt.
            const kept = crews.filter((c) => isSecondmateRoute(c) || (c.nativeHome ?? (s.fmHome.trim())) !== s.fmHome.trim() || ids.has(c.id) || c.metaWritten === false);
            if (kept.length !== crews.length) {
              for (const gone of crews) {
                if (!kept.includes(gone)) {
                  bb.log.info(`read-through: crew ${gone.id} dropped (no real state/<id>.meta)`);
                  await markQueueForCrew(gone.id, "done").catch(() => {});
                }
              }
              const removed = crews.filter(c => !kept.includes(c));
              return mutateCrews(current => current.filter(c => !removed.some(gone =>
                gone.id === c.id && gone.threadId === c.threadId && c.metaWritten !== false)));
            }
          }
        }
      }
    } catch {
      // reconciliation is best-effort; the KV cache still serves
    }
    return crews;
  }

  // Captain-facing view over listCrewsAll. By default (an `owner` captain thread id is
  // supplied) it returns ONLY that captain's crews (parentThreadId === owner), so `crews`,
  // bearings, deck, session and the @crew mention menu never show another captain's work.
  // `all: true` is the explicit opt-in that returns the whole host (e.g. `crews --all`).
  // Omitting `owner` (no calling captain, e.g. an internal by-id lookup) also returns the
  // whole host — this is a read-only view; the shared register and its eviction are untouched.
  async function listCrews(opts?: { owner?: string; all?: boolean }): Promise<Crew[]> {
    const crews = await listCrewsAll();
    if (opts?.all === true) return crews;
    const owner = opts?.owner;
    if (owner === undefined || owner === "") return crews;
    return crews.filter((c) => c.parentThreadId === owner);
  }

  // Dispatch ceiling per captain: past it, the captain queues instead of fanning
  // out. Returns the refusal text, or null when there is room for `adding` more.
  async function crewCapRefusal(parentThreadId: string | undefined, adding: number): Promise<string | null> {
    if (parentThreadId === undefined) return null;
    const raw = (await settings.get()).maxActiveCrews;
    const cap = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : DEFAULT_MAX_ACTIVE_CREWS;
    if (cap === 0) return null;
    const mine = (await listCrews({ owner: parentThreadId })).filter((c) => !isSecondmateRoute(c));
    const statuses = await Promise.all(mine.map((c) => crewStatus(c)));
    const running = statuses.filter((st) => st === "active" || st === "pending").length;
    if (running + adding <= cap) return null;
    return `Crew cap reached: ${running} crews running (cap ${cap}). Queue this with firstmate_queue and dispatch when a crew finishes, or ask the captain to raise the cap.`;
  }

  // An owner-scoped crew view that comes back empty must never read as "the fleet is empty":
  // a captain running `crews` from a DIFFERENT thread than the one that dispatched would
  // otherwise see a bare "No crews." and mistake a scoping artifact for an empty fleet. When
  // the scoped view is empty but the host has crews under other threads/captains, say so and
  // name the opt-in. `owner` undefined / `all` true means the view was already host-wide, so a
  // plain "No crews." is the truth.
  async function noCrewsMessage(owner: string | undefined, all: boolean): Promise<string> {
    if (all || owner === undefined || owner === "") return "No crews.";
    const hostCount = (await listCrews({ all: true })).length;
    if (hostCount === 0) return "No crews.";
    return (
      `No crews dispatched from this thread. This view is scoped to your own crews; ` +
      `${hostCount} crew(s) on this host belong to other threads/captains — pass --all ` +
      `(all=true from a tool) to see the whole host.`
    );
  }

  // Accept a crew id, or any thread id the crew has run on: captains often only
  // hold the thread id from a completion ping.
  async function findCrew(id: string): Promise<Crew | undefined> {
    const all = await listCrewsAll();
    return all.find((entry) => entry.id === id)
      ?? all.find((entry) => entry.threadId === id || (entry.priorThreadIds ?? []).includes(id));
  }

  async function findCrewByThread(threadId: string): Promise<Crew | undefined> {
    return (await listCrewsAll()).find((entry) => entry.threadId === threadId);
  }

  // `verdict` is the crew's self-reported terminal verdict (DONE/BLOCKED/FAILED),
  // when known: an idle thread status alone cannot tell a done ship from a blocked
  // or failed one, so pass the parsed verdict to render a distinct inline marker.
  function formatCrew(crew: Crew, status: string, verdict?: Verdict | null): string {
    const mark = verdict != null ? ` ${verdictMarker(verdict)}` : "";
    return `${crew.id} [${status}]${mark} ${crew.shape} ${crew.threadId} ${crew.worktree ? "worktree" : "shared-env"} :: ${truncate(crew.task, 80)}`;
  }

  async function resolveHostForProject(projectId: string, parentThreadId?: string, signal?: AbortSignal): Promise<string> {
    if (parentThreadId !== undefined) {
      const envId = await threadEnv(parentThreadId, signal);
      if (envId !== null) {
        try {
          const env = await raceAbort(bb.sdk.environments.get({ environmentId: envId }), signal, STUCK_HOST_CALL_MS);
          const hostId = asRecord(env)["hostId"];
          if (typeof hostId === "string" && hostId !== "") return hostId;
        } catch {
          // fall through to project environments
        }
      }
    }
    const listed = await raceAbort(bb.sdk.environments.list({ projectId }), signal, STUCK_HOST_CALL_MS);
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
    // Optional caller-owned crew id. The queue passes its item id so the crew,
    // its native backlog row, brief, meta and thread all share ONE id (C1) — no
    // second backlog row for one piece of work. Omitted → a fresh random id.
    crewId?: string;
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
        await mutateCrews(crews => [routed, ...crews]);
        return routed;
      } catch (error) {
        throw new Error(`Secondmate route to ${mate.threadId} failed; delivery may be uncertain. Reconcile that handoff before retrying: ${String(error)}`);
      }
    }
    const crew: Crew = {
      nativeHome: (await settings.get()).fmHome.trim(),
      id: input.crewId !== undefined && input.crewId !== "" ? input.crewId : randomUUID().slice(0, 8),
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
    // Real mode delegates policy to native; a refusal cannot select a less strict transport.
    const cur = await settings.get();
    const scheduledFuture = input.sendAt !== undefined && input.sendAt > Date.now();
    if (cur.transport === "real") {
      if (cur.fmHome.trim() === "") throw new Error("Real transport needs fmHome. Run init --real before dispatch.");
      if (scheduledFuture) throw new Error("Real transport does not support sendAt. Queue the task with waitUntil instead.");
      try {
        const rtHost = await resolveHostForProject(input.projectId, input.parentThreadId);
        const realThreadId = await dispatchViaRealTransport(
          crew,
          { task: input.task, projectId: input.projectId, parentThreadId: input.parentThreadId,
            title: input.title, permissionMode: input.permissionMode },
          rtHost,
        );
        if (realThreadId !== null && realThreadId !== "") {
          crew.threadId = realThreadId;
          // F2: a returned thread id means the backlog-first add succeeded and
          // fm-spawn started the row — record that this crew owns a real row so its
          // close survives a later settings flip.
          crew.backlogRow = true;
          await mutateCrews(crews => [crew, ...crews.filter(c => c.id !== crew.id)]);
          await publishFleet();
          // fm-spawn ran ~30s while this crew may already have ended its first turn;
          // its thread.idle/failed fired before this record carried the threadId and
          // was dropped. Now that the record exists, catch that missed terminal.
          await reconcileCrewTerminal(crew).catch(() => {});
          // The real fm-spawn.sh already wrote state/<id>.meta + the brief; the
          // native publishFmMeta/publishFmBrief backfills would only duplicate.
          return crew;
        }
        throw new Error(`Native dispatch produced no recorded worker for ${crew.id}; reconcile that task before retrying.`);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        bb.log.error(`real transport refused crew=${crew.id}: ${reason}`);
        throw new Error(`Real dispatch ${crew.id} stopped: ${reason}`);
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
      title: crewThreadTitle(task, input.shape, crew.id, input.title),
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
        nativeHome: crew.nativeHome ?? "",
        task: task.slice(0, 500),
        shape: input.shape,
        posture: crew.posture,
        worktree: input.worktree,
      },
    });
    crew.threadId = threadIdOf(spawned);
    await mutateCrews(crews => [crew, ...crews.filter(c => c.id !== crew.id)]);
    await publishFleet();
    const scheduled = input.sendAt !== undefined && input.sendAt > Date.now();
    const okMeta = await publishFmMeta({ crew, hostId, scheduled, model: input.model, provider: input.providerId });
    // R5: only record a known-failed write. undefined (write succeeded, or real
    // mode is off) stays reapable; false marks "meta write failed, do not reap on
    // absence" so read-through can't reap a live crew whose meta never landed.
    if ((await settings.get()).fmHome.trim() !== "" && !okMeta) {
      crew.metaWritten = false;
      await mutateCrews(crews => crews.map((c) => (c.id === crew.id ? crew : c)));
    }
    await publishFmBrief(crew, hostId, input.task);
    // Same record-after-spawn race as the real transport, though the native window
    // is far smaller. Skip a future-scheduled send: its thread sits idle until sendAt
    // and has not run yet, so its "idle" is not a turn-end to report.
    if (!scheduled) await reconcileCrewTerminal(crew).catch(() => {});
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
    if ((crew.relaunches ?? 0) >= MAX_CREW_RELAUNCHES) {
      throw new Error(
        `Crew ${crew.id} was already relaunched ${crew.relaunches} time(s). Stuck ladder: second failure means report it failed with preserved work; do not relaunch again.`,
      );
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
      title: crewThreadTitle(crew.task, crew.shape, crew.id),
      parentThreadId: crew.parentThreadId ?? undefined,
      providerId,
      model,
      reasoningLevel,
      permissionMode: capped,
      visibility: "visible",
      pluginMetadata: {
        crew: "true",
        crewId: crew.id,
        nativeHome: crew.nativeHome ?? "",
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
      relaunches: (crew.relaunches ?? 0) + 1,
      priorThreadIds: [...(crew.priorThreadIds ?? []), crew.threadId],
    };
    await mutateCrews(crews => crews.map((c) => (c.id === crew.id ? next : c)));
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
  // `fm_task_inbox_write <state> <id> <body>` takes the body as ONE
  // positional arg, so every prefix is stored verbatim (proven). F3: it needs no
  // state/<id>.meta, so a crew created before real transport is never rendered
  // unsteerable. Base64 keeps the body out of the command text entirely.
  //
  // Ordinary steers use a NORMAL record, matching upstream: until BB confirms the
  // message was inserted into the crew's model input, fm-watch may re-ring it. Once
  // BB confirms delivery we atomically move the record to handled/, which is the
  // native acknowledgement. An explicit non-urgent `--queue` remains
  // fire-and-forget because by definition it must not re-ring into an active turn.
  // Best-effort: null ⇒ no durable record (caller still attempts BB delivery).
  async function writeInboxRecord(
    hostId: string,
    fmHome: string,
    crewId: string,
    body: string,
    fireAndForget: boolean,
  ): Promise<string | null> {
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
      `fm_task_inbox_write ${shQuote(stateDir)} ${shQuote(crewId)} "$body"${fireAndForget ? " fire-and-forget" : ""}`,
    ].join("\n");
    try {
      const res = await runOnHost(hostId, script, 20_000);
      if (res.exitCode !== 0) {
        bb.log.warn(`fm inbox record crew=${crewId} exit=${res.exitCode}`);
        return null;
      }
      const record = res.output.trim().split(/\r?\n/).at(-1) ?? "";
      const prefix = `${stateDir}/${crewId}.inbox/`;
      if (!record.startsWith(prefix) || !/^\d+\.msg$/.test(record.slice(prefix.length))) {
        bb.log.warn(`fm inbox record crew=${crewId} returned an invalid record path`);
        return null;
      }
      return record;
    } catch (error) {
      bb.log.warn(`fm inbox record crew=${crewId} ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async function acknowledgeInboxRecord(hostId: string, fmHome: string, crewId: string, record: string): Promise<boolean> {
    const inbox = `${fmHome}/state/${crewId}.inbox`;
    const name = record.slice(`${inbox}/`.length);
    if (!/^\d+\.msg$/.test(name)) return false;
    const handled = `${inbox}/handled`;
    const res = await runOnHost(
      hostId,
      `mkdir -p ${shQuote(handled)} && { [ ! -f ${shQuote(record)} ] || mv -- ${shQuote(record)} ${shQuote(`${handled}/${name}`)}; }`,
      15_000,
    ).catch(() => null);
    return res !== null && res.exitCode === 0;
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

  // tellOwner=real: a captain→crew steer gets the same durable normal inbox record
  // upstream uses. BB then delivers the literal message as a live steer; confirmed
  // model-input delivery moves the record to handled/, while a failed send leaves it
  // unhandled for fm-watch's re-ring/recovery ladder. Delivery never depends on fm-send target
  // resolution or state/<id>.meta (F3), and the body is stored/delivered verbatim
  // regardless of prefix (F4). interrupt/stop stay hard steers, never this path.
  // Returns a status string once the literal doorbell is delivered or durably
  // recorded for recovery; null when tellOwner=kv, fmHome unset, or no normal
  // durable record exists and the BB send itself fails.
  async function sendViaInbox(crew: Crew, message: string, queue: boolean): Promise<string | null> {
    const current = await settings.get();
    if (current.tellOwner !== "real") return null;
    const fmHome = await crewNativeHome(crew);
    if (fmHome === "" || isSecondmateRoute(crew)) return null;
    let hostId: string | null = null;
    try {
      hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
    } catch {
      hostId = null;
    }
    const record = hostId === null ? null : await writeInboxRecord(hostId, fmHome, crew.id, message, queue);
    if (record !== null && queue && hostId !== null) await reapInboxRecords(hostId, fmHome, crew.id);
    // Capture the running-turn status BEFORE we send, so the returned line honestly
    // reports whether a steer LANDED in a live turn or merely started an idle one.
    const wasActive = queue ? false : await crewInTurn(crew);
    try {
      const result = await bb.sdk.threads.send({
        threadId: crew.threadId,
        // Default tell is a STEER: mode:"steer" lands inside the crew's running turn
        // (course correction reaches it mid-work) and starts a turn when idle.
        // queue:true opts out to the old non-disturbing doorbell — queue-if-active
        // only queues, so the crew reads it when it next drains its queue.
        mode: queue ? "queue-if-active" : "steer",
        input: [{ type: "text", text: message.slice(0, MAX_TASK), mentions: [] }],
      });
      if (!queue && record !== null && hostId !== null && asRecord(result)["delivery"] !== "queued") {
        if (!(await acknowledgeInboxRecord(hostId, fmHome, crew.id, record))) {
          bb.log.warn(`fm inbox ack crew=${crew.id} failed; watcher will recover the normal record`);
        }
      }
    } catch (error) {
      // A normal record is watcher-owned until acknowledged. Keep it pending for
      // fm-watch rather than sending a second copy through tellCrew's fallback.
      if (!queue && record !== null) {
        bb.log.warn(`fm inbox steer crew=${crew.id} ${error instanceof Error ? error.message : String(error)}; durable record left for watcher re-ring`);
        return `Recorded steer for crew ${crew.id}; fm-watch will re-ring it.`;
      }
      bb.log.warn(`fm inbox doorbell crew=${crew.id} ${error instanceof Error ? error.message : String(error)}; falling back`);
      return null;
    }
    const durable = record !== null;
    bb.log.info(`fm inbox ${queue ? "queue" : "steer"} crew=${crew.id} ${durable ? "durable record + BB delivery" : "BB delivery (no durable record)"}`);
    const audit = durable
      ? queue ? "durable non-urgent record" : "durable inbox record acknowledged on delivery"
      : "durable record unavailable — logged";
    if (queue) return `Queued for crew ${crew.id} (${audit}; read when its current turn ends)`;
    return wasActive
      ? `Steered into crew ${crew.id}'s running turn (${audit})`
      : `Told crew ${crew.id} (started a turn; ${audit})`;
  }

  async function crewInTurn(crew: Crew): Promise<boolean> {
    const status = await crewStatus(crew);
    return status === "active" || status === "starting" || status === "pending";
  }

  // Standard framing on a plain (non-interrupt) tell so a crew reads it as a course
  // correction to fold into its CURRENT task — not as a stop. interrupt keeps the
  // opposite framing ("INTERRUPT: stop the current action"). The distinction is the
  // whole point: a steer lands in the running turn and must not read as teardown —
  // a crew that treats a correction as "ACK: Stopped" abandons live work.
  const STEER_PREFIX =
    "STEER from captain — this is a course correction, NOT a stop. Keep working on your current task and fold this in without tearing down or discarding work: ";

  async function tellCrew(crew: Crew, message: string, interrupt: boolean, queue = false): Promise<string> {
    if (isSecondmateRoute(crew) && interrupt) {
      throw new Error(`Crew ${crew.id} is a secondmate route — do not interrupt the domain captain thread.`);
    }
    // A plain tell is a STEER by default: mode:"steer" LANDS inside the crew's
    // running turn (so a captain's correction reaches it mid-work instead of sitting
    // in a queue the crew only reads after it finishes) and STARTS a turn when the
    // crew is idle — strictly better than queue-if-active for a correction.
    // `queue: true` is the deliberate opt-out for a genuinely non-urgent note that
    // must not disturb an active turn (queue-if-active; read when the crew next
    // drains its queue). interrupt/stop keep their own hard-stop framing and are
    // never routed through the inbox or queued.
    if (!interrupt) {
      const body = queue ? message : `${STEER_PREFIX}${message}`;
      const routed = await sendViaInbox(crew, body, queue);
      if (routed !== null) return routed;
      const wasActive = queue ? false : await crewInTurn(crew);
      await bb.sdk.threads.send({
        threadId: crew.threadId,
        mode: queue ? "queue-if-active" : "steer",
        input: [{ type: "text", text: body.slice(0, MAX_TASK), mentions: [] }],
      });
      if (queue) {
        return (await crewInTurn(crew))
          ? `Queued for crew ${crew.id} (read when its current turn ends)`
          : `Told crew ${crew.id}`;
      }
      return wasActive
        ? `Steered into crew ${crew.id}'s running turn`
        : `Told crew ${crew.id} (started a turn)`;
    }
    await bb.sdk.threads.send({
      threadId: crew.threadId,
      mode: "steer",
      input: [{ type: "text", text: message.slice(0, MAX_TASK), mentions: [] }],
    });
    return `Interrupted crew ${crew.id}`;
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

  async function bearingsSnapshot(owner?: string): Promise<{
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
    const tracked = (await listCrews({ owner })).slice(0, 20);
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
        // Resolve the crew's real kind (native's `.meta` rule) only when a fold
        // would actually run, so the deck stays cheap. A metaless crew folds as
        // `unknown` → its open decision is NOT collapsed away.
        const openDecisions =
          latest !== null && latest.verb !== "done" && latest.verb !== "failed"
            ? foldOpenDecisions(lines, await foldKind(crew))
            : [];
        // A crew that ended idle self-reporting FAILED is a captain call (retry/
        // investigate), NOT a review-ready ship — its idle thread status must not
        // let it fall through to "ready to review (crew/deliver)".
        const failed = status === "idle" && latest !== null && latest.verb === "failed";
        return { ...crew, status, prUrl: pr.url, openDecisions, failed, prSummary: summarizePR({ pullRequest: { url: pr.url, number: pr.number, title: pr.title, state: pr.state, checks: { state: pr.checksState } } }) };
      }),
    );
    const now = Date.now();
    // D4: scope the backlog, landed work, AND decisions to the calling captain,
    // own-by-default with `--all` (owner === undefined) — the same partition
    // crews/session already use. Rows created before this attribution existed carry
    // no owner, so they surface only under --all (never mis-attributed to the wrong
    // captain). Decisions were once unscoped, so every captain's deck greeted it
    // with other projects' open calls.
    const ownedByCaptain = (parentThreadId: string | null | undefined): boolean =>
      owner === undefined || owner === "" ? true : parentThreadId === owner;
    const decisions = (await readDecisions()).filter((d) => ownedByCaptain(d.parentThreadId));
    const queue = (await readQueue()).filter((q) => ownedByCaptain(q.parentThreadId));
    const done = (await readDone()).filter((d) => ownedByCaptain(d.parentThreadId));
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
        .filter((row) => row.status === "idle" && row.failed)
        .map((row) => `! ${formatCrew(row, row.status)} — FAILED: retry/investigate (retry? tell? forget?)`),
      ...rows
        .filter((row) => row.status === "idle" && !row.failed && row.openDecisions.length > 0)
        .map((row) => {
          const d = row.openDecisions[row.openDecisions.length - 1]!;
          return `? ${row.id} — ${d.verb.toUpperCase()} [${d.key}]: ${truncate(d.note, 80)} — steer: bb firstmate tell ${row.id} -- "<answer>"`;
        }),
      ...rows
        .filter((row) => row.status === "idle" && !row.failed && row.openDecisions.length === 0 && row.prUrl !== "")
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
    const readyRows = rows.filter((row) => row.status === "idle" && !row.failed && row.openDecisions.length === 0);
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
      afk: (await readAfk(owner))?.on === true,
      quiet: await isQuiet(owner),
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

  async function sessionDigest(owner?: string): Promise<string> {
    // D3: recall must reflect the authoritative files, not the KV cache. When
    // memoryOwner=real, memoryShow reads data/captain.md + data/learnings.md
    // directly (and degrades to KV only if the host read fails), so /captain,
    // deck and session never serve a truncated/stale view — including after a
    // native `/stow` edit that never touches KV. In kv mode this is the KV read.
    const mem = await memoryShow();
    const capText = mem.captain !== "" ? mem.captain : "(empty)";
    const learnText = mem.learnings !== "" ? mem.learnings : "(empty)";
    const afk = await readAfk(owner);
    const snap = await bearingsSnapshot(owner);
    return [
      "== session ==",
      `afk: ${afk?.on === true ? `on since ${afk.since}` : "off"} · quiet: ${(await isQuiet(owner)) ? "on" : "off"}`,
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

  async function rememberWatchCaptain(ctx: unknown, threadId: string): Promise<void> {
    try {
      const hostId = await resolveHostId(undefined, ctx);
      await bb.storage.kv.set(`${FM_WATCH_CAPTAIN_PREFIX}${hostId}`, threadId);
    } catch {
      // A later deck/session call can record it once this thread has a host.
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
      if (typeof thread["projectId"] === "string") {
        await bb.storage.kv.set(`${CAPTAIN_PROJECT_PREFIX}${threadId}`, thread["projectId"]);
        knownCaptainsRef.add(threadId);
      }
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

  // Two captains on one project collide on deploys, key rotations, and deploy
  // holds. Name the other live captains so this one coordinates first.
  async function otherCaptainsNote(threadId: string | undefined, signal?: AbortSignal): Promise<string> {
    if (threadId === undefined) return "";
    try {
      let projectId = await bb.storage.kv.get<string>(`${CAPTAIN_PROJECT_PREFIX}${threadId}`);
      if (typeof projectId !== "string") {
        // A captain decked before this registry existed registers on its next digest.
        const own = asRecord(await raceAbort(bb.sdk.threads.get({ threadId }), signal, STUCK_HOST_CALL_MS))["projectId"];
        if (typeof own !== "string" || !(await isCaptainThread(threadId))) return "";
        projectId = own;
        await bb.storage.kv.set(`${CAPTAIN_PROJECT_PREFIX}${threadId}`, own);
        // Register live too: compaction and crew-ping batching key off this set, which
        // is otherwise only reloaded from KV at startup.
        knownCaptainsRef.add(threadId);
      }
      const others: string[] = [];
      for (const key of await bb.storage.kv.list(CAPTAIN_PROJECT_PREFIX)) {
        const other = key.slice(CAPTAIN_PROJECT_PREFIX.length);
        if (other === threadId || (await bb.storage.kv.get<string>(key)) !== projectId) continue;
        try {
          const row = asRecord(await raceAbort(bb.sdk.threads.get({ threadId: other }), signal, STUCK_HOST_CALL_MS));
          if (row["archivedAt"] != null) continue;
        } catch {
          continue;
        }
        if (await isCaptainThread(other)) others.push(other);
      }
      if (others.length === 0) return "";
      return others
        .map((id) => `WARN: Another captain is active on this project: @thread:${id} — coordinate before production deploys, key rotations, or deploy holds.`)
        .join("\n");
    } catch {
      return "";
    }
  }

  async function markDeck(threadId: string): Promise<void> {
    await settleDeck(threadId);
    await publishFleet();
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
    const nativeHome = await crewNativeHome(crew);
    if (nativeHome !== "") {
      const hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
      if (local) {
        const result = await runFmScript({ script: "merge-local", args: [crew.id], fmHome: nativeHome, hostId, timeoutMs: 180_000 });
        requireNativeSuccess(result, `local merge ${crew.id}`);
        await retireLanded(crew, "local ff-only", "");
        return `${result.output.trim()}\nCrew ${crew.id} retired.`;
      }
      const pr = prFacts(await bb.sdk.environments.pullRequest({ environmentId: envId }));
      if (!pr.available || !pr.url) throw new Error(`No PR for crew ${crew.id}.`);
      if (pr.state !== "merged") {
        const args = [crew.id, pr.url];
        if (allowRedCheck?.trim()) args.push("--allow-red", allowRedCheck.trim());
        const result = await runFmScript({ script: "pr-merge", args, fmHome: nativeHome, hostId, timeoutMs: 180_000 });
        requireNativeSuccess(result, `PR merge ${crew.id}`);
        const landed = prFacts(await bb.sdk.environments.pullRequest({ environmentId: envId }));
        if (landed.state !== "merged") return `${result.output.trim()}\nLanding not yet confirmed; crew ${crew.id} retained. Check the merge queue before teardown.`;
      }
      await retireLanded(crew, "merged through native gate", pr.url);
      return `Merged ${pr.url}\nCrew ${crew.id} retired.`;
    }
    if (local) return mergeLocal(crew, envId);
    if (crew.posture === "no-mistakes" || posture.mode === "no-mistakes") {
      const dirty = extractPaths(
        await bb.sdk.environments.diffFiles({ environmentId: envId, target: "uncommitted" }),
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
    const nativeHome = await crewNativeHome(crew);
    if (nativeHome !== "" && !isSecondmateRoute(crew)) {
      const hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined);
      const result = await runFmScript({ script: "teardown", args: [crew.id], fmHome: nativeHome, hostId, timeoutMs: 180_000 });
      requireNativeSuccess(result, `teardown ${crew.id} (work landed; cleanup pending)`);
    } else if (!(await isCaptainThread(crew.threadId))) {
      await bb.sdk.threads.stop({ threadId: crew.threadId });
      await bb.sdk.threads.archive({ threadId: crew.threadId });
    }
    await markQueueForCrew(crew.id, "done");
    await recordDone({ task: crew.task.slice(0, 200), shape: crew.shape, crewId: crew.id, outcome, pr, parentThreadId: crew.parentThreadId });
    await removeCrew(crew);
    await publishFleet();
  }

  // Live-check tracked crews against the forge and retire any whose PR was
  // merged or closed outside BB (e.g. the captain merged it on GitHub). Without
  // this, an external merge leaves the crew stale in both the KV cache and the
  // real state/<id>.meta ledger. Only idle/error crews are checked — an active
  // crew's PR is not landed yet — so this adds no PR reads beyond bearings.
  // A refused native teardown (e.g. uncommitted work in the crew worktree) keeps
  // the crew. One refusal must not fail the whole digest/fleet view, and the
  // slow teardown is not re-run on every poll.
  const landedRetireBackoff = new Map<string, number>();
  const LANDED_RETIRE_BACKOFF_MS = 10 * 60_000;

  async function reconcileExternallyLanded(crews: Crew[]): Promise<Set<string>> {
    const retired = new Set<string>();
    for (const crew of crews) {
      if (isSecondmateRoute(crew)) continue;
      if ((landedRetireBackoff.get(crew.id) ?? 0) > Date.now()) continue;
      const status = await crewStatus(crew);
      if (status !== "idle" && status !== "error") continue;
      const pr = await prForCrew(crew);
      if (!pr.available) continue;
      if (pr.state !== "merged" && pr.state !== "closed") continue;
      try {
        await retireLanded(crew, pr.state === "merged" ? "merged externally" : "PR closed externally", pr.url);
        retired.add(crew.id);
        landedRetireBackoff.delete(crew.id);
      } catch (error) {
        landedRetireBackoff.set(crew.id, Date.now() + LANDED_RETIRE_BACKOFF_MS);
        bb.log.warn(
          `landed crew retire refused crew=${crew.id} pr=${pr.url} (crew kept): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return retired;
  }

  async function forgetCrew(id: string, stop: boolean, force: boolean): Promise<string> {
    const crew = (await readCrews()).find(entry => entry.id === id) ?? await findCrew(id);
    if (crew === undefined) throw new Error(`No crew ${id}. Run "bb firstmate crews".`);
    if (stop && isSecondmateRoute(crew) && !force) {
      throw new Error(`Refusing: ${id} is a secondmate route. Drop with forget (no --stop), or --force to also stop that thread.`);
    }
    let worktreeRemoved = false;
    let nativeTeardown = false;
    if (stop) {
      if (await isCaptainThread(crew.threadId)) {
        throw new Error(
          "Refusing to archive the captain thread. Forget the crew without --stop.",
        );
      }
      const nativeHome = await crewNativeHome(crew);
      if (crew.shape === "scout" && !isSecondmateRoute(crew) && nativeHome !== "") {
        // Native owns scout report/hold gates and the resulting backlog transition.
        // KV worktree=false does not rule out a native-managed BB worktree.
        const hostId = await resolveHostForProject(crew.projectId, crew.threadId);
        const result = await runFmScript({
          script: "teardown", args: [crew.id, ...(force ? ["--force"] : [])],
          fmHome: nativeHome, hostId, timeoutMs: 180_000,
        });
        requireNativeSuccess(result, `teardown ${crew.id} (crew retained for retry)`);
        nativeTeardown = true;
      }
    }
    if (stop && !nativeTeardown) {
      const thread = await bb.sdk.threads.get({ threadId: crew.threadId });
      const envId = thread.environmentId;
      if (!force && crew.worktree && !envId) throw new Error(`Cannot verify worktree for crew ${id}: environment unavailable.`);
      // A crew's dedicated managed worktree is the environment to tear down. A
      // shared-env crew (crew.worktree === false) runs in the project-default
      // environment — never delete that; deleting it would take out the shared
      // checkout other crews use. So resolve the worktree env id only for an
      // isolated crew and only when the environment confirms isWorktree.
      let worktreeEnvId: string | null = null;
      if (envId !== null && crew.worktree) {
        try {
          const env = await bb.sdk.environments.get({ environmentId: envId });
          if (asRecord(env)["isWorktree"] === true) worktreeEnvId = envId;
        } catch (error) {
          if (!force) throw new Error(`Cannot verify environment for crew ${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (!force && envId !== null) {
        // Unlanded-work protection. "Unlanded" is BOTH uncommitted changes AND
        // committed-but-unpushed commits (F1) — either is work that only exists in
        // this worktree, and our hard rule is never to destroy it. We refuse on
        // either, loudly, leaving the thread AND the worktree intact. This makes
        // the safety DELIBERATE, not a side effect of the teardown primitive
        // happening to preserve the branch (see the note at environments.delete).
        const diff = await bb.sdk.environments.diffFiles({ environmentId: envId, target: "uncommitted" });
        const dirty = checkedDiffPaths(diff);
        if (dirty.length > 0) {
          throw new Error(
            `Refusing: crew ${id} has ${dirty.length} uncommitted file(s) (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? "…" : ""}). Deliver first, or re-run with --force to discard.`,
          );
        }
        const unpushed = await committedUnpushedCommits(envId);
        if (unpushed.length > 0) {
          throw new Error(
            `Refusing: crew ${id} has committed but UNPUSHED work on its branch (${unpushed.length >= 20 ? "at least " : ""}${unpushed.length} commit(s): ${unpushed.slice(0, 5).map(sha => sha.slice(0, 12)).join(", ")}${unpushed.length > 5 ? "…" : ""}). Those commits exist only in this worktree's branch. Open a PR / push first, or re-run with --force to discard.`,
          );
        }
      }
      await bb.sdk.threads.stop({ threadId: crew.threadId });
      await bb.sdk.threads.archive({ threadId: crew.threadId });
      // D2: native fm-teardown removes the git worktree; do the same so worktrees
      // do not accumulate on disk after forget. Only reached once the tree is clean
      // and has no committed-unpushed work (or --force), so no unlanded work is
      // discarded here.
      //
      // What this primitive deletes, precisely (F1): BB's `environments.delete` for
      // a managed worktree runs `git worktree remove` on the shared parent repo. It
      // removes the WORKING TREE only — it does NOT delete the crew's branch and
      // does NOT drop git stash entries; both live in the shared parent repo and
      // survive removal. We do NOT rely on that for safety: the guard above already
      // refuses committed-unpushed work, so removal here is of a worktree whose work
      // is either landed/pushed or explicitly force-discarded. This comment is the
      // contract — if a future BB version prunes branches or drops stashes on delete,
      // the guard (not this primitive) is still what prevents data loss.
      if (worktreeEnvId !== null) {
        try {
          await bb.sdk.environments.delete({ environmentId: worktreeEnvId });
          worktreeRemoved = true;
        } catch (error) {
          throw new Error(`forget ${id}: worktree ${worktreeEnvId} not removed; crew retained for retry: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
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
          parentThreadId: crew.parentThreadId,
        });
        await markQueueForCrew(crew.id, "done");
      }
    } catch {
      // best effort
    }
    if (!nativeTeardown) {
      await dropFmMeta(crew);
      // forget/drop removes the crew's own backlog row (dropped on forget, C1).
      await realBacklogTransitionForCrew(crew, "rm");
    }
    await removeCrew(crew);
    await publishFleet();
    await dropNudge(id);
    return `Forgot crew ${id}${worktreeRemoved ? " (worktree removed)" : ""}`;
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
    const scopedHost = homeScope.getStore()?.host;
    if (scopedHost) return scopedHost;
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
    let lastOutputError = "";
    try {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (signal?.aborted) throw new Error("Aborted.");
        if (Date.now() >= deadline) throw new Error(`Timed out waiting for host command (host ${hostId}, terminal ${terminalId}, budget ${timeoutMs / 1000}s).${lastOutputError ? ` Last output read: ${lastOutputError}` : ""}`);
        const cur = await bb.sdk.terminals.get({ terminalId });
        const status = asRecord(cur)["status"];
        if (status === "disconnected") throw new Error("Terminal disconnected.");
        let outputRead = false;
        try {
          const chunk = await bb.sdk.terminals.output({
            terminalId,
            sinceSeq: nextSeq,
            tailBytes: 65536,
          });
          const rec = asRecord(chunk);
          if (typeof rec["nextSeq"] === "number") nextSeq = rec["nextSeq"];
          output += decodeChunks(chunk);
          outputRead = true;
          lastOutputError = "";
        } catch (error) {
          lastOutputError = error instanceof Error ? error.message : String(error);
          bb.log.debug(
            `host terminal output terminal=${terminalId} status=${status} ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const parsed = parseHostRc(output);
        if (parsed !== null) return parsed;
        if (status === "exited" && outputRead) {
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
      "firstmate-bb-local-merge.patch": overlayBytes("firstmate-bb-local-merge.patch"),
      "firstmate-bb-browser.patch": overlayBytes("firstmate-bb-browser.patch"),
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
    // from PATH and is NOT bundled. Verify it
    // and, if absent, surface the exact install command rather than silently
    // degrading — queue-real still degrades safely to the KV cache until it's there.
    const axiPresent = /FM_AXI=\S/.test(tools.output);
    const axiVer = /FM_AXI_VER=v?(\d+\.\d+\.\d+)/.exec(tools.output)?.[1] ?? "";
    const queueNote = !axiPresent
      ? "tasks-axi MISSING — install with 'npm install -g tasks-axi' on this host; queueOwner=real refuses writes until repaired"
      : axiVer !== "" && !versionAtLeast(axiVer, TASKS_AXI_MIN)
        ? `tasks-axi v${axiVer} is BELOW the required ${TASKS_AXI_MIN} — upgrade with 'npm install -g tasks-axi'; queueOwner=real refuses writes until repaired`
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
    const toolchain = await checkToolchain(hostId, path, signal);
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
    // Refresh the version-pinned skills inventory and captain memory.
    // The complete native contract is read on demand through firstmate_contract.
    await refreshSkillsManifest(hostId, path, signal);
    await refreshCaptainMemory();
    const summary = [
      `host: ${hostId}`,
      `path: ${path} (${existed ? "existed" : "cloned"}; ${ffNote})`,
      `project: ${projectId}`,
      `backend: bb (overlay installed; config/backend=bb)`,
      `queue: ${queueNote}`,
      `native toolchain:\n${toolchain.output}`,
      `toolbelt: ${toolbeltPhrase(scriptCount, skillCount)}`,
      `fm: bb firstmate fm spawn -- --mode direct-PR -- ship "<task>"`,
      `overlay:\n${truncate(overlayOut, 800)}`,
      `tools:\n${truncate(tools.output, 500)}`,
    ].join("\n");
    return { hostId, path, existed, projectId, overlay: overlayOut, tools: tools.output, summary };
  }

  const FULL_PARITY_MIGRATION_KEY = "full-parity-migrated-home";

  async function activateFullParityForDeck(captainThreadId: string | undefined): Promise<string> {
    const before = await settings.get();
    const fmHome = before.fmHome.trim();
    if (!before.fullParityOnDeck || fmHome === "") return "";
    await settings.experimental_set({
      transport: "real",
      watchOwner: "fm-watch",
      readThrough: true,
      queueOwner: "real",
      decisionsOwner: "real",
      afkOwner: "real",
      quietOwner: "real",
      memoryOwner: "real",
      notifyOwner: "real",
      tellOwner: "real",
      // Live crew events already trigger the manager. Re-ringing after its turn
      // can start repeated manager turns with no new crew event; durable wakes
      // remain recoverable through firstmate_wake and deck/session catch-up.
      turnEndGuard: "off",
      supervisionEnabled: true,
      nudgeEnabled: true,
    });

    // Existing plugin state may predate the real owners. Import it once per home;
    // every migration is itself idempotent and refuses destructive overwrites.
    const migratedHome = await bb.storage.kv.get<unknown>(`${FULL_PARITY_MIGRATION_KEY}:${fmHome}`);
    if (migratedHome !== fmHome) {
      try {
        const state = await migrateState();
        const owners = await migrateOwners(captainThreadId);
        if (state.failed.length === 0 && owners.memory) {
          await bb.storage.kv.set(`${FULL_PARITY_MIGRATION_KEY}:${fmHome}`, fmHome);
        } else {
          bb.log.warn(
            `full parity migration incomplete home=${fmHome} stateFailed=${state.failed.length} memory=${owners.memory}`,
          );
        }
      } catch (error) {
        bb.log.warn(`full parity migration deferred: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await refreshCaptainMemory();
    return "Full Firstmate profile: active (real state, memory, watcher, backlog, decisions, durable messaging, and wake guard).";
  }

  // Real firstmate is the default. On deck, if it is not already initialized,
  // clone + overlay it now (best-effort); on any failure, surface the single
  // one-time command the captain must run. Returns a line for the deck digest.
  async function installCaptainHooks(
    hostId: string,
    threadId: string | undefined,
    fallbackHome: string,
    signal?: AbortSignal,
  ): Promise<void> {
    if (threadId === undefined || !/^[A-Za-z0-9_-]+$/.test(threadId)) return;
    const stored = await bb.storage.kv.get<string>(`native-home:${threadId}`);
    const home = typeof stored === "string" && stored !== "" ? stored : fallbackHome;
    const script = captainHookInstallScript({
      threadId,
      home,
      state: wakeStateDir(home, threadId),
      ownHome: home.endsWith(`-bb-homes/${threadId}`),
      scriptB64: overlayBytes("bin/bb-captain-hook.sh"),
    });
    const res = await runOnHost(hostId, `bash -c ${shQuote(script)}`, 60_000, signal);
    if (res.exitCode !== 0 || !res.output.includes("captain-hooks-ok")) {
      bb.log.warn(`captain hook install failed captain=${threadId} host=${hostId}: ${truncate(res.output, 400)}`);
    } else {
      bb.log.info(`captain hooks installed captain=${threadId} home=${home}`);
    }
  }

  async function ensureRealModeForDeck(ctx: unknown, signal: AbortSignal | undefined): Promise<string> {
    if ((await baseSettings.get()).fullParityOnDeck) await ensureCaptainHome(ctx, signal);
    const current = await settings.get();
    if (current.fmHome.trim() !== "") {
      // Refresh the version-pinned skills inventory when HEAD moved (best-effort).
      try {
        const hostId = await resolveHostId(undefined, ctx);
        // Re-apply the plugin-owned BB adapter on every deck. Upstream scripts stay
        // untouched; this refreshes the mirror when the plugin's transport semantics
        // change (for example queue → live steer) without requiring a manual re-init.
        await installBbBackend(
          hostId,
          current.fmHome,
          ctxString(ctx, "projectId"),
          180_000,
          signal,
        );
        await refreshSkillsManifest(hostId, current.fmHome, signal);
        await refreshCaptainMemory();
        await installCaptainHooks(hostId, ctxString(ctx, "threadId"), current.fmHome, signal);
      } catch (error) {
        if (current.fullParityOnDeck) throw new Error(`Native setup failed; captain is not ready: ${error instanceof Error ? error.message : String(error)}`);
        bb.log.warn(`Native adapter refresh failed in compatibility mode: ${String(error)}`);
      }
      const profile = await activateFullParityForDeck(ctxString(ctx, "threadId"));
      return [
        `Real firstmate: active (fmHome ${current.fmHome}; ${toolbeltPhrase(current.fmScriptCount, current.fmSkillCount)}).`,
        profile,
        `Dispatch through the full toolbelt: bb firstmate fm spawn -- --mode direct-PR -- ship "<task>".`,
      ].filter((line) => line !== "").join("\n");
    }
    try {
      const res = await initRealMode(ctx, signal, {});
      if ((await baseSettings.get()).fullParityOnDeck) await ensureCaptainHome(ctx, signal);
      const profile = await activateFullParityForDeck(ctxString(ctx, "threadId"));
      return [
        `Real firstmate: initialized now (${res.existed ? "reused clone" : "cloned"}).`,
        profile,
        res.summary,
      ].filter((line) => line !== "").join("\n");
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
  //
  // Native renders the whole selected home. Registered captains have dedicated
  // homes; callers using the legacy shared home still see its combined ledger.
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
      const scope = homeScope.getStore()?.home ? "captain home" : "host-wide";
      return [`== real bearings (fm-bearings-snapshot; authoritative, ${scope}) ==`, result.output.trim()].join("\n");
    } catch {
      return "";
    }
  }

  // The deck digest: real bearings first (authoritative when active), then the
  // native KV digest explicitly labelled as a cache/fallback view.
  async function deckDigest(ctx: unknown, signal: AbortSignal | undefined, all = false): Promise<string> {
    const realBearings = await realBearingsForDeck(ctx, signal);
    // The calling thread IS the captain — scope the native/KV digest to its own crews, unless
    // `all` opts into the whole host.
    const native = await sessionDigest(all ? undefined : ctxString(ctx, "threadId"));
    const nativeBlock = realBearings === ""
      ? native
      : ["== native digest (BB KV cache / fallback) ==", native].join("\n");
    const others = await otherCaptainsNote(ctxString(ctx, "threadId"), signal);
    return [others, realBearings, nativeBlock].filter((s) => s !== "").join("\n");
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
    if (script === "spawn") await reconcileReturnedAfk(input.parentThreadId);
    if (["spawn", "pr-merge", "merge-local"].includes(script)) await guardReturnCatchup(input.hostId, input.fmHome);
    // Native path for the RETURN value / diagnostics; the invocation below resolves
    // FM_BINDIR (bin-bb when the bb overlay is installed) on the host.
    const scriptPath = `${input.fmHome}/bin/fm-${script}.sh`;
    const scriptLeaf = `fm-${script}.sh`;
    const extraEnv = Object.entries({
      ...(script === "wake-drain" ? wakeStateEnv(input.fmHome, input.parentThreadId) : {}),
      ...input.env,
    })
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
      fmBinDirAssign(input.fmHome),
      fmMirrorStaleGuard(input.fmHome),
      `if [ ! -f "$FM_BINDIR/${scriptLeaf}" ]; then echo "error: missing $FM_BINDIR/${scriptLeaf}" >&2; exit 127; fi`,
      `"$FM_BINDIR/${scriptLeaf}" ${input.args.map(shQuote).join(" ")}`,
    ]
      .filter((line) => line !== "")
      .join("\n");
    const result = await runOnHost(input.hostId, prelude, input.timeoutMs, input.signal);
    if (result.output.includes("FM_MIRROR_STALE")) {
      const line = result.output.split("\n").find((l) => l.includes("FM_MIRROR_STALE"))?.trim() ?? "FM_MIRROR_STALE";
      bb.log.error(`bb mirror is STALE on host ${input.hostId} running fm-${script}: ${line}. Re-run the overlay installer against ${input.fmHome}; new native scripts are unmirrored and the three patched copies are frozen behind upstream.`);
    }
    return {
      ...result,
      output: script === "wake-drain" ? rewriteWakeAckLine(result.output) : result.output,
      scriptPath,
    };
  }

  async function installedScriptSurface(ctx: unknown, query = "") {
    const current = await settings.get();
    const fmHome = current.fmHome.trim();
    if (fmHome === "") throw new Error("No firstmate home. Run bb firstmate init --real.");
    const hostId = await resolveHostId(undefined, ctx);
    const bin = `${fmHome}/bin`;
    const mirrorBb = `${fmHome}/bin-bb/backends/bb.sh`;
    const res = await runOnHost(
      hostId,
      `{ find ${shQuote(bin)} -maxdepth 2 -type f -printf '%P\\n' 2>/dev/null; ` +
        `[ -f ${shQuote(mirrorBb)} ] && printf 'backends/bb.sh\\n' || true; } | LC_ALL=C sort -u`,
      20_000,
      asRecord(ctx)["signal"] as AbortSignal | undefined,
    );
    const files = res.output
      .split(/\r?\n/)
      .map((name) => name.trim())
      .filter((name) => name !== "");
    const names = files
      .filter((name) => !name.includes("/") && /^fm-[a-z0-9-]+\.sh$/.test(name))
      .map((name) => name.slice(3, -3));
    const entryFiles = new Set(names.map((name) => `fm-${name}.sh`));
    const support = files.filter((name) => !entryFiles.has(name));
    return compareUpstreamScriptSurface(names, query, support);
  }

  function renderScriptSurface(surface: ReturnType<typeof compareUpstreamScriptSurface>): string {
    const drift = [
      surface.missing.length > 0 ? `missing: ${surface.missing.join(", ")}` : "",
      surface.extra.length > 0 ? `new upstream: ${surface.extra.join(", ")}` : "",
    ].filter((line) => line !== "");
    return [
      `Firstmate scripts: ${surface.installed} callable + ${surface.installedSupport} support/adapters installed / ${surface.expected} + ${surface.expectedSupport} pinned @ ${surface.sha.slice(0, 12)}`,
      ...drift,
      surface.missingSupport.length > 0 ? `missing support: ${surface.missingSupport.join(", ")}` : "",
      surface.extraSupport.length > 0 ? `new support: ${surface.extraSupport.join(", ")}` : "",
      surface.matches.length > 0 ? surface.matches.join("\n") : "No matching scripts.",
    ].filter((line) => line !== "").join("\n");
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
  // at/below the sequence. Configuration, transport, and native-script failures
  // remain errors with their cause; none implies an empty or acknowledged queue.
  // A captain sees its own queue and decision rows. With its own home it sees only
  // those; on the shared legacy home it also keeps the unattributed rows written
  // before rows carried an owner — but never another captain's.
  function ownedByScopedCaptain(parentThreadId: string | null | undefined): boolean {
    const scope = homeScope.getStore();
    if (!scope?.captain) return true;
    if (parentThreadId === scope.captain) return true;
    return !scope.home && (parentThreadId === null || parentThreadId === undefined || parentThreadId === "");
  }

  async function drainWakes(
    captainThreadId: string | undefined,
    ackThrough?: number,
    recoveryGeneration?: string,
    hostOverride?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    const current = await settings.get();
    const fmHome = current.fmHome.trim();
    if (fmHome === "") throw new Error("Firstmate home is not configured. Run firstmate_deck before reading wakes.");
    let hostId = hostOverride || current.fmHostId.trim();
    if (!hostId && captainThreadId) {
      try { hostId = await resolveHostId(undefined, { threadId: captainThreadId }); }
      catch (error) { throw new Error(`Cannot resolve wake host for captain ${captainThreadId}, home ${fmHome}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!hostId) hostId = await fleetHost() ?? "";
    if (!hostId) throw new Error(`No host configured for Firstmate home ${fmHome}. Run firstmate_deck from its captain thread or set fmHostId.`);
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
      const res = await runFmScript({ script: "wake-drain", args, hostId, fmHome, env: wakeStateEnv(fmHome, captainThreadId), timeoutMs: fmTimeoutMs("wake-drain", undefined), signal });
      // B2: the native WAKE_ACK_REQUIRED line names the raw `bin/fm-wake-drain.sh
      // --ack-through`, which pasted verbatim acks the UNPARTITIONED root queue and can
      // consume another captain's rows. Rewrite it to the partition-safe bb command so
      // the emitted instruction can only ever touch the caller's own plane.
      const out = rewriteWakeAckLine(res.output).trim();
      if (res.exitCode !== 0) throw new Error(`native exit ${res.exitCode}: ${out || "no diagnostic output"}`);
      return out === "" ? "Wake queue empty." : out;
    } catch (error) {
      const message = `Wake drain failed (home ${fmHome}, host ${hostId}): ${error instanceof Error ? error.message : String(error)}`;
      bb.log.warn(message);
      throw new Error(message);
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
    const queuePath = `${wakeStateDir(fmHome, threadId)}/.wake-queue`;
    const fingerprint = await runOnHost(hostId, `sha256sum ${shQuote(queuePath)}`, 15_000);
    if (fingerprint.exitCode !== 0) return;
    const generation = fingerprint.output.split(/\s+/)[0];
    const generationKey = `${budgetKey}:generation`;
    if (await bb.storage.kv.get(generationKey) !== generation) {
      await bb.storage.kv.set(budgetKey, { count: 0, lastRingAt: 0 });
      await bb.storage.kv.set(generationKey, generation);
    }
    const max = Number.isFinite(s.turnEndGuardBudget) ? Math.max(1, Math.trunc(s.turnEndGuardBudget)) : 3;
    // Retain unresolved wakes without starting an unlimited sequence of turns.
    const raw = await bb.storage.kv.get(budgetKey);
    const state =
      raw !== null && typeof raw === "object"
        ? (raw as { count?: number; lastRingAt?: number })
        : { count: typeof raw === "number" ? raw : 0, lastRingAt: 0 };
    const count = typeof state.count === "number" ? state.count : 0;
    const now = Date.now();
    let nextCount = count;
    if (count < max) {
      nextCount = count + 1;
    } else {
      bb.log.warn(`turn-end guard: ${pending} wakes remain for ${threadId}; automatic re-ring budget exhausted. Queue retained for captain action.`);
      return;
    }
    await bb.storage.kv.set(budgetKey, { count: nextCount, lastRingAt: now });
    const tag = `${nextCount}/${max}`;
    try {
      await bb.sdk.threads.send({
        // Evidence (b), proven live: `mode: steer` to an IDLE thread STARTS a fresh
        // turn (status idle→active); `queue-if-active` only queues without starting
        // one. The captain is idle here (this fires on thread.idle), and the whole
        // point is to make it take another turn to drain — so steer is required.
        threadId,
        mode: "steer",
        input: captainWakeInput(
          `${pending} crew update(s) still need attention. ` +
          "Use `firstmate_wake` with ack=true, handle them, then continue.",
        ),
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
    opts: { hostId?: string; projectId?: string; home?: string } = {},
  ): Promise<{ exitCode: number | null; output: string } | null> {
    const fmHome = opts.home ?? (await settings.get()).fmHome.trim();
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
    opts: { hostId?: string; projectId?: string; home?: string } = {},
  ): Promise<{ exitCode: number | null; output: string } | null> {
    const fmHome = opts.home ?? (await settings.get()).fmHome.trim();
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
  // F2: the real away-record (state/.afk-contract) and flag (state/.afk) are
  // HOST-LEVEL, not per-captain. The native `fm-watch` keeper is one process per
  // fmHome and reads the UNSCOPED $FM_HOME/state paths; scoping the record to
  // cap-<captain>/ (an earlier D3 attempt) meant the keeper saw NO captain's away
  // posture and silently disabled native away-automation host-wide, while the
  // plugin wrote somewhere the keeper never reads — a write/read split-brain. So
  // the real contract stays where native reads it (one per-home posture, exactly
  // native firstmate's own model), and only the KV notification posture is scoped
  // per captain (that is the layer that drove the cross-captain doorbell holds the
  // D3 defect was about). No split-brain: plugin write and native read are the same
  // path. See the D3 note on readAfk/writeAfk for the KV side.
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
    // F2: host-level flag (see runAfkContract) — the native keeper reads this exact
    // unscoped path.
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
    const flag = `${fmHome}/state/.afk`; // F2: host-level, as native reads it
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
  async function writeHostFile(hostId: string, path: string, content: string, signal?: AbortSignal): Promise<boolean> {
    return writeHostBytes(hostId, path, content, 15_000, signal);
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

  function memoryCacheKey(key: string): string {
    const scope = homeScope.getStore();
    return scope?.home && scope.captain ? `${key}:${scope.captain}` : key;
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
    kvKey = memoryCacheKey(kvKey);
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
    const cap = await bb.storage.kv.get<unknown>(memoryCacheKey(MEM_CAPTAIN_KEY));
    const learn = await bb.storage.kv.get<unknown>(memoryCacheKey(MEM_LEARNINGS_KEY));
    return { captain: typeof cap === "string" ? cap : "", learnings: typeof learn === "string" ? learn : "", source: "kv" };
  }

  async function memorySetCaptain(text: string): Promise<void> {
    return withMemoryLock(async () => {
      if (await memoryIsReal()) {
        if (await writeMemoryFile(MEM_CAPTAIN_FILE, text)) {
          // D2: KV mirrors the real file EXACTLY (cache/projection) — never a raw
          // byte-slice that could desync the mirror from the authoritative file.
          await bb.storage.kv.set(memoryCacheKey(MEM_CAPTAIN_KEY), text);
          await refreshCaptainMemory();
          return;
        }
        throw new Error("Native captain memory write failed; cache unchanged.");
      }
      await bb.storage.kv.set(memoryCacheKey(MEM_CAPTAIN_KEY), text);
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
          if (arch === null) throw new Error("Native learnings archive unreadable; nothing changed.");
          const archNext = `${arch !== "" ? `${arch}\n` : ""}${overflow}`;
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
          await bb.storage.kv.set(memoryCacheKey(MEM_LEARNINGS_KEY), next);
          await refreshCaptainMemory();
          return;
        }
        throw new Error("Native learning write failed; cache unchanged.");
      } else {
        throw new Error("Native learnings unreadable; cache unchanged.");
      }
    }
    const prev = await bb.storage.kv.get<unknown>(memoryCacheKey(MEM_LEARNINGS_KEY));
    const line = `- ${date}: ${text}`;
    const raw = `${typeof prev === "string" && prev !== "" ? `${prev}\n` : ""}${line}`;
    // D2: kv-only mode has no archive, so overflow (oldest WHOLE lines) is dropped,
    // but the boundary is always a full line — never a mid-line byte-slice.
    const { kept } = capLearnings(raw);
    await bb.storage.kv.set(memoryCacheKey(MEM_LEARNINGS_KEY), kept);
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
          await bb.storage.kv.set(memoryCacheKey(MEM_LEARNINGS_KEY), lines.join("\n"));
          await refreshCaptainMemory();
          return lines.length;
        }
        throw new Error("Native learning drop failed; cache unchanged.");
      } else {
        throw new Error("Native learnings unreadable; cache unchanged.");
      }
    }
    const prev = await bb.storage.kv.get<unknown>(memoryCacheKey(MEM_LEARNINGS_KEY));
    const lines = typeof prev === "string" ? prev.split("\n").filter((l) => l !== "") : [];
    if (!Number.isInteger(n) || n < 1 || n > lines.length) return -1;
    lines.splice(n - 1, 1);
    await bb.storage.kv.set(memoryCacheKey(MEM_LEARNINGS_KEY), lines.join("\n"));
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
          if (prevArch === null) throw new Error("Native memory archive unreadable; nothing cleared.");
          const archNext = `${prevArch !== "" ? `${prevArch}\n` : ""}<!--cleared:${stamp}-->\n${cur}`;
          if (!(await writeMemoryFile(archiveRel, archNext))) {
            bb.log.warn(`real memory: clear ${which} refused — archive write failed (nothing cleared)`);
            return false;
          }
        } else if (cur === null) {
          bb.log.warn(`real memory: clear ${which} refused — current contents unreadable (nothing cleared)`);
          return false;
        }
        if (!(await writeMemoryFile(rel, ""))) {
          throw new Error(`Native memory clear ${which} failed after archive; cache unchanged.`);
        }
      }
      await bb.storage.kv.set(memoryCacheKey(which === "captain" ? MEM_CAPTAIN_KEY : MEM_LEARNINGS_KEY), "");
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
  // syncAfkFlag recomputes the HOST-LEVEL .afk flag (F2) from the CALLING captain's
  // per-captain KV posture. The flag is native's single per-home posture, so the
  // most recent captain toggle owns it (last-write-wins) — exactly how native's
  // one-home model behaves. captainThreadId selects whose KV is read; the write
  // target is always the host-level flag.
  async function syncAfkFlag(captainThreadId: string | undefined, quietOverride?: boolean): Promise<boolean> {
    const afkReal = await afkIsReal();
    const quietReal = await quietIsReal();
    if (!afkReal && !quietReal) return true; // neither projects to .afk
    const away = afkReal && (await readAfk(captainThreadId))?.on === true;
    const quiet = quietReal && (quietOverride ?? (await readQuiet(captainThreadId)).on);
    const mode = away ? "away" : quiet ? "quiet" : null;
    return writeAfkFlag(mode);
  }

  let afkTransition = Promise.resolve();
  async function withAfkTransition<T>(operation: () => Promise<T>): Promise<T> {
    const previous = afkTransition;
    let release!: () => void;
    afkTransition = new Promise<void>(resolve => { release = resolve; });
    await previous;
    try { return await operation(); } finally { release(); }
  }

  // Project AFK on/off into the real durable contract (state/.afk-contract) so
  // fm-merge-authority-lib and fm-watch see the same away authority, plus the
  // shared state/.afk flag. KV still owns held-ping delivery. Grant lists are
  // retired in native; commit KV only after the native transition succeeds.
  function projectAfkOn(words: string, grants: string[], captainThreadId: string | undefined) {
    return withAfkTransition(() => enterAfk(words, grants, captainThreadId));
  }
  async function enterAfk(words: string, grants: string[], captainThreadId: string | undefined): Promise<{ contract: boolean; text: string }> {
    if (grants.length > 0) throw new Error("Native Firstmate retired --grant. Put the captain's mandate in the away words.");
    const previous = await readAfk(captainThreadId);
    let contract = false;
    let text = "";
    if (await afkIsReal()) {
      const entered = await runAfkContract(["enter", "--words", words]);
      if (entered === null || entered.exitCode !== 0) {
        throw new Error(`Native AFK entry failed: ${entered?.output.slice(-800) || "host unavailable"}`);
      }
      contract = true;
      text = entered.output.trim();
    }
    await writeAfk({
      on: true,
      words: words.trim() !== "" ? words : previous?.on ? previous.words : "",
      since: previous?.on ? previous.since : new Date().toISOString(),
      lastEntryAt: new Date().toISOString(),
      held: previous?.held ?? [],
    }, captainThreadId);
    await syncAfkFlag(captainThreadId);
    return { contract, text };
  }

  function projectAfkOff(captainThreadId: string | undefined) {
    return withAfkTransition(() => exitAfk(captainThreadId));
  }
  async function nativeReturn(captainThreadId: string | undefined): Promise<void> {
    const current = await settings.get();
    const hostId = await fleetHost();
    if (!hostId) throw new Error("Native AFK return host unavailable.");
    const result = await runFmScript({ script: "afk-return", args: ["begin"], fmHome: current.fmHome, hostId, timeoutMs: 180_000 });
    await bb.storage.kv.set(`native-return:${captainThreadId ?? "legacy"}`, result.output);
    // Exit 3 retains the blocker gate; away mode has ended.
    if (result.exitCode !== 0 && result.exitCode !== 3) requireNativeSuccess(result, "AFK return");
  }

  async function exitAfk(captainThreadId: string | undefined): Promise<void> {
    if (await afkIsReal()) await nativeReturn(captainThreadId);
    await writeAfk({ on: false, words: "", since: new Date().toISOString(), held: [] }, captainThreadId);
    await syncAfkFlag(captainThreadId);
  }

  async function guardReturnCatchup(hostId: string, fmHome: string): Promise<void> {
    // Active away mode is allowed to dispatch under native's away authority.
    // The catch-up marker is separate: ordinary work waits for its native check.
    const result = await runOnHost(hostId, [
      ...fmBackendEnv({ hostId, fmHome }), fmBinDirAssign(fmHome),
      `if [ -f ${shQuote(`${fmHome}/state/.afk-return-catchup`)} ]; then "$FM_BINDIR/fm-afk-return.sh" check; fi`,
    ].join("\n"), 180_000);
    requireNativeSuccess(result, "AFK catch-up");
  }

  // Match native authority to one BB captain before treating chat as a return.
  // Old plugin wakes were labeled "user", so initiator alone is insufficient.
  function reconcileReturnedAfk(captainThreadId: string | undefined) {
    return withAfkTransition(() => reconcileReturnedAfkLocked(captainThreadId));
  }
  async function reconcileReturnedAfkLocked(captainThreadId: string | undefined): Promise<boolean> {
    if (!captainThreadId || !(await afkIsReal())) return false;
    const previous = await readAfk(captainThreadId);
    if (!previous?.on) return false;
    const current = await settings.get();
    const hostId = await fleetHost();
    if (!hostId) return false;
    const home = current.fmHome.trim();
    const contract = `${home}/state/.afk-contract`;
    const library = `${home}/bin/fm-afk-contract.sh`;
    const prelude = [
      `export FM_HOME=${shQuote(home)}`,
      `export FM_STATE_OVERRIDE=${shQuote(`${home}/state`)}`,
      `. ${shQuote(library)}`,
    ];
    const cachedEpoch = Math.floor(Date.parse(previous.since) / 1000);
    if (!Number.isSafeInteger(cachedEpoch)) return false;
    const snapshot = await runOnHost(hostId, [
      ...prelude,
      `__fm_source=live`,
      `fm_bb_afk_identity() {`,
      `  local __fm_record=$1`,
      `  fm_afk_contract_validate "$__fm_record" >/dev/null 2>&1 || return 0`,
      `  printf 'FM_AFK_ID\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$(sha256sum "$__fm_record" | cut -d' ' -f1)" "$(fm_afk_contract_read_field "$__fm_record" entered_epoch)" "$(fm_afk_contract_read_field "$__fm_record" confirmed_epoch)" "$(fm_afk_contract_read_words "$__fm_record" | base64 | tr -d '\\n')" "$__fm_source"`,
      `}`,
      `if [ -f ${shQuote(contract)} ]; then fm_bb_afk_identity ${shQuote(contract)}; else`,
      `  __fm_source=archive`,
      // Legacy KV was timestamped around, rather than by, native entry.
      `  for __fm_epoch in $(seq ${cachedEpoch - 4} ${cachedEpoch + 4}); do`,
      `    __fm_record=$(${shQuote(library)} archived "$__fm_epoch" 2>/dev/null) || continue`,
      `    fm_bb_afk_identity "$__fm_record"`,
      `  done`,
      `fi`,
    ].join("\n"), 15_000);
    if (snapshot.exitCode !== 0) return false;
    const identities = [...snapshot.output.matchAll(/^FM_AFK_ID\t([a-f0-9]{64})\t(\d+)\t(\d+)\t([A-Za-z0-9+/=]*)\t(live|archive)$/gm)];
    const matches = identities.filter(match =>
      Buffer.from(match[4]!, "base64").toString("utf8") === previous.words
      && Math.abs(Date.parse(previous.since) - Number(match[2]) * 1000) < 5000);
    if (matches.length !== 1) return false;
    const [, digest, entered, confirmed, encodedWords, source] = matches[0]!;
    const words = Buffer.from(encodedWords!, "base64").toString("utf8");
    const owns = (state: AfkState | null) => state?.on === true
      && state.words === words
      && Math.abs(Date.parse(state.since) - Number(entered) * 1000) < 5000;
    for (const key of await bb.storage.kv.list(`${AFK_KEY}:cap-`)) {
      if (key === afkKvKey(captainThreadId)) continue;
      const parsed = afkSchema.safeParse(await bb.storage.kv.get(key));
      if (parsed.success && owns(parsed.data)) return false; // ambiguous legacy owner
    }

    const accepted = new Set<string>();
    let beforeSeq: string | undefined;
    let returnRequest: { seq: number; requestId: string; at: number } | undefined;
    const boundary = Math.max(Number(confirmed) * 1000 + 1000, Date.parse(previous.lastEntryAt ?? "") || 0);
    // Bound recovery reads; keep authority unchanged if the return is beyond them.
    for (let page = 0; page < 8 && !returnRequest; page++) {
      const rows = await bb.sdk.threads.events.list({
        threadId: captainThreadId, order: "desc", limit: "100", beforeSeq,
        types: ["client/turn/requested", "turn/input/accepted"],
      });
      if (!rows.length) break;
      for (const row of rows) {
        if (row.createdAt <= boundary) continue;
        const data = asRecord(row.data);
        if (row.type === "turn/input/accepted" && typeof data["clientRequestId"] === "string") {
          accepted.add(data["clientRequestId"]);
          continue;
        }
        if (row.type !== "client/turn/requested" || data["initiator"] !== "user"
          || data["senderThreadId"] != null || data["originPluginId"] != null
          || (data["systemMessageKind"] != null && data["systemMessageKind"] !== "unlabeled")) continue;
        const id = data["requestId"];
        if (typeof id !== "string" || !accepted.has(id)) continue;
        const blocks = Array.isArray(data["input"]) ? data["input"].map(asRecord) : [];
        if (blocks.some(block => block["visibility"] === "agent-only")) continue;
        const text = blocks.filter(block => block["type"] === "text").map(block => block["text"]).filter(value => typeof value === "string").join("\n").trim();
        if (/^\/(?:firstmate:)?afk\b/i.test(text)) return false;
        if (!text || text.includes("FIRSTMATE INTERNAL WAKE") || text.includes("FIRSTMATE_OP:")
          || /^(?:🔔|🛰️\s*fm-watch:)/u.test(text)) continue;
        returnRequest = { seq: row.seq, requestId: id, at: row.createdAt };
        break;
      }
      const oldest = rows.at(-1)!;
      if (oldest.createdAt <= boundary || beforeSeq === String(oldest.seq)) break;
      beforeSeq = String(oldest.seq);
    }
    if (!returnRequest) return false;
    if (captainThreadId && captainHomes.get(captainThreadId) === home) {
      await nativeReturn(captainThreadId);
      await writeAfk({ ...previous, on: false }, captainThreadId);
      await bb.storage.kv.set(`afk-return-evidence${captainScopeSuffix(captainThreadId)}`, returnRequest);
      return true;
    }
    const quiet = (await quietIsReal()) && (await readQuiet(captainThreadId)).on;
    const archived = await runOnHost(hostId, [
      ...prelude,
      "fm_afk_contract_lock_hold || exit 1",
      "trap 'fm_afk_contract_lock_release || true' EXIT",
      ...(source === "archive" ? [
        `[ ! -f ${shQuote(contract)} ] || { echo 'AFK record changed during return reconciliation; retry.' >&2; exit 1; }`,
        `__fm_archived=$(${shQuote(library)} archived ${entered}) || exit 1`,
        `[ "$(sha256sum "$__fm_archived" | cut -d' ' -f1)" = ${shQuote(digest!)} ] || exit 1`,
        `printf '%s\\n' "$__fm_archived"`,
      ] : [
        `[ -f ${shQuote(contract)} ] || exit 3`,
        `[ "$(sha256sum ${shQuote(contract)} 2>/dev/null | cut -d' ' -f1)" = ${shQuote(digest!)} ] || { echo 'AFK record changed during return reconciliation; retry.' >&2; exit 1; }`,
        "fm_afk_contract_cmd_archive || exit 1",
      ]),
      quiet ? `printf 'quiet\\n' > ${shQuote(`${home}/state/.afk`)}` : `rm -f ${shQuote(`${home}/state/.afk`)}`,
    ].join("\n"), 150_000);
    if (archived.exitCode === 3) return false; // Another return already archived it.
    if (archived.exitCode !== 0) throw new Error(`AFK return reconciliation failed: ${archived.output.slice(-500)}`);
    await bb.storage.kv.set(`afk-return-evidence${captainScopeSuffix(captainThreadId)}`, {
      ...returnRequest, digest, archivedPath: archived.output.trim(),
    });
    // Keep held reports and the mandate for the normal afk off return brief.
    await writeAfk({ ...previous, on: false }, captainThreadId);
    bb.log.info(`archived stale AFK after accepted human return captain=${captainThreadId} seq=${returnRequest.seq}`);
    return true;
  }

  // Native validates the durable mandate; the legacy grants field stays empty.
  // Host-level away authority (F2): the native keeper and merge-authority read this
  // same host-level contract, so status/bearings reflect the real per-home posture.
  async function realAfkAuthority(): Promise<{ confirmed: boolean; grants: string[] } | null> {
    if (!(await afkIsReal())) return null;
    const valid = await runAfkContract(["validate"]);
    if (valid === null) return null;
    if (valid.exitCode !== 0) return { confirmed: false, grants: [] };
    return { confirmed: true, grants: [] };
  }

  // Project quiet on/off into the shared native state/.afk flag. Recomputed from
  // both owners (F2), so turning quiet off never deletes an active away flag, and
  // turning quiet on never overwrites away. Native write succeeds before KV changes.
  async function projectQuiet(on: boolean, captainThreadId: string | undefined): Promise<void> {
    if (!(await quietIsReal())) return;
    const ok = await syncAfkFlag(captainThreadId, on);
    if (!ok) throw new Error("Native quiet transition failed; BB posture unchanged.");
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
  function requireNativeSuccess(result: { exitCode: number | null; output: string } | null, operation: string): void {
    if (result !== null && result.exitCode === 0) return;
    const reason = result === null ? "host unavailable" : `exit ${result.exitCode}: ${truncate(result.output, 1600)}`;
    bb.log.error(`Native ${operation} failed: ${reason}`);
    throw new Error(`Native ${operation} failed: ${reason}. BB state was not advanced; reconcile native state before retrying.`);
  }

  async function projectQueueAdd(id: string, title: string, shape: Shape, projectId: string): Promise<{ ok: boolean }> {
    if (!(await queueIsReal())) return { ok: false };
    const res = await runTasksAxi(["add", id, title.slice(0, 500), "--kind", shape], { projectId });
    requireNativeSuccess(res, `backlog add ${id}`);
    return { ok: true };
  }

  // Drive the paired backlog transition for a KV queue item. verb: start|done|rm.
  async function projectQueueTransition(item: QueueItem, verb: "start" | "done" | "rm"): Promise<void> {
    if (!(await queueIsReal())) return;
    if (item.backlogId === undefined || item.backlogId === "") {
      throw new Error(`Native backlog ${verb} refused: queue ${item.id} has no native row. Reconcile it before continuing.`);
    }
    const res = await runTasksAxi([verb, item.backlogId], { projectId: item.projectId, home: item.nativeHome });
    requireNativeSuccess(res, `backlog ${verb}`);
  }

  // C1: close the crew's OWN backlog row (id = crew id) on the terminal events a
  // crew reaches directly (land → done, forget/drop → rm), mirroring the queue
  // item lifecycle. F2: gate on whether the crew was DISPATCHED with a real backlog
  // row (crew.backlogRow, recorded at dispatch) — NOT on live settings. The row is
  // ownership: a crew dispatched under real transport whose settings later flip to
  // native/kv must still close its row, or it strands in_flight forever. A crew
  // that never owned a row (native transport, legacy) is a no-op. Secondmate routes
  // are not backlog items. Best-effort: an already-terminal or absent row just logs
  // (rm of a missing row is harmless). runTasksAxi still needs fmHome+host; if
  // unreachable it logs and the row is closed on the next reconcile.
  async function realBacklogTransitionForCrew(crew: Crew, verb: "done" | "rm"): Promise<void> {
    if (isSecondmateRoute(crew)) return;
    if (crew.backlogRow !== true) return;
    const res = await runTasksAxi([verb, crew.id], { projectId: crew.projectId, home: await crewNativeHome(crew) });
    requireNativeSuccess(res, `backlog ${verb}`);
  }

  async function decisionsIsReal(): Promise<boolean> {
    const s = await settings.get();
    return s.decisionsOwner === "real" && s.fmHome.trim() !== "";
  }

  // A decision is an ordinary captain-held backlog task (captain-hold-lifecycle):
  // Linked calls hold the existing crew task; standalone calls use the decision id.
  async function projectDecisionAsk(d: Decision): Promise<void> {
    if (!(await decisionsIsReal())) return;
    if (!/^[A-Za-z0-9._-]+$/.test(d.id)) return;
    if (d.crewId) {
      const crew = await findCrew(d.crewId);
      if (!crew) throw new Error(`No crew ${d.crewId} for this captain call.`);
      d.nativeHome = await crewNativeHome(crew);
      d.nativeTaskId = crew.id;
    }
    const res = await runCaptainHold(
      ["hold", d.nativeTaskId ?? d.id, "--title", d.question.slice(0, 200), "--reason", "captain decision via BB firstmate_decide"],
      { home: d.nativeHome },
    );
    requireNativeSuccess(res, "decision update");
  }

  // Answer closes the captain-held row and writes the resolved close to the linked
  // crew's state/<id>.status via the existing appendResolvedStatus.
  async function projectDecisionAnswer(d: Decision, answer: string): Promise<void> {
    if (!(await decisionsIsReal())) return;
    if (!/^[A-Za-z0-9._-]+$/.test(d.id)) return;
    const fmHome = d.nativeHome ?? (await settings.get()).fmHome.trim();
    const hostId = await fleetHost();
    if (fmHome === "" || hostId === null) {
      throw new Error(`Native decision ${d.id}: host unavailable.`);
    }
    const tmp = `${fmHome}/state/.bb-decision-${d.id}.answer`;
    // F1: base64 payload, never in the command text (no heredoc-delimiter injection).
    if (!(await writeHostFile(hostId, tmp, answer.slice(0, 2000)))) {
      throw new Error(`Native decision ${d.id}: could not persist answer.`);
    }
    const res = await runCaptainHold(["answer", d.nativeTaskId ?? d.id, "--decision-file", tmp, ...(d.nativeTaskId ? ["--release"] : [])], { home: d.nativeHome });
    await runOnHost(hostId, `rm -f ${shQuote(tmp)}`, 10_000).catch(() => {});
    requireNativeSuccess(res, "decision update");
    // Also write the resolved close on the linked crew's own status log.
    if (d.crewId !== null) {
      const crew = await findCrew(d.crewId);
      if (crew !== undefined && !(await appendResolvedStatus(crew, d.id, answer))) throw new Error("Native decision recorded, but crew status could not be resolved. Repair the status before resuming the worker.");
    }
  }

  async function projectDecisionDefer(d: Decision, until: string | null): Promise<void> {
    if (!(await decisionsIsReal())) return;
    if (!/^[A-Za-z0-9._-]+$/.test(d.id)) return;
    const args = ["hold", d.nativeTaskId ?? d.id, "--reason", "deferred via BB firstmate_decide"];
    if (until !== null && /^\d{4}-\d{2}-\d{2}$/.test(until)) args.push("--until", until);
    const res = await runCaptainHold(args, { home: d.nativeHome });
    requireNativeSuccess(res, "decision update");
  }

  async function projectDecisionDrop(id: string): Promise<void> {
    if (!(await decisionsIsReal())) return;
    if (!/^[A-Za-z0-9._-]+$/.test(id)) return;
    const row = (await readDecisions()).find(d => d.id === id);
    if (row?.nativeTaskId) return projectDecisionAnswer(row, "Captain dropped this decision.");
    const res = await runTasksAxi(["rm", id], { home: row?.nativeHome });
    requireNativeSuccess(res, "decision update");
  }

  async function readToolActivity(threadId: string, signal?: AbortSignal): Promise<{ ok: true; at: number | null } | { ok: false }> {
    try {
      const rows = await raceAbort(
        bb.sdk.threads.events.list({
          threadId,
          order: "desc",
          limit: "1",
          types: TOOL_ACTIVITY_TYPES,
        }),
        signal,
        STUCK_HOST_CALL_MS,
      );
      if (!Array.isArray(rows)) return { ok: false };
      const row = rows[0];
      if (row === undefined) return { ok: true, at: null };
      const createdAt = asRecord(row)["createdAt"];
      return typeof createdAt === "number" && Number.isFinite(createdAt)
        ? { ok: true, at: createdAt }
        : { ok: false };
    } catch (error) {
      // An abort during a reload is not a read failure — stay quiet so a shutdown does
      // not masquerade as a broken activity read.
      if (!isAbortError(error)) {
        bb.log.warn(
          `stuck activity read failed for ${threadId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return { ok: false };
    }
  }

  let stuckRebased = false;

  async function crewExcerpt(crew: Crew, signal?: AbortSignal): Promise<{ ok: true; text: string } | { ok: false }> {
    try {
      const result = await raceAbort(bb.sdk.threads.output({ threadId: crew.threadId }), signal, STUCK_HOST_CALL_MS);
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
    return `fm-watch-beat:${hostId}${homeScope.getStore()?.home ? `:${homeScope.getStore()!.home}` : ""}`;
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

  async function resolveFmWatchHostId(signal?: AbortSignal): Promise<string | null> {
    const s = await settings.get();
    if (s.fmHostId.trim() !== "") return s.fmHostId.trim();
    try {
      for (const crew of await readCrews()) {
        if (signal?.aborted) break;
        if (isSecondmateRoute(crew)) continue;
        try {
          const hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined, signal);
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
  async function resolveFmWatchHosts(signal?: AbortSignal): Promise<string[]> {
    const hosts = new Set<string>();
    const s = await settings.get();
    if (s.fmHostId.trim() !== "") hosts.add(s.fmHostId.trim());
    try {
      for (const crew of await readCrews()) {
        if (signal?.aborted) break;
        if (isSecondmateRoute(crew)) continue;
        try {
          const hostId = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined, signal);
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
    const pid = `${fmHome}/${FM_WATCH_KEEPER_PID}`;
    const keeperScript = `${fmHome}/${FM_WATCH_KEEPER_SH}`;
    const ownerBeat = `${fmHome}/${FM_WATCH_OWNER_BEAT}`;
    const interval = fmWatchKeeperInterval(graceSec);
    // Phase 1: refresh the owner beat (D7 self-exit heartbeat — written BEFORE any
    // keeper launch so a freshly launched keeper always sees a fresh beat), then read
    // beacon age + keeper liveness + a log tail (no other side effects).
    const readScript = [
      fmBinDirAssign(fmHome),
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
      `[ -x "$FM_BINDIR/fm-watch-arm.sh" ] || echo FM_WATCH_NO_ARM`,
      // F2 (re-review): supervision runs fm-watch-arm FROM the mirror, so a stale mirror
      // here degrades supervision silently. Check on every supervision poll; the emitted
      // FM_MIRROR_STALE line is surfaced loudly by the caller below.
      fmMirrorStaleGuard(fmHome),
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
      // F2 (re-review): a stale mirror on the SUPERVISION path (this poll's own guard, or
      // the keeper's re-arm guard captured in the log tail) means the watcher fm-watch is
      // armed from unmirrored/drifted scripts — supervision degrading silently. Surface it
      // loudly on the supervision channel too, not just on dispatch.
      if (res.output.includes("FM_MIRROR_STALE")) {
        const line = res.output.split("\n").find((l) => l.includes("FM_MIRROR_STALE"))?.trim() ?? "FM_MIRROR_STALE";
        bb.log.error(
          `fm-watch-supervisor: bb mirror is STALE on host ${hostId}: ${line}. The keeper re-arms fm-watch from this mirror, so supervision is degrading — re-run the overlay installer against ${fmHome}.`,
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
        const wrote = await writeHostFile(hostId, keeperScript, fmWatchKeeperScript(hostId, fmHome, interval), signal);
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

  // R2/D-noise: relay fm-watch's actionable stale: and check: lines. Upstream defines
  // every check: result as actionable (inbox requests, process events, contribution
  // results, merge checks, and rejected/failed checks), so dropping them can leave the
  // manager asleep with durable work waiting. A stale: line is the wedge/outage
  // backstop — a genuinely stuck crew, an unread steering instruction, or an
  // unwritable-bookkeeping outage. A signal: line is the OTHER thing: it is only a list of
  // state/<id>.status file PATHS meaning "a status file changed" — a routine turn-end
  // pointer whose captain-relevant content (done/blocked/needs-decision) is ALREADY
  // delivered as a human line by notifyCaptain (thread.idle/failed → doorbell) and
  // persisted in the durable wake queue. Relaying the raw path list on top of that is
  // pure duplication that tells the captain nothing, so it is dropped. heartbeat/
  // watcher: are routine trace and are never relayed. Delivery is agent-only, so these
  // internal wake reasons activate the manager without becoming captain-chat noise.
  // Newest few only.
  function extractWatchReasons(logTail: string): string[] {
    return logTail
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => /^(?:stale|check):/.test(l))
      .slice(-8);
  }

  // R2 dedup key: drop volatile counters/timestamps so the same wedge is not
  // re-paged every cycle just because a "3m→4m" or epoch changed. A check line's
  // numbers can be request ids or receipt sequences, so preserve it byte-for-byte;
  // otherwise two queued captain requests can collapse into one notification.
  function relayDedupKey(line: string): string {
    return watchRelayDedupKey(line);
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
  const RELAY_MAX_ATTEMPTS = 20;
  const relayAttempts = new Map<string, number>();
  async function relayWatchReasons(lines: string[], hostId: string, seen: Set<string>, signal?: AbortSignal): Promise<void> {
    if (lines.length === 0) return;
    const crews = await readCrews();
    const crewsOnHost: Crew[] = [];
    for (const crew of crews) {
      if (signal?.aborted) return;
      if (isSecondmateRoute(crew)) continue;
      try {
        if ((await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined, signal)) === hostId) crewsOnHost.push(crew);
      } catch {
        // unresolved host → not attributed to this host's fallback set
      }
    }
    const hostParents = new Set(crewsOnHost.map((c) => c.parentThreadId).filter((p): p is string => p !== null && p !== ""));
    // Home-wide wakes (for example captain inbox notes) may name no crew. `/captain`
    // records the manager for this host, so those events still wake it when the fleet
    // is empty. Before any deck is recorded, fall back only when one captain owns crews
    // on this host; never fan an unattributable line across managers.
    const scope = homeScope.getStore();
    const remembered = await bb.storage.kv.get<unknown>(`${FM_WATCH_CAPTAIN_PREFIX}${hostId}`);
    let rememberedCaptain = scope?.captain ?? (typeof remembered === "string" && remembered !== "" ? remembered : undefined);
    let hostFallback = hostParents.size === 1 ? [...hostParents][0]! : undefined;
    if (!scope?.home) {
      // The base home's unattributed lines belong to a captain on the base home, never to
      // a captain that owns its own home (that captain's home has its own watcher). The
      // host key only remembers who last took the deck, whatever project that was.
      const baseHome = (await settings.get()).fmHome.trim();
      const ownsOtherHome = async (captain: string | undefined): Promise<boolean> => {
        if (captain === undefined) return false;
        const home = await bb.storage.kv.get<unknown>(`native-home:${captain}`);
        return typeof home === "string" && home !== "" && home !== baseHome;
      };
      if (await ownsOtherHome(rememberedCaptain)) rememberedCaptain = undefined;
      if (await ownsOtherHome(hostFallback)) hostFallback = undefined;
    }
    const soleHostParent = rememberedCaptain ?? hostFallback;
    const ownedCrews = crews.filter((c) => c.parentThreadId !== null && c.parentThreadId !== "" && (!scope?.home || c.nativeHome === scope.home || (!c.nativeHome && c.parentThreadId === scope.captain)));
    // Stale lines name crews by BB thread id; only a crew whose thread is still
    // running can be wedged. An idle/failed thread already rang its doorbell.
    const knownCrewThreads = new Set(ownedCrews.map((c) => c.threadId).filter((t) => t !== ""));
    const runningCrewThreads = new Set<string>();
    for (const threadId of new Set(lines.filter((l) => /^stale:/.test(l)).flatMap(watchLineThreadIds))) {
      if (!knownCrewThreads.has(threadId)) continue;
      try {
        const status = (await bb.sdk.threads.get({ threadId })).status;
        if (status !== "idle" && status !== "error") runningCrewThreads.add(threadId);
      } catch {
        runningCrewThreads.add(threadId); // unknown state: keep the wedge backstop
      }
    }
    // Group per target parent so each captain gets one message. A dropped line is marked
    // seen at once; a delivered line only per captain AFTER that captain's delivery
    // succeeded (a held wake counts), so a failed send (e.g. HTTP 409 for an errored
    // captain) is retried on the next cycle instead of being lost. A line that keeps
    // failing is given up after RELAY_MAX_ATTEMPTS so it cannot retry forever.
    const byParent = new Map<string, Array<{ text: string; key: string }>>();
    const pushFor = (parent: string, text: string, key: string) => {
      const arr = byParent.get(parent) ?? [];
      arr.push({ text, key: `${key}>${parent}` });
      byParent.set(parent, arr);
    };
    for (const line of lines) {
      const key = `${hostId}|${relayDedupKey(line)}`;
      if (seen.has(key)) continue;
      const stale = staleLineRelayDecision({ line, knownCrewThreads, runningCrewThreads });
      if (stale === "drop-finished" || stale === "drop-foreign") {
        seen.add(key);
        bb.log.info(`fm-watch relay: dropping ${stale === "drop-finished" ? "stale line for a finished crew" : "stale line for a crew outside this scope"}: ${truncate(line, 160)}`);
        continue;
      }
      // Every known crew whose id or thread id appears in this line, grouped by owning captain.
      const mentioned = ownedCrews.filter((c) => line.includes(c.id) || (c.threadId !== "" && line.includes(c.threadId)));
      if (mentioned.length === 0) {
        // No crew named: deliver only to a lone host captain, else drop (never fan).
        if (soleHostParent === undefined) {
          seen.add(key);
          bb.log.info(`fm-watch relay: dropping unattributable line on host ${hostId} (${hostParents.size} captains; no crew in line)`);
          continue;
        }
        if (!seen.has(`${key}>${soleHostParent}`)) pushFor(soleHostParent, line, key);
        continue;
      }
      const owners = new Set(mentioned.map((c) => c.parentThreadId!));
      for (const parent of owners) {
        // Redact tokens naming OTHER captains' crews before delivering to this captain.
        const foreignIds = mentioned.filter((c) => c.parentThreadId !== parent).flatMap((c) => (c.threadId !== "" ? [c.id, c.threadId] : [c.id]));
        const filtered = filterLineForOwner(line, foreignIds);
        if (filtered === "" || seen.has(`${key}>${parent}`)) continue;
        pushFor(parent, filtered, key);
      }
    }
    for (const [parent, items] of byParent) {
      if (signal?.aborted) return;
      if (await deliverToCaptain(parent, `🛰️ fm-watch:\n${items.map((i) => i.text).join("\n")}`, "fm-watch", signal)) {
        for (const i of items) { seen.add(i.key); relayAttempts.delete(i.key); }
        continue;
      }
      for (const i of items) {
        const n = (relayAttempts.get(i.key) ?? 0) + 1;
        if (n < RELAY_MAX_ATTEMPTS) { relayAttempts.set(i.key, n); continue; }
        relayAttempts.delete(i.key);
        seen.add(i.key);
        bb.log.warn(`fm-watch relay: giving up on a page for captain ${parent} after ${n} failed deliveries: ${truncate(i.text, 160)}`);
      }
    }
    // Bound the dedup memory.
    if (seen.size > 200) {
      const keep = [...seen].slice(-100);
      seen.clear();
      for (const k of keep) seen.add(k);
    }
  }

  async function stuckPass(signal?: AbortSignal): Promise<{ checked: number; notified: number }> {
    // The pass is abort-aware end to end: `passSignal` fires when the service is stopping
    // (the reload escape hatch) OR when this single pass exceeds its wall-clock budget, so
    // one slow/unreachable host cannot pin the pass even absent a reload. A partial pass is
    // fine — the next cycle re-runs, and the rotation cursor (below) resumes where we left
    // off so nothing is starved.
    const passSignal = AbortSignal.any([
      ...(signal !== undefined ? [signal] : []),
      AbortSignal.timeout(STUCK_PASS_BUDGET_MS),
    ]);
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
          host = await resolveHostForProject(crew.projectId, crew.parentThreadId ?? undefined, passSignal);
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
    // The register is HOST-GLOBAL and keeps growing (~50-67 crews live). Inspect at most
    // MAX_CREWS per pass, starting from a persisted rotation cursor, so a register larger
    // than the cap never starves its tail: successive passes sweep the whole list. (When
    // the eligible list fits under the cap the cursor is inert and every crew is inspected
    // every pass, exactly as before.) The cap + the per-pass wall budget together bound how
    // long one pass can run regardless of how big the register gets.
    const eligibleAll = (await listCrewsAll(passSignal)).filter((c) => c.parentThreadId !== null && !isSecondmateRoute(c));
    const eligibleIds = new Set(eligibleAll.map((c) => c.id));
    const cursorRaw = meta["cursor"];
    const total = eligibleAll.length;
    const start = total === 0 ? 0 : ((((typeof cursorRaw === "number" && Number.isFinite(cursorRaw) ? cursorRaw : 0) % total) + total) % total);
    const rotated = total === 0 ? [] : [...eligibleAll.slice(start), ...eligibleAll.slice(0, start)];
    const crews = rotated.slice(0, MAX_CREWS);
    const parsed = watchStateSchema.safeParse(await bb.storage.kv.get<unknown>("watch"));
    const state: WatchState = parsed.success ? parsed.data : {};
    let notified = 0;
    let inspected = 0;
    // Page the captain, but DEFER (not drop) if a reload aborts the send mid-flight: the
    // send is abort-responsive (no artificial timeout — a healthy send completes), and on
    // abort we return false so the caller leaves the crew's alerted/stuck state untouched
    // and the NEXT pass re-pages. This closes the last unguarded await inside the loop — a
    // captain send under a degraded BB API — so a reload cannot wedge on it either.
    async function pageOrDefer(crew: Crew, event: string, output: string | null): Promise<boolean> {
      try {
        await notifyCaptain(crew, event, output, passSignal);
        return true;
      } catch (error) {
        if (isAbortError(error)) return false;
        throw error;
      }
    }
    for (const crew of crews) {
      // Between crews: stop promptly when the service is aborting (reload) or the pass
      // budget is spent. Partial progress is persisted below; the cursor advances by the
      // number actually inspected so the next pass resumes at the first un-inspected crew.
      if (passSignal.aborted) break;
      inspected++;
      const status = await crewStatus(crew, passSignal);
      // A host read that raced an abort returns a degraded default ("unknown"); do NOT act
      // on it (that would spuriously page on shutdown). Un-count this crew (so the cursor
      // resumes here) and let the next cycle redo it.
      if (passSignal.aborted) {
        inspected--;
        break;
      }
      const prev = state[crew.id];
      if (prev === undefined) {
        if (status === "error" || status === "unknown") {
          const detail = status === "error" ? await crewOutput(crew, 300, passSignal) : null;
          if (!(await pageOrDefer(crew, status, detail))) {
            inspected--;
            break;
          }
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
          const detail = status === "error" ? await crewOutput(crew, 300, passSignal) : null;
          if (!(await pageOrDefer(crew, status, detail))) {
            inspected--;
            break;
          }
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
      const excerpt = await crewExcerpt(crew, passSignal);
      if (passSignal.aborted) {
        inspected--;
        break;
      }
      if (!excerpt.ok) {
        if (prev.alerted !== "unknown") {
          if (!(await pageOrDefer(crew, "unknown", null))) {
            inspected--;
            break;
          }
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
      const activity = await readToolActivity(crew.threadId, passSignal);
      if (passSignal.aborted) {
        inspected--;
        break;
      }
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
      const suppressed = await suppressForCrew(crew);
      // suppressForCrew swallows an aborted host resolve into `false` (do not suppress);
      // do NOT let that spurious-page on shutdown — break before deciding to notify.
      if (passSignal.aborted) {
        inspected--;
        break;
      }
      if (!suppressed && !prev.stuck && now - prev.at >= stuckMs) {
        if (
          !(await pageOrDefer(
            crew,
            `stuck (${outMin}m no output change, no tool/file activity ${actMin}m)`,
            excerpt.text === "" ? null : excerpt.text,
          ))
        ) {
          inspected--;
          break;
        }
        notified++;
        row.stuck = true;
      }
      state[crew.id] = row;
    }
    // Prune against the FULL eligible set (not just the crews inspected this pass): a crew
    // no longer eligible is gone and its row can drop, but a crew merely not reached this
    // rotation must keep its row so its stuck timer is not reset.
    for (const id of Object.keys(state)) {
      if (!eligibleIds.has(id)) delete state[id];
    }
    // Advance the rotation cursor by the crews actually inspected, so the next pass resumes
    // at the first un-inspected crew (fair rotation, no starvation) even after a partial/
    // aborted pass.
    const nextCursor = total === 0 ? 0 : (start + inspected) % total;
    await bb.storage.kv.set("watch", state);
    await bb.storage.kv.set("watch-meta", { lastPassAt: now, checked: inspected, notified, cursor: nextCursor });
    return { checked: inspected, notified };
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
    "  bb firstmate toolchain [--json]   # native AXI + Lavish compatibility, read-only",
    "  bb firstmate init [--real] [--machine m] [--path p] [--name n] [--json]",
    "  bb firstmate scripts [query] [--json]   # list + verify every installed fm-* script",
    "  bb firstmate fm [--timeout s] <script> [args...]   # real bin/fm-<script>.sh with FM_BACKEND=bb",
    "  bb firstmate deck | session [--json]",
    '  bb firstmate dispatch --project <id> [--task t ...] [--shape ship|scout] [--mode m] [--title t] [--provider p] [--model m] [--reasoning-level low|medium|high|xhigh|max] [--permission-mode m] [--shared-env] [--worktree] [--hidden] [--send-at ms] -- "<task>"',
    "  bb firstmate crews | crew <id> | watch [id ...] [--timeout s] [--json]",
    '  bb firstmate tell <id> [--queue] -- "<message>" | interrupt <id> | stop <id> | retry <id> [--model m] [--provider p] [--reasoning-level l] [--reason r]',
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

  function markCaptainToolResult(
    result: string | { content: Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>; isError?: boolean },
  ) {
    const marker = typeof result === "string" || result.isError !== true
      ? FIRSTMATE_ROUTINE_MARKER
      : FIRSTMATE_ATTENTION_MARKER;
    if (typeof result === "string") return `${result}${marker}`;
    return {
      ...result,
      content: [...result.content, { type: "text" as const, text: marker }],
    };
  }

  // BB's public suppress flag only folds low-value rows. The app content script
  // removes Firstmate's pending/success rows entirely; invisible result markers
  // let it restore failures while keeping the tool output available to the model.
  const registerCaptainTool = ((tool: Parameters<BbPluginApi["agents"]["registerTool"]>[0]) => {
    const execute = tool.execute as (
      params: unknown,
      ctx: Parameters<Parameters<BbPluginApi["agents"]["registerTool"]>[0]["execute"]>[1],
    ) => ReturnType<Parameters<BbPluginApi["agents"]["registerTool"]>[0]["execute"]>;
    bb.agents.registerTool({
      ...tool,
      presentation: { ...tool.presentation, suppress: true },
      async execute(params, ctx) {
        try {
          return await withLedgerOperation(tool.name, ctxString(ctx, "threadId"), () => inCaptainHome(ctxString(ctx, "threadId"), async () => markCaptainToolResult(await execute(params, ctx))));
        } catch (error) {
          const message = error instanceof Error ? error.message : "Firstmate tool failed.";
          return markCaptainToolResult(toolError(message));
        }
      },
    });
  }) as BbPluginApi["agents"]["registerTool"];

  async function readCaptainContract(ctx: unknown, section?: string) {
    const current = await settings.get();
    if (current.fmHome.trim() === "") return toolError("Initialize real Firstmate with firstmate_deck first.");
    const hostId = current.fmHostId.trim() || await resolveHostId(undefined, ctx);
    const path = `${current.fmHome}/AGENTS.md`;
    const result = await bb.sdk.files.read({ hostId, path });
    if (!("content" in result)) return toolError("Native contract read returned no content.");
    if (result.sizeBytes > 200_000) return toolError("Native contract exceeds 200KB; read it directly in the Firstmate home.");
    const content = result.contentEncoding === "base64"
      ? Buffer.from(result.content, "base64").toString("utf8") : result.content;
    const picked = selectContract(content, section);
    const done = picked.complete
      ? "The firstmate_contract read is now complete."
      : "This firstmate_contract read covers the listed sections; read any other section by name before acting in its area.";
    return `${picked.text}\n\n## BB runtime adaptations\n${BB_SKILL_RUNTIME_CONTRACT}\n${CAPTAIN_VISIBILITY_CONTRACT}\n${done} Treat native policy refusals as refusals. Read and acknowledge durable reports with one firstmate_wake ack=true call.\n`;
  }

  async function checkToolchain(hostId: string, fmHome: string, signal?: AbortSignal) {
    const result = await runFmScript({
      script: "bootstrap", args: [], hostId, fmHome,
      env: { FM_BOOTSTRAP_DETECT_ONLY: "1", FM_BOOTSTRAP_NETWORK: "skip" },
      timeoutMs: 60_000, signal,
    });
    if (result.exitCode !== 0) throw new Error(`Native toolchain check failed: ${truncate(result.output, 2000)}`);
    const output = [result.output.trim() || "Native bootstrap: all required tools and Lavish are compatible.", "Browser: use /browser with browser_script or bb browser script; leave profileId unset."].join("\n");
    return {
      ready: !/^(MISSING:|BACKEND_INVALID:)/m.test(output),
      presentationReady: !/^PRESENTATION_UNAVAILABLE:/m.test(output),
      output,
    };
  }

  async function toolchainForContext(ctx: unknown, signal?: AbortSignal) {
    const current = await settings.get();
    if (!current.fmHome.trim()) throw new Error("Initialize native Firstmate before checking its toolchain.");
    const hostId = current.fmHostId.trim() || await resolveHostId(undefined, ctx);
    return checkToolchain(hostId, current.fmHome.trim(), signal);
  }

  registerCaptainTool({
    name: "firstmate_toolchain",
    description: "Read-only native bootstrap check for required AXI tools, no-mistakes, and Lavish compatibility. Does not install tools or run fleet repairs.",
    parameters: z.object({}),
    async execute(_, ctx) {
      try { return (await toolchainForContext(ctx)).output; }
      catch (error) { return toolError(error instanceof Error ? error.message : String(error)); }
    },
  });

  registerCaptainTool({
    name: "firstmate_contract",
    description: "Read the current native Firstmate supervisor contract and the BB runtime adaptations. Without section: the table of contents plus the always-on sections. section=<number or title, comma-separated> reads those sections; section=\"all\" reads everything. Read before orchestrating and after an upstream update.",
    parameters: z.object({
      section: z.string().max(200).optional().describe('Contract section(s) by number or title, comma-separated (e.g. "7,8"), or "all".'),
    }),
    async execute({ section }, ctx) {
      return readCaptainContract(ctx, section);
    },
  });

  registerCaptainTool({
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
      const parentThreadId = typeof ctxRecord["threadId"] === "string" ? ctxRecord["threadId"] : undefined;
      const capped = await crewCapRefusal(parentThreadId, 1);
      if (capped !== null) return toolError(capped);
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

  registerCaptainTool({
    name: "firstmate_deck",
    description: "Mark this thread as the firstmate captain and return the session digest (memory, bearings, afk). Your own crews by default; pass all=true to see every captain's crews on the host.",
    presentation: { label: { pending: "Taking the deck", completed: "On deck" } },
    parameters: z.object({ all: z.boolean().optional().describe("Show every captain's crews host-wide, not just your own") }),
    async execute({ all }, ctx) {
      const record = asRecord(ctx);
      const threadId = record["threadId"];
      if (typeof threadId !== "string") return toolError("No thread to mark as captain.");
      await markDeck(threadId);
      await rememberWatchCaptain(ctx, threadId);
      const signal = record["signal"] as AbortSignal | undefined;
      const real = await ensureRealModeForDeck(ctx, signal);
      let providerId = "";
      try { providerId = (await bb.sdk.threads.get({ threadId })).providerId ?? ""; } catch { /* note is best-effort */ }
      const note = unhookedCaptainNote(providerId);
      return `Captain, on deck.\n${real}\n${await deckDigest(ctx, signal, all === true)}${note === "" ? "" : `\n\n${note}`}`;
    },
  });

  registerCaptainTool({
    name: "firstmate_tell",
    description:
      "Steer a crew: by default the message LANDS inside the crew's running turn (a course correction it acts on mid-work, not a stop) and starts a turn if the crew is idle. The returned line says honestly what happened (\"Steered into crew <id>'s running turn\" vs \"Told crew <id> (started a turn)\"). Pass queue=true for a genuinely non-urgent note that must NOT disturb an active turn — it queues and the crew reads it when its current turn ends. Use firstmate_interrupt to hard-stop. Pass resolveKey to also close that crew's open needs-decision/blocked (writes the resolved line to the real state/<id>.status, matching fm-classify-lib) when this steer is your answer to it.",
    parameters: z.object({
      crewId: z.string(),
      message: z.string().min(1).max(MAX_TASK),
      queue: z.boolean().optional().describe("Non-urgent note: queue it instead of steering into the crew's running turn (read when the turn ends). Default false = steer now."),
      resolveKey: z.string().optional().describe("Key of the crew's open decision this steer answers (from crew/bearings); closes it in real state"),
    }),
    async execute({ crewId, message, queue, resolveKey }) {
      const crew = await findCrew(crewId);
      if (crew === undefined) return toolError(`No crew ${crewId}.`);
      try {
        const sent = await tellCrew(crew, message, false, queue === true);
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

  registerCaptainTool({
    name: "firstmate_watch",
    description: "Hand supervision of the given crews to private event-driven wakes backed by the durable queue. Returns immediately; call once per crew batch, end the turn, and do not retry or poll.",
    parameters: z.object({
      crewIds: z.array(z.string()).max(MAX_WATCH_CREWS).optional(),
      timeoutSec: z.number().int().min(10).max(1800).optional().describe("Accepted for compatibility; event-driven handoff returns immediately"),
    }),
    async execute({ crewIds }) {
      const all = await listCrews();
      const targets = (crewIds === undefined ? all : all.filter((c) => crewIds.includes(c.id))).slice(0, MAX_WATCH_CREWS);
      if (targets.length === 0) return toolError("No matching crews.");
      const rows = await Promise.all(
        targets.map(async (crew) => {
          const status = await crewStatus(crew);
          const output = status === "idle" || status === "error" ? await crewOutput(crew, 800) : null;
          return { ...crew, status, outcome: parseOutcome(output), output };
        }),
      );
      const settled = rows
        .filter((row) => row.status === "idle" || row.status === "error" || row.status === "unknown")
        .map((row) => `${formatCrew(row, row.status, verdictOf(row.outcome))}${row.outcome !== null ? `\n  ${row.outcome}` : ""}`);
      const active = rows.filter((row) => row.status !== "idle" && row.status !== "error" && row.status !== "unknown");
      if (active.length === 0) return settled.join("\n");
      return [
        ...settled,
        `Private event-driven supervision active for ${active.map((row) => row.id).join(", ")}; outcomes arrive through agent-only durable wakes. End this turn and do not call firstmate_watch again for this crew batch.`,
      ].join("\n");
    },
  });

  registerCaptainTool({
    name: "firstmate_bearings",
    description: "Fleet digest: Captain's Call, Recently Landed, Ready, Underway, Charted Next. Your own crews by default; pass all=true to see every captain's crews on the host.",
    parameters: z.object({ all: z.boolean().optional().describe("Show every captain's crews host-wide, not just your own") }),
    async execute({ all }, ctx) {
      const text = (await bearingsSnapshot(all === true ? undefined : ctxString(ctx, "threadId"))).text;
      const others = await otherCaptainsNote(ctxString(ctx, "threadId"));
      return others === "" ? text : `${others}\n${text}`;
    },
  });

  registerCaptainTool({
    name: "firstmate_wake",
    description:
      "Drain the real firstmate wake queue: durable crew→captain notifications, unread crew statuses, and open decisions that a dropped doorbell would otherwise lose. Run this when doorbelled (notifyOwner=real) or on deck. Pass ack=true to present and acknowledge in ONE call (preferred: each extra call re-reads the whole captain context). Open decisions stay open after acknowledgment. Or pass ackThrough + recoveryGeneration (from the WAKE_ACK_REQUIRED line) to consume rows after a separate present.",
    parameters: z.object({
      ack: z.boolean().optional().describe("Present and acknowledge in one call"),
      ackThrough: z.number().int().min(0).optional().describe("Consume wakes at/below this sequence (from WAKE_ACK_REQUIRED)"),
      recoveryGeneration: z.string().optional().describe("Recovery generation token (from WAKE_ACK_REQUIRED)"),
    }),
    async execute({ ack, ackThrough, recoveryGeneration }, ctx) {
      // D6: the caller thread IS the captain — scope the drain/ack to its own queue.
      const captain = ctxString(ctx, "threadId");
      const signal = asRecord(ctx)["signal"] as AbortSignal | undefined;
      const out = await drainWakes(captain, ackThrough, recoveryGeneration, undefined, signal);
      if (ack !== true || ackThrough !== undefined) return wakeOutputForCaptainTool(out);
      const pair = wakeAckFromOutput(out);
      if (pair === null) return wakeOutputForCaptainTool(out);
      await drainWakes(captain, pair.ackThrough, pair.recoveryGeneration, undefined, signal);
      const presented = out
        .split("\n")
        .filter((line) => !/WAKE_ACK_REQUIRED|queued wakes pending/.test(line))
        .join("\n")
        .trim();
      return `${presented === "" ? "No unread reports." : presented}\nAcknowledged through ${pair.ackThrough}.`;
    },
  });

  registerCaptainTool({
    name: "firstmate_deliver",
    description: "Crew delivery: outcome + committed/uncommitted diff + PR state.",
    parameters: z.object({ crewId: z.string() }),
    async execute({ crewId }) {
      const crew = await findCrew(crewId);
      if (crew === undefined) return toolError(`No crew ${crewId}.`);
      return (await deliverLines(crew)).text;
    },
  });

  registerCaptainTool({
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

  registerCaptainTool({
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
      const all = (await readDecisions()).filter(row => ownedByScopedCaptain(row.parentThreadId));
      if (action === "list") {
        if (all.length === 0) return "No decisions.";
        return all.map((d) => `${d.id} [${d.status}] :: ${truncate(d.question, 80)}`).join("\n");
      }
      if (action === "ask") {
        if (question === undefined || question.trim() === "") return toolError("Need question.");
        const d: Decision = {
          parentThreadId: homeScope.getStore()?.captain ?? null,
          nativeHome: (await settings.get()).fmHome,
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
        await projectDecisionAsk(d);
        await writeDecisions([d, ...all]);
        return `Decision ${d.id}: ${truncate(question, 100)}. Prefer AskUserQuestion to collect the captain's choice, then firstmate_decide action=answer.`;
      }
      if (action === "answer") {
        const d = all.find((x) => x.id === decisionId);
        if (d === undefined || answer === undefined) return toolError("Need decisionId + answer.");
        await projectDecisionAnswer(d, answer);
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
        return `Answered ${d.id}`;
      }
      if (action === "defer") {
        const d = all.find((x) => x.id === decisionId);
        if (d === undefined) return toolError("Need decisionId.");
        d.status = "deferred";
        await projectDecisionDefer(d, d.deferredUntil);
        await writeDecisions(all);
        return `Deferred ${d.id}`;
      }
      if (action === "drop") {
        if (decisionId !== undefined) await projectDecisionDrop(decisionId);
        await writeDecisions(all.filter((x) => x.id !== decisionId));
        return `Dropped ${decisionId ?? ""}`;
      }
      return toolError("Unknown action.");
    },
  });

  registerCaptainTool({
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
      const { lines: statusLines, kind: foldKindResolved } = await crewStatusLines(crew, output);
      const protocol = statusProtocolSummary(statusLines, foldKindResolved);
      return [
        formatCrew(crew, status, verdictOf(outcome)),
        protocol ?? "",
        outcome === null ? "" : `outcome: ${outcome}`,
        output ?? "(no output yet)",
      ]
        .filter((l) => l !== "")
        .join("\n");
    },
  });

  registerCaptainTool({
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

  registerCaptainTool({
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
          await bb.sdk.threads.retry({ threadId: crew.threadId, reason: retryReason(reason, crew.id) });
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

  registerCaptainTool({
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
        parentThreadId: scout.parentThreadId,
      });
      return `Promoted scout ${scout.id} → ship ${ship.id} (${ship.threadId}). Scout record kept until forget.`;
    },
  });

  registerCaptainTool({
    name: "firstmate_afk",
    description: "Away posture: on holds routine done-pings for the return brief; off prints the brief then clears.",
    parameters: z.object({
      action: z.enum(["on", "off", "status"]),
      words: z.string().optional(),
    }),
    async execute({ action, words }, ctx) {
      const cap = ctxString(ctx, "threadId");
      if (action === "on") {
        try { await settings.experimental_set({ supervisionEnabled: true }); } catch { /* */ }
        const proj = await projectAfkOn(words ?? "", [], cap);
        const contractNote = (await afkIsReal()) ? ` Durable contract ${proj.contract ? "confirmed" : "not confirmed (KV flag only)"}.` : "";
        return proj.text || `AFK on. Words recorded, not executed as authority. Failures/credentials still surface.${contractNote}`;
      }
      if (action === "off") {
        const prev = await readAfk(cap);
        await projectAfkOff(cap);
        const held = prev?.held ?? [];
        const snap = await bearingsSnapshot(cap);
        return [
          "== return brief ==",
          String(await bb.storage.kv.get(`native-return:${cap ?? "legacy"}`) ?? ""),
          snap.text,
          held.length === 0 ? "Nothing held." : `Held while away:\n${held.join("\n---\n")}`,
          await wakeResumeBrief(cap),
        ].join("\n");
      }
      const afk = await readAfk(cap);
      const auth = await realAfkAuthority();
      const authNote = auth === null ? "" : ` contract:${auth.confirmed ? "confirmed" : "off"} grants=${auth.grants.length}`;
      return `afk: ${afk?.on === true ? "on" : "off"}${afk?.words ? ` words: ${afk.words}` : ""} held=${afk?.held.length ?? 0}${authNote}`;
    },
  });

  registerCaptainTool({
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

  registerCaptainTool({
    name: "firstmate_crews",
    description: "List recorded crews with live thread status. Your own crews by default; pass all=true to see every captain's crews on the host.",
    parameters: z.object({ all: z.boolean().optional().describe("Show every captain's crews host-wide, not just your own") }),
    async execute({ all }, ctx) {
      const owner = ctxString(ctx, "threadId");
      const crews = await listCrews({ owner, all: all === true });
      if (crews.length === 0) return noCrewsMessage(owner, all === true);
      const rows = await Promise.all(
        crews.map(async (crew) => {
          const status = await crewStatus(crew);
          const verdict =
            status === "idle" || status === "error" ? verdictOf(parseOutcome(await crewOutput(crew))) : null;
          return formatCrew(crew, status, verdict);
        }),
      );
      return rows.join("\n");
    },
  });

  registerCaptainTool({
    name: "firstmate_session",
    description: "Session digest: memory, bearings, afk/quiet. Your own crews by default; pass all=true to see every captain's crews on the host.",
    parameters: z.object({ all: z.boolean().optional().describe("Show every captain's crews host-wide, not just your own") }),
    async execute({ all }, ctx) {
      return sessionDigest(all === true ? undefined : ctxString(ctx, "threadId"));
    },
  });

  registerCaptainTool({
    name: "firstmate_quiet",
    description: "Batch routine done-pings while the captain is present. Failures and review-ready PRs still surface.",
    parameters: z.object({ action: z.enum(["on", "off", "status"]) }),
    async execute({ action }, ctx) {
      const cap = ctxString(ctx, "threadId");
      if (action === "on" || action === "off") {
        return await setQuiet(action, cap);
      }
      return `quiet: ${(await isQuiet(cap)) ? "on" : "off"}`;
    },
  });

  registerCaptainTool({
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
      const items = (await readQueue()).filter(row => ownedByScopedCaptain(row.parentThreadId));
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
          nativeHome: (await settings.get()).fmHome,
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
          parentThreadId: ctxString(ctx, "threadId") ?? null,
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
        title: item.title,
        crewId: item.id,
        worktree: resolveWorktree({ shape: item.shape }).worktree,
        visible: true,
        shape: item.shape,
        mode: toMode(item.mode !== "" ? item.mode : undefined, registry.mode),
      });
      item.status = "dispatched";
      item.crewId = crew.id;
      // Real transport spawns through fm-spawn.sh, which performs the queued→In-flight
      // start itself (it owns the crew.id row once its endpoint exists). Starting again
      // here would double-transition, so only start when the plugin owns the transition
      // (native transport, or real fell back to native).
      if ((await settings.get()).transport !== "real") await projectQueueTransition(item, "start");
      await writeQueue(items);
      await publishFleet();
      return `Dispatched queue ${queueId} as ${crew.shape} crew ${crew.id}`;
    },
  });

  registerCaptainTool({
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

  registerCaptainTool({
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

  registerCaptainTool({
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

  registerCaptainTool({
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

  registerCaptainTool({
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

  registerCaptainTool({
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

  registerCaptainTool({
    name: "firstmate_scripts",
    description:
      "List and verify every installed firstmate fm-* script exposed through firstmate_fm. Optionally filter by a name fragment.",
    parameters: z.object({ query: z.string().max(80).optional() }),
    async execute({ query }, ctx) {
      try {
        return renderScriptSurface(await installedScriptSurface(ctx, query));
      } catch (error) {
        return toolError(error instanceof Error ? error.message : "Could not list firstmate scripts.");
      }
    },
  });

  registerCaptainTool({
    name: "firstmate_fm",
    description:
      "Run a real firstmate bin/fm-<script>.sh with FM_BACKEND=bb (policy scripts, not a TypeScript port). Requires init --real.",
    parameters: z.object({
      script: z.string().min(1).max(80).describe("Stem of bin/fm-<script>.sh, e.g. spawn, peek, send, watch, bearings-snapshot"),
      args: z.array(z.string()).max(40).optional(),
      timeoutSec: z.number().int().min(1).max(1800).optional()
        .describe("Host command budget in seconds. Wake-drain uses at least 180 seconds, including when a shorter value is supplied; prefer firstmate_wake for drain/ack."),
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
        let text = result.output === "" ? `(exit ${result.exitCode ?? "?"})` : result.output;
        if (text.length > CAPTAIN_TOOL_OUTPUT_MAX) {
          const stem = normalizeFmScript(script).replace(/[^A-Za-z0-9._-]/g, "_");
          const path = `${current.fmHome}/state/.bb-tool-output/fm-${stem}-${Date.now()}.txt`;
          const saved = await writeHostFile(hostId, path, text).catch(() => false);
          text = capToolOutput(text, saved ? path : null);
          // Keep a day of saved outputs.
          void runOnHost(hostId, `find ${shQuote(`${current.fmHome}/state/.bb-tool-output`)} -type f -mmin +1440 -delete 2>/dev/null || true`, 15_000).catch(() => {});
        }
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
          `You are a firstmate crewmate. Do not dispatch other crews. Finish this one task, then report DONE, BLOCKED, or FAILED. ${WAITING_PROTOCOL} ${AXI_TOOL_CONTRACT} ${CI_POLL_CONTRACT}`,
      };
    }
    const marked = metaFlag(meta, "captain");
    const base = marked
      ? `${CAPTAIN_VISIBILITY_CONTRACT} ${BB_SKILL_RUNTIME_CONTRACT}`
      : "Firstmate crews are available. Run /captain or firstmate_deck to take the deck.";
    // The complete contract is a tool read; reserve the SDK window for pointers
    // and recall. Divide the remaining space so neither memory nor skills vanish.
    const remaining = Math.max(0, 4096 - base.length - 4);
    const memoryBudget = Math.floor(remaining * 0.6);
    const skillsBudget = remaining - memoryBudget;
    const memoryBlock = marked && !meta["nativeHome"] && captainMemoryCache !== ""
      ? `\n\n${truncate(captainMemoryCache, memoryBudget)}` : "";
    const skillsBlock = marked && skillsManifestCache !== ""
      ? `\n\n${truncate(skillsManifestCache, skillsBudget)}` : "";
    const instructions = truncate(`${base}${memoryBlock}${skillsBlock}`, 4096);
    return {
      tools: [...CAPTAIN_TOOLS],
      skills: marked ? [...CAPTAIN_SKILLS] : ["firstmate"],
      instructions,
    };
  });

  bb.rpc.register(rpcContract, {
    async fleet(input) {
      const threadId = input?.threadId;
      const owner = threadId ?? undefined;
      return {
        ...(await bearingsSnapshot(owner)).rpc,
        captain: owner !== undefined && await isCaptainThread(owner),
      };
    },
  });

  bb.ui.registerMentionProvider({
    id: "crew",
    label: "Crews",
    triggers: ["@"],
    async search({ query, threadId }) {
      // Scope the menu to the composing captain's own crews (threadId is the composer's
      // thread); null before the composer commits one → host-wide fallback.
      const crews = (await listCrews({ owner: threadId ?? undefined })).slice(0, 20);
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
      // The protocol nudge is an automated doorbell for a crew that just ended a
      // turn without a valid status verdict — queue it (do not steer/interrupt) so
      // it is read on the crew's next turn without hijacking a fresh one.
      await tellCrew(crew, protocolNudgeText(row.count + 1, limits.max), false, true);
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
    if (hasStatusProtocol(output) || isWaitingYield(output)) return;
    await applyProtocolNudge(crew);
  }

  // A crew that yields WAITING: is parked on an external run. It is not an outcome, so it
  // is neither nagged nor rung to the captain; BB resumes it after a delay through a
  // time-scheduled queued message (durable in BB, survives a plugin reload). Past the cap
  // the captain gets one decision instead of an endless silent loop.
  const WAITING_KEY = "crew-waiting";
  const WAIT_RESUME_MS = 5 * 60_000;
  const WAIT_RESUME_MAX = 24;
  const waitingRowSchema = z.record(z.string(), z.object({ generation: z.string(), count: z.number() }));
  async function clearWaiting(crewId: string): Promise<void> {
    const parsed = waitingRowSchema.safeParse(await bb.storage.kv.get<unknown>(WAITING_KEY));
    if (!parsed.success || parsed.data[crewId] === undefined) return;
    const next = { ...parsed.data };
    delete next[crewId];
    await bb.storage.kv.set(WAITING_KEY, next);
  }
  async function handleWaitingYield(crew: Crew, text: string | null): Promise<void> {
    await dropNudge(crew.id);
    const parsed = waitingRowSchema.safeParse(await bb.storage.kv.get<unknown>(WAITING_KEY));
    const state = parsed.success ? { ...parsed.data } : {};
    const generation = taskGeneration(crew);
    const prev = state[crew.id];
    const count = (prev !== undefined && prev.generation === generation ? prev.count : 0) + 1;
    state[crew.id] = { generation, count };
    await bb.storage.kv.set(WAITING_KEY, state);
    const what = truncate((text ?? "").replace(/\s+/g, " ").trim(), 200);
    if (count > WAIT_RESUME_MAX) {
      if (count === WAIT_RESUME_MAX + 1 && (await settings.get()).supervisionEnabled === true) {
        await notifyCaptain(crew, "needs-decision", `NEEDS DECISION: crew ${crew.id} has been waiting through ${WAIT_RESUME_MAX} automatic re-checks: ${what}`);
      }
      return;
    }
    try {
      await bb.sdk.threads.send({
        threadId: crew.threadId,
        mode: "queue-if-active",
        sendAt: Date.now() + WAIT_RESUME_MS,
        input: [{
          type: "text",
          text: "Firstmate resume: re-check the external run you reported WAITING on. Keep waiting inside this turn with bounded re-checks; when it resolves, finish and end with DONE:, BLOCKED:, or FAILED:. If it is still running when you must yield, end with WAITING: again.",
          mentions: [],
        }],
      });
      bb.log.info(`crew ${crew.id} waiting (${count}/${WAIT_RESUME_MAX}); resume scheduled, captain not woken`);
    } catch (error) {
      bb.log.warn(`crew ${crew.id} waiting: resume schedule failed, telling the captain: ${error instanceof Error ? error.message : String(error)}`);
      await notifyCaptain(crew, "needs-decision", `NEEDS DECISION: crew ${crew.id} is waiting and could not be scheduled to resume: ${what}`);
    }
  }

  // A crew's worker thread can reach idle/error BEFORE its record carries its
  // threadId: the real transport spawns through fm-spawn.sh (~30s) and only learns
  // the thread id — the moment the crew register can persist it — after that returns, while
  // a fast crew has long since ended its first turn. The live thread.idle/
  // thread.failed handlers fire at that earlier instant, findCrewByThread returns
  // undefined, and the event is dropped; BB never replays it, so notifyCaptain is
  // never reached — no captain doorbell and no durable wake. reconcileCrewTerminal
  // (run once at the end of dispatch, after the record lands) catches that missed
  // terminal. This set lets it skip a thread whose terminal a live event DID handle,
  // so the two paths never double-notify in the narrow window where the idle instead
  // lands just after the record. (Live handlers only ADD to it; they never dedup on
  // it — repeated same-turn idles must each still nudge/ping as before.)
  const liveTerminalHandled = new Set<string>();

  async function handleCrewIdle(
    crew: Crew,
    thread: { id: string; status: string; runtime?: { displayStatus?: string } },
    lastAssistantText: string | null,
  ): Promise<void> {
    if (isSecondmateRoute(crew)) return;
    const stopped = await turnWasStopped(thread);
    // BB already reports interruptions to the parent. A completion wake here can
    // cause the manager to resume work the user just stopped.
    if (stopped) return;
    if (isWaitingYield(lastAssistantText)) {
      await handleWaitingYield(crew, lastAssistantText);
      return;
    }
    await clearWaiting(crew.id);
    if (!hasStatusProtocol(lastAssistantText)) {
      const outcome = await applyProtocolNudge(crew);
      if (outcome !== "off") return;
    }
    const current = await settings.get();
    if (current.supervisionEnabled !== true) return;
    await notifyCaptain(crew, "idle", lastAssistantText);
  }

  async function handleCrewFailed(crew: Crew, error: string | null): Promise<void> {
    if (isSecondmateRoute(crew)) return;
    const current = await settings.get();
    if (current.supervisionEnabled !== true) return;
    await notifyCaptain(crew, "error", error);
  }

  // Backstop for the record-after-spawn race described on liveTerminalHandled: once
  // dispatch has recorded the crew (threadId set), re-check the thread's live state
  // and drive the same handler a dropped live event would have. A no-op unless the
  // thread is already terminal right now and no live event beat us to it.
  async function reconcileCrewTerminal(crew: Crew): Promise<void> {
    if (crew.parentThreadId === null || isSecondmateRoute(crew) || crew.threadId === "") return;
    if (liveTerminalHandled.has(crew.threadId)) return;
    let thread: { id: string; status: string; runtime?: { displayStatus?: string } };
    try {
      thread = await bb.sdk.threads.get({ threadId: crew.threadId });
    } catch {
      return;
    }
    // A live event may have landed while we were fetching — re-check before firing.
    if (liveTerminalHandled.has(crew.threadId)) return;
    if (thread.status === "idle") {
      await handleCrewIdle(crew, thread, await crewOutput(crew));
    } else if (thread.status === "error") {
      await handleCrewFailed(crew, (await crewOutput(crew)) ?? "crew thread ended in error");
    }
  }

  bb.events.on("thread.created", async ({ thread }) => {
    if (!isCaptainSpawn(thread)) return;
    await settleDeck(thread.id);
  });
  bb.events.on("thread.active", async ({ thread }) => {
    captainTurnStartedAt.set(thread.id, Date.now());
    await bb.storage.kv.delete(`captain-delivery:${thread.id}`);
    await inCaptainHome(thread.id, () => reconcileReturnedAfk(thread.id)).catch(error => bb.log.warn(`AFK return: ${String(error)}`));
    if (!isCaptainSpawn(thread)) return;
    await settleDeck(thread.id);
  });
  // Captain ids for the fast dispatch hook (KV-backed; settleDeck adds new ones).
  const knownCaptains = knownCaptainsRef;
  for (const key of await bb.storage.kv.list(CAPTAIN_PROJECT_PREFIX)) knownCaptains.add(key.slice(CAPTAIN_PROJECT_PREFIX.length));
  const heldPingCaptains = new Set<string>();
  try {
    bb.experimental_hooks.on("message.dispatch", async (context) => {
      try {
        const threadId = context.thread.id;
        if (!knownCaptains.has(threadId)) return { action: "proceed" };
        const sender = typeof context.senderThreadId === "string" && context.senderThreadId !== "mixed" ? context.senderThreadId : null;
        const senderIsCrew = sender !== null && (await readCrews()).some((c) => c.threadId === sender);
        const decision = crewPingHoldDecision({
          attempt: context.attempt,
          initiator: String(context.initiator),
          text: context.input.text,
          targetIsCaptain: true,
          senderIsCrew,
        });
        if (decision === "proceed") return { action: "proceed" };
        heldPingCaptains.add(threadId);
        return { action: "wait", reason: "Crew update held until the captain's current turn ends (firstmate batches crew pings)." };
      } catch {
        return { action: "proceed" };
      }
    });
  } catch (error) {
    bb.log.warn(`message.dispatch hook unavailable; crew pings join running turns: ${String(error)}`);
  }

  const CAPTAIN_COMPACT_COOLDOWN_MS = 20 * 60_000;
  async function maybeCompactCaptain(threadId: string): Promise<void> {
    if (!knownCaptains.has(threadId)) return;
    const budget = Number((await settings.get()).captainCompactAtTokens);
    if (!(budget > 0)) return;
    const key = `captain-compacted-at:${threadId}`;
    const last = await bb.storage.kv.get<unknown>(key);
    let usedTokens: number | null = null;
    try {
      usedTokens = (await bb.sdk.threads.context({ threadId })).usage?.usedTokens ?? null;
    } catch {
      return;
    }
    const now = Date.now();
    if (!captainCompactDue({ usedTokens, budget, lastCompactAt: typeof last === "number" ? last : null, now, cooldownMs: CAPTAIN_COMPACT_COOLDOWN_MS })) return;
    // Stamp first: a provider that cannot compact must not be retried on every idle.
    await bb.storage.kv.set(key, now);
    try {
      await bb.sdk.threads.compact({ threadId });
      bb.log.info(`captain ${threadId} compacted at ${usedTokens} tokens (budget ${budget})`);
    } catch (error) {
      bb.log.warn(`captain ${threadId} compaction failed at ${usedTokens} tokens: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // The thread.idle trigger alone never reaches a captain that is already idle past the
  // budget (it crossed it before this build, or its last turn ended while compaction was
  // cooling down); the release service sweeps those.
  async function compactIdleCaptain(threadId: string, signal?: AbortSignal): Promise<void> {
    try {
      const thread = asRecord(await raceAbort(bb.sdk.threads.get({ threadId }), signal, STUCK_HOST_CALL_MS));
      if (thread["status"] !== "idle" || thread["archivedAt"] != null) return;
    } catch (error) {
      if (isAbortError(error)) throw error;
      return;
    }
    await maybeCompactCaptain(threadId).catch((error) => bb.log.warn(`captain compaction check failed ${threadId}: ${String(error)}`));
  }

  bb.events.on("thread.idle", async ({ thread, lastAssistantText }) => {
    // Compact before releasing held pings so they land on the smaller context.
    await maybeCompactCaptain(thread.id).catch((error) => bb.log.warn(`captain compaction check failed ${thread.id}: ${String(error)}`));
    if (heldPingCaptains.delete(thread.id)) {
      await bb.experimental_hooks.recheck("message.dispatch").catch((error) => bb.log.warn(`crew ping release failed captain=${thread.id}: ${String(error)}`));
    }
    // A captain that completed a turn can take the wakes held while it was unavailable.
    await releaseHeldCaptainWakes(thread.id).catch((error) => bb.log.warn(`held wake release failed captain=${thread.id}: ${String(error)}`));
    await inCaptainHome(thread.id, () => reconcileReturnedAfk(thread.id)).catch(error => bb.log.warn(`AFK return: ${String(error)}`));
    // Turn-end backstop for the captain (no-op unless turnEndGuard=re-ring and this
    // is the captain thread). Captains are not crews.
    await inCaptainHome(thread.id, () => captainTurnEndGuard(thread.id)).catch(() => {});
    const crew = await findCrewByThread(thread.id);
    if (crew === undefined || isSecondmateRoute(crew)) return;
    liveTerminalHandled.add(thread.id);
    await handleCrewIdle(crew, thread, lastAssistantText);
  });
  bb.events.on("thread.failed", async ({ thread, error }) => {
    const crew = await findCrewByThread(thread.id);
    if (crew === undefined || isSecondmateRoute(crew)) return;
    liveTerminalHandled.add(thread.id);
    await handleCrewFailed(crew, error);
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
      { name: "contract", summary: "Read the full native supervisor contract (or named sections)", usage: "bb firstmate contract [section,...]" },
      { name: "toolchain", summary: "Check native AXI and Lavish dependencies without mutations", usage: "bb firstmate toolchain [--json]" },
      { name: "scripts", summary: "List + verify every installed fm-* script", usage: "bb firstmate scripts [query] [--json]" },
      { name: "fm", summary: "Run a real firstmate bin/ script with FM_BACKEND=bb", usage: "bb firstmate fm [--timeout s] <script> [args...]" },
      { name: "deck", summary: "Mark this thread captain + session digest", usage: "bb firstmate deck [--json]" },
      { name: "session", summary: "Session digest: memory + bearings + afk", usage: "bb firstmate session [--json]" },
      { name: "dispatch", summary: "Dispatch crewmate child threads", usage: 'bb firstmate dispatch --project <id> -- "<task>"' },
      { name: "crews", summary: "List recorded crews with live status", usage: "bb firstmate crews [--json]" },
      { name: "crew", summary: "Show one crew with last output", usage: "bb firstmate crew <crew-id> [--json]" },
      { name: "watch", summary: "Wait for crews via bb thread wait", usage: "bb firstmate watch [crew-id ...] [--timeout <sec>] [--json]" },
      { name: "tell", summary: "Steer a running crew mid-turn (course correction); --queue for a non-urgent note", usage: 'bb firstmate tell <crew-id> [--queue] [--resolve-key <key>] -- "<message>"' },
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
      { name: "afk", summary: "Away posture", usage: "bb firstmate afk on|off|status|reconcile-return [--captain <thread-id>]" },
      { name: "quiet", summary: "Batch routine pings while present", usage: "bb firstmate quiet on|off|status" },
      { name: "secondmate", summary: "Register a domain captain thread", usage: "bb firstmate secondmate list|register|drop" },
      { name: "supervision", summary: "Event pings + stuck checker", usage: "bb firstmate supervision on|off|status" },
      { name: "forget", summary: "Drop a crew record", usage: "bb firstmate forget <crew-id> [--stop] [--force]" },
      { name: "mark-crew", summary: "Tag a thread as a firstmate crew (used by the real-mode bb backend)", usage: "bb firstmate mark-crew <thread-id> [--shape ship|scout]" },
      { name: "migrate-state", summary: "Import the KV crew cache into authoritative real state (idempotent)", usage: "bb firstmate migrate-state [--json]" },
      { name: "migrate-owners", summary: "Project KV queue/decisions/afk/quiet/memory into the real files for owners set to real (idempotent)", usage: "bb firstmate migrate-owners [--json]" },
    ],
    async run(argv, ctx) {
      return withLedgerOperation(argv[0] ?? "", ctxString(ctx, "threadId"), () => inCaptainHome(ctxString(ctx, "threadId"), async () => {
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
          case "contract": {
            // The operator CLI reads the whole contract unless a section is named.
            const text = await readCaptainContract(ctx, rest.join(" ").trim() || "all");
            if (typeof text !== "string") return fail("Native contract could not be read.");
            return reply({ contract: text }, text);
          }
          case "toolchain": {
            const result = await toolchainForContext(ctx, signal);
            return reply(result, result.output);
          }
          case "scripts": {
            const surface = await installedScriptSurface(ctx, rest.join(" "));
            return reply(surface, renderScriptSurface(surface));
          }
          case "deck": {
            if (ctxThread === undefined) return fail("No thread: run this from a BB thread.");
            await markDeck(ctxThread);
            await rememberWatchCaptain(ctx, ctxThread);
            const real = await ensureRealModeForDeck(ctx, signal);
            const realMode = (await settings.get()).fmHome.trim() !== "";
            const digest = await deckDigest(ctx, signal, flags.has("all"));
            return reply(
              { captain: true, threadId: ctxThread, realMode, digest },
              `Captain, on deck.\n${real}\n${digest}`,
            );
          }
          case "session": {
            const digest = await sessionDigest(flags.has("all") ? undefined : ctxThread);
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
            const capped = await crewCapRefusal(ctxThread, tasks.length);
            if (capped !== null) return fail(capped);
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
            // Your own crews by default (calling captain = ctxThread); --all opts into host-wide.
            const crews = await listCrews({ owner: ctxThread, all: flags.has("all") });
            const rows = await Promise.all(
              crews.map(async (crew) => {
                const status = await crewStatus(crew);
                // Idle/error threads may carry a terminal verdict — surface it so a
                // done ship is distinguishable from a blocked/failed crew at a glance.
                const verdict =
                  status === "idle" || status === "error" ? verdictOf(parseOutcome(await crewOutput(crew))) : null;
                return { ...crew, status, verdict };
              }),
            );
            const empty = await noCrewsMessage(ctxThread, flags.has("all"));
            return reply(rows, rows.length === 0 ? empty : rows.map((row) => formatCrew(row, row.status, row.verdict)).join("\n"));
          }
          case "crew": {
            const id = rest[0];
            if (id === undefined || rest.length !== 1) return fail(usage);
            const crew = await findCrew(id);
            if (crew === undefined) return fail(`No crew ${id}. Run "bb firstmate crews".`);
            const status = await crewStatus(crew);
            const output = await crewOutput(crew);
            const outcome = parseOutcome(output);
            const { lines, kind: foldKindResolved } = await crewStatusLines(crew, output);
            const protocol = statusProtocolSummary(lines, foldKindResolved);
            const latest = latestStatus(lines);
            const openDecisions =
              latest !== null && latest.verb !== "done" && latest.verb !== "failed"
                ? foldOpenDecisions(lines, foldKindResolved)
                : [];
            return reply(
              { ...crew, status, outcome, protocol, openDecisions, output },
              [
                formatCrew(crew, status, verdictOf(outcome)),
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
                const head = formatCrew(row, row.status, verdictOf(row.outcome));
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
            const wantQueue = command === "tell" && flags.get("queue") === true;
            const text = await tellCrew(crew, message, command === "interrupt", wantQueue);
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
                reason: retryReason(reason, crew.id),
              });
              return reply({ retried: true, id }, `Retried crew ${id}`);
            }
            const next = await relaunchCrew(crew, { model, providerId, reasoningLevel, note: reason });
            return reply(
              { relaunched: true, id, threadId: next.threadId, model: next.model, providerId: next.providerId, reasoningLevel: next.reasoningLevel },
              `Relaunched crew ${id} as thread ${next.threadId} (${next.providerId ?? "default provider"}/${next.model ?? "default model"}/${next.reasoningLevel ?? "default reasoning"}), same worktree.`,
            );
          }
          case "mark-captain": {
            const threadId = rest[0];
            const home = flagStr(flags, "home");
            const parentHome = flagStr(flags, "parent-home");
            const taskId = flagStr(flags, "task");
            if (!threadId || !home?.startsWith("/") || !parentHome?.startsWith("/") || !taskId || !/^[A-Za-z0-9._-]+$/.test(taskId)) return fail("Need thread id, --home, --parent-home and --task.");
            const hostId = await resolveHostId(undefined, ctx);
            const proof = await runOnHost(hostId, [
              "set -eu",
              `[ "$(cat ${shQuote(`${home}/.fm-secondmate-home`)})" = ${shQuote(taskId)} ]`,
              `. ${shQuote(`${parentHome}/bin/fm-secondmate-parent-lib.sh`)}`,
              `fm_secondmate_parent_record_parse ${shQuote(`${home}/.fm-secondmate-parent`)}`,
              `[ "$FM_SECONDMATE_PARENT_ROUTE" = local ]`,
              `[ "$(realpath "$FM_SECONDMATE_PARENT_HOME")" = "$(realpath ${shQuote(parentHome)})" ]`,
              `test -f ${shQuote(`${home}/AGENTS.md`)}`,
              `test -d ${shQuote(`${home}/.git`)} -o -f ${shQuote(`${home}/.git`)}`,
            ].join("\n"), 15_000, signal);
            requireNativeSuccess(proof, "secondmate home identity");
            await installBbBackend(hostId, home, ctxProject, 180_000, signal);
            await bb.storage.kv.set(`native-home:${threadId}`, home);
            captainHomes.set(threadId, home);
            await bb.storage.kv.set(`native-home-host:${threadId}`, hostId);
            await bb.sdk.threads.updatePluginMetadata({ threadId, set: { captain: "true", nativeHome: home, nativeTaskId: taskId, nativeParentHome: parentHome }, remove: ["crew", "crewId"] });
            return reply({ threadId, home }, `Bound secondmate captain ${threadId} to ${home}`);
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
            const home = flagStr(flags, "home");
            if (home) set["nativeHome"] = home;
            await bb.sdk.threads.updatePluginMetadata({ threadId: id, set });
            return reply({ marked: true, threadId: id, shape, task: taskId || null }, `Marked thread ${id} as ${shape} crew.`);
          }
          case "bearings": {
            const snap = await bearingsSnapshot(flags.has("all") ? undefined : ctxThread);
            return reply(snap.json, snap.text);
          }
          case "wake": {
            const ackRaw = flagStr(flags, "ack-through");
            const gen = flagStr(flags, "recovery-generation");
            const ackThrough = ackRaw !== undefined && /^\d+$/.test(ackRaw) ? Number(ackRaw) : undefined;
            const out = await drainWakes(ctxString(ctx, "threadId"), ackThrough, gen, undefined, signal);
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
              parentThreadId: scout.parentThreadId,
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
            if (sub === "reconcile-return") {
              const captain = flagStr(flags, "captain") ?? ctxThread;
              if (!captain) return fail("Need --captain <thread-id>.");
              const changed = await reconcileReturnedAfk(captain);
              return reply({ changed }, changed ? "Archived stale away posture after verified human return; held reports retained for afk off." : "No verified return for this native away record; posture unchanged.");
            }
            if (sub === "on") {
              const words = flagStr(flags, "words") ?? rest.slice(1).join(" ").trim();
              await settings.experimental_set({ supervisionEnabled: true });
              const proj = await projectAfkOn(words, flagAll(flags, "grant"), ctxThread);
              return reply({ afk: true, words, contract: proj.contract }, proj.text || `AFK on. Words recorded, not executed as authority.${(await afkIsReal()) ? ` Durable contract ${proj.contract ? "confirmed" : "not confirmed (KV flag only)"}.` : ""}`);
            }
            if (sub === "off") {
              const prev = await readAfk(ctxThread);
              await projectAfkOff(ctxThread);
              const snap = await bearingsSnapshot(ctxThread);
              const held = prev?.held ?? [];
              const text = [
                "== return brief ==",
                String(await bb.storage.kv.get(`native-return:${ctxThread ?? "legacy"}`) ?? ""),
                snap.text,
                held.length === 0 ? "Nothing held." : `Held while away:\n${held.join("\n---\n")}`,
                await wakeResumeBrief(ctxThread),
              ].join("\n");
              return reply({ afk: false, held, bearings: snap.json }, text);
            }
            const afk = await readAfk(ctxThread);
            const auth = await realAfkAuthority();
            const authNote = auth === null ? "" : ` contract:${auth.confirmed ? "confirmed" : "off"} grants=${auth.grants.length}`;
            return reply({ ...afk, contract: auth }, `afk: ${afk?.on === true ? "on" : "off"} held=${afk?.held.length ?? 0}${authNote}`);
          }
          case "quiet": {
            const sub = rest[0] ?? "status";
            if (sub === "on" || sub === "off") {
              const text = await setQuiet(sub, ctxThread);
              return reply({ quiet: sub === "on" }, text);
            }
            const q = await isQuiet(ctxThread);
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
            const items = (await readQueue()).filter(row => ownedByScopedCaptain(row.parentThreadId));
            if (sub === "add") {
              const title = rest.slice(1).join(" ").trim();
              if (title === "") return fail(usage);
              const projectId = flagStr(flags, "project") ?? ctxProject;
              if (projectId === undefined) return fail("No project: pass --project <id>.");
              const newId = randomUUID().slice(0, 8);
              const shapeVal = toShape(flagStr(flags, "shape"));
              const proj = await projectQueueAdd(newId, title, shapeVal, projectId);
              const item: QueueItem = {
          nativeHome: (await settings.get()).fmHome,
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
                parentThreadId: ctxThread ?? null,
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
                title: item.title,
                crewId: item.id,
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
              // fm-spawn.sh performs the queued→In-flight start itself for real-transport
              // dispatches; only start here when the plugin owns the transition.
              if (current.transport !== "real") await projectQueueTransition(item, "start");
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
            const all = (await readDecisions()).filter(row => ownedByScopedCaptain(row.parentThreadId));
            if (sub === "ask") {
              const question = rest.slice(1).join(" ").trim();
              if (question === "") return fail(usage);
              const d: Decision = {
          parentThreadId: homeScope.getStore()?.captain ?? null,
          nativeHome: (await settings.get()).fmHome,
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
              await projectDecisionAsk(d);
              await writeDecisions([d, ...all]);
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
              await projectDecisionAnswer(d, answer);
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
              return reply({ answered: true, id: did }, `Answered ${did}${told}`);
            }
            if (sub === "defer") {
              const did = rest[1];
              const d = all.find((x) => x.id === did);
              if (did === undefined || d === undefined) return fail(`No decision ${did ?? ""}.`);
              d.status = "deferred";
              d.deferredUntil = flagStr(flags, "until") ?? null;
              await projectDecisionDefer(d, d.deferredUntil);
              await writeDecisions(all);
              return reply({ deferred: true, id: did }, `Deferred ${did}`);
            }
            if (sub === "drop") {
              const did = rest[1];
              if (did === undefined) return fail(usage);
              await projectDecisionDrop(did);
              await writeDecisions(all.filter((x) => x.id !== did));
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
            const r = await migrateOwners(ctxThread);
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
      }));
    },
  });

  bb.background.service("crew-watch", {
    async start(signal) {
      // Real fm-watch owns continuous wedge supervision. Keep one startup
      // reconciliation for crash/reload gaps, then stop timer-driven crew scans.
      let reconciledRealWatch = false;
      try {
        await rearmDeferredNudges();
      } catch (error) {
        bb.log.warn(error instanceof Error ? `nudge rearm: ${error.message}` : "nudge rearm failed");
      }
      while (!signal.aborted) {
        try {
          const s = await settings.get();
          // Full parity delegates wedge detection to the blocking real fm-watch.
          // Avoid a second timer-driven sweep; ordinary done/fail/input delivery
          // already comes from BB thread events below.
          const realWatch = s.watchOwner === "fm-watch" && s.fmHome.trim() !== "";
          if (s.supervisionEnabled === true && (!realWatch || !reconciledRealWatch)) {
            await stuckPass(signal);
          }
          reconciledRealWatch = realWatch;
        } catch (error) {
          bb.log.warn(error instanceof Error ? `supervise: ${error.message}` : "supervise failed");
        }
        const s = await settings.get().catch(() => null);
        const mins = s === null ? 5 : Math.min(60, Math.max(1, Number(s.supervisionIntervalMin) || 5));
        await new Promise<void>((resolve) => {
          // stuckPass now returns early on abort, so the signal can ALREADY be aborted here.
          // A sleep entered post-abort can never be woken by the abort listener (the event
          // already fired), so without this immediate resolve it would pin the service open
          // for the whole interval — the exact "service crew-watch did not stop" wedge.
          if (signal.aborted) {
            resolve();
            return;
          }
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
  const ROOT_WAKE_PRUNE_INTERVAL_MS = 10 * 60_000;
  const ROOT_WAKE_GRACE_SEC = 600;
  const rootWakePruneNext = new Map<string, number>();
  const rootWakePruneRunning = new Set<string>();
  function pruneRelayedRootWakes(hostId: string, fmHome: string, signal?: AbortSignal): void {
    const key = `${hostId}|${fmHome}`;
    // A captain bound to this exact home drains the root queue itself; never ack for it.
    if ([...captainHomes.values()].includes(fmHome)) return;
    if (rootWakePruneRunning.has(key) || (rootWakePruneNext.get(key) ?? 0) > Date.now()) return;
    rootWakePruneRunning.add(key);
    rootWakePruneNext.set(key, Date.now() + ROOT_WAKE_PRUNE_INTERVAL_MS);
    void runOnHost(hostId, `bash -c ${shQuote(rootWakePruneScript(fmHome, ROOT_WAKE_GRACE_SEC))}`, 600_000, signal)
      .then((res) => {
        const line = res.output.split("\n").find((l) => l.startsWith("root-wake-prune")) ?? truncate(res.output, 200);
        if (line.includes("through=") && !line.includes("ack-failed")) bb.log.info(`fm-watch: ${line} home=${fmHome}`);
        else if (!line.includes("rows=0") && !line.includes("nothing-old")) bb.log.warn(`fm-watch: ${line} home=${fmHome}`);
      })
      .catch((error) => bb.log.warn(`fm-watch: root wake prune failed home=${fmHome}: ${String(error)}`))
      .finally(() => rootWakePruneRunning.delete(key));
  }

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
            const hosts = await resolveFmWatchHosts(signal);
            if (hosts.length === 0) {
              bb.log.warn("fm-watch-supervisor: no host to reach fmHome (set fmHostId or dispatch a crew).");
            }
            for (const hostId of hosts) {
              // Between hosts: bail out promptly on a reload. superviseFmWatch/relayWatchReasons
              // already honor the signal inside, but without this check a multi-host fleet would
              // still walk every remaining host before the loop noticed the abort.
              if (signal.aborted) break;
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
              await relayWatchReasons(extractWatchReasons(res.logTail), hostId, relaySeen, signal);
              pruneRelayedRootWakes(hostId, s.fmHome.trim(), signal);
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
            const configured = await resolveFmWatchHostId(signal);
            if (configured !== null) toStop.add(configured);
            for (const hostId of toStop) {
              if (signal.aborted) break;
              await stopFmWatchKeeper(hostId, s.fmHome.trim(), signal);
            }
            keeperHosts = new Set<string>();
            await saveKeeperHosts(keeperHosts);
            sweptWhileOff = true;
          }
        } catch (error) {
          bb.log.warn(error instanceof Error ? `fm-watch-supervisor: ${error.message}` : "fm-watch-supervisor failed");
        }
        const checkMs = Math.max(15, Math.min(30, Math.floor(gate / 2))) * 1000;
        await new Promise<void>((resolve) => {
          // Same post-abort guard as crew-watch: the per-host work above now bails on abort,
          // so the signal can already be aborted here; a sleep entered post-abort would never
          // wake (the abort event already fired) and pin the service for the whole interval.
          if (signal.aborted) {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, checkMs);
          signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
        });
      }
    },
  });

  // Releases wakes held for an unavailable captain once its limit resets or it leaves
  // the error state without a turn of its own, and compacts idle captains whose context
  // crossed the budget while no turn ended (e.g. before an upgrade), so the next wake
  // does not re-read the oversized context first.
  const CAPTAIN_COMPACT_SWEEP_MS = 30 * 60_000;
  bb.background.service("captain-wake-release", {
    async start(signal) {
      let nextCompactSweep = 0;
      while (!signal.aborted) {
        try {
          for (const key of await bb.storage.kv.list(CAPTAIN_WAKE_HOLD_PREFIX)) {
            if (signal.aborted) break;
            await releaseHeldCaptainWakes(key.slice(CAPTAIN_WAKE_HOLD_PREFIX.length), signal);
          }
          if (Date.now() >= nextCompactSweep) {
            nextCompactSweep = Date.now() + CAPTAIN_COMPACT_SWEEP_MS;
            for (const captain of [...knownCaptainsRef]) {
              if (signal.aborted) break;
              await compactIdleCaptain(captain, signal);
            }
          }
        } catch (error) {
          if (!signal.aborted) bb.log.warn(`captain-wake-release: ${error instanceof Error ? error.message : String(error)}`);
        }
        await new Promise<void>((resolve) => {
          if (signal.aborted) return resolve();
          const onAbort = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 30_000);
          signal.addEventListener("abort", onAbort, { once: true });
        });
      }
    },
  });

  bb.background.service("captain-home-watch", {
    async start(signal) {
      const seen = new Map<string, Set<string>>();
      while (!signal.aborted) {
        for (const key of await bb.storage.kv.list("native-home:")) {
          if (signal.aborted) break;
          const captain = key.slice("native-home:".length);
          try {
            await inCaptainHome(captain, async () => {
              const s = await settings.get();
              const host = await bb.storage.kv.get<string>(`native-home-host:${captain}`);
              if (!host) return;
              if (s.watchOwner !== "fm-watch") {
                await stopFmWatchKeeper(host, s.fmHome, signal);
                return;
              }
              const grace = Math.max(30, Number(s.watchHeartbeatSec) || 90);
              const prior = fmWatchBeatSchema.safeParse(await bb.storage.kv.get(fmWatchBeatKey(host)));
              const now = Date.now();
              const backoff = prior.success ? prior.data.backoffUntil ?? 0 : 0;
              const result = await superviseFmWatch(host, s.fmHome, grace, now >= backoff, signal);
              if (!result) return;
              const streak = result.keeperAlive ? 0 : result.relaunched ? (prior.success ? prior.data.consecutiveRelaunch ?? 0 : 0) + 1 : 0;
              await bb.storage.kv.set(fmWatchBeatKey(host), {
                beatAge: result.beatAge, checkedAt: now, grace, relaunched: result.relaunched,
                consecutiveRelaunch: streak,
                backoffUntil: streak ? now + Math.min(1_800_000, 60_000 * 2 ** (streak - 1)) : backoff,
              });
              const delivered = seen.get(captain) ?? new Set<string>();
              seen.set(captain, delivered);
              await relayWatchReasons(extractWatchReasons(result.logTail), host, delivered, signal);
            });
          } catch (error) {
            if (!signal.aborted) bb.log.warn(`captain home ${captain}: ${String(error)}`);
          }
        }
        await new Promise<void>(resolve => {
          if (signal.aborted) return resolve();
          const onAbort = () => { clearTimeout(timer); resolve(); };
          const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, 30_000);
          signal.addEventListener("abort", onAbort, { once: true });
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
