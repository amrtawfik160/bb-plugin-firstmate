# Firstmate: the life of a piece of work

How the owner's requests become work, and when that work counts as finished.

## Work

**Task**:
One piece of work the owner asked for, from his request to its finish; every task is a record, never only something the captain remembers.
_Avoid_: job, request (for the whole piece of work)

**Spec**:
A long request from the owner that is split into tickets before any work starts; it is one task.
_Avoid_: plan, program (for the owner's document)

**Ticket**:
One part of a spec that can be merged and made live on its own; the owner confirms the list of tickets.
_Avoid_: subtask, item, issue

**Stall**:
A task or ticket that is not finished and has had no next step for more than 24 hours.
_Avoid_: stuck, forgotten, blocked

## States

**Merged**:
The work's code is in the project's main branch; this is not finished.
_Avoid_: done, shipped, landed

**Live**:
The work runs in production and was checked there, by the project's own way of going live.
_Avoid_: deployed, released, shipped

**Dropped**:
The owner stopped the work, in his own words.
_Avoid_: cancelled, abandoned, closed

**Finished**:
Live or dropped; nothing else counts.
_Avoid_: done, complete, closed
