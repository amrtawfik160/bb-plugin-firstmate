#!/usr/bin/env bash
# bin/backends/bb.sh — BB thread session-provider adapter for firstmate.
#
# BB owns the task worktree (managed-worktree) and the agent endpoint (a BB
# thread). There is no TUI composer: send is `bb thread tell`, capture is
# `bb thread output`, kill is `bb thread stop`. Treehouse is not used.
#
# Target string: `bb:<thread-id>` (preferred; all BB windows share session `bb`
# for one push wait) or a bare `thr_...`. Spawn writes window=bb:<thread-id>
# and bb_thread_id=<thread-id>.
#
# Required env/config for spawn:
#   FM_BB_PROJECT_ID or $FM_HOME/config/bb-project
# Optional:
#   FM_BB_PARENT_THREAD_ID / BB_THREAD_ID
#   FM_BB_PROVIDER FM_BB_MODEL FM_BB_PERMISSION_MODE FM_BB_VISIBLE
#   FM_BB_MACHINE / BB_MACHINE

# shellcheck source=bin/fm-composer-lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/../fm-composer-lib.sh"
# shellcheck source=bin/fm-transition-lib.sh
if [ -f "$(dirname -- "${BASH_SOURCE[0]}")/../fm-transition-lib.sh" ]; then
  . "$(dirname -- "${BASH_SOURCE[0]}")/../fm-transition-lib.sh"
fi

# Per-window dedupe marker for a fresh blocked edge. Same key scheme as herdr
# (.stale- / tr ':/.' '___') so commit and clear agree with the watcher's window.
FM_BACKEND_BB_ESCALATED_PREFIX=".bb-escalated-"

fm_backend_bb_tool_check() {
  command -v bb >/dev/null 2>&1 || {
    echo "error: backend=bb selected but the 'bb' CLI is not on PATH" >&2
    return 1
  }
  command -v python3 >/dev/null 2>&1 || {
    echo "error: backend=bb requires python3 to parse bb --json" >&2
    return 1
  }
}

fm_backend_bb_runtime_check() {
  fm_backend_bb_tool_check || return 1
  bb status >/dev/null 2>&1 || {
    echo "error: backend=bb selected but 'bb status' failed; enroll this host and retry" >&2
    return 1
  }
}

fm_backend_bb_thread_id() {  # <target>
  local t=$1
  case "$t" in
    bb:*) t=${t#bb:} ;;
  esac
  printf '%s' "$t"
}

fm_backend_bb_json_field() {  # <field> ; stdin JSON
  python3 -c '
import json, sys
field = sys.argv[1]
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception as exc:
    sys.stderr.write("error: invalid BB JSON: %s\n" % exc)
    sys.exit(2)

def pick(obj, *path):
    cur = obj
    for key in path:
        if not isinstance(cur, dict):
            return ""
        cur = cur.get(key)
    if isinstance(cur, (str, int)) and cur is not False:
        return str(cur)
    return ""

value = ""
if field == "id":
    value = pick(data, "id") or pick(data, "thread", "id") or pick(data, "threadId")
elif field == "status":
    value = pick(data, "status") or pick(data, "thread", "status")
elif field == "path":
    env = data.get("environment") if isinstance(data.get("environment"), dict) else {}
    value = ""
    if isinstance(env, dict):
        p = env.get("path")
        if isinstance(p, str):
            value = p
    if not value:
        value = pick(data, "path")
elif field == "env_id":
    value = pick(data, "environment", "id") or pick(data, "thread", "environmentId") or pick(data, "environmentId")
elif field == "output":
    value = pick(data, "output") or pick(data, "text") or pick(data, "result", "output")
if not value:
    sys.exit(1)
sys.stdout.write(value)
' "$1"
}

fm_backend_bb_project_id() {
  local line
  if [ -n "${FM_BB_PROJECT_ID:-}" ]; then
    printf '%s' "$FM_BB_PROJECT_ID"
    return 0
  fi
  if [ -f "${FM_HOME:-}/config/bb-project" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      line=${line//[[:space:]]/}
      if [ -n "$line" ]; then
        printf '%s' "$line"
        return 0
      fi
    done < "$FM_HOME/config/bb-project"
  fi
  echo "error: backend=bb spawn needs FM_BB_PROJECT_ID or $FM_HOME/config/bb-project" >&2
  return 1
}

fm_backend_bb_show() {  # <thread-id>
  local id
  id=$(fm_backend_bb_thread_id "$1")
  fm_backend_bb_tool_check || return 1
  bb thread show --json "$id"
}

fm_backend_bb_create_task() {  # <window-name> <project-path> <task-id> <kind> <brief-path>
  local name=$1 project=$2 id=$3 kind=$4 brief=$5
  local project_id prompt out thread_id wt_path parent perm vis machine tries
  fm_backend_bb_runtime_check || return 1
  project_id=$(fm_backend_bb_project_id) || return 1
  if [ -n "$brief" ] && [ -f "$brief" ]; then
    prompt=$(cat -- "$brief")
  else
    prompt="Firstmate $kind task $id. Follow the brief at the recorded data path."
  fi
  prompt="You are a firstmate ${kind:-ship} crewmate running inside BB.
Do not dispatch nested crews. Work only this task. End with DONE:, BLOCKED:, or FAILED:.

$prompt"
  parent=${FM_BB_PARENT_THREAD_ID:-${BB_THREAD_ID:-}}
  perm=${FM_BB_PERMISSION_MODE:-}
  if [ -z "$perm" ]; then
    case "${YOLO:-off}" in
      on|true|1) perm=full ;;
      *) perm=auto ;;
    esac
  fi
  vis=visible
  [ "${FM_BB_HIDDEN:-0}" = 1 ] && vis=hidden
  [ "${FM_BB_VISIBLE:-1}" = 0 ] && vis=hidden
  machine=${FM_BB_MACHINE:-${BB_MACHINE:-}}
  if [ -z "$machine" ]; then
    machine=$(bb machine list --json 2>/dev/null | python3 -c '
import json,sys
raw=sys.stdin.read()
try:
    data=json.loads(raw)
except Exception:
    sys.exit(1)
rows=data if isinstance(data,list) else data.get("machines") or data.get("hosts") or []
for row in rows:
    if not isinstance(row, dict):
        continue
    status=str(row.get("status") or "")
    if status in ("connected","ready","active") or row.get("connected") is True:
        ident=row.get("id") or row.get("hostId")
        if isinstance(ident, str) and ident:
            sys.stdout.write(ident)
            sys.exit(0)
sys.exit(1)
' 2>/dev/null || true)
  fi
  set -- thread spawn --json --project "$project_id" --title "$name" \
    --prompt "$prompt" --visibility "$vis" --permission-mode "$perm"
  if [ "${FM_BB_SHARED_ENV:-0}" = 1 ]; then
    set -- "$@" --environment "$project"
  else
    set -- "$@" --new-environment worktree
  fi
  [ -z "$parent" ] || set -- "$@" --parent-thread "$parent"
  [ -z "${FM_BB_PROVIDER:-}" ] || set -- "$@" --provider "$FM_BB_PROVIDER"
  [ -z "${FM_BB_MODEL:-}" ] || set -- "$@" --model "$FM_BB_MODEL"
  [ -z "$machine" ] || set -- "$@" --machine "$machine"
  out=$(bb "$@") || return 1
  thread_id=$(printf '%s' "$out" | fm_backend_bb_json_field id) || {
    echo "error: bb thread spawn did not return a thread id for $name" >&2
    return 1
  }
  wt_path=$(printf '%s' "$out" | fm_backend_bb_json_field path 2>/dev/null || true)
  tries=0
  while [ -z "$wt_path" ] && [ "$tries" -lt 45 ]; do
    sleep 1
    tries=$((tries + 1))
    wt_path=$(fm_backend_bb_show "$thread_id" 2>/dev/null | fm_backend_bb_json_field path 2>/dev/null || true)
  done
  if [ -z "$wt_path" ]; then
    echo "error: bb thread $thread_id has no environment path yet" >&2
    fm_backend_bb_kill "$thread_id" >/dev/null 2>&1 || true
    return 1
  fi
  printf '%s\t%s' "$thread_id" "$wt_path"
}

fm_backend_bb_relaunch() {  # <thread-id> [brief-path]
  local id brief=$2
  id=$(fm_backend_bb_thread_id "$1")
  fm_backend_bb_tool_check || return 1
  if bb thread retry --json "$id" >/dev/null 2>&1; then
    return 0
  fi
  if [ -n "$brief" ] && [ -f "$brief" ]; then
    fm_backend_bb_send_literal "$id" "RELAUNCH: continue from the brief at $brief. Follow it exactly."
    return
  fi
  fm_backend_bb_send_literal "$id" "RELAUNCH: continue the assigned firstmate task."
}

fm_backend_bb_capture() {  # <thread-id> <lines> [expected-label]
  local id lines=${2:-40} out
  id=$(fm_backend_bb_thread_id "$1")
  fm_backend_bb_tool_check || return 1
  out=$(bb thread output --json "$id" 2>/dev/null) || {
    out=$(fm_backend_bb_show "$id" 2>/dev/null) || return 1
    printf '%s\n' "$out"
    return 0
  }
  printf '%s' "$out" | fm_backend_bb_json_field output 2>/dev/null | tail -n "$lines"
}

fm_backend_bb_current_path() {  # <thread-id>
  local id
  id=$(fm_backend_bb_thread_id "$1")
  fm_backend_bb_show "$id" | fm_backend_bb_json_field path
}

fm_backend_bb_send_literal() {  # <thread-id> <text>
  local id text=$2
  id=$(fm_backend_bb_thread_id "$1")
  fm_backend_bb_tool_check || return 1
  bb thread tell --json --mode queue "$id" "$text" >/dev/null
}

fm_backend_bb_send_text_line() {  # <thread-id> <text>
  case "$2" in
    export\ *|unset\ *) return 0 ;;
  esac
  fm_backend_bb_send_literal "$1" "$2"
}

fm_backend_bb_send_key() {  # <thread-id> <key> [expected-label]
  local id key=$2
  id=$(fm_backend_bb_thread_id "$1")
  fm_backend_bb_tool_check || return 1
  case "$key" in
    C-c|ctrl+c|Ctrl-c|Ctrl-C)
      bb thread tell --json --mode steer "$id" \
        "INTERRUPT: stop the current action. Await new orders. Do not teardown." >/dev/null
      ;;
    Enter|enter) return 0 ;;
    Escape|esc|Esc)
      echo "error: backend=bb has no Escape key; use tell/interrupt" >&2
      return 1
      ;;
    *)
      echo "error: unsupported BB key '$key'" >&2
      return 1
      ;;
  esac
}

fm_backend_bb_send_text_submit() {  # <thread-id> <text> <retries> <enter-sleep> <settle>
  fm_backend_bb_send_literal "$1" "$2" || { printf 'send-failed'; return 0; }
  printf 'empty'
}

fm_backend_bb_composer_state() {  # <thread-id> [expected-label] -> empty|pending|unknown
  local state
  state=$(fm_backend_bb_busy_state "$1")
  case "$state" in
    idle) printf 'empty' ;;
    busy) printf 'pending' ;;
    *) printf 'unknown' ;;
  esac
}

fm_backend_bb_busy_state() {  # <thread-id>
  local id status
  id=$(fm_backend_bb_thread_id "$1")
  status=$(fm_backend_bb_show "$id" 2>/dev/null | fm_backend_bb_json_field status 2>/dev/null || true)
  case "$status" in
    idle|stopped|error|failed) printf 'idle' ;;
    active|running|starting|working|pending|queued) printf 'busy' ;;
    *) printf 'unknown' ;;
  esac
}

fm_backend_bb_agent_state() {  # <thread-id>
  local id status
  id=$(fm_backend_bb_thread_id "$1")
  if ! fm_backend_bb_show "$id" >/dev/null 2>&1; then
    printf 'missing'
    return 0
  fi
  status=$(fm_backend_bb_show "$id" | fm_backend_bb_json_field status 2>/dev/null || true)
  case "$status" in
    active|running|starting|working|pending|queued) printf 'alive' ;;
    idle|stopped|error|failed) printf 'dead' ;;
    *) printf 'unreadable' ;;
  esac
}

fm_backend_bb_target_exists() {  # <thread-id> [expected-label]
  local id
  id=$(fm_backend_bb_thread_id "$1")
  fm_backend_bb_show "$id" >/dev/null 2>&1
}

fm_backend_bb_kill() {  # <thread-id>
  local id
  id=$(fm_backend_bb_thread_id "$1")
  [ -n "$id" ] || { echo "error: refusing empty BB kill target" >&2; return 1; }
  fm_backend_bb_tool_check || return 1
  bb thread stop "$id" >/dev/null 2>&1 || true
}

# Paths only. Drops the same untracked harness noise fm-teardown.sh ignores
# (validate_worktree_teardown_safety) so a turn-end marker is not crew work.
fm_backend_bb_porcelain_paths() {
  python3 -c '
import sys
noise = ("?? .fm-grok-turnend", "?? .fm-kimi-turnend")
for raw in sys.stdin:
    line = raw.rstrip("\n")
    if len(line) < 4:
        continue
    if line.startswith("?? .claude/") or line in noise:
        continue
    path = line[3:]
    if " -> " in path:
        path = path.split(" -> ", 1)[1]
    if len(path) >= 2 and path[0] == "\"" and path[-1] == "\"":
        path = path[1:-1]
    if path:
        sys.stdout.write(path + "\n")
'
}

fm_backend_bb_diff_file_paths() {  # stdin: bb environment diff-files --json
  python3 -c '
import json, sys
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception as exc:
    sys.stderr.write("error: invalid BB diff-files JSON: %s\n" % exc)
    sys.exit(2)
files = data.get("files") if isinstance(data, dict) else data
if isinstance(data, dict) and not isinstance(files, list):
    files = data.get("paths")
if not isinstance(files, list):
    sys.stderr.write("error: BB diff-files JSON has no file list\n")
    sys.exit(2)
for item in files:
    path = ""
    if isinstance(item, str):
        path = item
    elif isinstance(item, dict):
        for key in ("path", "file", "filename"):
            val = item.get(key)
            if isinstance(val, str) and val:
                path = val
                break
    if path:
        sys.stdout.write(path + "\n")
'
}

# 0 when stdin has no paths. 1 after printing the list; caller must not archive.
fm_backend_bb_refuse_if_dirty() {  # <thread-id> <where>
  local id=$1 where=$2 paths
  paths=$(cat)
  [ -n "$paths" ] || return 0
  echo "error: refusing to remove BB worktree for $id; uncommitted changes ($where):" >&2
  printf '%s\n' "$paths" >&2
  return 1
}

# 0 only when the crew copy is proven clean. Any inspect failure is a refusal:
# fm-teardown.sh treats remove_worktree failure as abort-and-retain.
fm_backend_bb_worktree_is_clean() {  # <target> <thread-id>
  local target=$1 id=$2 show wt env_id dirty
  show=$(fm_backend_bb_show "$id" 2>/dev/null || true)
  wt=$(printf '%s' "$show" | fm_backend_bb_json_field path 2>/dev/null || true)
  if [ -z "$wt" ] && [ -d "$target" ]; then
    wt=$target
  fi
  if [ -n "$wt" ] && [ -d "$wt" ]; then
    if ! dirty=$(git -C "$wt" status --porcelain 2>/dev/null); then
      echo "error: refusing to remove BB worktree for $id; cannot inspect uncommitted changes at $wt" >&2
      return 1
    fi
    if ! dirty=$(printf '%s\n' "$dirty" | fm_backend_bb_porcelain_paths); then
      echo "error: refusing to remove BB worktree for $id; cannot inspect uncommitted changes at $wt" >&2
      return 1
    fi
    fm_backend_bb_refuse_if_dirty "$id" "$wt" <<<"$dirty" || return 1
    return 0
  fi
  env_id=$(printf '%s' "$show" | fm_backend_bb_json_field env_id 2>/dev/null || true)
  if [ -z "$env_id" ]; then
    echo "error: refusing to remove BB worktree for $id; cannot inspect uncommitted changes" >&2
    return 1
  fi
  fm_backend_bb_tool_check || return 1
  if ! dirty=$(bb environment diff-files --json --target uncommitted "$env_id"); then
    echo "error: refusing to remove BB worktree for $id; cannot inspect uncommitted changes (environment $env_id)" >&2
    return 1
  fi
  if ! dirty=$(printf '%s' "$dirty" | fm_backend_bb_diff_file_paths); then
    echo "error: refusing to remove BB worktree for $id; cannot inspect uncommitted changes (environment $env_id)" >&2
    return 1
  fi
  fm_backend_bb_refuse_if_dirty "$id" "environment $env_id" <<<"$dirty" || return 1
  return 0
}

fm_backend_bb_remove_worktree() {  # <thread-id-or-worktree-id>
  # BB owns worktree lifecycle. Archive is what retires the managed-worktree;
  # a dirty tree must fail here so fm-teardown.sh aborts and keeps its records.
  # Do not rm -rf the checkout from firstmate. Discard is forget --force.
  local id
  id=$(fm_backend_bb_thread_id "$1")
  [ -n "$id" ] || { echo "error: refusing empty BB remove_worktree target" >&2; return 1; }
  fm_backend_bb_worktree_is_clean "$1" "$id" || return 1
  fm_backend_bb_kill "$id"
  fm_backend_bb_tool_check || return 1
  bb thread archive "$id" || return 1
}

fm_backend_bb_worktree_path() {  # <thread-id>
  fm_backend_bb_current_path "$1"
}

# --- native event push -------------------------------------------------------
#
# fm-watch replaces `sleep POLL` with fm_backend_wait_transition. Return codes
# match herdr: 0 prints one normalized record (fresh actionable/blocked edge);
# 1 is a clean wait with no actionable edge (caller already waited); 2 means
# the push path is unusable and the caller sleeps the budget itself.
#
# BB has no pane.agent_status_changed stream. The blocking primitive is
# `bb thread wait --status idle`. Idle is policy `defer` (turn boundary: the
# poll loop classifies status files; it is not a stale wake). A pending
# interaction is `blocked` — the herdr "waiting on human" edge. Multi-window:
# one session's windows race; the first idle completion or fresh blocked edge
# wins and the other waiters are killed.

fm_backend_bb_events_capable() {  # <session>
  fm_backend_bb_tool_check || return 1
  command -v setsid >/dev/null 2>&1 || return 1
  declare -F fm_transition_policy >/dev/null 2>&1 || return 1
  return 0
}

fm_backend_bb_thread_of_window() {  # <window>
  local window=$1 rest
  case "$window" in
    *:*) rest=${window#*:} ;;
    *) rest=$window ;;
  esac
  fm_backend_bb_thread_id "$rest"
}

fm_backend_bb_pane_of_window() {  # <session> <window> <state_dir>
  local session=$1 window=$2 state=$3 meta w tid task
  case "$window" in
    "$session":*)
      printf '%s' "${window#"$session":}"
      return 0
      ;;
  esac
  # Bare thread id: the watcher rebuilds "$session:$pane". The task id makes
  # window_to_task's suffix fallback resolve the crew. Prefer bb:<thread-id>
  # windows so the rebuilt string matches meta exactly.
  tid=$(fm_backend_bb_thread_id "$window")
  if [ -n "$state" ]; then
    for meta in "$state"/*.meta; do
      [ -e "$meta" ] || continue
      w=$(grep '^window=' "$meta" 2>/dev/null | tail -1 | cut -d= -f2- || true)
      if [ "$w" = "$window" ] || [ "$w" = "$tid" ] || [ "$w" = "bb:$tid" ]; then
        task=$(basename -- "$meta")
        printf '%s' "${task%.meta}"
        return 0
      fi
    done
  fi
  printf '%s' "$tid"
}

fm_backend_bb_escalation_marker() {  # <state_dir> <window>
  local state=$1 window=$2 key
  key=$(printf '%s' "$window" | tr ':/.' '___')
  printf '%s/%s%s' "$state" "$FM_BACKEND_BB_ESCALATED_PREFIX" "$key"
}

fm_backend_bb_map_status() {  # <bb-status> <pending 0|1>
  if [ "${2:-0}" = 1 ]; then
    printf 'blocked'
    return 0
  fi
  case "$1" in
    active|starting|stopping|running|working|pending|queued) printf 'working' ;;
    idle|stopped) printf 'idle' ;;
    *) printf 'unknown' ;;
  esac
}

fm_backend_bb_snapshot() {  # <thread-id> -> status<TAB>pending
  local id raw pending=0
  id=$(fm_backend_bb_thread_id "$1")
  raw=$(fm_backend_bb_show "$id" 2>/dev/null) || return 1
  if bb thread interactions list --json "$id" 2>/dev/null | python3 -c '
import json, sys
raw = sys.stdin.read().strip()
if not raw:
    sys.exit(1)
try:
    data = json.loads(raw)
except Exception:
    sys.exit(1)
rows = data
if isinstance(data, dict):
    rows = data.get("interactions") or data.get("items") or data.get("pending") or []
if not isinstance(rows, list):
    sys.exit(1)
for row in rows:
    if not isinstance(row, dict):
        continue
    status = row.get("status")
    if status in (None, "", "pending", "resolving"):
        sys.exit(0)
sys.exit(1)
' >/dev/null 2>&1; then
    pending=1
  fi
  printf '%s' "$raw" | python3 -c '
import json, sys
pending = sys.argv[1]
raw = sys.stdin.read()
try:
    data = json.loads(raw)
except Exception:
    sys.exit(2)
if isinstance(data, dict) and isinstance(data.get("thread"), dict):
    data = data["thread"]
if not isinstance(data, dict):
    sys.exit(1)
status = data.get("status")
if not isinstance(status, str) or not status:
    runtime = data.get("runtime")
    if isinstance(runtime, dict) and isinstance(runtime.get("displayStatus"), str):
        status = runtime.get("displayStatus")
if not isinstance(status, str) or not status:
    sys.exit(1)
sys.stdout.write(status + "\t" + pending)
' "$pending"
}

fm_backend_bb_normalize_event() {  # <pane_id> <workspace_id> <to_status>
  fm_transition_record "${1:-}" "${2:-}" "" "${3:-}" "bb"
}

fm_backend_bb_apply_transition() {  # <state_dir> <session> <record>
  local state=$1 session=$2 record=$3 pane_id to action window marker
  pane_id=$(fm_transition_pane_id "$record")
  [ -n "$pane_id" ] || return 1
  to=$(fm_transition_to_status "$record")
  action=$(fm_transition_policy "$to")
  window="$session:$pane_id"
  marker=$(fm_backend_bb_escalation_marker "$state" "$window")
  case "$action" in
    actionable)
      if [ ! -e "$marker" ]; then
        printf '%s' "$record"
        return 0
      fi
      ;;
    absorb)
      rm -f "$marker" 2>/dev/null || true
      ;;
  esac
  return 1
}

fm_backend_bb_commit_transition() {  # <state_dir> <session> <record>
  local state=$1 session=$2 record=$3 pane_id window marker
  pane_id=$(fm_transition_pane_id "$record")
  [ -n "$pane_id" ] || return 1
  window="$session:$pane_id"
  marker=$(fm_backend_bb_escalation_marker "$state" "$window")
  : > "$marker"
}

fm_backend_bb_clear_transition() {  # <state_dir> <window>
  local state=$1 window=$2 tid marker tidkey
  [ -n "$window" ] || return 0
  marker=$(fm_backend_bb_escalation_marker "$state" "$window")
  rm -f "$marker" 2>/dev/null || true
  tid=$(fm_backend_bb_thread_id "$window")
  [ -n "$tid" ] || return 0
  marker=$(fm_backend_bb_escalation_marker "$state" "bb:$tid")
  rm -f "$marker" 2>/dev/null || true
  tidkey=$(printf '%s' "$tid" | tr ':/.' '___')
  # shellcheck disable=SC2086
  rm -f "$state"/$FM_BACKEND_BB_ESCALATED_PREFIX*"$tidkey"* 2>/dev/null || true
}

# 0: printed a fresh blocked record. 2: working, caller should wait for idle.
# 1: observed and not waiting (idle, unknown, or already-escalated blocked).
# 3: snapshot unreadable.
fm_backend_bb_consider_window() {  # <state_dir> <session> <window>
  local state=$1 session=$2 window=$3 tid snap status pending to pane record hit
  tid=$(fm_backend_bb_thread_of_window "$window")
  [ -n "$tid" ] || return 3
  snap=$(fm_backend_bb_snapshot "$tid") || return 3
  status=${snap%%$'\t'*}
  pending=${snap#*$'\t'}
  to=$(fm_backend_bb_map_status "$status" "$pending")
  pane=$(fm_backend_bb_pane_of_window "$session" "$window" "$state")
  record=$(fm_backend_bb_normalize_event "$pane" "" "$to")
  if hit=$(fm_backend_bb_apply_transition "$state" "$session" "$record"); then
    printf '%s' "$hit"
    return 0
  fi
  [ "$to" = working ] && return 2
  return 1
}

fm_backend_bb_stop_waiters() {  # <pid...>
  local pid
  for pid in "$@"; do
    [ -n "$pid" ] || continue
    kill -- -"$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  done
  for pid in "$@"; do
    [ -n "$pid" ] || continue
    wait "$pid" 2>/dev/null || true
  done
}

# Race `bb thread wait --status idle` across working threads. Prints nothing.
# 0: a waiter reached idle or error (caller re-reads). 1: full timeout.
# 2: every waiter failed. First completion wins; the rest are killed.
fm_backend_bb_race_idle() {  # <timeout_secs> <thread_id...>
  local timeout=$1
  shift
  local -a tids=("$@") pids=()
  local dir tid rcfile rc start i left any_timeout=0 any_fail=0
  [ "${#tids[@]}" -gt 0 ] || return 1
  dir=$(mktemp -d "${TMPDIR:-/tmp}/fm-bb-eventwait.XXXXXX") || return 2
  for tid in "${tids[@]}"; do
    setsid bash -c 'bb thread wait --status idle --timeout "$1" --json "$2" >"$3" 2>"$4"; printf "%s" "$?" > "$5"' \
      _ "$timeout" "$tid" "$dir/$tid.out" "$dir/$tid.err" "$dir/$tid.rc" </dev/null &
    pids+=("$!")
  done
  start=$SECONDS
  left=${#tids[@]}
  while [ "$left" -gt 0 ]; do
    for i in "${!tids[@]}"; do
      tid=${tids[$i]}
      [ -n "$tid" ] || continue
      rcfile="$dir/$tid.rc"
      [ -f "$rcfile" ] || continue
      rc=$(tr -d '[:space:]' < "$rcfile" 2>/dev/null || true)
      tids[$i]=
      left=$((left - 1))
      case "$rc" in
        0|4)
          fm_backend_bb_stop_waiters "${pids[@]}"
          rm -rf "$dir" 2>/dev/null || true
          return 0
          ;;
        2) any_timeout=1 ;;
        *) any_fail=1 ;;
      esac
    done
    [ "$left" -eq 0 ] && break
    if [ $((SECONDS - start)) -gt "$timeout" ]; then
      any_timeout=1
      break
    fi
    sleep 0.05
  done
  fm_backend_bb_stop_waiters "${pids[@]}"
  rm -rf "$dir" 2>/dev/null || true
  [ "$any_timeout" -eq 1 ] && return 1
  [ "$any_fail" -eq 1 ] && return 2
  return 1
}

fm_backend_bb_wait_transition() {  # <session> <timeout_secs> <state_dir> <window...>
  local session=$1 timeout=$2 state=$3
  shift 3
  local -a windows=("$@") to_wait=()
  local w hit tid crc seen_ok=0 race_rc joined=
  [ "${#windows[@]}" -gt 0 ] || return 2
  case "$timeout" in
    ''|*[!0-9]*) return 2 ;;
  esac
  if [ "${FM_BACKEND_EVENTS_CAPABILITY_CONFIRMED:-0}" != 1 ]; then
    fm_backend_bb_events_capable "$session" || return 2
  fi
  for w in "${windows[@]}"; do
    hit=$(fm_backend_bb_consider_window "$state" "$session" "$w")
    crc=$?
    case "$crc" in
      0)
        printf '%s' "$hit"
        return 0
        ;;
      2)
        tid=$(fm_backend_bb_thread_of_window "$w")
        if [ -n "$tid" ]; then
          case " $joined " in
            *" $tid "*) ;;
            *)
              to_wait+=("$tid")
              joined="$joined $tid"
              ;;
          esac
        fi
        seen_ok=1
        ;;
      1) seen_ok=1 ;;
      *) seen_fail=1 ;;
    esac
  done
  if [ "${#to_wait[@]}" -eq 0 ]; then
    # Nothing in flight. Sleep the budget so an all-idle fleet does not spin.
    # Every window unreadable is an unusable push path.
    [ "$seen_ok" -eq 1 ] || return 2
    sleep "$timeout"
    return 1
  fi
  fm_backend_bb_race_idle "$timeout" "${to_wait[@]}"
  race_rc=$?
  [ "$race_rc" -eq 2 ] && return 2
  for w in "${windows[@]}"; do
    hit=$(fm_backend_bb_consider_window "$state" "$session" "$w")
    crc=$?
    if [ "$crc" -eq 0 ]; then
      printf '%s' "$hit"
      return 0
    fi
  done
  [ "$race_rc" -eq 0 ] || [ "$race_rc" -eq 1 ] && return 1
  return 2
}
