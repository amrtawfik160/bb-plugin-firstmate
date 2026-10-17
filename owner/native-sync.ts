// Owner layer (decisions Q3, Q12, Q13): the weekly native sync. scripts/native-sync.ts reads
// GitHub, git and BB, then asks nextSyncStep what to do. Each run does at most one step.
// Every side effect has an operation id that the script saves before it acts: a spawned
// thread carries it in its title, a message to the repair thread on its first line. A run that
// finds an operation without its result looks for that id first, so it never repeats one.
import { ROLE_DEFAULTS } from "./crew-roles.ts";
import { matches } from "./reach.ts";

export const SYNC = {
  upstream: "https://github.com/kunchenguid/firstmate",
  repo: "amrtawfik160/bb-plugin-firstmate",
  branchPrefix: "native-sync/",
  brief: "docs/native-sync.md",
  builder: ROLE_DEFAULTS.builder,
  checker: ROLE_DEFAULTS.checker,
} as const;

/** A sync crew that ends without a PR is started again until this many attempts, then reported. */
export const MAX_SYNC_ATTEMPTS = 2;

// A sync that changes one of these changes how Hanoon talks to the owner, so the owner gets a
// card. The allowlist pins the captain's prompt text, so a change to that text in server.ts
// changes it too.
export const OWNER_FACING_PATHS = [
  "/entry-skills/captain/",
  "/owner/handoff-contract.ts",
  "/lib/owner-asks.ts",
  "/lib/owner-board.ts",
  "/lib/owner-tasks.ts",
  "/lib/telegram-*.ts",
  "/lib/inbound-*.ts",
  "/docs/telegram-bridge-contract.md",
  "/docs/verification/native-transport-allowlist.v1.json",
] as const;

/** threadId is missing while the launch's result is unknown. */
type Launch = { op: string; threadId?: string; at: string };

export type SyncState = {
  sync?: Launch & { target: string; attempt: number };
  check?: Launch & { head: string; pr: number };
  /** A message to the repair thread whose delivery is not confirmed yet, saved before it is sent. */
  outbox?: { key: string; op: string; text: string; at: string };
  /** What `bb thread tell --json` returned for each delivered message. */
  receipts?: Record<string, unknown>;
  /** Keys of the messages delivered: report:<head>, failed:<target>, closed:<pr>. */
  done?: string[];
};

export type SyncPr = { number: number; url: string; branch: string; head: string };

export type SyncObservation = {
  /** The weekly run may start a sync for a new upstream HEAD; the follow-up run never does. */
  start: boolean;
  /** Start the current upstream HEAD again after it was reported as failed or closed. */
  retry: boolean;
  pin: string;
  upstream: string;
  /** Open PRs whose branch starts with SYNC.branchPrefix, oldest first. */
  prs: readonly SyncPr[];
  /** Sync PRs on the last sync's branch that were closed without a merge. */
  closed: readonly SyncPr[];
  /** Changed files of the first open sync PR. */
  files: readonly string[];
  /** The threads named in the state; a missing thread is finished. */
  threads: Readonly<Record<string, { status: string; output: string } | undefined>>;
  /** For a launch without its result: the repair thread's children created inside the
   * operation's window whose title carries its id. */
  launched: Readonly<Record<string, readonly string[]>>;
  /** For a message without its result: whether the repair thread's log since the intent has
   * it. "unknown": the search could not finish. */
  delivered: Readonly<Record<string, "found" | "absent" | "unknown">>;
  /** A fresh operation id for a new side effect. */
  newOp: string;
  /** The live captain home, read-only for the sync crew: the guard hashes its data/captain.md. */
  liveHome?: string;
};

export type SyncStep =
  | { action: "none"; why: string }
  | { action: "adopt"; slot: "sync" | "check"; threadId: string }
  | { action: "spawn-sync"; op: string; target: string; attempt: number; branch: string; title: string; prompt: string }
  | { action: "spawn-check"; op: string; pr: number; head: string; branch: string; title: string; prompt: string }
  | { action: "tell"; key: string; op: string; text: string }
  | { action: "delivered"; key: string };

const short = (sha: string) => sha.slice(0, 8);
const working = (thread: { status: string } | undefined) => thread !== undefined && !["idle", "error", "archived"].includes(thread.status);
const tail = (text: string, max = 1500) => (text.length > max ? `…${text.slice(-max)}` : text).trim() || "(no final message)";
export const opTag = (op: string) => `[op:${op}]`;
export const marker = (op: string) => `[native-sync ${op}]`;

export function ownerFacing(files: readonly string[]): string[] {
  return files.filter((file) => matches(file, OWNER_FACING_PATHS));
}

/** The verdict is the last non-empty line of the checker's final message. */
export function verdictOf(output: string): { verdict: "pass" | "fail"; line: string } {
  const line = output.split("\n").map((l) => l.trim()).filter((l) => l !== "").pop() ?? "";
  if (!/^VERDICT:\s*(pass|fail)\b/i.test(line)) return { verdict: "fail", line: "no VERDICT line at the end of the checker's final message" };
  return { verdict: /^VERDICT:\s*pass\b/i.test(line) ? "pass" : "fail", line };
}

export function nextSyncStep(o: SyncObservation, state: SyncState): SyncStep {
  if (state.outbox !== undefined) {
    const { key, op, text } = state.outbox;
    const seen = o.delivered[op] ?? "unknown";
    if (seen === "found") return { action: "delivered", key };
    if (seen === "unknown") return { action: "none", why: `cannot confirm whether ${key} was delivered: the search of the repair thread's log did not finish; it runs again next time` };
    return { action: "tell", key, op, text };
  }
  const adopt = (slot: "sync" | "check", op: string, again: () => SyncStep): SyncStep => {
    const found = o.launched[op] ?? [];
    if (found.length === 1) return { action: "adopt", slot, threadId: found[0]! };
    if (found.length > 1) return { action: "none", why: `${found.length} threads carry operation ${op} (${found.join(", ")}); set the right one as ${slot}.threadId in the state file` };
    return again();
  };
  const sync = state.sync;
  if (sync !== undefined && sync.threadId === undefined) return adopt("sync", sync.op, () => spawnSync(o, sync.target, sync.attempt, sync.op));
  const pr = o.prs[0];
  const check = state.check;
  if (check !== undefined && check.threadId === undefined && pr !== undefined) return adopt("check", check.op, () => spawnCheck(pr, check.op));
  if (sync?.threadId !== undefined && working(o.threads[sync.threadId])) return { action: "none", why: `sync crew ${sync.threadId} is still working` };
  const done = new Set(state.done ?? []);
  const tell = (key: string, body: string): SyncStep => (done.has(key) ? { action: "none", why: `${key} is already reported` } : { action: "tell", key, op: o.newOp, text: `${marker(o.newOp)}\n${body}` });

  if (pr !== undefined) {
    const checker = check?.threadId === undefined ? undefined : o.threads[check.threadId];
    if (check !== undefined && working(checker)) return { action: "none", why: `checker ${check.threadId} is still working on PR #${check.pr}` };
    if (check === undefined || check.head !== pr.head) return spawnCheck(pr, o.newOp);
    return tell(`report:${pr.head}`, report(o, state, pr));
  }

  if (o.upstream === o.pin) return { action: "none", why: `pin ${short(o.pin)} is upstream HEAD` };
  if (sync !== undefined && sync.target === o.upstream) {
    if (o.retry) return spawnSync(o, o.upstream, 1, o.newOp);
    const closed = o.closed[0];
    if (closed !== undefined) return tell(`closed:${closed.number}`, closedReport(closed));
    if (sync.attempt < MAX_SYNC_ATTEMPTS) return spawnSync(o, o.upstream, sync.attempt + 1, o.newOp);
    return tell(`failed:${sync.target}`, failedReport(o, sync));
  }
  if (!o.start) return { action: "none", why: "no sync PR is open; only the weekly run starts a sync" };
  return spawnSync(o, o.upstream, 1, o.newOp);
}

function spawnSync(o: SyncObservation, target: string, attempt: number, op: string): SyncStep {
  const branch = `${SYNC.branchPrefix}${short(target)}`;
  return { action: "spawn-sync", op, target, attempt, branch, title: `Native sync to ${short(target)} ${opTag(op)}`, prompt: syncPrompt(o.pin, target, branch, o.liveHome) };
}

function spawnCheck(pr: SyncPr, op: string): SyncStep {
  return { action: "spawn-check", op, pr: pr.number, head: pr.head, branch: pr.branch, title: `Check native sync PR #${pr.number} ${opTag(op)}`, prompt: checkerPrompt(pr) };
}

function syncPrompt(pin: string, target: string, branch: string, liveHome: string | undefined): string {
  return [
    `Native Firstmate sync: move the pin from ${pin} to ${target} (${SYNC.upstream}).`,
    `Read ${SYNC.brief} in full first and follow every step. Work on branch ${branch}.`,
    ...(liveHome ? [`The live captain home is ${liveHome}. It is read-only for you: pass it to the guard as FM_HOME and change nothing in it.`] : []),
    "Resolve clashes yourself. Keep the owner layer byte-identical. Stop at the open PR: do not merge, reload or switch a live home.",
  ].join("\n");
}

function checkerPrompt(pr: SyncPr): string {
  return [
    `Check the native sync PR ${pr.url} at head ${pr.head}. Do not change its branch.`,
    `Read the Checker section of ${SYNC.brief} and follow it.`,
    "End your final message with the findings, then one last line: VERDICT: pass, or VERDICT: fail (<n> findings).",
  ].join("\n");
}

function report(o: SyncObservation, state: SyncState, pr: SyncPr): string {
  const check = state.check!;
  const verdict = verdictOf(o.threads[check.threadId!]?.output ?? "");
  const facing = ownerFacing(o.files);
  return [
    `Native sync PR ${pr.url} is ready for your check and merge, at head ${short(pr.head)}.`,
    `Upstream: ${short(o.pin)} to ${state.sync === undefined ? "unknown" : short(state.sync.target)}.`,
    `Checker verdict: ${verdict.verdict} (${verdict.line}). Checker: ${check.threadId} on ${SYNC.checker.model}.`,
    facing.length > 0
      ? `Owner card: needed. This sync changes how Hanoon talks to the owner: ${facing.join(", ")}. Send the owner one card before the reload.`
      : "Owner card: not needed. No owner-facing file changed.",
    "",
    `Sync crew ${state.sync?.threadId ?? "(unknown)"}, final message:`,
    tail(state.sync?.threadId === undefined ? "" : o.threads[state.sync.threadId]?.output ?? ""),
    "",
    `Checker ${check.threadId}, final message:`,
    tail(o.threads[check.threadId!]?.output ?? ""),
    "",
    "If the verdict is pass: merge, reload and switch the live home with the steps in the PR's docs/verification/upstream-update-<date>.md.",
    "If it is fail: send the findings to the sync crew. Its next push gets a new checker.",
  ].join("\n");
}

const RETRY = "To try again, run in the project checkout with the automation's environment: node scripts/native-sync.ts tick --start --retry";

function failedReport(o: SyncObservation, sync: NonNullable<SyncState["sync"]>): string {
  const thread = o.threads[sync.threadId!];
  return [
    `Native sync to ${short(sync.target)} failed: the sync crew ended ${sync.attempt} times without a PR. No sync starts for this upstream HEAD until it moves.`,
    `Last attempt: ${sync.threadId} (${thread === undefined ? "thread not found" : thread.status}), final message:`,
    tail(thread?.output ?? ""),
    "",
    RETRY,
  ].join("\n");
}

function closedReport(pr: SyncPr): string {
  return [
    `Native sync PR ${pr.url} was closed without a merge. No sync starts for this upstream HEAD until it moves.`,
    RETRY,
  ].join("\n");
}
