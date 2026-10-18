// A crew that wrote a native `done` line and went idle has finished. Its plugin task closes at
// once, but its native backlog row stays "In flight" until native teardown removes state/<id>.meta
// and closes the row in one step. Nothing ran that teardown: on 18 Oct the live captain home listed
// 22 finished crews as in flight (one since 9 Oct) and its home summary was invalid. The plugin now
// retires a finished crew itself, after a grace period, when nothing still needs it.
import { hasTerminalVerdict, latestStatus, latestWorkerStatusLine } from "./policy.ts";

/** How long a finished crew stays, so the captain can still send it a follow-up first. */
export const FINISHED_RETIRE_GRACE_MS = 2 * 60 * 60_000;

export type FinishedCrewFacts = {
  shape: string;
  secondmate: boolean;
  /** The captain kept this crew after its merge on purpose. */
  keptAfterMerge: boolean;
  nativeHome: string;
  /** BB thread status; null when it could not be read. */
  threadStatus: string | null;
  /** The crew's native status lines, oldest first. */
  statusLines: readonly string[];
  /** An open PR delivery still needs this crew's worktree or authority. */
  deliveryOpen: boolean;
  /** The crew names a PR that has no delivery record yet. */
  untrackedPr: boolean;
  /** Firstmate's records hold an open owner card for the crew's task, or an unanswered decision for the crew. */
  ownerQuestionOpen: boolean;
};

export type RetireVerdict = { retire: true; note: string } | { retire: false; reason: string };

/** Epoch milliseconds of the latest status line's `[at=<seconds>]` tag; null when absent. */
export function latestStatusAt(lines: readonly string[]): number | null {
  const last = latestWorkerStatusLine(lines);
  const at = last === null ? null : /\[at=(\d+)\]/.exec(last)?.[1];
  return at == null ? null : Number(at) * 1000;
}

export function finishedRetireVerdict(facts: FinishedCrewFacts, now: number, graceMs = FINISHED_RETIRE_GRACE_MS): RetireVerdict {
  if (facts.secondmate) return { retire: false, reason: "secondmate route" };
  if (facts.nativeHome === "") return { retire: false, reason: "no native home" };
  if (facts.keptAfterMerge) return { retire: false, reason: "kept by the captain after its merge" };
  if (facts.threadStatus !== "idle") return { retire: false, reason: `thread is ${facts.threadStatus ?? "unreadable"}` };
  const lines = [...facts.statusLines];
  const latest = latestStatus(lines);
  // Only a declared done line counts. A failed crew may still be retried.
  if (latest?.verb !== "done" || !hasTerminalVerdict(lines)) return { retire: false, reason: `latest status is ${latest?.verb ?? "none"}` };
  const at = latestStatusAt(lines);
  if (at === null) return { retire: false, reason: "done line has no time" };
  if (now - at < graceMs) return { retire: false, reason: "finished less than 2 hours ago" };
  if (facts.deliveryOpen) return { retire: false, reason: "an open PR delivery still needs it" };
  if (facts.untrackedPr) return { retire: false, reason: "its PR is not tracked yet" };
  // Owner answer, 18 Oct: an unattended retirement only when no card or question waits for this crew.
  if (facts.ownerQuestionOpen) return { retire: false, reason: "an owner card or question for it is still open" };
  return { retire: true, note: latest.note };
}

/**
 * Crew ids with an open captain-held question in the native backlog (`data/backlog.md`): an open
 * row with a `Captain hold origin: <crew>` line, or the crew's own open row held for the captain.
 */
export function openCaptainHoldOrigins(backlog: string): Set<string> {
  const origins = new Set<string>();
  let row: { id: string; held: boolean } | null = null;
  for (const line of backlog.split("\n")) {
    const open = /^- \[ \] (\S+) /.exec(line);
    if (open !== null) {
      row = { id: open[1]!, held: line.includes("(hold: ") };
      // A standalone captain row names its crew on the origin line below.
      if (row.held && !line.includes("(kind: captain)")) origins.add(row.id);
      continue;
    }
    if (/^(?:- \[|#)/.test(line)) { row = null; continue; }
    const origin = /^\s+Captain hold origin: (\S+)/.exec(line);
    if (row !== null && origin !== null) origins.add(origin[1]!);
  }
  return origins;
}

// Forgotten-work audit, 18 Oct: crew 2803e0af had 34 commits that existed only in its worktree, and
// retiring a crew deletes that worktree. A crew is never retired while its worktree has uncommitted
// files, commits on HEAD or its own fm/<id> branches that no remote has, or stashes made on those
// branches. Git spaces are not allowed in branch names, so the stash subject prefix is exact.
export const UNSAVED_MARK = "FM_UNSAVED";

/**
 * A bash script for `bash -c <script> check <worktree> <crew id>`. Prints one UNSAVED_MARK line per
 * finding, then `checked`. Any git failure prints `failed` and stops; no `checked` line is no clean read.
 */
export const UNSAVED_WORK_SCRIPT = [
  'dir=$1 id=$2',
  `fail() { echo "${UNSAVED_MARK} failed"; exit 0; }`,
  `cd -- "$dir" 2>/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "${UNSAVED_MARK} unreadable"; exit 0; }`,
  'count() { printf "%s" "$1" | awk "NF { n++ } END { print n + 0 }"; }',
  'st=$(git status --porcelain --untracked-files=all) || fail',
  'n=$(count "$st")',
  `[ "$n" -gt 0 ] && echo "${UNSAVED_MARK} uncommitted $n"`,
  'refs=$(git for-each-ref --format="%(refname)" "refs/heads/fm/$id" "refs/heads/fm/$id-*" "refs/heads/fm/$id/*") || fail',
  'local_only=$(git rev-list HEAD $refs --not --remotes) || fail',
  'u=$(count "$local_only")',
  `[ "$u" -gt 0 ] && echo "${UNSAVED_MARK} unpushed $u"`,
  'head=$(git symbolic-ref --quiet --short HEAD); [ $? -le 1 ] || fail',
  'names=$(printf "%s\\n" "$head"; for r in $refs; do printf "%s\\n" "${r#refs/heads/}"; done)',
  'subjects=$(git stash list --format=%gs) || fail',
  's=0',
  'while IFS= read -r subject; do [ -n "$subject" ] || continue; for b in $names; do case "$subject" in "WIP on $b: "*|"On $b: "*) s=$((s + 1)); break ;; esac; done; done <<< "$subjects"',
  `[ "$s" -gt 0 ] && echo "${UNSAVED_MARK} stashed $s"`,
  `echo "${UNSAVED_MARK} checked"`,
  'exit 0',
].join("\n");

/** Plain findings from the script's output; ["worktree unreadable"] when the check did not run. */
export function unsavedWorkFindings(output: string): string[] {
  const lines = output.split("\n").filter((line) => line.startsWith(`${UNSAVED_MARK} `)).map((line) => line.slice(UNSAVED_MARK.length + 1).trim());
  const findings: string[] = [];
  if (lines.includes("unreadable")) return ["worktree unreadable"];
  if (lines.includes("failed") || !lines.includes("checked")) return ["worktree check failed"];
  for (const line of lines) {
    const [kind, count] = line.split(" ");
    if (kind === "uncommitted") findings.push(`${count} uncommitted file(s)`);
    else if (kind === "unpushed") findings.push(`${count} commit(s) on no remote`);
    else if (kind === "stashed") findings.push(`${count} stash(es)`);
  }
  return findings;
}
