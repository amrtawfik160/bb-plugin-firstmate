// Owner layer (decisions Q3, Q12, Q13): the weekly native sync. scripts/native-sync.ts reads
// GitHub, git and BB, then asks nextSyncStep what to do. Each run does at most one step, so a
// repeated or overlapping run changes nothing that is already done.
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

export type SyncState = {
  sync?: { target: string; threadId: string; at: string };
  check?: { head: string; threadId: string; pr: number; at: string };
  reported?: string;
};

export type SyncPr = { number: number; url: string; branch: string; head: string };

export type SyncObservation = {
  /** The weekly run may start a sync crew; the follow-up run only moves an open one on. */
  start: boolean;
  pin: string;
  upstream: string;
  /** Open PRs whose branch starts with SYNC.branchPrefix, oldest first. */
  prs: readonly SyncPr[];
  /** Changed files of the first open sync PR. */
  files: readonly string[];
  /** The threads named in the state; a missing thread is finished. */
  threads: Readonly<Record<string, { status: string; output: string } | undefined>>;
  /** The live captain home, read-only for the sync crew: the guard hashes its data/captain.md. */
  liveHome?: string;
};

export type SyncStep =
  | { action: "none"; why: string }
  | { action: "start-sync"; target: string; branch: string; title: string; prompt: string }
  | { action: "start-checker"; pr: number; head: string; branch: string; title: string; prompt: string }
  | { action: "report"; pr: number; head: string; message: string };

const short = (sha: string) => sha.slice(0, 8);
const working = (thread: { status: string } | undefined) => thread !== undefined && !["idle", "error", "archived"].includes(thread.status);
const tail = (text: string, max = 1500) => (text.length > max ? `…${text.slice(-max)}` : text).trim() || "(no final message)";

export function ownerFacing(files: readonly string[]): string[] {
  return files.filter((file) => matches(file, OWNER_FACING_PATHS));
}

export function verdictOf(output: string): { verdict: "pass" | "fail"; line: string } {
  const line = output.split("\n").map((l) => l.trim()).filter((l) => /^VERDICT:\s*(pass|fail)\b/i.test(l)).pop();
  if (line === undefined) return { verdict: "fail", line: "no VERDICT line in the checker's final message" };
  return { verdict: /^VERDICT:\s*pass\b/i.test(line) ? "pass" : "fail", line };
}

export function nextSyncStep(o: SyncObservation, state: SyncState): SyncStep {
  const sync = state.sync === undefined ? undefined : o.threads[state.sync.threadId];
  if (state.sync !== undefined && working(sync)) return { action: "none", why: `sync crew ${state.sync.threadId} is still working` };
  const pr = o.prs[0];
  if (pr === undefined) {
    if (!o.start) return { action: "none", why: "no sync PR is open; only the weekly run starts a sync" };
    if (o.upstream === o.pin) return { action: "none", why: `pin ${short(o.pin)} is upstream HEAD` };
    if (state.sync?.target === o.upstream) return { action: "none", why: `a sync to ${short(o.upstream)} already ran in ${state.sync.threadId} and left no open PR; it starts again only for a new upstream HEAD` };
    const branch = `${SYNC.branchPrefix}${short(o.upstream)}`;
    return { action: "start-sync", target: o.upstream, branch, title: `Native sync to ${short(o.upstream)}`, prompt: syncPrompt(o.pin, o.upstream, branch, o.liveHome) };
  }
  if (state.check === undefined || state.check.head !== pr.head) {
    return { action: "start-checker", pr: pr.number, head: pr.head, branch: pr.branch, title: `Check native sync PR #${pr.number}`, prompt: checkerPrompt(pr) };
  }
  if (working(o.threads[state.check.threadId])) return { action: "none", why: `checker ${state.check.threadId} is still working on PR #${pr.number}` };
  if (state.reported === pr.head) return { action: "none", why: `PR #${pr.number} at ${short(pr.head)} is already reported` };
  return { action: "report", pr: pr.number, head: pr.head, message: report(o, state, pr) };
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
    "End your final message with one line: VERDICT: pass, or VERDICT: fail (<n> findings), after the findings.",
  ].join("\n");
}

function report(o: SyncObservation, state: SyncState, pr: SyncPr): string {
  const check = state.check!;
  const verdict = verdictOf(o.threads[check.threadId]?.output ?? "");
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
    tail(state.sync === undefined ? "" : o.threads[state.sync.threadId]?.output ?? ""),
    "",
    `Checker ${check.threadId}, final message:`,
    tail(o.threads[check.threadId]?.output ?? ""),
    "",
    "If the verdict is pass: merge, reload and switch the live home with the steps in the PR's docs/verification/upstream-update-<date>.md.",
    "If it is fail: send the findings to the sync crew. Its next push gets a new checker.",
  ].join("\n");
}
