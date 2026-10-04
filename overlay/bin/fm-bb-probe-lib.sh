#!/usr/bin/env bash
# BB-ONLY: bound native read-only dependency probes; native version floors and
# feature verdicts remain authoritative. No provider/model execution or cache.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/fm-timeout-lib.sh"
fm_bb_read_probe() {
  local rc capture_stderr=0
  # Native version probes discard stderr; native feature help reads include it.
  if [ "${1:-}" = --include-stderr ]; then capture_stderr=1; shift; fi
  if [ "$capture_stderr" = 0 ]; then
    fm_run_timed 5 "$@" </dev/null 2>/dev/null
  else
    fm_run_timed 5 "$@" </dev/null 2>&1
  fi
  rc=$?
  if [ "$rc" != 0 ]; then
    printf 'BB_STARTUP_PROBE_FAILED: %s (exit=%s; read-only probe bound=5s); repair this dependency before retry\n' "$*" "$rc" >&2
  fi
  return "$rc"
}
