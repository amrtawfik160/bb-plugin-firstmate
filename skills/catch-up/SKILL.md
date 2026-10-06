---
name: catch-up
description: Recover important outcomes, open decisions, blockers, current work, and next steps after a long conversation or time away.
disable-model-invocation: true
user-invocable: true
---

# Catch up

Give the captain a short recovery brief they can act on without rereading the
conversation. This is a requested snapshot, not a supervision action or an
invocation of `/bearings` and its board format.

## Gather

1. Use this captain's work by default. If the request names other projects or
   asks for all work, use that scope and label each project. Read the available
   conversation for commitments and decisions, including work outside Firstmate.
2. Call `firstmate_bearings` once for current work, completed outcomes, open
   decisions, and queued steps. Set `all: true` only for an explicit request
   covering every captain. Preserve coverage, truncation, unavailable-source,
   and deferred-decision warnings from the result.
3. Read `firstmate_crew` or a referenced report only when an important item lacks
   the evidence needed to summarize it. Current durable state wins over old
   conversation claims. Label unverified commitments and missing sources;
   a partial view cannot establish that nothing needs attention.
4. Compare against the last visible catch-up when available. Recover significant
   outcomes since then and unresolved items even if already mentioned. Without
   that baseline, label outcomes as recent recorded results; do not imply a
   complete history or claim the captain has not seen them.

Gathering ends when each reported item has a source, current state, and a next
action or named dependency. If evidence is unavailable, report that limit and
the specific verification needed instead of repeatedly querying.

## Compose

Put any material coverage limit first. Then use these labels, omitting empty
groups:

- **Needs you:** Every currently actionable decision, approval, login, or blocker
  only the captain can clear. State the consequence and recommended choice.
- **Blocked:** Other blocked work, what it awaits, and who can clear it. Keep
  deferred decisions here with their recorded condition or date.
- **Important results:** Consequential completed outcomes and changed plans.
  Preserve distinctions such as ready for review, merged, and deployed.
- **In progress:** One line per active workstream, grouped by project when useful.
  Include the next meaningful milestone; omit routine retries and tool activity.
- **Next:** Ordered steps with their owner and any prerequisite. Distinguish
  already authorized work from a proposed action that needs approval.

Use one sentence per item and recorded links where the captain can act.
Apply the [report editor](../calm/references/reporting.md) to wording
only. Preserve coverage warnings, every actionable decision, and the read-only
boundary below.
Give each decision its own numbered item. Aim for one screen; retain every
actionable decision and material blocker even if that exceeds the target.
Compress other groups first. State how many lower-priority items were omitted
only when the source provides that count, with a link to their record.

If current evidence establishes no required action, say so once. If nothing
else is recorded, answer in one sentence rather than printing empty sections.

This invocation summarizes only. Leave decisions open and preserve unread
reports: do not drain or acknowledge wakes, answer decisions, dispatch work,
merge, change quiet/AFK settings, or treat the brief as authorization. Existing
supervision continues independently. Never mark items seen or resolved merely
because they appeared in the brief.
