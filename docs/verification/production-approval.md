# Production approval cards

Owner request, 19 October 2026: no production change before the owner answers
an approval card naming that change.

## Paths checked

- `mergeCrew`: native `pr-merge` and the environment PR path. Both require a
  named, affirmative, owner-answered approval card as well as existing proof,
  checker, ownership and repository checks. Local fast-forward merges refuse;
  they need a PR that an approval card can name.
- `shipWorkstream`: Ship may push the workstream branch and prepare its PR.
  It stops for a card before checking or merging that PR. Its release crew
  prepares publication and requests missing publication approval.
- `firstmate_fm` and `bb firstmate fm`: raw `pr-merge` and `merge-local` calls
  refuse and point to `firstmate_merge`, which performs the approval check.
- `followThrough` / `runLivePass`: read production and record observations;
  they do not publish. Release readbacks and device-proof helpers record
  evidence, not permission to publish. They cannot replace an approval card.
- Dispatch and queued work: `crewSkillBlock` puts the same fixed production
  rule in every brief, including scouts, checkers and release crews. A crew
  reports “ready to go live” with the change, destination and undo steps.
  Production commands run by a crew remain governed by its brief; arbitrary
  shell commands are not intercepted by this plugin.
- `runtimeForContext` / `firstmate_runtime` and direct operator scripts: live
  runtime selection, migration, rollback or live plugin/bot changes are subject
  to the captain approval rule; inactive installation is preparation. These
  operator tools are governed by the contract, not the PR-specific hard gate.
- Captain contract, persistent captain instructions, captain skill and
  supervision reference: define production and require an approval card
  with change, destination, undo steps, and screenshots for visible changes.

## Approval record

A card takes PRs from the structured `firstmate_ask prs` field, as
`owner/repo#N`. The plugin normalizes and deduplicates that list, displays it in
“PRs approved by this card”, and captures only those PR heads. Contextual or
rollback PR mentions in the question do not grant permission. The rendered
question and complete list must fit the card limit; the list is never truncated.

The plugin supplies fixed Approve and No buttons. It rejects other option sets
and captain-set recommendations. Authorization reads only the visible Approve
answer on the fixed card, never a captain-defined hidden value. Existing cards
without a structured-target record require a new card. Captain corrections,
plain RPC calls without a matching Telegram owner tap, unanswered cards and No
cannot grant permission. Device proof cards remain a separate proof mechanism
and cannot authorize production merges.

The newest card for this PR and captain takes precedence, so a later No cannot
be bypassed with an older approval. New author commits invalidate the card. A changed head is accepted only when
GitHub comparison data proves that its first-parent changes are merges whose
other parents are already in the PR base, including manual conflict-resolution edits
(owner decision in review round 1). Missing, divergent or truncated
ancestry refuses. The existing verification and checker gates still apply to
the current head, even when approval survives a base merge.

The native merge's inherited `gh` guard checks its final `--match-head-commit`
against the approved head. The environment path uses `gh pr merge` with the
same head binding because the BB merge API does not expose that condition.
A push during merge preparation cannot silently replace the checked head.

No new owner bypass flag was added. A verification waiver does not waive the
approval card. Read-only checks and reversible PR preparation need no card.

## Evidence

Before: `production merge without an owner approval card is refused` failed;
the fake host returned `Merged #2391 Change 2391` and reached the merge script.
After: it refuses and no merge command runs.

Before: `every dispatch brief contains one production approval rule` failed
with zero rules. After: every shape and playbook contains exactly one.

Focused coverage includes owner card creation and answer provenance, wrong PR,
wrong captain, question cards, unanswered cards, No, new author commits, proven
base merges, Ship, raw-script bypasses and native head changes at the final
forge command. All network and BB side effects in these tests use fake hosts;
local shell tests use temporary fake `gh` executables.

Transport pins were updated with the owner-authorized boundary change and its
causal regression evidence. Native source, ownership guards and ownership
classifications were preserved.

Review round 1 reproduced all four checker failures before the fix, plus the
chat and board Ship variants. The tests exercise the copied real Telegram
connector with fake Telegram and in-memory databases. They cover both visible
Approve and No through chat and board, rejected contradictory option sets,
legacy contradictory cards, and structured-only PR binding and card rendering.

The approval integration fixture uses `APPROVAL_TELEGRAM_CHECKOUT` (falling back
to `TELEGRAM_CHECKOUT` or the sibling checkout). This runs the real approval
transport independently of older optional cross-repository integration tests.
With the checker’s connector copy, the older file-delivery notification test
fails identically on head `0799293e` and this revision; it is not an approval
regression. Its evidence is preserved with the round-1 test logs.
