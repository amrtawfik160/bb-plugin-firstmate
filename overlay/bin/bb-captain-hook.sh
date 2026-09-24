#!/usr/bin/env bash
# Harness hooks for BB firstmate captain threads, installed at user level by the
# firstmate plugin on `deck` (~/.claude/settings.json, ~/.codex/hooks.json).
#
# BB captains run inside product repositories, so upstream's project-level hook
# files (.claude/settings.json, .codex/hooks.json in the firstmate home) never
# load. These user-level entries restore the two harness-owned guarantees:
#
#   stop           Upstream fm-turnend-guard.sh's queued-wake predicate: a captain
#                  may not end a turn while its wake queue holds unacknowledged
#                  rows. Blocks with exit 2 (Claude and Codex both honor it) and
#                  never twice in one turn (stop_hook_active / stopHookActive).
#   session-start  Runs the home's native fm-sessionstart-run.sh from inside the
#                  harness process tree, so the session lock is owned by the real
#                  harness (native ancestry), not a host terminal.
#
# Scope: a thread is a captain only when the plugin wrote
# ~/.bb-firstmate/captains/$BB_THREAD_ID. Every other thread, and every error,
# is a silent exit 0.
set -u

mode=${1:-}
payload=$(cat 2>/dev/null || true)
thread=${BB_THREAD_ID:-}
[ -n "$thread" ] || exit 0
case "$thread" in *[!A-Za-z0-9_-]*) exit 0 ;; esac
marker="${HOME}/.bb-firstmate/captains/${thread}"
[ -f "$marker" ] || exit 0
home=$(sed -n 's/^home=//p' "$marker" 2>/dev/null | head -n 1)
state=$(sed -n 's/^state=//p' "$marker" 2>/dev/null | head -n 1)
[ -n "$home" ] && [ -n "$state" ] || exit 0

case "$mode" in
  stop)
    active=false
    if command -v jq >/dev/null 2>&1 && [ -n "$payload" ]; then
      active=$(printf '%s' "$payload" | jq -r 'if (.stopHookActive // .stop_hook_active // false) == true then "true" else "false" end' 2>/dev/null || echo false)
    fi
    [ "$active" = "true" ] && exit 0
    queue="${state}/.wake-queue"
    [ -s "$queue" ] || exit 0
    rows=$(awk 'END { print NR }' "$queue" 2>/dev/null || echo 0)
    [ "${rows:-0}" -gt 0 ] 2>/dev/null || exit 0
    printf 'firstmate: %s unhandled crew wake(s) for this captain. Call firstmate_wake with ack=true (reads and acknowledges in one call), handle anything actionable, then end the turn.\n' "$rows" >&2
    exit 2
    ;;
  session-start)
    # Only a captain with its own native home owns that home's session lock; a
    # legacy captain on the shared base home would take it from the others.
    [ "$(sed -n 's/^own_home=//p' "$marker" 2>/dev/null | head -n 1)" = "1" ] || exit 0
    run="${home}/bin/fm-sessionstart-run.sh"
    [ -x "$run" ] || exit 0
    cd "$home" 2>/dev/null || exit 0
    printf '%s' "$payload" | FM_BACKEND=bb "$run" || true
    exit 0
    ;;
esac
exit 0
