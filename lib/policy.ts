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
              "Before opening the PR you MUST: run the full test suite, run lint/typecheck, self-review the diff, update affected docs.",
              "Then push + open a PR. Report DONE with the PR URL only after CI is green.",
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
