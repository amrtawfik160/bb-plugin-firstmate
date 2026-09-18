#!/usr/bin/env bash
# bin/backends/bb.sh — BB thread session-provider adapter for firstmate.
#
# BB owns the task worktree (managed-worktree) and the agent endpoint (a BB
# thread). There is no TUI composer: send is `bb thread tell`, capture is
# `bb thread output`, kill is `bb thread stop`. Treehouse is not used.
#
# Target string: a BB thread id (`thr_...`), optionally prefixed `bb:`.
# Spawn writes window=<thread-id> and bb_thread_id=<thread-id>.
#
# Required env/config for spawn:
#   FM_BB_PROJECT_ID or $FM_HOME/config/bb-project
# Optional:
#   FM_BB_PARENT_THREAD_ID / BB_THREAD_ID
#   FM_BB_PROVIDER FM_BB_MODEL FM_BB_PERMISSION_MODE FM_BB_VISIBLE
#   FM_BB_MACHINE / BB_MACHINE

# shellcheck source=bin/fm-composer-lib.sh
. "$(dirname -- "${BASH_SOURCE[0]}")/../fm-composer-lib.sh"

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

fm_backend_bb_remove_worktree() {  # <thread-id-or-worktree-id>
  # BB owns worktree lifecycle. Stop + archive so the managed-worktree can
  # retire. Do not rm -rf the checkout from firstmate.
  local id
  id=$(fm_backend_bb_thread_id "$1")
  fm_backend_bb_kill "$id"
  fm_backend_bb_tool_check || return 1
  bb thread archive "$id" >/dev/null 2>&1 || true
}

fm_backend_bb_worktree_path() {  # <thread-id>
  fm_backend_bb_current_path "$1"
}

fm_backend_bb_has_push() {
  return 1
}
