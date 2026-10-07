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
