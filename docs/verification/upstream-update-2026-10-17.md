# Firstmate update: 2026-10-17

The native pin moves from `1f3e769616fdf9f31f85f4c3e6a9f71606634238` to
`15ad1bd6524bdccca00feb07b3e3ed985fb2d7f4`, upstream HEAD on 17 Oct 2026.
That is 73 upstream commits.

## How the pin moved

1. The guard (`scripts/refresh-native-pin.mjs`) ran against a fresh clone with
   `FM_HOME` set to the live captain home, read-only. It reported 66 changed
   native-owned paths and 3 unchanged host files. It then refused the pin on
   2 sentences in `skills/harness-adapters/SKILL.md` outside BB markers.
2. That skill now uses native's wording: Command Code joins the list of
   crewmate-and-scout-only harnesses and the routing table. Fidelity passes:
   33 skills, 12 BB-DIVERGE anchors, 9 BB-ONLY fences, snapshot fresh.
3. 10 hunks across the 4 overlay patches no longer applied. Each patched file was
   rebuilt with a 3-way merge (pristine 1f3e7696, BB-patched 1f3e7696,
   pristine 15ad1bd6). 7 conflicts were resolved by hand. A line audit shows
   every BB-added line is kept; 4 lines changed shape to fit native's new code.
4. The 1f3e7696 patches stay as an exact compatibility set under
   `overlay/compat/1f3e7696…/`, because every live captain home still runs the
   1f3e7696 bundle. `patch-drift-check` applies all three sets cleanly.
5. The bundled runtime was regenerated: snapshot commit `6555ce68`, native
   commit 15ad1bd6, 398 native files.

## Plugin code changes

- **Overlay patches** (`overlay/firstmate-bb-*.patch`). Rebuilt for
  15ad1bd6, as in step 3 above. The BB backend now holds the project lock like
  Orca when a project capacity is declared (opt-in, not declared in BB homes).
- **Worker brief renderer** (`overlay/bin/backends/bb-worker-prompt.py`).
  Native 918a5bf1 rewrote ship rule 2. The renderer refused every ship brief
  from a 15ad1bd6 home. It now accepts either wording and keeps native's new
  guidance: scratch output outside the worktree, a clean worktree before done.
- **Worker role** (`overlay/bin/backends/bb.sh`). Native e5b9dddc added a
  third argument to `fm_brief_worker_role`. BB passed two, so a replacement
  launch brief was refused. BB now passes the runtime root.
- **Native policy reads** (`lib/native-policy.ts`, `server.ts`). Not an
  upstream commit: a BB defect the re-pin exposed. The reader accepted only the
  snapshot of the bundle this plugin ships. A home keeps its selected bundle
  until its owner selects another, so after the reload every existing captain
  would have lost `firstmate_skill` and `firstmate_contract`. The reader now
  accepts each audited bundled snapshot with its native commit.
- **Runtime switch with task records** (`scripts/runtime-host.py`,
  `lib/launch.ts`). A home with task records can now move to a new audited
  native release; see the section below.
- **Audited pin lists.** 15ad1bd6 joins `AUDITED_POLICY_COMMITS`, the legacy
  repair `PINS`, the patch registry and both install-input lists, the test
  fixtures and the transport allowlist.

No owner rule was added. The owner layer is unchanged apart from the
harness-adapters wording the task asked for.

## Commit table

Decisions: 28 vendored (come in with the bundle and skill copies), 11 plugin
changes, 34 do not apply to BB.

| # | Commit | Subject | Decision | Where or why |
| --- | --- | --- | --- | --- |
| 1 | `fede6197` | test(pi): accept Pi 1.0.1's renamed HTML export renderer lookup | Does not apply | Test only. |
| 2 | `2e659ffd` | fix(bin): tolerate transient quota read failures | Plugin change | Overlay browser patch: `fm-quota-axi-lib.sh` split the version check; the BB read probe moved into the new `fm_quota_axi_compatible`. Vendored for `fm-procevent-quota.sh`. |
| 3 | `918a5bf1` | fix(bin): clarify scratch guidance and dirty teardown refusals | Plugin change | `bb-worker-prompt.py` accepts the new ship rule 2 and keeps its scratch and clean-worktree text. Teardown wording is vendored. |
| 4 | `42dd906d` | fix(bin): escalate inbox instructions blocked by busy workers | Vendored | Native watcher and inbox libraries; BB runs the native watcher through `fm-watch-arm.sh`. |
| 5 | `9ea0c41a` | fix: prevent unnecessary remote worker turnover | Does not apply | Remote secondmate jobs; BB registers no remote secondmates. |
| 6 | `f470a01c` | fix: speed up remote-job sequence claim cleanup | Does not apply | Remote secondmate jobs. |
| 7 | `98d80a16` | feat(bin): record no-mistakes pipeline spend per task at teardown, opt-in | Vendored | Opt-in teardown record; not enabled in BB homes. |
| 8 | `6a7b3919` | feat(bin): start tasks from a named base branch | Plugin change | Overlay backend patch: BB keeps `bb_thread_id` in the new relaunch meta key list. `firstmate_dispatch` does not pass `--base-branch`. |
| 9 | `e5b9dddc` | fix(bin): name the Firstmate skill file as a fallback in the worker role | Plugin change | `bb.sh` passes the runtime root as the new third argument of `fm_brief_worker_role`. |
| 10 | `4c0331a5` | feat(bin): retire a contribution whose forge object is permanently gone | Vendored | Bearings contribution records. |
| 11 | `332de270` | test: extend remote-reply whole-log recapture waits | Does not apply | Test only. |
| 12 | `70f2ed3d` | fix(bin): reopen a pending-reply escalation after its resolve | Does not apply | Remote secondmate pending replies. |
| 13 | `2d7daa9e` | fix: refuse a confirming Enter on the Claude background-task exit picker | Plugin change | Overlay backend patch: the BB arm of `fm_backend_send_text_submit` takes native's new `rc` form. The picker itself is a terminal case BB threads do not have. |
| 14 | `5838f105` | fix: restore timeout watchdog compatibility with macOS Bash 3.2 | Vendored | Shared timeout library. |
| 15 | `e06a46fe` | fix(project-management): use subshell form for Initialize command | Vendored | Native skill. |
| 16 | `99da16d9` | feat(bin): add armable daily startup growth check | Vendored | Opt-in; not armed in BB homes. |
| 17 | `2e8cd9e9` | fix(bin): reopen the remote-reply continuity decision on a later break | Does not apply | Remote secondmate replies. |
| 18 | `e7c3bdc1` | fix(control): drop busy_gen from the task record when an incarnation is retired | Vendored | `fm-control.sh`; BB crew control goes through the plugin's interrupt, retry and stop tools. |
| 19 | `237e1cf3` | test: cover PID collisions in harness ancestry detection | Does not apply | Test only. |
| 20 | `53b5bc11` | fix: share Pi Calm's working-ship widget slot | Does not apply | Pi harness. |
| 21 | `23e71b3d` | feat(bin): add opt-in --herdr-resume-lock-wait to fm-spawn | Does not apply | Herdr backend. The batch path keeps the BB mirror spawn. |
| 22 | `0f34fab4` | fix(bin): let TERM stop a watcher blocked in a pane capture on bash 3.2 | Vendored | Native watcher. |
| 23 | `47aff866` | feat: add per-home worker tool exclusions | Vendored | The shared spawn preflight runs for BB. A listed `config/crew-exclude-tools` refuses a BB spawn before any thread exists, because a BB crew cannot hide tools (native allows only Pi). Kept as native's fail-closed refusal; `scripts/native-compat.test.mjs` pins it. |
| 24 | `ac0811c4` | feat(bin): defer spawns beyond a declared per-project capacity, opt-in | Plugin change | Overlay backend patch: batch spawn keeps the mirror path; BB, like Orca, takes the project lock only when a capacity is declared. Not declared in BB homes. |
| 25 | `228b27d2` | fix(bin): name the Lavish read message count by the same label as its section | Vendored | Lavish process events. |
| 26 | `8fa25382` | fix(herdr): make the presentation lock namespace per OS account | Does not apply | Herdr backend. |
| 27 | `0c83b3f4` | Fix OpenCode arm plugin to decide with the shared supervision predicate | Does not apply | OpenCode harness. |
| 28 | `9b85a955` | fix(bin): resolve a pending reply only from its own task's status line | Does not apply | Remote secondmate pending replies. |
| 29 | `2ce57d00` | docs(skills): index the six missing agent-only skill triggers | Vendored | Native skill trigger index; the repo copy was refreshed by the re-pin. |
| 30 | `329ad4ed` | test: make agent process fixtures compatible with multicall sleep | Does not apply | Test and docs only. |
| 31 | `3c58ec8e` | fix(bin): keep the supervision host's successor watcher alive after the Stop hook's group is torn down | Does not apply | Supervision host is opt-in and BB does not enable it. |
| 32 | `0ec1c5a4` | test: make tmux Claude readiness checks independent of permission footers | Does not apply | Test docs only. |
| 33 | `b062eb94` | test(herdr): accept safe exit refusals and clean lab once | Does not apply | Test only. |
| 34 | `19fcbbde` | test: stabilize watcher lock race fixtures | Does not apply | Test only. |
| 35 | `b75658b6` | fix(bin): keep herdr composer probes observable-only without autostarting server | Does not apply | Herdr backend. |
| 36 | `fb75c1f9` | fix(tests): clear inherited Git repository location in fixture helper | Does not apply | Upstream test helper. |
| 37 | `1a868710` | fix: avoid argument-size failures in fleet contribution snapshots | Vendored | Fleet snapshot. |
| 38 | `4735ddc6` | fix(bin): arm the busy contract on secondmate launches | Does not apply | Native secondmate launch hooks; BB secondmates are BB threads. |
| 39 | `072a7da3` | test: guard fleet snapshot contribution input against argument-size failures | Does not apply | Test only. |
| 40 | `b675126a` | fix(bin): scrub nested repos from scratch copies before treehouse return | Does not apply | Treehouse return; BB owns its worktrees and skips Treehouse. |
| 41 | `4cca7d07` | fix(bin): pin markdown backend in backlog handoff and receive | Vendored | Backlog handoff. |
| 42 | `e0d95ac7` | fix(bin): parse whole project names in home seed registry queries | Vendored | Home seeding. |
| 43 | `a1ecefb4` | fix: preserve announced recovery across Codex checkpoints | Vendored | Native watcher checkpoints. |
| 44 | `20dcbf91` | feat(bin): support Forgejo/Gitea as a forge via the tea CLI | Does not apply | Vendored, but the BB renderer still refuses a non-GitHub forge rule, loudly. BB projects use GitHub. |
| 45 | `6407052f` | fix: prevent concurrent secondmate relaunch races | Plugin change | Overlay backend patch: the BB `--backend bb --harness bb` relaunch arguments kept with native's new per-home relaunch lock. |
| 46 | `7df545bf` | fix: require explicit authority for Firstmate upstream contributions | Plugin change | Vendored policy and `fm-role` gate; overlay backend patch keeps `bb_thread_id` in the meta key list beside `upstream_consent`. |
| 47 | `8c9c67de` | fix(pi): narrow before_agent_start events before reading prompt | Does not apply | Pi harness. |
| 48 | `2911a3bb` | feat: let a home declare authoritative external memory tiers | Vendored | AGENTS.md and stow skill; opt-in per home. |
| 49 | `89028578` | fix: keep unsupported contribution URLs unmeasured | Vendored | Contribution records. |
| 50 | `0397cb2b` | fix(bin): keep inherited Git config entries when installing the trailer-strip hooks path | Does not apply | BB still does not deliver `core.hooksPath` to crew threads (known gap since 4299683d). |
| 51 | `723f43c7` | fix(bin): name the failing step when a contribution observation is unavailable | Vendored | Contribution records. |
| 52 | `24f3a6b8` | fix(spawn): scope Orca worker launch env to an opt-in tmux session | Plugin change | Overlay backend patch: the BB branch closes after native's new Orca launch block. Orca itself does not apply. |
| 53 | `08f0a069` | fix(bin): treat OpenCode's right-aligned cwd rail as composer furniture, including absolute paths | Does not apply | OpenCode harness. |
| 54 | `138cf11a` | fix(bin): report a worker parked on the exit picker as blocked-on-prompt | Vendored | Watcher; the picker is a terminal case BB threads do not have. |
| 55 | `9cd4a3be` | feat: set afk spend cap from live ordinary workers at entry | Vendored | Away-mode contract; counts BB crews from their native records. |
| 56 | `819f1a49` | fix(bin): guide completed-scout cleanup and permit stock lab supervision paths | Vendored | Scout cleanup guidance. |
| 57 | `33503ab3` | ci: let a fork skip the push run and the macOS job by repository variable | Does not apply | Upstream CI. |
| 58 | `0fd0e82a` | fix(bin): have workers paused on their own background job set until to the job's timeout | Vendored | Worker brief text; the renderer keeps it. |
| 59 | `a24f4cb8` | feat(bin): add a verified Command Code (commandcode) crewmate/scout adapter | Plugin change | `skills/harness-adapters/SKILL.md` adopts native's Command Code wording. The adapter itself does not apply to BB crews. |
| 60 | `0aa7facd` | fix: put a read cue at the head of a context re-emit | Vendored | Session start. |
| 61 | `4f77bb37` | fix(bin): retry transient contribution forge reads once before waking | Vendored | Contribution records. |
| 62 | `9b1ada04` | fix(bin): let a backlog captain hold bound the watcher's wedge escalation | Vendored | Native watcher and captain holds. |
| 63 | `fc8972cd` | fix: parse list-form Lavish results without dropping answers | Vendored | Lavish process events. |
| 64 | `230db821` | fix: correct Pi wake ownership and processing-turn handling | Does not apply | Pi harness. |
| 65 | `1a6714f2` | feat(bin): add a forge=external review rail that never pushes task branches | Plugin change | Overlay backend patch keeps `bb_thread_id` in the extended meta key list. The rail itself: the BB renderer refuses its rule 3, loudly. |
| 66 | `5f2b81bc` | test(pi): Lauf ohne prompt in before_agent_start festnageln | Does not apply | Test only. |
| 67 | `aa9ab042` | fix(bin): stop tmux target checks reporting gone windows as alive | Does not apply | Tmux backend; the merged backend files keep every BB arm. |
| 68 | `e906f2e0` | fix(composer): prove opencode 1.19 de-emphasised mode footer from the plain row | Does not apply | OpenCode harness. |
| 69 | `4de02c06` | test(send): codex im Tuerklingel-Test hook-frei starten | Does not apply | Test only. |
| 70 | `67abd40a` | fix(bin): store only classified review fields in contribution records | Vendored | Contribution records. |
| 71 | `7099556d` | fix: handle Pi 1.1 and 1.2 supervision events correctly | Does not apply | Pi harness and upstream CI. |
| 72 | `7efe9d04` | fix(bin): verify cursor launch binaries with a bounded probe | Does not apply | Cursor harness. |
| 73 | `15ad1bd6` | fix: require actual PR references in CI-ready ship notes | Vendored | Definition-of-done library used in BB crew briefs. |

## Known gaps kept

- `skills/harness-adapters/references/` holds older native copies (one is a
  BB edit). Crews read skills from the bundled runtime, not from this folder,
  and the owner layer marks it owner-owned, so this sync leaves it alone.
- `fm-procevent-quota.sh` probes `quota-axi --version` without the BB read
  probe. It is a native process-event source BB does not run.
- `core.hooksPath` still does not reach BB crew threads (see
  [upstream alignment](../upstream-alignment.md)).

## Verification

```sh
FM_HOME=<live captain home> node scripts/refresh-native-pin.mjs <clone> 15ad1bd6524bdccca00feb07b3e3ed985fb2d7f4
npm run fidelity -- --native <clone>
FM_TEST_HOME=<clone> node scripts/patch-drift-check.mjs --ref 15ad1bd6524bdccca00feb07b3e3ed985fb2d7f4
FM_TEST_HOME=<clone> node scripts/patch-drift-check.mjs --ref 1f3e769616fdf9f31f85f4c3e6a9f71606634238
FIRSTMATE_TEST_NATIVE=<clone> FM_TEST_HOME=<clone> npm test
```

## Moving a home with task records to a new native release

The runtime refused any native change while a home kept task records, the
captain's own primary lock or a watcher. It also read lock files by presence,
so one dead spawn lock blocked for good. The plugin added a second refusal:
it counted every launched crew (`running`) as a consumer. So the live captain
could never leave the 1f3e7696 bundle.

Native's own update (`updatefirstmate`) moves code under live tasks. Records
keep naming their own immutable release folder, which stays on disk. The
plugin's supervision already re-arms a watcher and keeper from another
release. The state contract (`native-flat-v1`) is the same in both releases.

The switch now refuses only while something is executing old code at that
moment: a spawn or control lock held by a live process, or a BB launch that is
reserved, creating, provisioning or uncertain. Migration from and rollback to
an external checkout keep the strict rule.

## Canary (test captain)

Run on an isolated BB server and host daemon (own data folder, ports 39710
and 39711), with the real HOME so crews could sign in to the model provider.
The live server never saw a canary thread (`bb thread show` on the live server
returned 404 for the canary crew).

1. Installed this repo's main (`2066fa5`) on the isolated server. Bound a
   test captain (Claude Opus). Its home ran release `c9f623c8`, native
   1f3e7696, the same release the live captain runs.
2. Dispatched a crew there. It opened PR #1 in a private scratch repo and left
   task records (`82228e59.meta`, status, git hooks).
3. Installed this branch on the isolated server. On the old bundle,
   `firstmate_skill` and `firstmate_contract` still read native 1f3e7696.
4. `firstmate_runtime select` was refused by the plugin's launch check (the
   finished crew counted as running). Fixed, test first, then the switch
   passed: release `1e8f4d75`, native 15ad1bd6, `taskStateChanged: false`.
   `referencedReleases` still listed the old crew on `c9f623c8`.
5. Supervision moved by itself: watcher, keeper and captain marker now run
   from the new release.
6. `firstmate_merge` merged the pre-switch crew's PR #1 (`7b8f61c`). A new
   dispatch made PR #2; its brief carried native's new rule 2 and the skill
   file fallback. `firstmate_merge` merged it (`ebb4d54`). GitHub shows both
   merged.

### Mid-turn switch

A second run on a fresh isolated server closed the limit an independent check
raised: a switch while a crew's model turn is running, with the real watcher.

1. Main plugin; test captain on release `c9f623c8`. A crew started one
   turn that ran `sleep 420`, then fixed a typo and opened a PR.
2. During that turn: this branch installed, then `firstmate_runtime select`
   to release `e99f6c5e` (native 15ad1bd6) passed.
3. The crew's turn ran from before the switch to after it and completed
   normally. It opened PR #3 and wrote its done line in that same turn.
4. The watcher and keeper moved to the new release. Once, while the old
   keeper was replaced, the old release's `fm-watch-arm.sh` failed with
   `trap: line 2: unexpected EOF while looking for matching ')'`. For about
   one minute no watcher ran; the captain got the native "watcher down"
   notice, and a new watcher on the new release started by itself. No wake
   was lost.
5. `firstmate_merge` merged PR #3 (`6222b47`) on the switched home.

Observations, not changed here:
- The captain once asked for a Claude model on the project's default Codex
  provider; that crew failed at its first turn. The captain retried with the
  provider named.
- After a recorded verification on PR #2, the delivery record showed
  `waiting-checks` in a repo with no checks; the merge still went through.

## Switching the live captain (after merge and reload)

Run these as the live captain, in its own thread:

1. `firstmate_runtime action=install`.
2. `firstmate_runtime action=status`. Note the installed release whose
   upstream commit is `15ad1bd6524bdccca00feb07b3e3ed985fb2d7f4`.
3. `firstmate_runtime action=select release=<that release> check=true`.
4. If it refuses with "native operation in flight" or "BB launches are
   running/reserved/uncertain": wait for that spawn or launch to finish, then
   repeat step 3. If the named lock stays and its process is not a spawn or
   control step (a reused process ID), inspect the lock and the process
   before any reconciliation. Do not delete a lock because it is old.
5. `firstmate_runtime action=select release=<that release>`. It checks
   again; if it refuses, go back to step 4.
6. `firstmate_contract`, read again in full. It must name 15ad1bd6.
7. Check `firstmate_runtime action=status`: selected release has upstream
   15ad1bd6; old crews appear under `referencedReleases`.
   Expect one "watcher down" notice while the old watcher is replaced; a
   new watcher should start within about a minute.
8. Check that `state/.watch.lock/watcher-path` and
   `state/.bb-watch-keeper.bindir` in the home name the new release folder.
   The plugin log shows "replacing the keeper" when it moved them.

To undo: `firstmate_runtime action=rollback release=<the recorded previous
release>` (`c9f623c8…` for the live captain), with `check=true` first.
Rolling back to an external checkout keeps the strict rule: task records, the
primary lock and the watcher refuse it.

## What the live captain and its crews see after merge and reload

Every existing captain home stays on the 1f3e7696 bundle until its captain
runs the switch above. Open crews keep running on the release they started
with.

- **Existing captains before the switch, the live one included.** Same
  native contract, skills and scripts as today. `firstmate_skill` and `firstmate_contract` keep
  working (the policy-reader fix). `firstmate_runtime status` lists the new
  installed release. `bb firstmate scripts` lists 9 new native script names
  as missing for that home; this inventory is diagnostic only.
- **Their crews.** Unchanged. Crews use the selected release's own BB
  backend and renderer.
- **New captain homes, and a home after the switch.** Native
  15ad1bd6: the upstream-contribution authority rule, external memory tiers,
  opt-in project capacity, the new scout cleanup and watcher fixes.
- **Crews of those homes.** Ship briefs carry native's new rule 2 (scratch and
  proof output under the task data folder, a clean worktree before done). The
  worker role names the Firstmate skill file as a fallback. A CI-ready ship
  note must name the actual PR.
