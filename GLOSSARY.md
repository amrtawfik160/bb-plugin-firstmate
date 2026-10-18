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

## Workstreams

**Workstream**:
A long piece of work in one project that holds many tasks, with one Telegram topic, one worktree and branch per repository, and one dev link. It ends when all its tasks are Live or Dropped.
_Avoid_: big task, epic, project (for the workstream itself)

**Ship**:
The owner's action that checks a workstream's ready code independently, merges it, and makes it live by the project's live path. The owner may Ship many times before the workstream ends.
_Avoid_: release, deploy, merge (for the owner's action)

**Dev link**:
The fixed address where the owner tries a workstream's running web app. It starts on request and stops after two hours without HTTP requests. Projects without a web app keep their device proof.
_Avoid_: preview, test link, share
