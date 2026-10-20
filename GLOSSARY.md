# Firstmate: the life of a piece of work

How the owner's requests become work, and when that work counts as finished.

## Work

**Owner**:
The person who gives Firstmate work and approves what goes live; the owner calls themself the captain.
_Avoid_: user, captain (for the AI)

**Firstmate**:
The AI that takes the owner's messages, starts and steers crews, and reports back.
_Avoid_: captain, bot, assistant

**Task**:
One piece of work the owner asked for, from his request to its finish; every task is a record, never only something Firstmate remembers.
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

**Model rule**:
One line of the home's model-choice file (`config/fm-model-rules.json`): a kind of task and the models for it, strongest first. When the owner names no model, Firstmate picks the rule; quota and the provider catalog pick the model from it.
_Avoid_: routing rule, dispatch profile

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
A long piece of work in one project that holds many tasks, with one Telegram topic. Create provisions one workstream branch per repository and one dev link. Each task in it gets its own new crew and its own worktree, cut from the workstream branch; many tasks run at once. Adopt brings existing open tasks into a new workstream with a new topic, once the owner approves one card that lists them: idle crews' saved work folds at once, and running crews fold when they finish. It ends when all its tasks are Live or Dropped.
_Avoid_: big task, epic, project (for the workstream itself)

**Workstream branch**:
The one branch per repository that collects a workstream's finished tasks; the dev link runs it and Ship merges it.
_Avoid_: feature branch, integration branch

**Fold**:
A finished task's work joining the workstream branch, after the crew's own tests pass; its worktree is then removed. Folded is not merged: only Ship merges.
_Avoid_: merge back, land, integrate

**Follow-up**:
An owner message in a workstream topic that changes a task still being worked on, instead of starting a new task; Firstmate decides which it is, and a direct reply to a crew's message is always a follow-up.
_Avoid_: steer, amendment

**Ship**:
The owner's action that checks a workstream's ready code independently, merges it, and makes it live by the project's live path. The owner may Ship many times before the workstream ends.
_Avoid_: release, deploy, merge (for the owner's action)

**Dev link**:
The fixed address where the owner tries a workstream's running web app. It starts on request and stops after two hours without HTTP requests. Projects without a web app keep their device proof.
_Avoid_: preview, test link, share
