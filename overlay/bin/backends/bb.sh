#!/usr/bin/env bash
# bin/backends/bb.sh — BB thread session-provider adapter for firstmate.
#
# BB owns the task worktree (managed-worktree) and the agent endpoint (a BB
# thread). There is no TUI composer: send is `bb thread tell`, capture is
# `bb firstmate activity`, kill is `bb thread stop`. Treehouse is not used.
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
. "${FM_BACKEND_LIB_DIR:-$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}/fm-composer-lib.sh"
# shellcheck source=bin/fm-transition-lib.sh
if [ -f "${FM_BACKEND_LIB_DIR:-$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}/fm-transition-lib.sh" ]; then
  . "${FM_BACKEND_LIB_DIR:-$(cd "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)}/fm-transition-lib.sh"
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

# The home's BB-capable script dir. Native bin/ has no bb backend (FM_BACKEND_KNOWN
# lacks it and there is no bin/backends/bb.sh), so a crew that runs
# bin/fm-procevent-lavish.sh or bin/fm-teardown.sh against its own bb task is
# refused ("backend identity missing"). bin-bb is the installer's mirror.
fm_backend_bb_crew_bindir() {
  local home=${FM_HOME:-}
  if [ -n "$home" ] && [ -d "$home/bin-bb" ]; then
    printf '%s' "$home/bin-bb"
  else
    printf '%s' "${home:+$home/}bin"
  fi
}

# Rewrite the native brief's script paths (fm-brief.sh is a symlinked native
# entry, so it renders $FM_ROOT/bin/... and relative bin/fm-*.sh) to the
# BB-capable dir. No-op when the mirror is absent.
fm_backend_bb_crew_brief_paths() {  # <bindir> <text>
  local bindir=$1 text=$2 root
  case "$bindir" in */bin-bb) ;; *) printf '%s' "$text"; return 0 ;; esac
  for root in "${FM_HOME:-}" "${FM_ROOT:-}"; do
    [ -n "$root" ] || continue
    text=${text//"$root/bin/"/"$bindir/"}
  done
  text=${text//" bin/fm-"/" $bindir/fm-"}
  text=${text//"\`bin/fm-"/"\`$bindir/fm-"}
  text=${text//"(bin/fm-"/"($bindir/fm-"}
  text=${text//$'\n'"bin/fm-"/$'\n'"$bindir/fm-"}
  printf '%s' "$text"
}

# Crews exhausted the shared GitHub token (GraphQL bucket) with `run watch`
# (3s interval) and `pr checks` loops. firstmate's own PR check wakes the crew.
fm_backend_bb_ci_poll_rule() {
  printf '%s' "Never poll CI in a loop: do not run gh run watch, gh-axi run watch, or repeated gh pr checks / gh-axi pr checks loops; they burn the GitHub token every crew shares. When waiting on CI, run gh pr checks <url> once at most every 5 minutes, or end your turn and let firstmate's PR check wake you. When rate-limited, read gh api rate_limit including .resources.graphql, not only core."
}

fm_backend_bb_create_task() {  # <window-name> <project-path> <task-id> <kind> <brief-path>
  local name=$1 project=$2 id=$3 kind=$4 brief=$5
  local project_id prompt out thread_id wt_path parent perm vis machine tries fm_bin
  fm_backend_bb_runtime_check || return 1
  project_id=$(fm_backend_bb_project_id) || return 1
  if [ -n "$brief" ] && [ -f "$brief" ]; then
    prompt=$(cat -- "$brief")
  else
    prompt="Firstmate $kind task $id. Follow the brief at the recorded data path."
  fi
  if [ "$kind" = secondmate ]; then
    prompt="You are a persistent Firstmate secondmate captain inside BB.
Your native home is $project. Read $project/AGENTS.md and data/charter.md. Take the deck using firstmate_deck; your home binding is installed by the launcher. Dispatch and supervise crews within your charter using native Firstmate policy and AXI tools. Persist open work in your home before stopping.
For browser work use the /browser skill and browser_script (or bb browser script), leaving profileId unset for this thread's isolated default profile. This overrides native chrome-devtools-axi instructions; do not use the AXI browser or install its hooks.

$prompt"
  else
  fm_bin=$(fm_backend_bb_crew_bindir)
  prompt=$(fm_backend_bb_crew_brief_paths "$fm_bin" "$prompt")
  prompt="You are a firstmate ${kind:-ship} crewmate running inside BB.
Do not dispatch nested crews. Work only this task. End with DONE:, BLOCKED:, or FAILED:.
Waiting on a long external run (no-mistakes pipeline, CI, deploy) is not a finish: keep waiting inside this turn with bounded re-checks. Only if you must end the turn before its result, start the reply with WAITING: <what you are waiting on>; firstmate resumes you later. Never write DONE: for work that is not done.
Use gh-axi for GitHub and lavish-axi for visual review. For browser work use the /browser skill and browser_script (or bb browser script), leaving profileId unset for this thread's isolated default profile. This overrides native chrome-devtools-axi instructions; do not use the AXI browser or install its hooks. Read current --help. In no-mistakes mode, drive the real no-mistakes axi pipeline as its worker owner.
Firstmate home: ${FM_HOME:-}. Run every firstmate script from $fm_bin/ (the BB-capable scripts); where anything names bin/fm-*.sh, use $fm_bin/fm-*.sh instead, because the native bin/ copies do not know the bb backend and refuse BB tasks. Use $fm_bin/fm-tasks-axi.sh for backlog work. For a Lavish board, read its config/lavish-axi-host if present and set LAVISH_AXI_HOST on the open command; BB does not inherit the launcher's shell exports. Open the artifact, then arm $fm_bin/fm-procevent-lavish.sh with --for $id. Do not start a second poller.
$(fm_backend_bb_ci_poll_rule)

$prompt"
  fi
  parent=${FM_BB_PARENT_THREAD_ID:-${BB_THREAD_ID:-}}
  # Permission is a BB concern, not the firstmate yolo axis: yolo governs merge
  # authority, not the crew's sandbox. Only an explicit FM_BB_PERMISSION_MODE
  # raises it; default auto. (Previously yolo=on forced BB full permission.)
  perm=${FM_BB_PERMISSION_MODE:-auto}
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
  # Provider/model/reasoning come from FM_BB_* env, else fm-spawn's resolved
  # dispatch-profile globals (MODEL/EFFORT are in scope here). Propagating them
  # is what lets `fm spawn --effort xhigh` actually reach the BB thread instead
  # of only landing in state/<id>.meta.
  local provider model reasoning
  provider=${FM_BB_PROVIDER:-}
  model=${FM_BB_MODEL:-${MODEL:-}}
  reasoning=${FM_BB_REASONING:-${FM_BB_EFFORT:-${EFFORT:-}}}
  case "$reasoning" in
    low|medium|high|xhigh|max|ultra|ultracode|none) ;;
    *) reasoning= ;;
  esac
  # Put the work first so sidebar names are useful. Keep the task id as a stable
  # suffix: the plugin can adopt the thread in the SIGKILL window before the
  # separate `mark-crew` call tags it. Plugin dispatch supplies the normalized
  # title; direct fm-spawn users get the same shape from the backlog name.
  local title role subject
  role=Ship
  [ "$kind" = scout ] && role=Scout
  [ "$kind" = secondmate ] && role=Captain
  subject=${name:-Crew task}
  subject=${subject//$'\r'/ }
  subject=${subject//$'\n'/ }
  subject=${subject//$'\t'/ }
  subject=${subject:0:76}
  title="${FM_BB_THREAD_TITLE:-$role · $subject · $id}"
  set -- thread spawn --json --project "$project_id" --title "$title" \
    --prompt "$prompt" --visibility "$vis" --permission-mode "$perm"
  if [ "$kind" = secondmate ] || [ "${FM_BB_SHARED_ENV:-0}" = 1 ]; then
    set -- "$@" --environment "$project"
  else
    set -- "$@" --new-environment worktree
  fi
  [ -z "$parent" ] || set -- "$@" --parent-thread "$parent"
  [ -z "$provider" ] || set -- "$@" --provider "$provider"
  [ -z "$model" ] || set -- "$@" --model "$model"
  [ -z "$reasoning" ] || set -- "$@" --reasoning-level "$reasoning"
  [ -z "$machine" ] || set -- "$@" --machine "$machine"
  out=$(bb "$@") || return 1
  thread_id=$(printf '%s' "$out" | fm_backend_bb_json_field id) || {
    echo "error: bb thread spawn did not return a thread id for $name" >&2
    return 1
  }
  # Tag the thread as a firstmate crew so the plugin's agent config gives it the
  # crewmate contract (no captain tools/skills), not the unmarked captain fallback.
  # Pass the task id so the plugin can adopt this thread by id if fm-spawn is
  # hard-killed before it records bb_thread_id in the meta (no double-spawn).
  if [ "$kind" = secondmate ]; then
    if ! bb firstmate mark-captain "$thread_id" --home "$project" --parent-home "$FM_HOME" --task "$id" >/dev/null; then
      echo "error: secondmate $id launched as $thread_id but captain binding failed; endpoint retained for recovery" >&2
      return 1
    fi
  else
    bb firstmate mark-crew "$thread_id" --home "$FM_HOME" --shape "${kind:-ship}" --task "$id" >/dev/null 2>&1 || true
  fi
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
  out=$(bb firstmate activity "$id" --json) || {
    echo "error: BB activity capture failed for $id; install matching firstmate server and adapter" >&2
    return 1
  }
  # A recorded event identity changes for real model/tool progress; repeated reads
  # of a quiet thread are byte-identical. Never hash updatedAt or the poll clock.
  printf '%s' "$out" | python3 -c '
import fcntl, json, os, sys, tempfile
from pathlib import Path
try:
    data = json.load(sys.stdin)
    if data.get("version") != 1 or data.get("threadId") != sys.argv[1]:
        raise ValueError("unsupported or mismatched activity snapshot")
    output = data.get("output")
    if not isinstance(output, str):
        raise ValueError("missing output")
    activity = data.get("activity")
    marker = "none"
    if activity is not None:
        if not isinstance(activity, dict) or not isinstance(activity.get("seq"), int) or not isinstance(activity.get("createdAt"), (int, float)) or not isinstance(activity.get("type"), str):
            raise ValueError("invalid activity event")
        marker = "%s %s %s" % (activity["seq"], activity["createdAt"], activity["type"])
    # Native bounds long busy turns with <task>.progress, not pane churn alone.
    # Publish the event timestamp exactly, including on the first read of an old
    # event. A polling clock would hide real stalls indefinitely.
    state = Path(sys.argv[3]) if sys.argv[3] else None
    if state is not None and state.is_dir() and activity is not None:
        matches = []
        for meta in state.glob("*.meta"):
            fields = dict(line.split("=", 1) for line in meta.read_text().splitlines() if "=" in line)
            if fields.get("backend") == "bb" and fields.get("window") == "bb:" + sys.argv[1] and fields.get("bb_thread_id") == sys.argv[1]:
                matches.append(meta)
        if len(matches) > 1:
            raise ValueError("ambiguous BB task metadata")
        if matches:
            progress = matches[0].with_suffix(".progress")
            event_time = activity["createdAt"] / 1000
            with (state / ".bb-progress.lock").open("a") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX)
                if not progress.exists() or progress.stat().st_mtime < event_time:
                    temp_name = None
                    try:
                        with tempfile.NamedTemporaryFile(mode="w", dir=state, prefix=".bb-progress-", delete=False) as temp:
                            temp_name = temp.name
                            temp.write(marker + "\n")
                        os.utime(temp_name, (event_time, event_time))
                        os.replace(temp_name, progress)
                        temp_name = None
                    finally:
                        if temp_name is not None:
                            os.unlink(temp_name)
    lines = max(1, int(sys.argv[2]))
    body = output.splitlines()[-max(0, lines - 1):] if lines > 1 else []
    print("\n".join(body + ["[BB activity: " + marker + "]"]))
except Exception as exc:
    sys.stderr.write("error: invalid BB activity capture: %s\n" % exc)
    sys.exit(1)
' "$id" "$lines" "${FM_STATE_OVERRIDE:-${FM_HOME:+$FM_HOME/state}}"
}

fm_backend_bb_current_path() {  # <thread-id>
  local id
  id=$(fm_backend_bb_thread_id "$1")
  fm_backend_bb_show "$id" | fm_backend_bb_json_field path
}

fm_backend_bb_send_literal() {  # <thread-id> <text>
  local id text=$2 out queued
  id=$(fm_backend_bb_thread_id "$1")
  fm_backend_bb_tool_check || return 1
  FM_BACKEND_BB_DELIVERY=
  # The native watcher may ring an unhandled inbox again while BB is waiting on
  # an interaction. Reuse that accepted queue row, not another identical steer.
  case "$text" in
    ': Firstmate instruction waiting: '*)
      queued=$(bb thread queue list --json "$id") || return 1
      out=$(printf '%s' "$queued" | python3 -c '
import json, sys
try:
    rows = json.load(sys.stdin)
    if not isinstance(rows, list):
        raise ValueError("expected queue array")
    for row in rows:
        content = row.get("content", [])
        if len(content) == 1 and content[0].get("type") == "text" and content[0].get("text") == sys.argv[1]:
            print(json.dumps({"ok": True, "delivery": "queued", "queuedMessage": row}))
            break
except Exception as exc:
    sys.stderr.write("error: invalid BB queue response: %s\n" % exc)
    sys.exit(1)
' "$text") || return 1
      ;;
    *) out= ;;
  esac
  if [ -z "$out" ]; then
    out=$(bb thread tell --json --mode steer "$id" "$text") || return 1
  fi
  FM_BACKEND_BB_DELIVERY=$(printf '%s' "$out" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    delivery = data.get("delivery")
    if data.get("ok") is not True or delivery not in ("sent", "queued"):
        raise ValueError("missing accepted delivery receipt")
    if delivery == "queued":
        row = data.get("queuedMessage", {})
        if not isinstance(row, dict) or not row.get("id"):
            raise ValueError("queued delivery has no queue id")
        wait = row.get("waitingOn") or {}
        sys.stderr.write("BB accepted queued steer %s (waiting on %s); do not resend.\n" % (row["id"], wait.get("kind", "dispatch")))
    print(delivery)
except Exception as exc:
    sys.stderr.write("error: invalid BB send receipt: %s\n" % exc)
    sys.exit(1)
') || return 1
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
      bb thread stop --json "$id" >/dev/null
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
  case "$FM_BACKEND_BB_DELIVERY" in
    sent) printf 'empty' ;;
    queued) printf 'pending' ;;  # accepted durably, not delivered into the turn yet
  esac
}

fm_backend_bb_composer_state() {  # <thread-id> [expected-label] -> empty|unknown
  # There is no terminal composer to overwrite. Execution, an accepted queue row,
  # and an open interaction are separate BB states, never an unsent draft.
  local status
  status=$(fm_backend_bb_show "$1" 2>/dev/null | fm_backend_bb_json_field status 2>/dev/null) || {
    printf 'unknown'; return 0;
  }
  case "$status" in
    idle|stopped|error|failed|active|running|starting|working|pending|queued|stopping) printf 'empty' ;;
    *) printf 'unknown' ;;
  esac
}

# Positive wait evidence is read only at native's wedge threshold; stale or invalid
# snapshots must never grant an indefinite exemption from inactivity checks.
fm_backend_bb_pending_input() {  # <thread-id>
  local id out
  id=$(fm_backend_bb_thread_id "$1")
  . "$(dirname -- "${BASH_SOURCE[0]}")/../fm-timeout-lib.sh"
  out=$(fm_run_timed 5 bb firstmate activity "$id" --json) || {
    echo "error: BB pending-input probe failed for $id; native wedge checks continue" >&2
    return 1
  }
  printf '%s' "$out" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    if not isinstance(data, dict) or type(data.get("version")) is not int or data["version"] != 1 or data.get("threadId") != sys.argv[1]:
        raise ValueError("unsupported or mismatched activity snapshot")
    count = data.get("interactionCount")
    if type(count) is not int or count < 0:
        raise ValueError("invalid interaction count")
    status = data.get("status")
    if status not in ("active", "running", "working", "idle", "error", "failed", "stopped", "pending", "queued", "starting", "stopping"):
        raise ValueError("invalid execution status")
    sys.exit(0 if count > 0 and status in ("active", "running", "working", "idle") else 1)
except Exception as exc:
    sys.stderr.write("error: invalid BB pending-input snapshot: %s; native wedge checks continue\n" % exc)
    sys.exit(1)
' "$id"
}

fm_backend_bb_busy_state() {  # <thread-id>
  local id out
  id=$(fm_backend_bb_thread_id "$1")
  out=$(bb firstmate activity "$id" --json) || { printf 'unknown'; return 0; }
  printf '%s' "$out" | python3 -c '
import json, sys
try:
    data = json.load(sys.stdin)
    if data.get("version") != 1 or data.get("threadId") != sys.argv[1]:
        raise ValueError("unsupported or mismatched activity snapshot")
    if data.get("interactionCount", 0) > 0:
        print("idle", end="")
    elif data.get("runtimeStatus") in ("host-reconnecting", "waiting-for-host", "provisioning", "stopping"):
        print("unknown", end="")
    elif data.get("status") in ("active", "running", "working"):
        print("busy", end="")
    elif data.get("status") in ("idle", "stopped", "error", "failed"):
        print("idle", end="")
    else:
        print("unknown", end="")
except Exception as exc:
    sys.stderr.write("error: invalid BB busy-state snapshot: %s\n" % exc)
    print("unknown", end="")
' "$id"
}

fm_backend_bb_agent_state() {  # <thread-id>
  local id out status
  id=$(fm_backend_bb_thread_id "$1")
  out=$(fm_backend_bb_show "$id" 2>/dev/null) || { printf 'unreadable'; return 0; }
  status=$(printf '%s' "$out" | fm_backend_bb_json_field status 2>/dev/null || true)
  # Idle is a resumable BB session, not a dead native endpoint.
  case "$status" in
    idle|active|running|starting|working|pending|queued) printf 'alive' ;;
    stopped|error|failed) printf 'dead' ;;
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
  bb thread stop "$id" >/dev/null || return 1
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
  # Upstream scout carve-out: a completed scout's worktree is disposable scratch
  # (its durable deliverable is the report, already gated by teardown), so it is
  # discarded without the dirty-tree refusal. --force is the captain's explicit
  # discard. Ship work still gets the full clean-or-refuse protection. KIND/FORCE
  # are fm-teardown.sh globals in scope here.
  case "${KIND:-}" in
    scout) ;;
    *)
      if [ "${FORCE:-}" != "--force" ]; then
        fm_backend_bb_worktree_is_clean "$1" "$id" || return 1
      fi
      ;;
  esac
  fm_backend_bb_kill "$id" || return 1
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
    # shellcheck disable=SC2016 # Positional parameters belong to the child shell.
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
      tids[i]=
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
      *) : ;;
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
