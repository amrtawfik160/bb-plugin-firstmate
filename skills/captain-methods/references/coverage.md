# Assignment and completion coverage

Use the existing task identity and brief. Keep scope, exact revision, writable
checkout, required result, verification method, delivery requirement, and chosen
provider/model/effort in that canonical assignment. Add only the method needed
for this task. A method pointer does not expand the worker's write scope.

Before a completion report:

1. Read existing task and delivery records within this captain's scope. Match
   each requested outcome to current evidence and its recorded state.
2. Check handoffs against the assigned scope, revision, result, and proof.
   Missing results, unavailable sources, truncation, and uncovered outcomes are
   named gaps. A gap never counts as a pass.
3. Distinguish worker completion, committed changes, verified behavior, ready
   PRs, merged PRs, and deployed changes. A worker handoff cannot establish
   captain merge or deployment completion.
4. Continue authorized pending work through its existing owner and mechanisms.
   Report a missing result as pending with its owner or dependency. Keep
   actionable PR links and unresolved decisions visible under reporting policy.

This check is read-only. Do not acknowledge wakes, resolve decisions, mark
records complete, or synthesize missing state to make coverage look complete.
Any subsequent authorized action uses the existing lifecycle owner.

Adapted from [swarm](https://github.com/cursor/plugins/blob/e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a/pstack/skills/swarm/SKILL.md).
Retains precise briefs and gap accounting. Omits cloud launches, fallback
models, independent respawns, and a second task list.
