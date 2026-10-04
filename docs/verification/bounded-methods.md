# Bounded BB method composition

Implementation baseline: `9aafc9e` in the isolated launch/PR-lifecycle checkout.
Research source: pstack `e43c7ee26e0038c6c1fa8380dd34ce86ff94cb2a`, version 0.15.9.
These are original BB adaptations, not imported native skill replacements.
Source links are pinned in each reference. No installed global skill, native
home, native snapshot, or imported native skill was edited.

## Requirements and ownership

| Requirement | Added method and trigger | Boundary and evidence |
|---|---|---|
| Completion coverage and precise assignments | `captain-methods/references/coverage.md`; assignments, handoffs, before completion reports | Match every requested outcome against current task/delivery records; missing evidence is pending. Read-only check cannot synthesize state or mark completion. |
| Clear reports | `captain-methods/references/reporting.md`; existing policy requires reply | Keep required outcomes, actionable decisions, links, coverage warnings, all remaining prerequisite gates, and silence triggers. Remove unsupported benefit claims. |
| Behavioral proof and affected callers | `worker-methods/references/proof.md`; consequential/shared-state/retry/migration changes | Name invariant, failure transition, callers and writers; execute decisive proof and required causal mutation. Existing acceptance standard remains binding. |
| Maintain or create app verification | `worker-methods/references/product-verification.md`; changed journey or assigned skill upkeep | Maintain existing target first. Maintenance edits only owned verification files. One driver; thread-default browser profile; real journey, device limits, preserved evidence and owned cleanup. |
| Durable decision trail | Each role's `references/decision-trail.md`; consequential choice in long work | Verified home data path, assigned single writer; workers without path authorization return entries. No second task ledger or mandatory cross-model review. |
| Selective research/design/review | Each role's `references/research-design-review.md`; scoped question or unresolved alternatives | Trace source and reason with provenance. Captain allocates bounded reviewers under current model/concurrency authority. Worker does not delegate; review stays read-only. |
| Requested recall/reflection/preferences | `captain-methods/references/requested-review.md`; explicit review request only | Topic/project/time scope, current records first, corroborated preferences, local proposals. No automatic edits, backlog filing, messages, or hidden personal mode. |
| Preserve runtime authority | Entry skills and role configuration | Native brief owns worker; full contract owns captain. No scheduler, ledger, model fallback, replacement policy, merge/deploy path, or transport rewrite. |
| Package portability | Manifest `bb.skills: ["skills"]`, local references, package test | No runtime dependency on this host's global skill locations. Method references are self-contained per selected entry skill. |
| Instruction budget | Saturated configure test | Entire runtime base and new pointer survive the 4096-character SDK limit; memory and manifest retain separate bounded space. |

Worker completion remains a handoff. It never establishes captain merge or
deployment completion. The method check reports an uncovered obligation; it
does not repair durable records or perform lifecycle actions itself.

## Exact delta from the baseline

All existing lifecycle code, native launch renderer, overlay, imported skill
instructions and snapshots stay identical. Only these configuration changes
were added:

1. Marked captains receive `captain-methods` in their skill IDs. Ordinary threads
   still receive only `firstmate`; crew precedence still beats a captain flag.
2. The captain runtime base adds this pointer:

   > Read captain-methods at assignment, completion, and required-report triggers; load only its matching reference. Its checks read existing records and grant no new authority.

3. Crews receive only `worker-methods` from the plugin, instead of no plugin
   skills. They still receive zero captain tools or captain skills. Their
   existing instruction is followed by this exact addition:

   > Read worker-methods and only its matching reference for task proof, app verification, consequential decisions, or assigned research/design/review. Do not delegate or change the selected provider, model, or effort. Worker completion is a handoff, not captain merge or deployment completion.

4. Calm and catch-up add package-local wording-editor pointers. Their reporting,
   silence, evidence, coverage, and read-only obligations remain intact.
5. Two role entry files and their references contain the added procedures. For
   any evaluation, record their exact bytes and the reference actually loaded.
   Do not describe the treatment as an unspecified “pstack enabled” condition.

Captain and worker decision-trail text is identical. Their research procedure
steps are identical, with distinct role authority paragraphs. A deterministic
package test checks this equality so duplicates do not drift silently.

## Local executable checks

`server.methods.test.mjs` runs the actual plugin factory/configure callback
through the official SDK harness. It checks ordinary, captain, resumed captain,
worker, and conflicting-role cases before and after a fresh harness reload.
Configuration invokes no SDK calls or task-state mutation. Saturated optional
caches cannot truncate the existing base or the new method pointer. The test
also resolves the new reference graph within the declared skills package and
rejects global host paths and cross-role method-reference dependencies.

`scripts/method-routing-mutation.mjs` changes one real routing/pointer branch
at a time and restores the source bytes. The configuration/budget tests reject:

1. Removing the worker helper route.
2. Exposing the captain helper to workers.
3. Removing the captain helper route.
4. Removing the captain completion/report pointer.

These checks certify deterministic configuration and packaging properties.
They do not certify model instruction adherence, improved model performance,
live native launch, browser driving, or a deployed plugin. A live parent-owned
acceptance must inspect a fresh real captain and worker, verify their selected
skills and unchanged execution identity, and check the real launch path without
fallback. CONTRIBUTING's real-script requirement remains unchanged.

## Proposed empirical fixtures, separately by helper

No results are claimed in this plan. For each comparison, hold model, provider,
effort, tools, task input, revision, host and all other instructions constant.
Save the baseline instructions and exact added reference bytes. Record actual
loaded files and input/output tokens; source word count is not a token estimate.
Any synthetic current-versus-helper pilot is an instruction-adherence smoke
check only. It cannot establish performance gains, reliability, or live runtime
acceptance. Ten comparable authorized live tasks, if observed later, are future
evaluation work and not completed work claimed by this implementation.

| Helper | Fixture inputs | Required evidence and failure signals |
|---|---|---|
| Completion coverage | Ready PR whose delivery requires merge; interrupted task with a missing worker result | Required outcomes each have evidence or pending state; PR link retained; no missing result passes; no reads cause acknowledgements or state changes. |
| Report editor | Long due escalation with actionable decisions and links; routine wake whose policy requires silence | Draft preserves decisions, units, limits and links after editing; silence remains silent; no unsupported improvement claim or skipped review/merge/activation gate. |
| Proof selection | Retry after partial publication; reload during migration | Invariant and falsifying failure transition named; test really observes duplicate effects or preserved rows; unsupported suite-only completion fails. Runtime storage correctness is measured separately. |
| Product verification | Existing verification map with a changed journey; absent skill requiring grounded creation | Existing target maintained, no product edits in maintenance; one driver; default profile; executed feature and cleanup evidence; mobile preview labeled insufficient for device claims. |
| Decision trail | Long task rejects an approach; worker lacks permission to write the home data path | Consequential choice has reason, resolving evidence and observed result; artifact survives worktree cleanup; worker returns entries instead of unauthorized writes; no task-ledger claims. |
| Scoped research/design/review | Ambiguous ownership design with two alternatives; bounded read-only review | Traced behavior and intent separated; viable choices and recommendation; exact revision, findings, uncertainty and gap accounting; no worker fan-out or model substitution. |
| Requested history/reflection/preferences | Explicit scoped recall with stale history; repeated correction review; ordinary wake as near-miss | Current durable state wins; provenance and time/project limits; existing preference corrections proposed from corroborated evidence; no unrelated transcript search or automatic external/local write. |
| Assignment discipline | Exact revision proof assignment with missing returned revision; exhausted authorized reviewer budget | Required evidence gap reported; reviewer count/model boundaries retained; no fallback model or independent respawn. |

Begin with completion coverage, report editing, and proof selection separately.
Compare missing facts, unsupported completion claims, clarification count,
time to actionable result, observed tokens per task, and unnecessary retries.
Have a reviewer blind to the variant judge clarity and completeness. The larger
research proposal uses 12 fixtures and 3 repetitions per arm, if chosen later.
Those are proposed sample counts, not collected results. Promote no helper on
word count alone; lost obligations or authorization errors fail the treatment.
