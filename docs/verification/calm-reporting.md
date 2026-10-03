# Calm reporting verification

## Change

Captain configuration now includes `calm` and `catch-up`, with a default Calm
pointer in both session instructions and the BB runtime contract. Captain
bootstrap reads Calm. Workers and ordinary threads keep their existing skill
configuration. No notification, authorization, or receipt lifecycle changed.

Calm reuses the adapted escalation policy. Catch-up is explicitly invoked,
reads existing observations, preserves open decisions, and discloses incomplete
coverage. These are BB presentation skills; upstream skill snapshots are unchanged.

## Verified on 2026-10-03

- Captain configuration tests pass for fresh and resumed captain metadata,
  worker isolation, ordinary-thread isolation, and the instruction size limit.
- Removing either the Calm registration or its default instruction in an
  isolated copy makes the new configuration test fail with an assertion.
- `npx tsc --noEmit`, `npm run fidelity`, and `bb plugin build` pass.
- `bb plugin reload firstmate` returns running with all four services running.
- Live `bb skill list` discovers both new skills. `bb skill show` returns the
  exact source bytes for each; their relative reference targets exist.
- The eight host timeout tests pass together when run as a separate group,
  both against unchanged HEAD and the edited source.
- The remaining suite completes with 559 tests passed and eight existing
  conditional skips. Together with the separate timeout group, 567 tests pass.

## Limits

The combined `npm test` run stopped progressing in host timeout tests and was
terminated. Running with `--test-skip-pattern='host timeout:'` completed in
125 seconds; the excluded group passed separately. The combined-run issue is
unresolved; these checks do not establish its cause.

Live checks verify plugin registration and skill delivery, not a model's future
wording. Existing captain sessions can invoke `/calm` immediately; new sessions
receive its default pointer during configuration.
