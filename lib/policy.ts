export type Shape = "ship" | "scout";
export type DeliveryMode = "direct-PR" | "no-mistakes" | "local-only";
export type PermissionMode = "accept-edits" | "auto" | "full";

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
