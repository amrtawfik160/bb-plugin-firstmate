#!/usr/bin/env bash
set -u
. "$(dirname "$0")/wake-helpers.sh"
WATCH="$ROOT/bin-bb/fm-watch.sh"
LIB="$ROOT/bin/fm-wake-lib.sh"
TMP_ROOT=$(fm_test_tmproot fm-bb-watcher-beat)
dir=$(make_case slow-pane-scan)
state="$dir/state" fakebin="$dir/fakebin" out="$dir/watch.out" windows=
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
PATH="$fakebin:$PATH" FM_HOME="$dir" FM_STATE_OVERRIDE="$state" FM_FAKE_TMUX_WINDOWS="$windows" \
  FM_POLL=1 FM_SIGNAL_GRACE=1 FM_CHECK_INTERVAL=999999 FM_HEARTBEAT=999999 FM_WATCHER_STALE_GRACE=6 \
  "$WATCH" > "$out" 2>&1 &
pid=$!
i=0
while [ "$i" -lt 50 ] && [ ! -e "$state/.last-watcher-beat" ]; do sleep 0.1; i=$((i + 1)); done
[ -e "$state/.last-watcher-beat" ] || { kill "$pid"; fail "slow-scan watcher never wrote its beacon"; }
i=0
while [ "$i" -lt 36 ]; do
  if ! FM_HOME="$dir" FM_STATE_OVERRIDE="$state" bash -c '. "$1"; fm_watcher_healthy "$2" "$3" 6 "$4"' _ "$LIB" "$state" "$WATCH" "$dir"; then
    kill "$pid"; wait "$pid" 2>/dev/null
    fail "a watcher mid-scan of 12 slow panes read as stale after $((i / 2))s of polling"
  fi
  sleep 0.5
  i=$((i + 1))
done
kill "$pid"; wait "$pid" 2>/dev/null
pass "a watcher scanning many slow panes keeps its beacon inside the stale grace"
