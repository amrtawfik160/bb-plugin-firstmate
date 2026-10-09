# Verify a changed journey; maintain a verification skill only when assigned

Use the project's existing verification skill and explicit visual references
for a changed user journey. This method describes future project work; loading
it does not authorize editing an app or generating a skill during an unrelated
assignment.

1. For a changed journey, read the relevant existing verification procedure and
   exercise that journey. This does not assign full skill maintenance.
   Only when explicitly assigned maintenance, maintain its skill and feature
   map. Create a skill only when none exists and creation is assigned. If several targets are ambiguous, ask the
   captain which one owns this surface. Do not assume a Cursor directory.
2. Inspect launch, readiness, authentication, driver, evidence, and cleanup
   procedures against source. Use the project's harness first. A maintenance
   assignment edits only the verification skill, map, and owned harness; report
   product regressions instead of changing product code or hiding them in docs.
3. Use the BB browser skill and browser_script or bb plugin run browser script
   for web driving. Leave profileId unset for the thread-isolated default unless the
   owner explicitly selected a shared profile. One app driver owns the session;
   workers do not launch parallel drivers. Follow BB's sign-in procedure.
4. Health-check before driving and after surprises. Exercise the changed user
   path and observe both its visible result and side effects. Respect required
   native-device proof; a mobile web preview cannot establish native behavior.
5. For maintenance, cover every mapped feature from source and live execution.
   Report unreachable prerequisites with the attempted route and label coverage
   gaps. For creation, write grounded launch, doctor, drive, evidence, cleanup,
   and feature-map instructions in the project's supported skill location.
   Run those instructions end to end on one mapped feature before declaring
   the generated procedure usable. An unexecuted procedure remains a draft.
6. Save action and result evidence outside disposable worktrees. Clean up only
   instances and scratch resources this run owns, including failed attempts.
   Verify that saved evidence survives cleanup. Return coverage, observed
   results, corrections, and remaining gaps through the assigned handoff.

Adapted from [maintain-verification-skill](https://github.com/cursor/plugins/blob/e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a/pstack/skills/maintain-verification-skill/SKILL.md)
and [create-verification-skill](https://github.com/cursor/plugins/blob/e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a/pstack/skills/create-verification-skill/SKILL.md).
Omits default reader fan-out and PR shipping; captain authority still owns both.
