export type Shape = "ship" | "scout";
export type DeliveryMode = "direct-PR" | "no-mistakes" | "local-only";
export type PermissionMode = "accept-edits" | "auto" | "full";
export type ReasoningLevel = "low" | "medium" | "high" | "xhigh" | "max";

const REASONING_LEVELS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

/** Dispatch-profile reasoning effort, same scale as fm-spawn --effort (minus ultra). */
export function toReasoningLevel(value: unknown): ReasoningLevel | undefined {
  return typeof value === "string" && REASONING_LEVELS.has(value) ? (value as ReasoningLevel) : undefined;
}

const PERM_RANK: Record<PermissionMode, number> = {
  "accept-edits": 0,
  auto: 1,
  full: 2,
};

export function toShape(value: unknown): Shape {
  return value === "scout" ? "scout" : "ship";
}

export function toMode(value: unknown, fallback: DeliveryMode): DeliveryMode {
  return value === "no-mistakes" || value === "local-only" || value === "direct-PR"
    ? value
    : fallback;
}

export function toPermissionMode(value: unknown): PermissionMode | undefined {
  return value === "accept-edits" || value === "auto" || value === "full"
    ? value
    : undefined;
}

/** Parent permission is a ceiling. Never grant a crew more than the captain. */
export function capPermission(
  requested: PermissionMode | undefined,
  parent: PermissionMode | undefined,
): PermissionMode | undefined {
  if (requested === undefined) return parent;
  if (parent === undefined) return requested;
  return PERM_RANK[requested] <= PERM_RANK[parent] ? requested : parent;
}

export const READONLY_HINT =
  /\bread[\s-]?only\b|\baudit\b|\breview\b|\binspect\b|\bdiagnos|\bresearch\b|\binvestigat/i;

export function looksReadOnly(task: string): boolean {
  return READONLY_HINT.test(task);
}

export function resolveWorktree(input: {
  shape: Shape;
  sharedEnv?: boolean;
  worktreeFlag?: boolean;
  explicit?: boolean;
}): { worktree: boolean; sharedOverride: boolean } {
  if (input.explicit !== undefined) {
    return { worktree: input.explicit, sharedOverride: input.shape === "ship" && !input.explicit };
  }
  if (input.sharedEnv) return { worktree: false, sharedOverride: input.shape === "ship" };
  if (input.shape === "ship") return { worktree: true, sharedOverride: false };
  return { worktree: input.worktreeFlag === true, sharedOverride: false };
}

export function parseOutcome(output: string | null): string | null {
  if (output === null || output === "") return null;
  const m = /(^|\n)\s*(DONE|BLOCKED|FAILED)\s*:\s*(.+)/i.exec(output);
  if (!m || m[3] === undefined) return null;
  const tag = (m[2] as string).toUpperCase();
  return `${tag}: ${m[3].trim().replace(/\s+/g, " ").slice(0, 200)}`;
}

/** The self-reported terminal verdict a crew ends its turn with. */
export type Verdict = "DONE" | "BLOCKED" | "FAILED";

/** The verdict tag carried by a parsed outcome (parseOutcome output), or null. */
export function verdictOf(outcome: string | null): Verdict | null {
  if (outcome === null) return null;
  if (outcome.startsWith("DONE")) return "DONE";
  if (outcome.startsWith("BLOCKED")) return "BLOCKED";
  if (outcome.startsWith("FAILED")) return "FAILED";
  return null;
}

/** Compact inline verdict marker (glyph + word) for list/row surfaces. */
export function verdictMarker(verdict: Verdict): string {
  switch (verdict) {
    case "BLOCKED":
      return "🚧 BLOCKED";
    case "FAILED":
      return "❌ FAILED";
    default:
      return "✅ DONE";
  }
}

/** How a crew's idle turn is presented once its self-reported verdict is known. */
export interface VerdictPresentation {
  /** Doorbell / wake-drain head, e.g. "✅ crew c1 done". */
  head: string;
  /** The `next:` action line appropriate to the verdict. */
  next: string;
}

/**
 * Present a crew that ended its turn idle (thread.idle → kind "idle") by its
 * PARSED VERDICT, not by the raw event kind. A crew that self-reports BLOCKED or
 * FAILED in-band still fires thread.idle, so deriving the head from kind alone
 * renders a failure as "✅ … done" and offers `deliver` on a FAILED crew. Each
 * verdict gets a distinct glyph and an appropriate next action:
 *   DONE    → ✅ done,    deliver
 *   BLOCKED → 🚧 blocked, tell|retry|forget (unblock/steer, never deliver)
 *   FAILED  → ❌ failed,  retry|tell|forget (retry/investigate, never deliver)
 * A verdict-less idle (verdict null — ambiguous) keeps the done/deliver shape,
 * matching the prior default; the doorbell-suppression gate independently errs
 * toward telling the captain for any non-DONE outcome.
 */
export function idleVerdictPresentation(crewId: string, verdict: Verdict | null): VerdictPresentation {
  switch (verdict) {
    case "BLOCKED":
      return { head: `🚧 crew ${crewId} blocked`, next: `next: bb firstmate tell|retry|forget ${crewId}` };
    case "FAILED":
      return { head: `❌ crew ${crewId} failed`, next: `next: bb firstmate retry|tell|forget ${crewId}` };
    default:
      return { head: `✅ crew ${crewId} done`, next: `next: bb firstmate deliver ${crewId}` };
  }
}

const CORR_TOKEN = /^corr=[0-9A-Fa-f]{16}$/;
const PROTOCOL_VERBS = new Set(["done", "blocked", "failed"]);

/** Leading verb, same cut as fm-classify-lib `status_line_verb` (before `:` / `[`, corr tokens dropped). */
export function statusLineVerb(line: string): string {
  let verb = line.split(":")[0] ?? "";
  const bracket = verb.indexOf("[");
  if (bracket >= 0) verb = verb.slice(0, bracket);
  verb = verb.trim();
  if (!verb.includes("corr=")) return verb;
  const words = verb.split(/[ \t]+/).filter((word) => word !== "");
  const first = words[0] ?? "";
  const rest = words.slice(1).filter((word) => !CORR_TOKEN.test(word));
  return [first, ...rest].filter((word) => word !== "").join(" ");
}

/**
 * True when a reply already carries a status-protocol verdict.
 * Marker at the start of the reply, or a standalone line: the line's leading
 * verb is DONE / BLOCKED / FAILED. Prose that merely mentions the token does not count.
 */
export function hasStatusProtocol(text: string | null | undefined): boolean {
  if (text == null || text === "") return false;
  for (const line of text.split(/\r?\n/)) {
    if (!/[^ \t]/.test(line)) continue;
    if (PROTOCOL_VERBS.has(statusLineVerb(line).toLowerCase())) return true;
  }
  return false;
}

// ── Full status protocol ─────────────────────────────────────────────────────
// The complete firstmate status vocabulary and the keyed open-decision fold,
// ported line-for-line from bin/fm-classify-lib.sh so BB reads the same state
// the real watcher/bearings do. `working`/`paused`/`done`/`failed`/`resolved`/
// `captain-held` never leave a decision open; `needs-decision`/`blocked` open one
// keyed by [key=<slug>], and only a `resolved`/`captain-held` line carrying that
// exact key closes it — a later unrelated line never masks a still-open decision.

/** The whole firstmate status verb roster (fm-classify-lib vocabulary). */
export const STATUS_VERBS: ReadonlySet<string> = new Set([
  "working",
  "needs-decision",
  "blocked",
  "paused",
  "done",
  "failed",
  "resolved",
  "captain-held",
]);

/** Terminal, always-captain-relevant verbs (fm-classify-lib `status_is_terminal_verb`). */
export const TERMINAL_VERBS: ReadonlySet<string> = new Set(["done", "needs-decision", "blocked", "failed"]);

const SLUG_OK = /^[A-Za-z0-9._-]+$/;
const RESERVED_KEY_PREFIXES = ["pending-reply-"] as const;
const RESOLVE_VERB = "resolved";
const HELD_VERB = "captain-held";

export interface OpenDecision {
  key: string;
  verb: "needs-decision" | "blocked";
  note: string;
}

/**
 * fm-classify-lib `_fm_status_unstamped`: strip the worker-written `[at=…]` time
 * tag(s) that sit before the line's first colon. Both the key and note readers,
 * and the terminal-collapse colon test, locate the head/note separator on this
 * unstamped copy so a readable stamp like `[at=10:30]` can never move it — its
 * colons would otherwise end the head mid-tag or make a keyless line look like a
 * transition. Tags at or after the first real colon (i.e. inside the note) are
 * left untouched, exactly as the reference stops on the first colon it sees.
 */
function stripTimeTag(line: string): string {
  let rest = line;
  let keep = "";
  for (;;) {
    const at = rest.indexOf("[at=");
    if (at < 0) break;
    const close = rest.indexOf("]", at + 4);
    if (close < 0) break; // no complete tag left (bash *\[at=*\]* requires a `]`)
    const before = rest.slice(0, at);
    if (before.includes(":")) break; // colon before the tag → the tag is in the note
    keep += before.replace(/ $/, ""); // bash `${before% }`: drop one trailing space
    rest = rest.slice(close + 1);
  }
  return keep + rest;
}

/** fm-classify-lib `_fm_key_before_colon` + key extraction: the `[key=<slug>]` before the first colon. */
function keyBeforeColon(unstamped: string): string | null {
  const before = unstamped.split(":", 1)[0] ?? unstamped;
  const m = /\[key=([^\]]*)\]/.exec(before);
  return m ? (m[1] ?? "") : null;
}

/** fm-classify-lib `_fm_key_at_note_head`: a `[key=<slug>]` token at the head of the note. */
function keyAtNoteHead(unstamped: string): string | null {
  const idx = unstamped.indexOf(":");
  if (idx < 0) return null;
  const rest = unstamped.slice(idx + 1).replace(/^\s+/, "");
  const m = /^\[key=([^\]]*)\]/.exec(rest);
  return m ? (m[1] ?? "") : null;
}

/** fm-classify-lib `_fm_decision_key`: key slug, "default" when no token, null when the stated slug is malformed. */
function decisionKey(line: string): string | null {
  const unstamped = stripTimeTag(line);
  const before = keyBeforeColon(unstamped);
  let k: string;
  if (before !== null) {
    k = before;
  } else {
    const head = keyAtNoteHead(unstamped);
    if (head === null) return "default";
    k = head;
  }
  return SLUG_OK.test(k) ? k : null;
}

/** fm-classify-lib `status_line_note`: text after the first colon, with a note-head key token stripped. */
export function statusLineNote(line: string): string {
  const unstamped = stripTimeTag(line);
  const idx = unstamped.indexOf(":");
  if (idx < 0) return unstamped;
  let n = unstamped.slice(idx + 1).replace(/^\s+/, "");
  if (keyBeforeColon(unstamped) === null) {
    const k = keyAtNoteHead(unstamped);
    if (k !== null && SLUG_OK.test(k)) {
      const tok = `[key=${k}]`;
      if (n.startsWith(tok)) n = n.slice(tok.length).replace(/^\s+/, "");
    }
  }
  return n;
}

/** fm-classify-lib `_fm_decision_key_transition_allowed`: reserved keys only transition on their own vocabulary. */
function keyTransitionAllowed(key: string, note: string): boolean {
  for (const prefix of RESERVED_KEY_PREFIXES) {
    if (key.startsWith(prefix)) {
      return note.startsWith(prefix) && note.slice(prefix.length).includes(":");
    }
  }
  return true;
}

/**
 * Fold an append-only status stream into the decisions still open, mirroring
 * fm-classify-lib `status_open_decisions` (via `_fm_decision_fold_line`).
 * Most-recently-opened last, exactly as the reference prints them.
 *
 * `kind` selects the terminal-collapse rule native reads from the task's sibling
 * `.meta`: a ship/scout `done`/`failed` line closes EVERY open decision
 * (fm-classify-lib.sh:700-702), because the terminal verdict retires the whole
 * task — an earlier keyed decision it never explicitly resolved is moot, not a
 * phantom the captain still owes an answer. `secondmate` and `unknown` do NOT
 * collapse.
 *
 * `kind` is NOT optional-with-a-safe-guess: native derives it per crew from the
 * `.meta` and classifies a metaless crew as `unknown` (non-collapsing), so a
 * caller that hardcodes `ship` would collapse decisions native keeps open —
 * a SUPPRESSING divergence that hides a real captain call. Callers MUST resolve
 * the crew's real kind (see server.ts `foldKind` → `classifyMetaKind`). The
 * `"ship"` default exists only so the pure differential harness and the
 * hand-written unit tests can name a kind inline; it is not a stand-in for
 * resolving the real one.
 */
export function foldOpenDecisions(lines: string[], kind: string = "ship"): OpenDecision[] {
  const collapses = kind === "ship" || kind === "scout";
  let open: OpenDecision[] = [];
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    // Real state/<id>.status is lowercase (fm-classify-lib); a BB crew's chat
    // output emits uppercase DONE/BLOCKED/FAILED. Compare case-insensitively so
    // both streams fold the same; the on-host stream is already lowercase, so
    // this never changes the reference behavior.
    const verb = statusLineVerb(line).toLowerCase();
    // Only the six fold verbs can move the set; prose, blank lines, working, and
    // paused are no-ops — mirrors the `while … case "$verb"` filter in native.
    if (
      verb !== "needs-decision" &&
      verb !== "blocked" &&
      verb !== "done" &&
      verb !== "failed" &&
      verb !== RESOLVE_VERB &&
      verb !== HELD_VERB
    ) {
      continue;
    }
    const unstamped = stripTimeTag(line);
    // Declaration guard (native `_fm_decision_fold_line`): a fold verb whose
    // unstamped body carries neither a colon nor a complete `[key=…]` token is
    // continuation prose and can never move the set.
    if (!unstamped.includes(":") && !/\[key=[^\]]*\]/.test(unstamped)) continue;
    // Terminal collapse (native :700-702): a ship/scout done|failed line whose
    // unstamped body carries a colon retires every open decision. This runs
    // BEFORE the key parse, so a malformed or absent key on the terminal line
    // still collapses — exactly as native returns the empty set there.
    if (collapses && (verb === "done" || verb === "failed") && unstamped.includes(":")) {
      open = [];
      continue;
    }
    // A done|failed that did not collapse (non-collapsing kind, or no colon) is a
    // no-op: native's later `case "$verb"` lists only the four decision verbs.
    if (verb === "done" || verb === "failed") continue;
    const key = decisionKey(line);
    if (key === null) continue; // malformed slug: no-op
    if (!keyTransitionAllowed(key, statusLineNote(line))) continue;
    if (verb === "needs-decision" || verb === "blocked") {
      const note = statusLineNote(line);
      open = open.filter((r) => r.key !== key);
      open.push({ key, verb, note });
    } else {
      open = open.filter((r) => r.key !== key); // resolved | captain-held closer
    }
  }
  return open;
}

/**
 * fm-classify-lib `_fm_status_kind` (its `.meta`-derived branch): the crew kind
 * native folds a status file under, resolved from the sibling `.meta`.
 *   - `null` (meta absent / unreadable / a symlink) → `"unknown"` — native's
 *     fallback, which does NOT terminal-collapse.
 *   - present but no `kind=` line → `"ship"` (native's `${kind:-ship}`).
 *   - the LAST `kind=` line wins (native overwrites in its read loop); an
 *     unrecognized value → `"unknown"`.
 * The caller performs the file stat/read (native requires a regular, readable,
 * non-symlink file); this is the pure classify so it can be proven equal to
 * native's `_fm_status_kind` in the differential guard.
 */
export function classifyMetaKind(metaContent: string | null): string {
  if (metaContent === null) return "unknown";
  let kind = "";
  // Match native's `while IFS= read -r line; case kind=*`: split on \n only and
  // keep any \r, so a CRLF meta classifies exactly as native's `read -r` would.
  for (const line of metaContent.split("\n")) {
    if (line.startsWith("kind=")) kind = line.slice("kind=".length);
  }
  if (kind === "") kind = "ship";
  return kind === "ship" || kind === "scout" || kind === "secondmate" ? kind : "unknown";
}

/** The most recent recognized status verb + note (fm-classify-lib `last_status_line`, verb-filtered). */
export function latestStatus(lines: string[]): { verb: string; note: string } | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = (lines[i] ?? "").replace(/\r$/, "");
    if (!/\S/.test(line)) continue;
    const verb = statusLineVerb(line).toLowerCase();
    if (STATUS_VERBS.has(verb)) return { verb, note: statusLineNote(line) };
  }
  return null;
}

/** Pull the status-protocol lines out of arbitrary text (a BB crew's chat output has no .status file). */
export function statusLinesFrom(text: string | null | undefined): string[] {
  if (text == null || text === "") return [];
  return text.split(/\r?\n/).filter((line) => /\S/.test(line) && STATUS_VERBS.has(statusLineVerb(line).toLowerCase()));
}

/**
 * A one-block human summary of a crew's folded status: the latest state, and any
 * still-open keyed decisions. `null` when the stream carries no status protocol.
 */
export function statusProtocolSummary(lines: string[], kind: string = "ship"): string | null {
  const latest = latestStatus(lines);
  // Once a crew's latest status is terminal (done/failed) the task is over, so
  // any earlier keyed decision is moot — do not report it as still open. This
  // also protects the chat-output source, which never carries the resolved/
  // captain-held closing lines the real state/<id>.status stream would.
  const terminal = latest !== null && (latest.verb === "done" || latest.verb === "failed");
  const open = terminal ? [] : foldOpenDecisions(lines, kind);
  if (latest === null && open.length === 0) return null;
  const parts: string[] = [];
  if (latest !== null) {
    parts.push(`state: ${latest.verb}${latest.note !== "" ? ` — ${truncate(latest.note, 160)}` : ""}`);
  }
  for (const d of open) {
    parts.push(`open ${d.verb} [${d.key}]: ${truncate(d.note, 160)}`);
  }
  return parts.join("\n");
}

const TURNEND_RULE = "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━";

/** Doorbell copy in the upstream turn-end guard banner shape. */
export function protocolNudgeText(nag: number, max: number): string {
  return [
    `●${TURNEND_RULE}`,
    `●  TURN ENDED WITHOUT A STATUS VERDICT (nag ${nag} of ${max})`,
    "●  Last reply has no DONE:, BLOCKED:, or FAILED: verdict.",
    "●  A verdict is the marker at the start of the reply, or a standalone line.",
    "●  Re-state the outcome in that protocol. Do not redo the task.",
    "●    DONE: <one-line outcome>",
    "●    BLOCKED: <what you need, exactly>",
    "●    FAILED: <what failed + evidence>",
    `●${TURNEND_RULE}`,
  ].join("\n");
}

export function queueGate(
  item: { status: string; blockedBy: string[]; waitUntil: string | null; id: string },
  all: Array<{ id: string; status: string }>,
  now: number,
): string | null {
  if (item.status !== "queued") return `status ${item.status}`;
  for (const depId of item.blockedBy) {
    const dep = all.find((q) => q.id === depId);
    if (dep === undefined) return `dep ${depId} unknown`;
    if (dep.status !== "done") return `waiting on ${depId} (${dep.status})`;
  }
  if (item.waitUntil !== null) {
    const t = Date.parse(item.waitUntil);
    if (Number.isNaN(t)) return `bad wait-until ${item.waitUntil}`;
    if (t > now) return `gated until ${item.waitUntil}`;
  }
  return null;
}

export function decisionDue(
  d: { status: string; deferredUntil: string | null },
  now: number,
): boolean {
  if (d.status === "open") return true;
  if (d.status !== "deferred" || d.deferredUntil === null) return false;
  const t = Date.parse(d.deferredUntil);
  return !Number.isNaN(t) && t <= now;
}

/** AFK holds routine done-pings; failures, stuck, credentials, and review-ready PRs always surface. */
export function afkShouldSend(event: string): boolean {
  if (event === "idle") return false;
  if (event === "error" || event.startsWith("stuck") || event === "unknown") return true;
  if (event === "interaction" || event === "credential" || event === "review") return true;
  return true;
}

export function quietShouldSend(event: string): boolean {
  return event !== "idle";
}

export const AXI_TOOL_CONTRACT = "Use gh-axi for GitHub and lavish-axi for visual review; read current --help. For all browser work, use the /browser skill and browser_script (or bb browser script). Leave profileId unset for the thread-isolated default profile. This BB browser policy overrides imported native chrome-devtools-axi instructions; do not use the AXI browser or install its hooks. Use quota-axi for quota decisions and the home's bin/fm-tasks-axi.sh for backlog work. In no-mistakes mode, the worker owns the real no-mistakes axi pipeline; a manual checklist is not a substitute. For crew-hosted Lavish boards, open the artifact then use the home's fm-procevent-lavish.sh arm <artifact> --for <task-id>; never start a second poller.";

export const SECRET_HYGIENE_CONTRACT = "Never print production secrets: do not run env list/get against production (e.g. convex env list --prod), printenv, or credential dumps, and never echo credential values. Reference variable names only.";

// Stuck ladder: a relaunch is the replacement step; the second failure is reported,
// not relaunched again.
export const MAX_CREW_RELAUNCHES = 1;

// Default ceiling on concurrently running crews per captain (0 = no cap).
export const DEFAULT_MAX_ACTIVE_CREWS = 5;

// BB rejects retry reasons over 200 characters; a long captain note must not
// turn a retry into an error.
export function retryReason(reason: string | undefined, crewId: string): string {
  const text = (reason ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return `firstmate retry crew ${crewId}`;
  return text.length <= 200 ? text : `${text.slice(0, 199)}…`;
}

export function crewPrompt(input: {
  task: string;
  parentThreadId: string | undefined;
  shape: Shape;
  mode: DeliveryMode;
  isolated: boolean;
}): string {
  const { task, parentThreadId, shape, mode, isolated } = input;
  const head = [
    shape === "scout"
      ? "You are a SCOUT in a firstmate-style crew: investigate, then report back. You never change code, never commit, never open a PR."
      : "You are a CREWMATE in a firstmate-style crew: one task, in your own workspace, then report back.",
    parentThreadId === undefined
      ? "No captain thread linked; work standalone."
      : `Your captain thread is ${parentThreadId}; it supervises and is your ONLY contact. Never address the user directly. Messages from the captain are orders: start your reply with ACK: <one line> confirming you understood, then act immediately, do not ask for confirmation.`,
    "",
    "Captain's intent + Firstmate spec (do not widen):",
    task,
    "",
    isolated
      ? "Workspace: you MUST work only in this isolated worktree. If this is the project's primary checkout, STOP and report BLOCKED: not isolated."
      : "Workspace: stay inside your assigned environment. If you find yourself editing outside it, STOP and report BLOCKED.",
    "Do not dispatch other crews. Do not run bb firstmate dispatch. One task, then report.",
    AXI_TOOL_CONTRACT,
    SECRET_HYGIENE_CONTRACT,
    "",
    "Status protocol: when finished, your final message MUST start with exactly one of these lines:",
    "  DONE: <one-line outcome>",
    "  BLOCKED: <what you need, exactly>",
    "  FAILED: <what failed + evidence>",
    "Then the detail. Keep it sparse: outcomes and blockers only, no progress narration.",
    "",
  ];
  const tail =
    shape === "scout"
      ? [
          "Report (standalone, the captain never saw your session): findings, evidence (file:line),",
          "decision inventory (options + your recommendation), open questions.",
          "A recommendation is not authorization: never implement what you recommend.",
        ]
      : mode === "local-only"
        ? [
            "Delivery (local-only): own branch, small diff, run relevant checks.",
            "Do NOT push, do NOT open a PR. Stop at a clean ready branch and report DONE with the branch name.",
            "After DONE: outcome, branch, changed files, validation run, blockers/next step.",
          ]
        : mode === "no-mistakes"
          ? [
              "Delivery (no-mistakes): own branch, small diff.",
              "Read no-mistakes axi --help, then drive the native run/respond workflow as its worker owner. Follow its gates and branch custody; do not replace the pipeline with manual checks.",
              "Report DONE with the PR URL only after the pipeline permits delivery and CI is green. Missing tools or authentication are BLOCKED, not permission to bypass a gate.",
              "After DONE: outcome, PR URL, validation run, blockers/next step.",
            ]
          : [
              "Delivery (direct-PR): own branch, small diff, run relevant checks.",
              "Then push + open a PR. Report DONE with the PR URL.",
              "After DONE: outcome, PR URL, changed files, validation run, blockers/next step.",
            ];
  return [...head, ...tail].join("\n");
}

export interface BearingsRow {
  id: string;
  status: string;
  shape: string;
  task: string;
  prUrl?: string;
  prSummary?: string;
}

export function bearingsText(input: {
  rows: BearingsRow[];
  calls: string[];
  landed: string[];
  ready: string[];
  running: string[];
  next: string[];
  idle: number;
  active: number;
  errors: number;
  decisionsDue: number;
  queued: number;
}): string {
  const section = (title: string, items: string[], empty: string) =>
    [`== ${title} ==`, ...(items.length > 0 ? items : [empty])].join("\n");
  const head = `Fleet: ${input.rows.length} crews (${input.idle} idle, ${input.active} active, ${input.errors} error) · ${input.decisionsDue} decisions due · ${input.queued} queued`;
  if (
    input.rows.length === 0 &&
    input.calls.length === 0 &&
    input.landed.length === 0 &&
    input.next.length === 0
  ) {
    return "No crews, no queue, no decisions.";
  }
  return [
    head,
    section("Captain's Call", input.calls, "Nothing needs your action right now."),
    section("Recently Landed", input.landed, "No recent completions."),
    section("Ready to review", input.ready, "Nothing waiting for review."),
    section("Underway", input.running, "Nothing underway."),
    section("Charted Next", input.next, "Nothing queued."),
  ].join("\n");
}

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export interface MergeGateInput {
  /** Live PR state: open | merged | closed | draft | ... */
  prState: string;
  /** Live check rollup state: passing | failing | pending | no_checks | unknown. */
  checksState: string;
  /** Forge mergeability: MERGEABLE | CONFLICTING | UNKNOWN. */
  mergeable: string;
  failed: number;
  pending: number;
  /** Exact check name the captain waives (mirrors fm-pr-merge --allow-red). */
  allowRedCheck?: string;
  /** Names of the non-green checks, when they can be read. null when unknown. */
  redChecks?: string[] | null;
}

export type MergeGate = { ok: true; waived: string[] } | { ok: false; reason: string };

/**
 * The check/mergeability half of the merge decision, mirroring fm-pr-merge.sh.
 * Captain authority (`yes`/yolo) is enforced by the caller and is deliberately
 * NOT part of this gate: an allowRedCheck waiver never grants authority, and
 * authority never waives a red check. Zero checks (no_checks) is treated as no
 * failing checks. A red check lands only when the captain names it exactly and
 * every other check is green — never silently.
 */
export function mergeGate(input: MergeGateInput): MergeGate {
  if (input.prState !== "open") {
    return { ok: false, reason: `PR is ${input.prState === "" ? "unknown" : input.prState}, not open.` };
  }
  const waive = (input.allowRedCheck ?? "").trim();
  const cs = input.checksState;
  if (cs === "failing") {
    if (waive === "") {
      return {
        ok: false,
        reason: `checks failing (failed ${input.failed}, pending ${input.pending}). To land anyway, name the exact red check to waive: allowRedCheck=<check-name>.`,
      };
    }
    if (!Array.isArray(input.redChecks)) {
      return {
        ok: false,
        reason: `cannot read individual check names to honor allowRedCheck=${waive}; refusing (a failed read is never an empty red set).`,
      };
    }
    if (!input.redChecks.includes(waive)) {
      return {
        ok: false,
        reason: `allowRedCheck=${waive} names no failing check (red: ${input.redChecks.join(", ") || "none"}).`,
      };
    }
    const remaining = input.redChecks.filter((name) => name !== waive);
    if (remaining.length > 0) {
      return {
        ok: false,
        reason: `other checks still red (${remaining.join(", ")}); allowRedCheck waives one exact name and every other check must be green.`,
      };
    }
    if (input.pending > 0) {
      return { ok: false, reason: `checks still pending (${input.pending}); wait before waiving a red check.` };
    }
    return mergeableGate(input, [waive]);
  }
  if (cs === "pending") return { ok: false, reason: `checks pending (${input.pending}).` };
  if (cs === "unknown") return { ok: false, reason: "checks unknown; cannot confirm green." };
  // passing | no_checks — no failing checks. An allowRedCheck with nothing red waives nothing.
  return mergeableGate(input, []);
}

function mergeableGate(input: MergeGateInput, waived: string[]): MergeGate {
  if (input.mergeable !== "MERGEABLE") return { ok: false, reason: `PR not mergeable (${input.mergeable}).` };
  return { ok: true, waived };
}
