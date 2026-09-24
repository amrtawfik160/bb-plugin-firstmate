# Supervision + modes

Read when crews are running, stepping away, catching up, or closing out.

## Live supervision

- With crews running, call `firstmate_watch` once per crew batch to hand supervision to private event-driven durable wakes, then end the turn and never retry or poll.
- The `bb firstmate watch` CLI remains blocking via BB `threads.wait` for operator use; `supervision on` keeps thread idle/fail events + stuck checker active.
- `bearings` = instant status.
  Prefer events and the `firstmate_watch` handoff over polling loops; never report unchanged fleets as news.
- Status lines are events, not truth: `crew`/`deliver` for current state
  before re-escalating anything old.

## Stuck ladder

1. Peek: `crew <id>` + `deliver <id>`. Unacked steer? Question the brief
   already answers?
2. One-line `tell` answering/redirecting.
3. Genuinely wedged (looping, unresponsive, repeating one obstacle) → `stop`,
   dispatch a replacement crew with brief + progress note in the same
   workspace. Never split one task across two copies.
4. Second failure → report failed with preserved work + consequence. Done.

Relaunch keeps the crew's provider and model unless the captain names
another. A credential or production-access blocker is one batched captain
ask, never a relaunch. Waiting is silent: no-change updates, elapsed time, and
pending reviews are not captain-facing progress.

Low context is not wedging (harnesses compact and continue). A worker
claiming infra dead is a guess until you verify the run/branch yourself.

## Bearings (5-section digest)

`bearings` renders it from live data — durable decisions (`decide ask`),
landings (auto-recorded on `forget`/`merge`), crews, queue (`queue add`):

1. **Captain's Call** — only items needing captain action now: due decision,
   PR to approve/merge (full `https://...` URL, never bare `#n`), credential,
   captain-only blocker.
2. **Recently Landed** — merged PRs, completed scouts, finished landings.
3. **Ready to review** — idle crews awaiting `deliver`.
4. **Underway** — live work, one line of current state each.
5. **Charted Next** — queued/gated work with blocker or date + deferred decisions.

Every section always renders (short empty-state if none). Complete snapshot,
never delta. Scout/crewmate ids stay out of chat unless captain needs them
to act. Read-only: never dispatch/steer/merge/forget during a digest.

## Ahoy

Session-only recap, no fresh gathering: what happened since the last real
captain message (outcomes, landings, failures, decisions made/needed),
then open decisions from the whole visible session, guided one at a time
in mate-judged impact order with context + options + recommendation.
No prior captain message → full `bearings` instead. After compaction,
report only visibly supported events; state uncertainty plainly.

## AFK / quiet

- `/afk [words]`: `supervision on`. Routine done-pings held for return.
  Failures, stuck crews, credentials, and review-ready PRs still surface.
  Words recorded as mandate notes, never executed as authority.
  No authority expands: merges still need yolo-or-word, red stays refused.
  First genuine message = return → `bearings` return brief first (health,
  waiting-on-you, tried-and-failed, handled), then act on the message.
- `/quiet`: same batching while present and chatting. Only `/quiet off`
  exits. Presentation only — decisions, failures, review-ready work, and
  credentials always surface immediately.

## Stow (close-out sweep)

Before reset/compaction or on `/stow`:

1. Sweep the session for durable knowledge existing only in chat.
2. File it: project knowledge → `queue add` follow-up or project record;
   captain prefs → `memory set-captain` (inspect-then-update);
   fleet facts → `memory add-learning` (dated, evidence-backed, prune rot
   with `drop-learning`).
3. Correct wrong records, answer/deflect open decisions, `forget --stop`
   retired crews, file follow-ups via `queue add`.
4. Leave a compact map: landed / underway / open decisions / learnings.

Omit trivia and anything already owned elsewhere. Rewrite and prune rather
than appending forever.

## Protocol nudge

`thread.idle` on a registered crew whose last reply has no `DONE:` / `BLOCKED:` /
`FAILED:` line (start of the reply, or a standalone line) doorbells that crew
to re-state the verdict. Non-crew threads are left alone. A stopping thread or
a manual/host interrupt is not nudged. Defaults, no config required:
`nudgeEnabled` on, `nudgeMaxPerCrew` 3, `nudgeCooldownSeconds` 60. Past the
cap the captain gets one `NEEDS DECISION`. Afk/quiet still nudges the crew and
holds that captain ping the same way a done-ping is held.
