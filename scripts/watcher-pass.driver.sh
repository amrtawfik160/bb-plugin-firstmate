#!/usr/bin/env bash
set -u
. "$(dirname "$0")/wake-helpers.sh"
WATCH="$ROOT/bin-bb/fm-watch.sh"
TMP_ROOT=$(fm_test_tmproot fm-bb-watcher-pass)
dir=$(make_case slow-pass)
state="$dir/state" fakebin="$dir/fakebin" out="$dir/watch.out" windows= count="$dir/captures"
mv "$fakebin/tmux" "$fakebin/tmux.fixture"
cat > "$fakebin/tmux" <<'SH'
#!/usr/bin/env bash
[ "${1:-}" != capture-pane ] || sleep 1
exec "${0%/*}/tmux.fixture" "$@"
SH
chmod +x "$fakebin/tmux"
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  printf 'window=test:fm-slow%s\nkind=ship\n' "$i" > "$state/slow$i.meta"
  windows="${windows}fm-slow$i"$'\n'
done
pass_file="$state/.last-watcher-pass"
PATH="$fakebin:$PATH" FM_HOME="$dir" FM_STATE_OVERRIDE="$state" FM_FAKE_TMUX_WINDOWS="$windows" FM_FAKE_TMUX_CAPTURE_COUNT_FILE="$count" \
  FM_POLL=1 FM_SIGNAL_GRACE=1 FM_CHECK_INTERVAL=999999 FM_HEARTBEAT=999999 FM_WATCHER_STALE_GRACE=6 \
  "$WATCH" > "$out" 2>&1 &
pid=$!
i=0
while [ "$i" -lt 100 ] && [ ! -e "$pass_file" ]; do sleep 0.1; i=$((i + 1)); done
[ -e "$pass_file" ] || { kill "$pid"; fail "the watcher never marked the top of a pass in $pass_file"; }
first=$(file_mtime "$pass_file") at_first=$(cat "$count" 2>/dev/null || echo 0)
i=0
while [ "$i" -lt 400 ]; do
  now=$(file_mtime "$pass_file")
  [ "$now" != "$first" ] && break
  sleep 0.1
  i=$((i + 1))
done
done_captures=$(( $(cat "$count" 2>/dev/null || echo 0) - at_first ))
kill "$pid"; wait "$pid" 2>/dev/null
[ "$now" != "$first" ] || fail "the pass marker never advanced"
[ "$done_captures" -ge 12 ] || fail "the pass marker advanced after $done_captures of 12 pane captures"
pass "the pass marker advances only after a whole pass captured all 12 panes"
