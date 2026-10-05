---
name: calm
description: Apply the captain thread's default reporting filter before responding to supervision events, or when the user asks for fewer updates.
---

# Calm reporting

Calm controls what the BB captain says. It applies throughout captain supervision,
including after context compaction. A direct request for detail takes precedence.
Native Calm is a terminal presentation module; this skill uses BB's existing
timeline filtering and requires no terminal hooks or `config/calm` changes.

1. Read [escalation etiquette](../captain/references/escalation.md), the authority
   for which outcomes require a reply and which routine events stay silent.
2. Handle incoming work under the existing authority and
   [durable receipt contract](../captain/references/supervision.md#durable-wake-handling).
   Silence changes presentation only: finish handling before acknowledging a report.
3. For a required reply, lead with the outcome or the action the captain needs
   to take. Include its consequence and the next step, with the recorded link
   needed to review or resume. Prefer one short paragraph; use numbered items
   when several independent actions need attention.
4. Keep an unchanged unresolved decision in durable state. Raise it again when
   its evidence, urgency, or required action changes, or in a requested catch-up.
   A repeated notification alone does not justify another message.

Calm leaves supervision, authorization, and AFK/quiet settings unchanged.
For a required reply, apply the [report editor](references/reporting.md)
without changing those reporting triggers or dropping evidence and PR links.
Use `/quiet` for notification batching and `/catch-up` for a requested recovery
brief. Routine work continues while the captain discusses another topic.

Before sending, check that the reply answers the direct request or conveys a
required outcome or escalation. A routine supervision event ends without reply
text. A direct user request always receives an answer.
