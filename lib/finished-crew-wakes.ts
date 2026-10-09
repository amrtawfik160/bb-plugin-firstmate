// fm-watch keeps paging "stale: … possible wedge" for an idle crew and "inactive terminal
// outcome" for a crew that finished, every few minutes, until its PR lands. When the
// crew's last outcome is DONE and the PR tracker owns its PR, those rows are noise: the
// tracker wakes the captain on PR news. (Fleet audit 2026-10-07: 54 of 116 captain turns
// ended with "nothing new", mostly after these rows.)

export type WakeRow = { seq: number; kind: string; key: string; line: string };
export type FinishedCrews = { threads: ReadonlySet<string>; crewIds: ReadonlySet<string> };

export function parseWakeRow(text: string): WakeRow | null {
  const parts = text.split("\t");
  if (parts.length < 5 || !/^\d+$/.test(parts[0]!) || !/^\d+$/.test(parts[1]!)) return null;
  return { seq: Number(parts[1]), kind: parts[2]!, key: parts[3]!, line: parts.slice(4).join("\t") };
}

const threadIds = (line: string) => [...new Set([...line.matchAll(/\bthr_[A-Za-z0-9]+/g)].map((m) => m[0]))];
const doneChild = (row: WakeRow) =>
  row.kind === "check" && row.key.startsWith("inactive-outcome:") ? /\bchild=(\S+) state=done\b/.exec(row.line)?.[1] ?? null : null;

/** Thread ids and crew ids a finished-crew check would need to resolve. */
export function finishedCrewCandidates(rows: readonly WakeRow[]): { threads: string[]; crewIds: string[] } {
  const threads = rows.filter((r) => r.kind === "stale").flatMap((r) => threadIds(r.line));
  const crewIds = rows.map(doneChild).filter((id): id is string => id !== null);
  return { threads: [...new Set(threads)], crewIds: [...new Set(crewIds)] };
}

export function isFinishedCrewWake(row: WakeRow, finished: FinishedCrews): boolean {
  if (row.kind === "stale") {
    const ids = threadIds(row.line);
    return ids.length > 0 && ids.every((id) => finished.threads.has(id));
  }
  const child = doneChild(row);
  return child !== null && finished.crewIds.has(child);
}

/** Drop finished-crew rows from a presented drain; every other line stays as it was. */
export function withoutFinishedCrewWakes(text: string, finished: FinishedCrews): { text: string; hidden: number } {
  let hidden = 0;
  const kept = text.split("\n").filter((line) => {
    const row = parseWakeRow(line);
    if (row === null || !isFinishedCrewWake(row, finished)) return true;
    hidden++;
    return false;
  });
  return { text: kept.join("\n"), hidden };
}

// A stale row says "this crew went quiet". It is a false alert when the crew already
// said why: it declared a wait, it finished, or the captain forgot it. 9 Oct 2026: 0 of
// the 19 "possible wedge" rows a captain read were about a stuck crew. A crew whose
// thread is still running, or that went quiet with no declaration and no outcome, keeps
// its row.
export type QuietCrew = {
  /** The captain forgot this crew and kept only its PR delivery. */
  forgotten: boolean;
  /** BB thread status; null when it could not be read. */
  threadStatus: string | null;
  archived: boolean;
  /** Latest status verb in the crew's status file, plugin notes skipped; null when none. */
  statusVerb: string | null;
  /** The crew's last chat message opens with WAITING: or with a DONE verdict. */
  lastMessage: "waiting" | "done" | null;
};
export type QuietVerdict = "surface" | "declared-wait" | "finished" | "forgotten";

export function quietStaleVerdict(crew: QuietCrew): QuietVerdict {
  if (crew.forgotten) return "forgotten";
  const resting = crew.archived || crew.threadStatus === "idle" || crew.threadStatus === "error";
  if (!resting) return "surface";
  if (crew.statusVerb === "paused" || crew.statusVerb === "captain-held") return "declared-wait";
  if (crew.statusVerb === "done") return "finished";
  // working, blocked, needs-decision and failed are the status file's own word; chat does not override it.
  if (crew.statusVerb !== null && crew.statusVerb !== "resolved") return "surface";
  if (crew.lastMessage === "waiting") return "declared-wait";
  return crew.lastMessage === "done" ? "finished" : "surface";
}

/** Sequence numbers and thread ids of the stale rows in a wake queue. */
export function staleQueueRows(queue: string): { seq: number; threadId: string }[] {
  return queue.split("\n").map(parseWakeRow)
    .filter((row): row is WakeRow => row !== null && row.kind === "stale")
    .flatMap((row) => { const ids = threadIds(row.line); return ids.length === 1 ? [{ seq: row.seq, threadId: ids[0]! }] : []; });
}
