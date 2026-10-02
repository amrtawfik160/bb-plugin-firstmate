#!/bin/sh
# BB-DIVERGE: native fm_task_inbox_doorbell_line tells the worker to list, read,
# and mv state/<id>.inbox/*.msg by hand. fm-inbox.sh drain is the captain note
# inbox, not this one. This script is those worker steps and nothing else.
# Default prints each body and leaves the file in place. --ack moves it to
# handled/ after the worker has acted. Acknowledging first would stop the
# native re-ring before the work is done.
set -eu
ack=0
id=
for arg in "$@"; do
  case "$arg" in
    --ack) ack=1 ;;
    *) id=$arg ;;
  esac
done
home=${FM_HOME:-}
if [ -z "$id" ] || [ -z "$home" ]; then
  echo "usage: FM_HOME=<home> fm-inbox-take.sh <task-id> [--ack]" >&2
  exit 2
fi
case "$id" in
  *[!A-Za-z0-9._-]*) echo "bad task id" >&2; exit 2 ;;
esac
dir="$home/state/$id.inbox"
if [ ! -d "$dir" ]; then
  echo "no inbox $dir"
  exit 0
fi
lib="$home/bin/fm-task-inbox-lib.sh"
if [ -f "$lib" ]; then
  # shellcheck disable=SC1090
  . "$lib"
fi
files=$(find "$dir" -maxdepth 1 -type f -name '*.msg' | sort)
if [ -z "$files" ]; then
  echo "inbox empty"
  exit 0
fi
printf '%s\n' "$files" | while IFS= read -r f; do
  [ -n "$f" ] || continue
  echo "----- ${f##*/} -----"
  if command -v fm_task_inbox_body >/dev/null 2>&1; then
    fm_task_inbox_body "$f"
  else
    cat -- "$f"
  fi
  if [ "$ack" -eq 1 ]; then
    mkdir -p "$dir/handled"
    mv -- "$f" "$dir/handled/"
  fi
done
if [ "$ack" -eq 0 ]; then
  echo "Act on the records above, then run: FM_HOME=$home $0 $id --ack"
fi
