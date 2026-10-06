---
name: captain-methods
description: "BB captain methods for bounded assignments, completion coverage, consequential decisions, and explicitly requested history or preference review."
user-invocable: false
---

# Captain methods

This BB-owned skill adds methods, not lifecycle policy. The native supervisor
contract, imported skills, and existing task and delivery records remain
authoritative. Do not execute raw pstack skills or load their whole corpus.

Read only the reference for the current trigger:

| Trigger | Reference |
|---|---|
| Assign work or check a handoff; before reporting completion | [Assignment and coverage](references/coverage.md) |
| A long task makes a consequential decision | [Decision trail](references/decision-trail.md) |
| Choose an investigation, design, or independent review | [Scoped methods](references/research-design-review.md) |
| Explicitly requested history, reflection, or preference review | [Requested review](references/requested-review.md) |

Firstmate owns launch, concurrency, recovery, worktree ownership, review, guarded
merge, and delivery. Preserve the exact selected provider, model, and effort.
Additional reviewers require a scoped assignment and an agreed cost or count
bound under existing authority. Do not substitute models or create another
scheduler, ledger, memory store, or shipping path.

These original BB adaptations draw on
[pstack at e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a](https://github.com/cursor/plugins/tree/e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a/pstack/skills).
References identify each source and its adaptation. Installation and routing do
not establish that a method improves model performance.
