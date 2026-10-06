#!/usr/bin/env bash
# BB-ONLY: replace an exact endpoint without changing native task policy/work.
# --check runs before BB stops the source. --publish repeats all native guards.
set -euo pipefail
case "${1:-}" in --check|--publish) ACTION=$1 ;; *) exit 2 ;; esac
[ "$#" = 1 ] || exit 2
: "${FM_HOME:?}"
SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
FM_BINDIR=${FM_BINDIR:-$SCRIPT_DIR}
[ "$FM_BINDIR" = "${FM_ROOT_OVERRIDE:-$FM_HOME}/bin-bb" ] || exit 2
SCRIPT_DIR=$FM_BINDIR
STATE=$FM_HOME/state CONFIG=$FM_HOME/config DATA=$FM_HOME/data
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
PREPARED=$(python3 "$SCRIPT_DIR/fm-worker-rebind.py" "$TMP/plan.json" "$TMP/task.meta")
eval "$PREPARED"
. "$SCRIPT_DIR/fm-wake-lib.sh"
. "$SCRIPT_DIR/fm-lease-lib.sh"
fm_lease_forbid_branch 'BB worker endpoint replacement'
fm_lease_guard "$ID" 'BB worker endpoint replacement'
TASK_LOCK=$(fm_task_set_lock_path "$STATE")
fm_lock_try_acquire "$TASK_LOCK" || { TASK_LOCK=; exit 2; }
META_LOCK=$(fm_meta_lock_path "$STATE/$ID.meta")
fm_lock_try_acquire "$META_LOCK" || { META_LOCK=; exit 2; }
PREPARED=$(python3 "$SCRIPT_DIR/fm-worker-rebind.py" "$TMP/plan.json" "$TMP/task.meta")
eval "$PREPARED"
PROJ_ABS_REAL=$(cd -- "$PROJ_ABS" && pwd -P)
spawn_worktree_isolated "$WT" || { echo "REFUSED: native isolation guard: $SPAWN_WT_REASON" >&2; exit 2; }
. "$SCRIPT_DIR/fm-dod-lib.sh"
fm_brief_task_placeholders_present "$BRIEF" && { echo 'REFUSED: native brief placeholders' >&2; exit 2; }
[ -z "$(fm_brief_intent_address_line "$BRIEF")" ] || { echo 'REFUSED: native captain intent address' >&2; exit 2; }
. "$SCRIPT_DIR/fm-backend.sh"
fm_backend_validate_task_endpoint "$TMP/task.meta" "$ID"
if [ "$ACTION" = --publish ]; then
  . "$SCRIPT_DIR/fm-tasks-axi-lib.sh"
  . "$SCRIPT_DIR/fm-backlog-transition-lib.sh"
  STAGED=$(mktemp "$STATE/.$ID.meta.rebind.XXXXXXXX")
  cp -- "$TMP/task.meta" "$STAGED"
  if ! fm_backlog_atomic_transition publish "$STAGED" "$STATE/$ID.meta" 'task record' "$STATE"; then
    rm -f -- "$STAGED";echo "REFUSED: $FM_BACKLOG_TRANSITION_ERROR" >&2;exit 2
  fi
fi
printf 'BB worker endpoint %s: %s\nFM_BB_REBIND_SOURCE_SHA=%s\n' "$ID" "$ACTION" "$SOURCE_SHA"
