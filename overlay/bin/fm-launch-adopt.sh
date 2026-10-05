#!/usr/bin/env bash
# BB-ONLY: repair an existing endpoint, never spawn/relaunch or deliver a prompt.
# The plugin supplies exact public BB identity evidence. Native source still owns
# isolation/filled brief/endpoint/backlog publication and lease rules. Neither
# initial worktree freshness nor original admission is fabricated after work ran.
set -euo pipefail
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
case "${1:-}" in --check|--publish) ACTION=$1 ;; *) echo 'Usage: fm-launch-adopt.sh --check|--publish (plugin evidence on stdin)' >&2; exit 2 ;; esac
[ "$#" = 1 ] || exit 2
: "${FM_HOME:?}" "${FM_BINDIR:?}"
[ "$FM_BINDIR" = "${FM_ROOT_OVERRIDE:-$FM_HOME}/bin-bb" ] || { echo 'REFUSED: adoption requires the current BB mirror' >&2; exit 2; }
STATE=$FM_HOME/state
CONFIG=$FM_HOME/config
DATA=$FM_HOME/data
export FM_TASKS_AXI_TIMEOUT=5
export FM_ROOT=${FM_ROOT_OVERRIDE:-$FM_HOME} FM_ROOT_OVERRIDE=${FM_ROOT_OVERRIDE:-$FM_HOME} FM_STATE_OVERRIDE=$STATE
TMP=$(mktemp -d)
TASK_LOCK= META_LOCK=
cleanup() {
  [ -z "$META_LOCK" ] || fm_lock_release "$META_LOCK"
  [ -z "$TASK_LOCK" ] || fm_lock_release "$TASK_LOCK"
  if declare -F fm_lease_guard_release >/dev/null; then fm_lease_guard_release; fi
  rm -rf -- "$TMP"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
cat > "$TMP/plan.json"
PREPARED=$(python3 "$SCRIPT_DIR/fm-launch-adopt.py" prepare "$TMP/plan.json" "$TMP/task.meta")
eval "$PREPARED"
. "$SCRIPT_DIR/fm-wake-lib.sh"
. "$SCRIPT_DIR/fm-lease-lib.sh"
fm_lease_forbid_branch 'explicit legacy worker adoption'
if [ "$ACTION" = --publish ]; then
  fm_lease_guard "$ID" 'explicit legacy worker adoption'
elif fm_lease_live "$ID" && [ "$FM_LEASE_ACTOR" != main ]; then
  echo 'REFUSED: native task lease belongs to the supervision branch' >&2; exit 2
fi
TASK_LOCK=$(fm_task_set_lock_path "$STATE")
fm_lock_try_acquire "$TASK_LOCK" || { TASK_LOCK=; echo 'REFUSED: native task set is busy' >&2; exit 2; }
META_LOCK=$(fm_meta_lock_path "$STATE/$ID.meta")
fm_lock_try_acquire "$META_LOCK" || { META_LOCK=; echo 'REFUSED: native task record is busy' >&2; exit 2; }
# Repeat provenance/collision inspection under the same locks used by lifecycle
# publication and teardown. No staged task record is authoritative before this.
PREPARED=$(python3 "$SCRIPT_DIR/fm-launch-adopt.py" prepare "$TMP/plan.json" "$TMP/task.meta")
eval "$PREPARED"
PROJ_ABS_REAL=$(cd -- "$PROJ_ABS" && pwd -P)
spawn_worktree_isolated "$WT" || { echo "REFUSED: native isolation guard: $SPAWN_WT_REASON" >&2; exit 2; }
. "$SCRIPT_DIR/fm-dod-lib.sh"
if fm_brief_task_placeholders_present "$BRIEF"; then
  echo 'REFUSED: native brief still contains task/spec placeholders' >&2; exit 2
fi
fm_brief_task_content_valid "$BRIEF" || { echo 'REFUSED: native filled-brief guard' >&2; exit 2; }
if ADDRESS_LINE=$(fm_brief_intent_address_line "$BRIEF"); then
  echo "REFUSED: native captain-intent provenance guard: $ADDRESS_LINE" >&2; exit 2
fi
. "$SCRIPT_DIR/fm-backend.sh"
fm_backend_validate_task_endpoint "$TMP/task.meta" "$ID"
. "$SCRIPT_DIR/fm-tasks-axi-lib.sh"
. "$SCRIPT_DIR/fm-backlog-transition-lib.sh"
TRANSITION=0
if fm_backlog_transition_applies "$CONFIG" "$DATA" "$KIND"; then
  TRANSITION=1
  fm_backlog_row_probe "$DATA" "$ID" || { echo "REFUSED: native backlog: $FM_BACKLOG_ROW_ERROR $FM_BACKLOG_ROW_RESULT" >&2; exit 2; }
  fm_backlog_row_dispatchable "$FM_BACKLOG_ROW_STATE" || { echo "REFUSED: native backlog task is held, retired or not dispatchable: $FM_BACKLOG_ROW_STATE" >&2; exit 2; }
else
  rc=$?
  [ "$rc" = 1 ] || { echo 'REFUSED: native backlog configuration cannot be resolved' >&2; exit 2; }
fi
if [ "$ACTION" = --publish ]; then
  if [ "$EXISTING" = 0 ]; then
    # Native publication insists on a sibling stage under the real state root.
    STAGED=$(mktemp "$STATE/.$ID.meta.adopt.XXXXXXXX")
    cp -- "$TMP/task.meta" "$STAGED"
    if ! fm_backlog_atomic_transition publish "$STAGED" "$STATE/$ID.meta" 'task record' "$STATE"; then
      rm -f -- "$STAGED"
      echo "REFUSED: native registration publication: $FM_BACKLOG_TRANSITION_ERROR" >&2; exit 2
    fi
  fi
  if [ "$TRANSITION" = 1 ]; then
    fm_backlog_atomic_transition dispatch "$STATE/$ID.meta" "$DATA" "$ID" "$STATE" >/dev/null || { echo "REFUSED: registration published; backlog pairing requires retry: $FM_BACKLOG_TRANSITION_ERROR" >&2; exit 2; }
  fi
fi
python3 "$SCRIPT_DIR/fm-launch-adopt.py" inspect "$TMP/plan.json"
