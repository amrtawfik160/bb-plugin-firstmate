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

Plugin entry: `bb firstmate fm spawn -- --mode direct-PR -- ship '<task>'` runs `fm-spawn.sh` on the host with `FM_BACKEND=bb`.

## Installation architecture: the mirror bin (never patch tracked files)

`/root/firstmate` is a clone of a third-party repo (`kunchenguid/firstmate`). Native firstmate exposes **no runtime seam** to register a new spawn-capable backend: `FM_BACKEND_KNOWN`/`FM_BACKEND_SPAWN` and every `fm_backend_*` dispatch `case` are hardcoded in the **tracked** files `bin/fm-backend.sh`, `bin/fm-spawn.sh`, and `bin/fm-teardown.sh`, and the only extension host (`bin/fm-extension.mjs`) binds **process-event adapters** only (`poll`/`classify`/`terminal`/`silent`) — it cannot register a spawn/worktree backend.

The overlay therefore does **not** edit those tracked files. `install-bb-backend.py` builds a parallel **mirror bin** at `<home>/bin-bb`:

- every native `bin/` entry is **symlinked** into `bin-bb/` (so it keeps inheriting upstream on every ff-update),
- **except** the eight no-seam files, which are generated as **patched copies** (native source + the overlay patches), and
- `bin-bb/backends/` mirrors the native adapters plus the real `bb.sh`.

Native scripts derive `SCRIPT_DIR`/`FM_BACKEND_LIB_DIR` from their own `BASH_SOURCE`, so invoking `bin-bb/fm-*.sh` makes every `. "$SCRIPT_DIR/fm-*.sh"` resolve **inside `bin-bb`**: the patched `fm-backend.sh` (with the bb dispatch arms) and the `bb.sh` adapter are picked up for **all** scripts, with zero edits to tracked files. The plugin routes `bin` → `bin-bb` at runtime (`fmBinDirAssign` / `$FM_BINDIR`) whenever the marker `config/bb-overlay` and `bin-bb/` are present, and falls back to native `bin` otherwise.

`bin-bb/` is registered in `<home>/.git/info/exclude` (a per-clone, untracked git exclude that is **not** part of the repository), and `config/` is already gitignored upstream. So `git -C <home> status --porcelain` stays **empty** — which is exactly what the plugin's `fetch` + `git merge --ff-only` auto-update requires: with the old in-place patch the tree was permanently dirty and the update **always skipped**; the mirror keeps it clean so the clone actually fast-forwards.

Re-run the installer after an ff-update: it re-mirrors (picking up new native `bin/` files) and regenerates the eight patched copies against the new native source.

The install is **atomic and loud** (see `install-bb-backend.py`, `build_mirror` / `_atomic_swap`): the new mirror is built in full inside a `bin-bb.staging` directory and swapped into place with `os.rename` **only on complete success**, so a failed install can never replace a working mirror with a broken/partial one — on any failure the staging tree is discarded and the existing `bin-bb` is left **exactly as it was**. If upstream changed one of the eight files so a hunk no longer applies, the install **aborts non-zero with a loud `INSTALL FAILED` banner** (detected via `patch`'s exit code **and** any reject file — not the exit code alone), never printing `BB backend ready` over a failure. (The earlier installer rebuilt in place: it `rmtree`d the live mirror first, so a patch failure mid-rebuild left `bin-bb` missing the three dispatch copies — a host-wide `unknown backend 'bb'` outage on a shared home.)

The overlay patches are refreshed against a **pinned upstream base** recorded in [`overlay/patch-base.txt`](patch-base.txt) (currently the current `kunchenguid/firstmate` HEAD). Because the patches edit upstream prose/comments they are version-specific — they apply at that base and drift as upstream evolves. [`scripts/patch-drift-check.mjs`](../scripts/patch-drift-check.mjs) fetches the live upstream HEAD and dry-run-applies the patches exactly as the installer does, so drift is caught **ahead of a migration** rather than during one; when it flags drift, refresh the patches against HEAD, re-run the live proofs, and bump `patch-base.txt`.

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
| send_text_submit | `bb thread tell --mode steer` (inject active turn, otherwise start one) |
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

**Only `bb firstmate wake` is partition-safe — never the raw script (D9).** Native `fm-wake-drain.sh` names the raw `bin/fm-wake-drain.sh` at several sites — the `WAKE_ACK_REQUIRED:` acknowledgement lines, the stale-ack advisory (`… run bin/fm-wake-drain.sh --ack-through <N> --recovery-generation <G> after handling it`), and the "re-run bin/fm-wake-drain.sh" present hints — in both the **consuming** (`--ack-through …`) and **present** forms. Pasted and run by hand, that raw invocation carries **no** `FM_STATE_OVERRIDE`, so it presents/acks the **unpartitioned** global `state/.wake-queue` and can consume a *different* captain's rows. Because a PTY merges stderr into output, every one of these reaches the captain — so the plugin rewrites **every** `bin/fm-wake-drain.sh` occurrence in the surfaced output to `bb firstmate wake` (e.g. `bb firstmate wake --ack-through <N> --recovery-generation <G>`). Pasting any presented instruction verbatim is then safe and can only touch the caller's own plane. Never substitute the raw `bin/fm-wake-drain.sh` form.

**Cutover note (expected, not a bug):** the pre-partition global `state/.wake-queue` is no longer read once a captain drains its `state/cap-<id>/` plane. Any rows already sitting in that legacy global queue at the moment `notifyOwner` is switched to `real` are abandoned — they are stale *pending* wakes, so nothing durable is lost (the reports also live in each crew's `state/<id>.status` note log), only the "please drain" pointers are dropped. This is correct: some of those legacy rows belonged to other captains (the pre-partition global queue is exactly the cross-captain leak this partitioning fixes), so a captain must not inherit them. If you want a clean slate, the legacy `state/.wake-queue` / `.wake-queue.seq` / `.wake-queue.lock` can be deleted at cutover; leaving them is harmless (they are simply never read again).

## Limits

- `remove_worktree` refuses a dirty crew worktree (uncommitted or untracked files on stderr, exit 1) before stop/archive. That failure is what makes `fm-teardown.sh` abort and keep the task record. This op never discards. `--force` / discard is the captain's `forget --force`.
- Event push is supported. `backend=bb` is push-capable: the toolbelt watcher blocks in `bb thread wait --status idle` instead of sleeping the poll interval. A pending interaction is the blocked edge (immediate escalation, deduped). Reaching idle ends the wait so the poll loop runs; it is not a stale wake.
- No `--secondmate` yet (same class as Orca/cmux).
- No Escape key.
- Relay/mail/voice stay firstmate scripts if those planes are enabled; they are not rewritten in the BB plugin.
- Native `bb firstmate dispatch` uses the plugin SDK (pluginMetadata, Fleet UI) and, when `fmHome` is set, writes the same `state/<id>.meta` ledger `fm-spawn` does. `bb firstmate fm` is how the bash toolbelt drives the same BB runtime.

## The eight files still carried as patched copies (and the upstream seam we want)

The mirror keeps the tracked tree clean, but `fm-backend.sh`, `fm-spawn.sh`, `fm-teardown.sh`, `fm-merge-local.sh`, `fm-bootstrap.sh`, `fm-busy-lib.sh`, `fm-secondmate-liveness-lib.sh`, and `fm-watch.sh` are still carried as **patched copies** in `bin-bb`, because their edits cannot be expressed through any native seam:

- **`fm-backend.sh` — registration + dispatch.** `FM_BACKEND_KNOWN`/`FM_BACKEND_SPAWN` are literal strings and each `fm_backend_*` function is a literal `case` with a `*)` reject/`unknown` arm. There is no drop-in dir, no `FM_BACKEND_KNOWN_EXTRA`, no config-driven registration, and no post-source hook, so a new backend name and its dispatch arms cannot be added at runtime.
- **`fm-spawn.sh` — spawn flow.** The worktree-creation `case "$BACKEND"` block, the two `[ "$BACKEND" != orca ]` Treehouse-skip conditionals, and the relaunch/meta handling are **inline in the main body**, not overridable functions.
- **`fm-teardown.sh` — worktree ownership.** The `fm_backend_owns_worktrees` branch selection and the bb teardown arm are likewise inline.

- **`fm-merge-local.sh` — managed branch identity.** BB worktrees use BB branch names. Resolve the recorded worktree branch after verifying it belongs to the target repository; retain native landing gates.

- **`fm-bootstrap.sh` — browser dependency.** BB uses `/browser`; native bootstrap must not demand `chrome-devtools-axi` for a BB home. Other backends retain their native checks.

- **`fm-busy-lib.sh` — native busy verdict.** `fm_busy_classify` trusts a backend's native `busy` verdict only for a literal `herdr`. BB thread status is equally semantic (an active thread is a turn in flight, even inside a long tool call), so the copy trusts `bb` too (source `bb-native`). Without it every busy BB crew classified `unknown` and fm-watch paged a false `stale:` after two unchanged polls.

- **`fm-secondmate-liveness-lib.sh` — relaunch entrypoint.** Native hardcodes `$FM_ROOT/bin/fm-spawn.sh`; the mirror copy invokes the sibling `fm-spawn.sh` so bootstrap and watcher recovery reach the BB adapter; its probe recognizes `bb` and its relaunch preserves explicit BB backend/harness selection through timeout subprocesses.

- **`fm-watch.sh` — BB input wait evidence.** Before a wedge alarm, a BB task probes `bb firstmate activity` with a five-second bound and requires the matching version/thread ID plus a positive integer interaction count. Native `wait_record` then defers/rechecks the captain-owned wait; clearing the interaction restores ordinary alarms at the next threshold. Failed, malformed or timed-out probes print an error and leave native checks active. Worker status and progress are untouched.

Because these are `case`/`if` blocks in tracked bodies (not functions with a `*)` that dispatches to `fm_backend_<name>_*`), no function override or env hook can inject them; a real copy is the only faithful option. The mirror confines the drift to exactly these eight files while every other script inherits upstream.

**Minimal upstream-friendly seams we would contribute to `kunchenguid/firstmate`** so these copies could shrink to a pure drop-in (no copied bodies):

1. **Sourced backend drop-in + registration.** After computing `FM_BACKEND_KNOWN`, source `config/backends.d/*.sh` (gitignored, like `config/backend`) and append their declared names to `FM_BACKEND_KNOWN`/`FM_BACKEND_SPAWN` and to `fm_backend_owns_worktrees`. A drop-in declares `name`, `spawn=1`, `owns_worktrees=0|1`, and its adapter path.
2. **Generic dispatch fallthrough.** Give every `fm_backend_*` dispatcher a `*)` arm that, for a registered non-native backend, calls `fm_backend_<name>_<op>` (the convention the adapters already follow) instead of printing `unknown`. That alone removes every per-op `case` edit in `fm-backend.sh`.
3. **Spawn/teardown backend hooks.** Replace the inline `case`/`if` in `fm-spawn.sh`/`fm-teardown.sh` with calls the adapter can implement — e.g. `fm_backend_<name>_create_task`, and a queryable `fm_backend_owns_worktrees "$BACKEND"` gate around the Treehouse-skip conditionals (the teardown patch already introduces exactly this predicate).

4. **Managed branch query.** Allow the adapter to resolve the worktree branch after repository-identity verification.

5. **Backend-specific browser dependency.** Let the backend select its browser dependency rather than putting AXI browser in the universal tool list.

With (1)–(5), the entire bb overlay becomes `config/backends.d/bb.sh` + `bin/backends/bb.sh` with **zero** copied native bodies. Until then, the eight patched copies are the honest, documented cost, isolated in `bin-bb`.

## Migrating a home off the in-place patch (safe; run by an operator, not the plugin)

A home installed by the **old** overlay has the three tracked files patched in place — its tree is permanently dirty, so ff-update skips. `install-bb-backend.py` never reverts a tracked file (it only warns); restore the home by hand with this procedure. It touches **only** the three tracked files and the `.orig` leftovers; it never goes near `state/` or `data/` (crew state and the captain's live memory), and it never references the memory backup at `/root/.bb-server/secrets/fm-memory-backup`.

**`fmHome` is shared host-global across captains — the procedure must have NO bb-less window.** Every captain thread on a host shares this one `fmHome`, and a single captain **cannot** quiesce the others; another captain's crew can dispatch at any instant. So the migration cannot rely on "no dispatch in flight." It is ordered so that **a bb-capable path exists at every step**: install the mirror **FIRST** (while native is still patched in place — both paths dispatch bb), and only *then* restore native, fast-forward, and re-install. From the moment `bin-bb/` + the `config/bb-overlay` marker exist, `$FM_BINDIR` routes to the mirror, which serves bb dispatch through the rest of the sequence; native is never the only path, so no dispatch ever hits `unknown backend 'bb'`. (Proven end-to-end, with a dispatch probe at every step, by `scripts/live-migration-zero-window-check.mjs`; its `--old-order` mode shows the previous "restore-first" ordering *did* open a window.)

Between the fast-forward (step 4) and the re-install (step 5) the mirror is momentarily **stale** (HEAD advanced past the mirror's manifest) — but it is not bb-*less*: the frozen copies still carry the bb arms and keep dispatching. `--verify` flags that staleness and the re-install repairs it; the plugin keeps routing to `bin-bb` throughout. This is a staleness window, not a correctness window.

> **The install only succeeds at the patch base.** The overlay patches are pinned to
> [`overlay/patch-base.txt`](patch-base.txt) (the upstream commit they were refreshed
> against). Step 1's install-first works only if `$FMH`'s HEAD is at that base. A home
> that is **behind** the base cannot install-first at its old HEAD — the patches
> target the new source.
> Such a home is handled by the sequence in **"Migrating a home that is behind the patch
> base"** below, which relies on the mirror it already carries. Because the install is now
> atomic, a re-install whose patch no longer applies aborts without touching the working
> mirror, so a mistimed re-install can never open a window either.

```bash
FMH=/root/firstmate   # the live home; OVL=<path to overlay/>

# 0. Confirm the legacy state (expect: bin/fm-backend.sh, bin/fm-spawn.sh,
#    bin/fm-teardown.sh, docs/configuration.md modified; *.orig untracked).
git -C "$FMH" status --porcelain

# 1. Install the mirror FIRST, while native is still patched. Now BOTH paths
#    dispatch bb: native (still patched) and bin-bb (patched copies). Once the
#    marker + bin-bb exist, the plugin routes to bin-bb. No bb-less moment.
python3 "$OVL"/install-bb-backend.py --home "$FMH" --project-id <bb-project-id>
python3 "$OVL"/install-bb-backend.py --home "$FMH" --verify   # healthy

# 2. Restore the tracked files the old overlay patched in place. `git checkout`
#    only rewrites these exact paths; nothing under state/ or data/ is touched.
#    bb keeps working — the plugin is already routing to bin-bb.
git -C "$FMH" checkout -- bin/fm-backend.sh bin/fm-spawn.sh bin/fm-teardown.sh docs/configuration.md

# 3. Remove the patch's .orig backups (untracked; safe to delete).
rm -f "$FMH"/bin/fm-*.sh.orig "$FMH"/docs/*.md.orig

# 4. Fast-forward the now-clean clone to upstream (the update that was frozen).
#    The mirror goes momentarily STALE here but still dispatches bb.
git -C "$FMH" fetch --quiet origin
up=$(git -C "$FMH" rev-parse --abbrev-ref --symbolic-full-name '@{u}' 2>/dev/null || true)
[ -n "$up" ] && git -C "$FMH" merge --ff-only "$up"

# 5. Re-install against the new HEAD so bin-bb mirrors the updated bin/ and the
#    eight copies are patched from current sources. Then verify + confirm clean.
python3 "$OVL"/install-bb-backend.py --home "$FMH" --project-id <bb-project-id>
python3 "$OVL"/install-bb-backend.py --home "$FMH" --verify   # healthy
git -C "$FMH" status --porcelain                              # expect empty
```

Do **not** run step 2 as `git checkout .` or `git reset --hard` — those would reach beyond the three files. `state/` and `data/` are never tracked in this clone (they are gitignored), so a scoped `git checkout -- <the four paths>` cannot lose crew state or memory; still, restrict the command to those paths. After any later out-of-band fast-forward (a manual `git pull`, an external updater), re-run step 5; `--verify` fails loud (`FM_MIRROR_STALE`) whenever the mirror is behind HEAD or a sibling is missing, and the plugin logs the same on the dispatch and supervision paths.

## Migrating a home that is behind the patch base

A home with a **working mirror already installed** may be behind the patch base. Do **not** rebuild the mirror at that old HEAD; the existing mirror carries bb through the update, and the only install is the final one at the pinned base. Zero-window and atomic-failure survival are proven by `scripts/live-migration-zero-window-check.mjs` (step G is a deliberately-failed re-install).

```bash
FMH=/root/firstmate   # the live home; OVL=<path to overlay/>
PATCH_BASE=$(cat "$OVL/patch-base.txt")

# 1. Confirm the existing mirror is healthy and serving bb. Do NOT re-install at the
#    old HEAD: the refreshed patches target PATCH_BASE.
python3 "$OVL"/install-bb-backend.py --home "$FMH" --verify   # healthy (at old HEAD)
git -C "$FMH" status --porcelain                              # expect empty (no in-place patch)

# 2. Fast-forward the clean clone to the base. The mirror goes momentarily STALE
#    (HEAD past its manifest) but keeps dispatching bb — never bb-less.
git -C "$FMH" fetch --quiet origin
git -C "$FMH" merge --ff-only "$PATCH_BASE"

# 3. Re-install against the new HEAD. The refreshed patches apply; the installer builds
#    the mirror in bin-bb.staging and atomically swaps it in ONLY on full success. If it
#    failed (further drift), it aborts loud + non-zero and leaves the stale-but-serving
#    mirror exactly in place — still no window; fix the patches and retry.
python3 "$OVL"/install-bb-backend.py --home "$FMH" --project-id <bb-project-id>
python3 "$OVL"/install-bb-backend.py --home "$FMH" --verify   # healthy
git -C "$FMH" status --porcelain                              # expect empty
```

`bin-bb` contains a complete bb-capable mirror at every step (the old one until the instant the new one swaps in at step 3), so native `bin` — which rejects bb once fast-forwarded — is never the only path. Run `node scripts/patch-drift-check.mjs` before starting: if it reports drift, the patches need refreshing (and `patch-base.txt` bumping) before step 3 can succeed.

## Paths that do NOT reach bb through the mirror (F4/F5)

The mirror redirects the plugin's entry points via `$FM_BINDIR`, and each patched copy's own internal dispatch self-calls are rewritten to `$SCRIPT_DIR` at install time (so `fm-spawn.sh` batch/array dispatch, which re-invokes itself per pair with `--backend bb`, stays inside the mirror). Two native references still resolve to pristine `bin/` and would report `unknown backend 'bb'` if reached with `backend=bb`:

- **`bin/fm-bootstrap.sh` secondmate spawn** (`FM_SPAWN_NO_GUARD=1 "$FM_ROOT/bin/fm-spawn.sh" … --secondmate`). This is a symlinked (not patched) mirror entry, so its absolute `$FM_ROOT/bin/` call reaches native. **Not a functional regression:** `backend=bb` refuses `--secondmate` outright (`fm-spawn.sh`: "backend=bb does not support --secondmate spawns yet"), so a bb captain never completes a secondmate spawn under either scheme — the mirror only changes the error text (`unknown backend` vs the explicit refusal). If bb ever gains secondmate support, this call must be rewritten to `$FM_BINDIR`/`$SCRIPT_DIR`, or better, fixed by the upstream seam below.
- **`bin/fm-remote-entrypoint.sh`** resolves `realpath "${BASH_SOURCE[0]}"`, so a symlinked `bin-bb` entry resolves back to native `bin` and bypasses the mirror. This is the remote-job entrypoint, outside the bb dispatch path; noted for completeness.

The clean fix for both is the **upstream seam** proposed above (a generic `*)` dispatch fallthrough in native `bin/fm-backend.sh`): once native itself dispatches a registered backend to `fm_backend_<name>_*`, every `$FM_ROOT/bin/` reference reaches a bb-aware script with no mirror rewrite at all.

`FM_TEST_HOME=/path/to/native node scripts/native-bb-pending-input-check.mjs`
executes the installed native alarm functions with controlled BB responses: pending
input defers, clearing resumes alarms, and replacing the patched watcher with
pristine native reproduces the false wedge. It also checks invalid/failed/timeout
reads preserve alarms and worker status/progress remain unchanged. This is a
native shell regression proof; it does not create a real BB interaction.
