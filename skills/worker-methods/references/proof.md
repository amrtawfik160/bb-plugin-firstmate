# Behavioral proof and affected callers

1. Name the user-visible behavior and invariant affected by this change.
   Trace callers, readers, writers, persistence, and failure transitions within
   scope before changing shared behavior. Identify what could break elsewhere.
2. Choose the cheapest decisive executable check that could disprove the claim.
   For retries or migrations, exercise the failure, partial result, retry, and
   reload transitions that matter. Check duplicate effects and preserved state.
   A passing general suite does not establish an untested transition.
3. Execute the real path required by the project's acceptance standard. Capture
   observed results and evidence, including positive-path and absent-fallback
   signatures where required. Mocks and code reading cannot replace mandatory
   real-script, live-app, or device proof.
4. Follow the repository's actual verification requirements. When it requires
   causal mutation, show that reverting the fix makes the decisive check fail,
   then restore and recheck. Otherwise use scoped behavioral proof; do not
   invent a mandatory pipeline or mutation check without a project requirement.
   Report uncovered transitions and unavailable proof instead of claiming pass.

For repeated failed fixes, write the premise and enumerate relevant actors and
writers before another patch. Test a counterfactual; an even actor count alone
cannot disprove a premise. Separate independent facts when the domain permits,
but serialize canonical shared objects structurally. Instructions are not
concurrency control. Preserve Firstmate's canonical records and ownership.

Prefer types, durable identity, transactions, and runtime checks over repeated
warnings for critical invariants. Do not delete native authority or trigger
instructions after adding enforcement. For measurements, report the unit,
sample definition, run count, spread, and actual measured result.

Adapted from [prove-it-works](https://github.com/cursor/plugins/blob/e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a/pstack/skills/principle-prove-it-works/SKILL.md),
[blast-radius](https://github.com/cursor/plugins/blob/e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a/pstack/skills/blast-radius/SKILL.md),
[idempotence](https://github.com/cursor/plugins/blob/e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a/pstack/skills/principle-make-operations-idempotent/SKILL.md),
[premise testing](https://github.com/cursor/plugins/blob/e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a/pstack/skills/principle-attack-the-premise/SKILL.md),
[independent writers](https://github.com/cursor/plugins/blob/e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a/pstack/skills/principle-separate-before-serializing-shared-state/SKILL.md),
[structural enforcement](https://github.com/cursor/plugins/blob/e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a/pstack/skills/principle-encode-lessons-in-structure/SKILL.md),
and [measurement](https://github.com/cursor/plugins/blob/e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a/pstack/skills/principle-explain-the-number/SKILL.md).
