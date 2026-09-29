# Firstmate update — 2026-09-29

Updated the native pin from `bb69be62e1f8df465d674a35f7e2ce707b900501`
to `2d833ff147cd26a5c461e914e06854e0eb2707ce` (36 upstream commits).

## What changed upstream that the plugin mirrors

- Six verbatim skills changed and were re-synced: bootstrap-diagnostics,
  fmx-respond, firstmate-coding-guidelines, captain-hold-lifecycle,
  secondmate-provisioning, process-event-sources.
- AGENTS.md moved situational sections into seven on-demand skills, now bundled
  verbatim: agent-skill-trigger-index, away-quiet-supervision,
  operational-home-layout, scout-completion, session-start-recovery,
  ship-landing, validation-supervision.
- AGENTS.md section 9 was reformatted into bullets. The `escalation.md` anchors
  still resolve.
- The adapted `afk` skill needed no text change. The upstream edits (quiet mode
  record, "away record" wording) touch lines the BB adaptation replaces, and its
  native quotes still resolve.
- New scripts: `fm-jev-mem-guard.sh`, `fm-path-lib.sh` (plus
  `fm-jev-mem-guard.py`). Surface: 192 scripts, 22 support files, 28 skills.

## Validation

- All four overlay patches apply cleanly at the new base.
- Skill fidelity against a live native clone at the pin: 28 skills, 12
  BB-DIVERGE anchors, 7 BB-ONLY fences, snapshot fresh.
- Full suite: 556 tests, 554 pass, 0 fail, 2 skipped, both with the default
  native checkout and with `FM_TEST_HOME` set to a clone at the new pin that has
  the BB mirror installed. Without the mirror, the local-merge integration test
  fails, because that clone runs unpatched native scripts.

## Installed outcome

- `bin/fm-update.sh` fast-forwarded `/root/firstmate` and the three live captain
  homes (`thr_4e7xd2z94s`, `thr_pn4bde9b68`, `thr_yr4ppi2r3i`) to the pin. No
  secondmates needed a restart or a re-read nudge.
- Every home's BB mirror was rebuilt and passes `--verify`. Every tracked tree
  is clean.
- After the plugin reload, `bb firstmate scripts` reports 192 callable + 22
  support files installed out of 192 + 22 pinned at `2d833ff147cd`.

Running captain conversations keep the AGENTS.md text they loaded at start. The
new skills are registered with BB and load on demand.
