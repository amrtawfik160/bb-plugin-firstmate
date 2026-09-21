# A plain `tell` steers into the crew's running turn by default

A captain corrected a crew mid-work — "the company is Straightline, not
Streetline" — while the crew was auditing with the misspelling baked into its
task. The correction never reached the crew: a plain `tell` delivered with BB
`mode:"queue-if-active"`, which only queues and is read *after* the current turn
ends. The crew finished the whole audit on the wrong premise before it ever saw
the note. The only delivery mode that reaches a running turn was `interrupt`, but
that carries hard-stop framing — a crew in this fleet answered one with
"ACK: Stopped" and abandoned its task. So a captain had **no** way to course-correct
a running crew without either waiting for the turn to end or stopping the crew.

## Decision

A plain `tell` (`firstmate_tell` / `bb firstmate tell`) now delivers with
`mode:"steer"`. `mode:"steer"` LANDS the message inside the crew's running turn and
STARTS a turn when the crew is idle (the same primitive the turn-end backstop
already relies on — see ADR 0002 and the `turn/started` evidence in
`scripts/live-tell-steer-check.mjs`). The message carries a standard prefix framing
it as a course correction, not a stop ("keep working … fold this in without tearing
down"), so a crew continues its task instead of aborting. The returned status is
honest: "Steered into crew <id>'s running turn" vs "Told crew <id> (started a
turn)", never the old "told" that merely queued.

`tell` with `queue:true` (`--queue`) is the deliberate opt-out: a genuinely
non-urgent note delivered with `queue-if-active`, read only when the crew next
drains its queue. `interrupt`/`stop` keep their own distinct hard-stop framing.

## Why default to steer (the surprising part)

Steering interrupts the crew's turn — normally something to avoid. We default to it
anyway because a captain telling a crew something almost always means "act on this
now", and the failure mode of the old default (silent misdirection for a whole turn)
is far worse than the cost of folding a correction into a live turn. A future reader
tempted to "fix" this back to `queue-if-active` for politeness would re-introduce the
exact bug: corrections that arrive too late to matter. Reach for `--queue` for the
rare non-urgent note instead.

## Consequences

- `tellCrew` takes a `queue` flag (default false = steer); the `tellOwner=real`
  inbox path and the plain BB path both honour it. The durable fire-and-forget inbox
  record under `tellOwner=real` is unchanged — a pure audit trail, not the delivery
  mechanism.
- The automated protocol-verdict nudge stays `queue:true` on purpose: it is not a
  captain's correction and must not hijack a fresh turn.
- Live proof (`scripts/live-tell-steer-check.mjs`, not in `npm test`): a steered
  correction is echoed by the crew mid-turn and the crew continues to completion in
  ONE `turn/started`; a `--queue` note reaches the crew only in a SECOND turn, after
  the first completes.
