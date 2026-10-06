# Scoped research, design, and review

Use only the method needed for the scoped question. The captain allocates
independent research or review through existing Firstmate mechanisms, within
authorization and concurrency limits. Keep the exact selected provider, model,
and effort. State scope, revision, required result, proof, and cost or count
bound before assigning reviewers. Do not add default reviewers or fallback models.
A worker does this work within its brief and must not delegate.

1. To explain current behavior, trace the concrete entry point through relevant
   calls, state changes, and outputs. Cite source locations and execute a small
   decisive check when needed. Stop when the scoped question has an answer.
2. To explain a design's reason, inspect the relevant history or recorded
   decision. Distinguish documented intent from inference and current behavior.
   Search additional sources only for a named evidence gap, within scope.
3. When alternatives remain unresolved, write the constraint and caller usage
   first. Compare structurally different viable choices, state ownership and
   failure behavior, and sketch the smallest useful interface. Recommend one
   using decisive evidence and its tradeoff. Revise the sketch if implementation
   disproves it; do not default to a multi-model design competition.
4. For assigned independent review, pin intent, revision or diff, relevant
   context, and the verification question. Challenge correctness, shared
   ownership, retry behavior, and user-visible outcomes. Return evidenced
   findings with severity, uncertainty, and a falsifying check. Review is
   read-only and does not authorize applying fixes or external writes.
5. The captain checks reviewer coverage and missing results, resolves evidence
   disagreements, and follows the agreed native review and validation path.
   The method cannot replace required independent review or guarded merge.

Adapted from [how](https://github.com/cursor/plugins/blob/e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a/pstack/skills/how/SKILL.md),
[why](https://github.com/cursor/plugins/blob/e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a/pstack/skills/why/SKILL.md),
[architect](https://github.com/cursor/plugins/blob/e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a/pstack/skills/architect/SKILL.md),
and [interrogate](https://github.com/cursor/plugins/blob/e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a/pstack/skills/interrogate/SKILL.md).
Omits raw Task calls, automatic fan-out, model fallbacks, and broad searches.
