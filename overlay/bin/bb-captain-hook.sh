#!/usr/bin/env bash
# Harness hooks for BB firstmate captain threads, installed at user level by the
# firstmate plugin on `deck` (~/.claude/settings.json, ~/.codex/hooks.json).
#
# BB captains run inside product repositories, so upstream's project-level hook
# files (.claude/settings.json, .codex/hooks.json in the firstmate home) never
# load. These user-level entries restore the two harness-owned guarantees:
#
#   stop           Runs native fm-turnend-guard, then guards the BB presentation receipt.
#   stop-autoarm   Defer to a healthy BB keeper; otherwise use native asyncRewake.
#   session-start  Runs native startup inside the harness process tree.
#
# Only registered captain threads use these home bindings.
set -u

mode=${1:-}
payload=$(cat 2>/dev/null || true)
thread=${BB_THREAD_ID:-}
[ -n "$thread" ] || exit 0
case "$thread" in *[!A-Za-z0-9_-]*) exit 0 ;; esac
marker="${HOME}/.bb-firstmate/captains/${thread}"
[ -f "$marker" ] || exit 0
home=$(sed -n 's/^home=//p' "$marker" 2>/dev/null | head -n 1)
root=$(sed -n 's/^root=//p' "$marker" 2>/dev/null | head -n 1)
root=${root:-$home}
state=$(sed -n 's/^state=//p' "$marker" 2>/dev/null | head -n 1)
[ -n "$home" ] && [ -n "$state" ] || {
  printf 'firstmate: invalid captain marker thread=%s path=%s\n' "$thread" "$marker" >&2; exit 1;
}
run_native() {
  local leaf=$1; shift
  local run="$root/bin-bb/$leaf"
  [ -x "$run" ] || {
    printf 'firstmate: captain=%s missing executable %s\n' "$thread" "$run" >&2; return 1;
  }
  cd "$home" 2>/dev/null || {
    printf 'firstmate: captain=%s cannot enter home %s\n' "$thread" "$home" >&2; return 1;
  }
  printf '%s' "$payload" | FM_HOME="$home" FM_ROOT_OVERRIDE="$root" FM_STATE_OVERRIDE="$state" FM_BACKEND=bb FM_SUPERVISION_MODEL=autoarm "$run" "$@"
}

bb_keeper_healthy() {
  local keeper_pid keeper_command owner_beat watcher_beat now
  keeper_pid=$(cat "$state/.bb-watch-keeper.pid" 2>/dev/null || true)
  case "$keeper_pid" in ''|*[!0-9]*|0) return 1 ;; esac
  keeper_command=$(ps -p "$keeper_pid" -o args= 2>/dev/null || true)
  case "$keeper_command" in
    "bash $state/.bb-watch-keeper.sh"|"/bin/bash $state/.bb-watch-keeper.sh") ;;
    *) return 1 ;;
  esac
  owner_beat=$(cat "$state/.bb-watch-owner.beat" 2>/dev/null || true)
  watcher_beat=$(stat -c %Y "$state/.last-watcher-beat" 2>/dev/null \
    || stat -f %m "$state/.last-watcher-beat" 2>/dev/null || true)
  case "$owner_beat" in ''|*[!0-9]*) return 1 ;; esac
  case "$watcher_beat" in ''|*[!0-9]*) return 1 ;; esac
  now=$(date +%s)
  # Match the keeper's 600s owner TTL and native's default 300s watcher grace.
  [ "$owner_beat" -le "$now" ] && [ $((now - owner_beat)) -le 600 ] \
    && [ "$watcher_beat" -le "$now" ] && [ $((now - watcher_beat)) -le 300 ]
}

# BB private Stop feedback continues a turn that may already contain a report.
# Point that continuation back to native section 9, without consuming reports
# or introducing a second reporting policy. The final-message sentence is native.
resume_outcome_report() {
  printf '%s\n' 'After handling, continue the captain-facing outcome under native AGENTS.md section 9. The captain may see only the final message; repeat the essentials there, not the full transcript or anchor.' >&2
}

case "$mode" in
  stop)
    native_args=()
    [ "${2:-}" != "--claude" ] || native_args+=(--claude)
    run_native fm-turnend-guard.sh "${native_args[@]}"
    rc=$?
    [ "$rc" = 0 ] || exit "$rc"
    active=false
    if command -v jq >/dev/null 2>&1 && [ -n "$payload" ]; then
      active=$(printf '%s' "$payload" | jq -r 'if (.stopHookActive // .stop_hook_active // false) == true then "true" else "false" end' 2>/dev/null || echo false)
    fi
    [ "$active" = "true" ] && exit 0
    queue="${state}/.wake-queue"
    if [ -e "${state}/.bb-wake-receipt.json" ]; then
      printf 'firstmate: a durable wake receipt still needs handling. Call firstmate_wake with ack=true to recover it; after handling all reports, pass handledWake on the final successful Firstmate action or firstmate_wake.\n' >&2
      resume_outcome_report
      exit 2
    fi
    [ -s "$queue" ] || exit 0
    rows=$(awk 'END { print NR }' "$queue" 2>/dev/null || echo 0)
    [ "${rows:-0}" -gt 0 ] 2>/dev/null || exit 0
    printf 'firstmate: %s unhandled crew wake(s) for this captain. Call firstmate_wake with ack=true, handle all reports, then pass handledWake on the final successful Firstmate action or firstmate_wake.\n' "$rows" >&2
    resume_outcome_report
    exit 2
    ;;
  stop-autoarm)
    # The keeper already arms and relays this home's watcher. A second owner
    # can turn a closed cycle into repeated empty recovery turns.
    bb_keeper_healthy && exit 0
    run_native fm-claude-stop-autoarm.sh
    exit $?
    ;;
  session-start)
    # Only a captain with its own native home owns that home's session lock; a
    # legacy captain on the shared base home would take it from the others.
    [ "$(sed -n 's/^own_home=//p' "$marker" 2>/dev/null | head -n 1)" = "1" ] || exit 0
    run_native fm-sessionstart-run.sh
    exit $?

    ;;
esac
exit 0
