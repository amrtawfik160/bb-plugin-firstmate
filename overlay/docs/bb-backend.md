# BB runtime backend

BB is a spawn-capable firstmate backend: a BB thread is the session endpoint, and a BB managed worktree is the task copy. The `bin/` toolbelt stays the policy engine (brief, gate, inbox, watch, merge, teardown, afk, bearings, backlog). BB replaces tmux/herdr/zellij/orca/cmux for that home.

The crewmate is the BB agent started by `bb thread spawn`, not a TUI harness launched in a pane.

## Setup

Prerequisites: `bb` CLI enrolled on the host, `python3` (JSON parse), and a BB project id.

Select BB with local `config/backend` containing `bb`, `FM_BACKEND=bb`, or `bb firstmate init --real` (plugin overlay writes both). Never auto-detected.

Also set `config/bb-project` or `FM_BB_PROJECT_ID` to the BB project that should own spawned threads.

Optional:

- `FM_BB_PARENT_THREAD_ID` / `BB_THREAD_ID` — parent (captain) thread
- `FM_BB_MACHINE` / `BB_MACHINE` — host for managed-worktree (plugin `fm` sets this)
- `FM_BB_PROVIDER` `FM_BB_MODEL` `FM_BB_PERMISSION_MODE`
- `FM_BB_VISIBLE=0` / `FM_BB_HIDDEN=1` — hide child threads from the sidebar (default visible)
- `FM_BB_SHARED_ENV=1` — skip managed-worktree (ships should not)

Plugin entry: `bb firstmate fm spawn -- --mode direct-PR -- ship '<task>'` runs `bin/fm-spawn.sh` on the host with `FM_BACKEND=bb`.

## Task shape and metadata

```text
backend=bb
window=bb:<thread-id>
bb_thread_id=<thread-id>
worktree=<absolute managed-worktree path>
harness=bb
```

`window=` is `bb:<thread-id>` (the watcher groups every BB window under session `bb`). `bb_thread_id=` is the bare thread id. Peek/send/teardown resolve `window=` through `fm_backend_resolve_selector`; the adapter strips a leading `bb:`.

`fm-spawn.sh` does not call Treehouse. Isolation and unlanded-work refusals still apply.

## Operations

| firstmate op | BB |
| --- | --- |
| create_task | `bb thread spawn --new-environment worktree --prompt <brief>` |
| capture | `bb thread output` |
| send_text_submit | `bb thread tell --mode queue` |
| send_key C-c | `bb thread tell --mode steer` interrupt |
| kill | `bb thread stop` |
| remove_worktree | Dirty tree: print the file list, exit 1, do not stop or archive. Clean: `bb thread stop` + `bb thread archive` (archive failure exits 1; no Treehouse) |
| busy_state | thread status → idle/busy |
| agent_state | missing/alive/dead from `bb thread show` |
| event wait | `bb thread wait --status idle` (first window to finish) |

Composer submit/retry is a no-op: BB has no TUI composer. Delivery is the tell JSON succeeding.

## Supervision model (auto-arm)

A bb-backed home is the **auto-arm** supervision model. There is no live watcher process holding the singleton lock between wakes: the plugin's keeper re-arms `bin/fm-watch.sh`, which exits on every actionable wake and is re-armed ~20s later. Harness detection (`bin/fm-harness.sh`), run by the bb daemon detached from any agent process, therefore resolves to `unknown` → the `persistent` model, which demands a live lock-holder and would permanently declare downtime even while the beacon is fresh.

The plugin declares the correct model with native firstmate's own override, `FM_SUPERVISION_MODEL=autoarm`, on every bb firstmate invocation (`runFmScript`) and in the keeper. Under `autoarm` a fresh beacon within grace is healthy with no live watcher, and a stale beacon still alarms (a bb home has no auto-arm ledger to explain the gap), so a real watcher outage — e.g. the keeper dying, which stops the beacon — is never muffled.

The keeper additionally exports `FM_WATCH_HANDLING_SUCCESSOR=1`: every re-arm is a continuation of one unbroken supervision run, not a new down stretch, so `fm-watch` does not re-mint the recovery generation of an open wake episode on each re-arm (`fm_recovery_marker_reopen_announced`). Without it that generation churned every ~20s and no `fm-wake-drain --ack-through … --recovery-generation …` could match it — a permanent ack loop. The initial episode is still published by `arm_check` when a wake is pending, so buried rows are still presented; only the churn is stopped.

## Per-captain wake plane (notifyOwner=real)

Under `notifyOwner=real` the durable crew→captain wake plane is partitioned **per owning captain** via native `FM_STATE_OVERRIDE`: each captain thread gets its own state subdir `state/cap-<captain-thread-id>/` holding its queue, lock, seq, unread-status files, open-decisions fold and recovery marker. A captain's `bb firstmate wake` (and its `--ack-through`) can therefore only ever present/consume its own rows, because the plugin sets that captain's `FM_STATE_OVERRIDE` on every drain/ack.

**Only `bb firstmate wake` is partition-safe — never the raw script (D9).** The native drain prints its acknowledgement as `WAKE_ACK_REQUIRED: … run bin/fm-wake-drain.sh --ack-through <N> --recovery-generation <G>`. That raw `bin/fm-wake-drain.sh` invocation, pasted and run by hand, carries **no** `FM_STATE_OVERRIDE`, so it acks the **unpartitioned** global `state/.wake-queue` and can consume a *different* captain's rows. The plugin therefore rewrites the surfaced `WAKE_ACK_REQUIRED:` line so it names `bb firstmate wake --ack-through <N> --recovery-generation <G>` instead; pasting the presented instruction verbatim is safe and can only touch the caller's own plane. Do not substitute the raw `bin/fm-wake-drain.sh --ack-through` form.

**Cutover note (expected, not a bug):** the pre-partition global `state/.wake-queue` is no longer read once a captain drains its `state/cap-<id>/` plane. Any rows already sitting in that legacy global queue at the moment `notifyOwner` is switched to `real` are abandoned — they are stale *pending* wakes, so nothing durable is lost (the reports also live in each crew's `state/<id>.status` note log), only the "please drain" pointers are dropped. This is correct: some of those legacy rows belonged to other captains (the pre-partition global queue is exactly the cross-captain leak this partitioning fixes), so a captain must not inherit them. If you want a clean slate, the legacy `state/.wake-queue` / `.wake-queue.seq` / `.wake-queue.lock` can be deleted at cutover; leaving them is harmless (they are simply never read again).

## Limits

- `remove_worktree` refuses a dirty crew worktree (uncommitted or untracked files on stderr, exit 1) before stop/archive. That failure is what makes `fm-teardown.sh` abort and keep the task record. This op never discards. `--force` / discard is the captain's `forget --force`.
- Event push is supported. `backend=bb` is push-capable: the toolbelt watcher blocks in `bb thread wait --status idle` instead of sleeping the poll interval. A pending interaction is the blocked edge (immediate escalation, deduped). Reaching idle ends the wait so the poll loop runs; it is not a stale wake.
- No `--secondmate` yet (same class as Orca/cmux).
- No Escape key.
- Relay/mail/voice stay firstmate scripts if those planes are enabled; they are not rewritten in the BB plugin.
- Native `bb firstmate dispatch` uses the plugin SDK (pluginMetadata, Fleet UI) and, when `fmHome` is set, writes the same `state/<id>.meta` ledger `fm-spawn` does. `bb firstmate fm` is how the bash toolbelt drives the same BB runtime.
