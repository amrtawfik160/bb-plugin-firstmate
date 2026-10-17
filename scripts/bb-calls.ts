// bb CLI calls for the weekly automation scripts. Every call has a timeout, and the searches
// that decide whether an earlier operation happened report "unknown" when they could not
// finish, so a caller never repeats a spawn or a message on an incomplete search.
import { execFileSync } from "node:child_process";

const CALL_MS = Number(process.env.FM_BB_CALL_TIMEOUT_MS) || 30_000;

export function bb(argv: string[], timeout = CALL_MS): string {
  return execFileSync("bb", argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout, killSignal: "SIGKILL" });
}

export const bbJson = (argv: string[], timeout?: number) => JSON.parse(bb(argv, timeout));

/** Children of a thread (visible, hidden and archived) whose title carries the marker and that
 * were created inside [from, to]. A marker on an older or later thread is someone else's. */
export function markedChildren(parent: string, marker: string, from: number, to: number): string[] {
  const ids = new Set<string>();
  for (const extra of [["--include-hidden"], ["--archived", "--include-hidden"]]) {
    for (const t of bbJson(["thread", "list", "--parent-thread", parent, "--json", ...extra]) as { id: string; title: string | null; createdAt?: number }[]) {
      const created = Number(t.createdAt);
      if ((t.title ?? "").includes(marker) && created >= from && created <= to) ids.add(t.id);
    }
  }
  return [...ids];
}

type Event = { seq: number; type: string; createdAt: number; data?: { input?: { text?: string }[] } };

/** Whether a message whose first lines include `marker` reached the thread at or after `since`.
 * It reads the thread's structured log from the first event of that time, page by page, to
 * the end. "unknown" when the budget ran out or a read failed before the end. */
export function findMessage(threadId: string, marker: string, since: number, budgetMs: number): "found" | "absent" | "unknown" {
  const deadline = Date.now() + budgetMs;
  const page = (after: number, limit: number): Event[] => {
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("budget");
    return bbJson(["thread", "log", threadId, "--json", "--after-seq", String(after), "--limit", String(limit)], Math.min(CALL_MS, left)) as Event[];
  };
  try {
    // The first seq at or after `since` (with a minute of clock skew): grow, then halve.
    const from = since - 60_000;
    const before = (after: number) => { const [e] = page(after, 1); return e !== undefined && e.createdAt < from; };
    let lo = 0;
    let hi = 1;
    while (before(hi)) { lo = hi; hi *= 2; }
    while (lo + 1 < hi) { const mid = Math.floor((lo + hi) / 2); if (before(mid)) lo = mid; else hi = mid; }
    for (let after = lo; ;) {
      const events = page(after, 200);
      if (events.length === 0) return "absent";
      for (const e of events) {
        if (!e.type.startsWith("client/turn/")) continue;
        if ((e.data?.input ?? []).some((i) => (i.text ?? "").split("\n").slice(0, 3).some((line) => line.trim() === marker))) return "found";
      }
      after = events[events.length - 1]!.seq;
    }
  } catch {
    return "unknown";
  }
}
