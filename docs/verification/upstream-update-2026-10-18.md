# Firstmate update: 2026-10-18

The native pin moves from `15ad1bd6524bdccca00feb07b3e3ed985fb2d7f4` to
`8ba34f1da5d19004adc3a7521dc600d1815cf380`, upstream HEAD on 18 Oct 2026.
That is 16 upstream commits.

## How the pin moved

1. The guard (`scripts/refresh-native-pin.mjs`) ran against a fresh clone with
   `FM_HOME` set to the live captain home, read-only. It reported 66 changed
   native-owned paths and 5 unchanged host files. It then refused the pin on
   2 sentences in `skills/harness-adapters/SKILL.md` outside BB markers.
2. That skill now uses native's wording: Polytoken joins the list of
   crewmate-and-scout-only harnesses and the routing table. Fidelity passes:
   33 skills, 12 BB-DIVERGE anchors, 9 BB-ONLY fences, snapshot fresh.
3. 2 hunks of the backend patch no longer applied, both in `bin/fm-spawn.sh`.
   Every patched file was rebuilt with a 3-way merge (pristine 15ad1bd6,
   BB-patched 15ad1bd6, pristine 8ba34f1d). One conflict was resolved by
   hand: the relaunch meta key list keeps `bb_thread_id` beside native's 3 new
   Polytoken keys. A line audit shows every BB-added and BB-removed line is
   kept; that one line is the only one that changed shape.
4. The 15ad1bd6 patches stay as an exact compatibility set under
   `overlay/compat/15ad1bd6…/`, because the live captain and 4 other homes run
   the 15ad1bd6 bundle. The other live homes run 1f3e7696.
   `patch-drift-check` applies the 8ba34f1d, 15ad1bd6 and 1f3e7696 sets
   cleanly.
5. The bundled runtime was regenerated: snapshot commit `37920efb`, native
   commit 8ba34f1d, 403 native files.

## Plugin code changes

- **Overlay patches** (`overlay/firstmate-bb-*.patch`). Rebuilt for
  8ba34f1d, as in step 3 above. The BB create-task arm of `fm-spawn.sh` sits
  before native's new Polytoken endpoint block, which only a Polytoken
  harness enters.
- **Harness skill** (`skills/harness-adapters/SKILL.md`). Native's Polytoken
  wording, as in step 2 above.
- **Audited pin lists.** 8ba34f1d joins `AUDITED_POLICY_COMMITS`, the legacy
  repair `PINS`, the patch registry and both install-input lists, the test
  fixtures and the transport allowlist. Snapshot `37920efb` joins
  `AUDITED_BUNDLED_SNAPSHOTS`, so captains on the 15ad1bd6 bundle
  (`6555ce68`) keep their policy reads.

No owner rule was added. The owner layer is unchanged.

## Commit table

Decisions: 10 vendored (come in with the bundle and skill copies), 1 plugin
change, 5 do not apply to BB.

| # | Commit | Subject | Decision | Where or why |
| --- | --- | --- | --- | --- |
| 1 | `d20196ae` | feat(herdr): opt-in project groups with status tags and a sorted agents view | Does not apply | Herdr backend. The new `fm-spawn.sh` and `fm-watch.sh` lines run only for `BACKEND=herdr`; the backend patch merged around them. |
| 2 | `ce697402` | fix(bin): pin LC_ALL=C for remote job process identity reads | Does not apply | Remote secondmate jobs; BB registers no remote secondmates. |
| 3 | `64dddf65` | fix(opencode): ignore child stdin EPIPE in guard and encoder | Does not apply | OpenCode harness. |
| 4 | `11becbbb` | fix(bin): ignore crew state overrides for other tasks | Vendored | `fm-crew-state.sh`, read by the native watcher and fleet snapshot. |
| 5 | `eeeeb916` | fix(bin): re-anchor a Claude session's lock so /clear keeps ownership | Vendored | Session lock, lease and wake libraries. BB's lease callers (`fm-launch-adopt.sh`, `fm-worker-rebind.sh`) use functions whose interface did not change. |
| 6 | `66c300bd` | feat: support version URLs for watched tool updates | Vendored | Opt-in update check; not armed in BB homes. |
| 7 | `30944754` | fix(pi): keep a live session's extension markers when a nested Pi command loads them | Does not apply | Pi harness. |
| 8 | `f05b6284` | fix: reclaim orphaned Claude auto-arm claims | Vendored | `bb-captain-hook.sh` runs native `fm-claude-stop-autoarm.sh` and `fm-turnend-guard.sh` when the BB keeper is not healthy. Arguments and output did not change. |
| 9 | `c4f43332` | feat(bin): add Polytoken crewmate/scout worker adapter | Plugin change | `skills/harness-adapters/SKILL.md` adopts native's wording. The backend patch keeps `bb_thread_id` beside the new Polytoken meta keys. The adapter itself does not apply to BB crews. |
| 10 | `11990a20` | Fix away branch relaunch admission | Vendored | Native spawn admission under the away posture. |
| 11 | `56074d03` | fix(bin): show reported checks when a pull request's base requires none | Vendored | `fm-pr-state.sh`. BB's own delivery records do not use it. |
| 12 | `07912680` | fix: support durable per-secondmate account pins | Vendored | Opt-in config for Claude and Pi runners; not set in BB homes. |
| 13 | `4e6b9f59` | feat(bin): consult operator evidence guards before wedge escalation | Vendored | Opt-in watcher guard list; not set in BB homes. The backend patch merged around the new `fm-watch.sh` code. |
| 14 | `c7b7798b` | fix(bin): make inbox listing succeed when the inbox is empty | Vendored | `fm-brief.sh` and the relaunch note. The BB renderer replaces the brief's inbox section with its `fm-inbox-take.sh` helper; its anchors still match the new wording. |
| 15 | `63fc5ebd` | fix: bound remote secondmate convergence and preserve owed re-reads | Does not apply | Remote secondmates. The browser patch merged around the new `fm-bootstrap.sh` code. |
| 16 | `8ba34f1d` | fix: require positive daemon running status in crew-state | Vendored | `fm-crew-state.sh` no-mistakes daemon probe. |

## Known gaps kept

- `skills/harness-adapters/references/` holds older native copies and has no
  `commandcode.md` or `polytoken.md`. Crews read skills from the bundled
  runtime, not from this folder, and the owner layer marks it owner-owned, so
  this sync leaves it alone.
- `core.hooksPath` still does not reach BB crew threads (see
  [upstream alignment](../upstream-alignment.md)).

## Verification

```sh
FM_HOME=<live captain home> node scripts/refresh-native-pin.mjs <clone> 8ba34f1da5d19004adc3a7521dc600d1815cf380
npm run fidelity -- --native <clone>
FM_TEST_HOME=<clone> node scripts/patch-drift-check.mjs --ref 8ba34f1da5d19004adc3a7521dc600d1815cf380
FM_TEST_HOME=<clone> node scripts/patch-drift-check.mjs --ref 15ad1bd6524bdccca00feb07b3e3ed985fb2d7f4
FM_TEST_HOME=<clone> node scripts/patch-drift-check.mjs --ref 1f3e769616fdf9f31f85f4c3e6a9f71606634238
FIRSTMATE_TEST_NATIVE=<clone> FM_TEST_HOME=<clone> npm test
npx tsc --noEmit
```

The re-pin also moved the native source header of 5 mixed entry skills to
8ba34f1d. The transport allowlist records the 2 new reviewed captain skill
hashes, as in the 15ad1bd6 sync.

## Canary (test captain)

Run on an isolated BB server and host daemon (own data folder, ports 39720
and 39721, own launch id), with the real HOME so crews could sign in to the
model provider. The live server never saw a canary thread: `bb thread show`
on the live server returned 404 for the captain and both crews. Evidence is
kept under `/tmp/hanoon/canary-8ba34f1d/` on the build host.

1. Installed this repo's main (`804c88f`) on the isolated server. Bound a test
   captain (Claude Opus 5.5). Its home ran release `64909984`, native
   15ad1bd6, the same release the live captain runs. Startup passed.
2. Dispatched crew `canary-timing-readme-typo` (Claude Sonnet 5.5). Its one
   model turn waited on a signal file.
3. During that turn, at 03:25:56 UTC, installed this branch (head `0861e96`)
   on the isolated server. On the old bundle, `firstmate_skill` still read
   native 15ad1bd6.
4. Still during that turn: `firstmate_runtime install` returned release
   `103c4974c1aaa2fc5dce378a0347fa3cdc76b02a2eeb6eee9193e313914abf86`. The
   checked select and the real select both passed. `referencedReleases`
   listed the running crew on `64909984`. `firstmate_contract` then named
   8ba34f1d.
5. At 03:27:18 the watcher and the keeper ran from release `103c4974`. The
   watcher beat was 10 seconds old.
6. The crew, still in the same turn, wrote `working: CANARY-MID …` after the
   switch, then fixed a word and wrote `done` with PR #1. Its turn ran from
   03:11 to 03:27, across the switch. The captain got the crew's done report
   at 03:28 and reported PR #1.
7. A new dispatch on the new release, crew `readme-typo-repository`, opened
   PR #2. Its brief names release `103c4974`, so BB's renderer accepted an
   8ba34f1d brief.
8. `firstmate_merge` merged PR #1 (`41ad7c8`), from the crew started before
   the switch, and PR #2 (`153805e`), from the crew started after it. GitHub
   shows both merged. `referencedReleases` was then empty.

What this proves: on this branch, a captain on the live captain's release
moves to the 8ba34f1d release while a crew's model turn runs. That crew's
done line and PR still reach the captain. New dispatches and both merges work
on the new release.

What it does not prove: no waking status line was written inside a watcher
handoff in this run; the 15ad1bd6 sync's run 3 tested that once. The canary
captain used native's Claude auto-arm only if the BB keeper went unhealthy;
it did not go unhealthy, so the new auto-arm reachability rule (`f05b6284`)
was not exercised.

Observation, not changed here: the first `firstmate_merge` of PR #1 refused
with `has no verification record for its current head`. The captain recorded
a verification and the retry merged. That is the existing checker gate.

## Switching the live captain (after merge and reload)

Run these as the live captain, in its own thread. `<home>` is the captain's
home from `firstmate_deck`.

1. `firstmate_runtime action=status`. Record the full 64-character selected
   release as `<previous>` (for the live captain today:
   `64909984c99c8f8f2f30f8813821172a17cc008e962a41a5c0c81691dd954c01`).
2. `firstmate_runtime action=install`. Record the full 64-character
   `release` it returns as `<release>`. At head `0861e96` and the docs-only
   heads after it, this is
   `103c4974c1aaa2fc5dce378a0347fa3cdc76b02a2eeb6eee9193e313914abf86`. If
   install returns another ID, use the returned one.
3. `firstmate_runtime action=status`. Confirm `<release>` is listed with
   upstream `8ba34f1da5d19004adc3a7521dc600d1815cf380`. The native commit is a
   check, not the selector: several releases can share one.
4. `firstmate_runtime action=select release=<release> check=true`.
5. If it refuses with "native operation in flight" or "BB launches are
   running/reserved/uncertain": wait for that spawn or launch to finish, then
   repeat step 4. If the named lock stays and its process is not a spawn or
   control step (a reused process ID), inspect the lock and the process
   before any reconciliation. Do not delete a lock because it is old.
6. `firstmate_runtime action=select release=<release>`. It checks again; if
   it refuses, go back to step 5.
7. `firstmate_runtime action=status`: the selected release is exactly
   `<release>` (all 64 characters), `previous` is `<previous>`, and open crews
   appear under `referencedReleases`.
8. `firstmate_contract`, read again in full. It must name 8ba34f1d.
9. Verify supervision on live processes, not only files. Within 2 minutes of
   step 6, all must hold:
   - `<home>/state/.watch.lock/pid` names a live process whose command line
     runs `versions/<release>/runtime/bin-bb/fm-watch.sh`.
   - `<home>/state/.bb-watch-keeper.pid` names a live process, and
     `<home>/state/.bb-watch-keeper.bindir` is
     `versions/<release>/runtime/bin-bb`.
   - `<home>/state/.last-watcher-beat` was modified less than 90 seconds ago.
10. If step 9 does not hold within 2 minutes: report "runtime selected,
    supervision unverified", not "switched". Then:
    1. Call `firstmate_watch` once, then repeat step 9.
    2. If it still fails, read the keeper log `<home>/state/.bb-watch-arm.log`
       and the plugin log for "fm-watch-supervisor" lines. Report what they
       show.
    3. If supervision cannot be restored, roll back:
       `firstmate_runtime action=rollback release=<previous> check=true`, then
       without `check`, then repeat step 9 with `<previous>` in place of
       `<release>`.

## What the live captain and its crews see after merge and reload

Every existing captain home stays on its selected bundle (15ad1bd6 or
1f3e7696) until its captain runs the switch above. Open crews keep running on
the release they started with.

- **Existing captains before the switch, the live one included.** Same
  native contract, skills and scripts as today. `firstmate_skill` and
  `firstmate_contract` keep working. `firstmate_runtime status` lists the new
  installed release.
- **Their crews.** Unchanged.
- **New captain homes, and a home after the switch.** Native 8ba34f1d: the
  auto-arm and session-lock fixes, the crew-state fixes, and opt-in watcher
  guards, watched-tool URLs and per-secondmate account pins.
- **Crews of those homes.** Briefs are the same apart from native's relaunch
  note, which now lists the inbox with `find`. BB's own inbox section is
  unchanged.
