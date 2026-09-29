export const ORPHAN_SWEEP_INTERVAL_MS = 10 * 60_000;
export const ORPHAN_SWEEP_BUDGET_MS = 8_000;

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
