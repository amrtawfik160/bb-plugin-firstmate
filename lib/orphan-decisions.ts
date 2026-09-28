import { foldOpenDecisions } from "./policy.ts";

// A crew that is gone leaves its state/<id>.status behind. Native folds that log
// under kind `unknown` (no .meta), which never terminal-collapses, so a blocked or
// needs-decision line stays open forever and is re-printed on every wake drain.
export const ORPHAN_DECISION_QUIET_SEC = 3600;
export const ORPHAN_SWEEP_INTERVAL_MS = 10 * 60_000;
export const ORPHAN_SWEEP_BUDGET_MS = 8_000;

// Host script: ids of metaless status files that are quiet and still mention a
// decision verb. The register check and the fold stay in TS.
export function orphanCandidateScript(stateDir: string, quietSec: number): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    `cd ${q(stateDir)} 2>/dev/null || exit 0`,
    "now=$(date +%s)",
    "for f in ./*.status; do",
    '  [ -f "$f" ] && [ ! -L "$f" ] || continue',
    '  id=${f#./}; id=${id%.status}',
    '  [ -e "$id.meta" ] || [ -L "$id.meta" ] && continue',
    '  mtime=$(stat -c %Y -- "$f" 2>/dev/null) || continue',
    `  [ $((now - mtime)) -ge ${Math.max(0, Math.trunc(quietSec))} ] || continue`,
    "  grep -qE '^(needs-decision|blocked)' \"$f\" || continue",
    '  printf "FMORPHAN %s\\n" "$id"',
    "done",
  ].join("\n");
}

export function parseOrphanCandidates(output: string): string[] {
  return [...output.matchAll(/^FMORPHAN ([A-Za-z0-9._-]+)$/gm)].map((m) => m[1]!);
}

// One closing `resolved [key=…]` line per decision still open in a metaless log.
export function orphanResolveLines(statusLines: string[], reason: string): string[] {
  const note = reason.replace(/[\r\n]+/g, " ").trim().slice(0, 200);
  return foldOpenDecisions(statusLines, "unknown").map((d) => `resolved [key=${d.key}]: ${note}`);
}

// A Lavish source polls one artifact. When that artifact's worktree is torn down the
// poller can never launch again, and the watcher re-reports "process-event source
// failed to start" every cycle for a session that closed long ago. Host script: ids of
// Lavish sources whose artifact (third argv word) no longer exists.
export function staleLavishSourceScript(stateDir: string): string {
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  return [
    `cd ${q(`${stateDir}/procevent`)} 2>/dev/null || exit 0`,
    "for s in ./lavish-*.source; do",
    '  [ -f "$s" ] && [ ! -L "$s" ] || continue',
    '  id=${s#./}; id=${id%.source}',
    "  art=$(awk '/^argv:$/{f=1;next} f{n++; if(n==3){print; exit}}' \"$s\")",
    '  [ -n "$art" ] || continue',
    '  [ -e "$art" ] || [ -L "$art" ] && continue',
    '  printf "FMSTALESRC %s\\n" "$id"',
    "done",
  ].join("\n");
}

export function parseStaleLavishSources(output: string): string[] {
  return [...output.matchAll(/^FMSTALESRC (lavish-[A-Za-z0-9._-]+)$/gm)].map((m) => m[1]!);
}
