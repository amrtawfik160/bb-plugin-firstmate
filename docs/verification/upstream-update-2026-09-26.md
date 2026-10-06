# Firstmate update — 2026-09-26

Updated the native pin from `4299683d5b656a70ced609d7d929499ddc0d675a`
to `bb69be62e1f8df465d674a35f7e2ce707b900501` (19 upstream commits).
The plugin repository had no newer `origin/main` commit at fetch time.
Existing local audit fixes and unrelated uncommitted files were preserved.

## Validation

- All four BB overlay patches apply cleanly at the new pin.
- Skill fidelity passed: 21 managed files, 12 divergence anchors, seven BB-only
  fences; snapshots verified against native Git objects.
- Full suite against the new native scripts: 507 passed, zero failed, two skipped.
  The skipped scout checks require the opt-in `FM_SCOUT_NATIVE_BIN` fixture.
- Native mirror checks: 14/14 passed, including merge-order mutation and liveness
  routing checks. `FM_MIRROR_CHECK_NO_REAL_PROJECT=1` was set; this run did not
  create actual BB worker threads.
- TypeScript, whitespace checks and `bb plugin build` passed.

## Installed outcome

The native guarded updater advanced `/root/firstmate` and seven Git homes under
`/root/firstmate-bb-homes`. Every home ended at the new pin with clean tracked
files and a rebuilt, verified BB mirror. Each updater reported no secondmates
requiring restart or a re-read message. Operational directories were retained.

The installed plugin was reloaded from this checkout. All four services reported
running. Runtime inventory reported 190/190 scripts and 21/21 support files,
with no missing or extra entries. The cumulative handler error count remained
12, unchanged from before this update. Cached script counts and the native
skills inventory were refreshed.

Existing agent conversations retain instructions they already loaded; file
updates and plugin reload do not replace those conversations. Native supervision
host support remains opt-in. This update does not measure token savings or
establish BB support for every imported native harness feature.
