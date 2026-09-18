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

## Limits

- `remove_worktree` refuses a dirty crew worktree (uncommitted or untracked files on stderr, exit 1) before stop/archive. That failure is what makes `fm-teardown.sh` abort and keep the task record. This op never discards. `--force` / discard is the captain's `forget --force`.
- Event push is supported. `backend=bb` is push-capable: the toolbelt watcher blocks in `bb thread wait --status idle` instead of sleeping the poll interval. A pending interaction is the blocked edge (immediate escalation, deduped). Reaching idle ends the wait so the poll loop runs; it is not a stale wake.
- No `--secondmate` yet (same class as Orca/cmux).
- No Escape key.
- Relay/mail/voice stay firstmate scripts if those planes are enabled; they are not rewritten in the BB plugin.
- Native `bb firstmate dispatch` uses the plugin SDK (pluginMetadata, Fleet UI) and, when `fmHome` is set, writes the same `state/<id>.meta` ledger `fm-spawn` does. `bb firstmate fm` is how the bash toolbelt drives the same BB runtime.
