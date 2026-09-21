# Background services must be abort-aware end to end

An operator merged a PR and ran `bb plugin reload firstmate` on a shared host. The
reload failed repeatedly with `service crew-watch did not stop`; the plugin went
DEGRADED and `bb firstmate` was UNAVAILABLE to every captain on that host for ~4
minutes, recovering only after NINE reload attempts. `bb plugin reload` has no
`--force`, and `bb plugin disable`/`enable` also report "did not stop", so an
operator had no escape hatch short of restarting the BB server.

Root cause: the `crew-watch` service loop checked `signal.aborted` between cycles and
its interval sleep was abortable, but it `await stuckPass()` with **no** abort
awareness inside. `stuckPass` walks a **host-global** crew register (~50-67 crews
live) doing per-crew host round-trips; a single pass was observed at 302.5s in the
plugin handler stats — far past the shutdown grace. A pass in flight when the reload
arrived pinned the service open, so the reload could not complete.

A second, quieter wedge was latent in the same loops: once the inner work returns on
abort, the loop reaches its interval sleep with the signal **already aborted**. A
sleep whose only wake-up is `signal.addEventListener("abort", …)` can never fire that
listener (the abort event was already dispatched), so it would block for the whole
interval (up to 60 min). Fixing `stuckPass` without this would just move the wedge one
line down.

## Decision

Every long-running background service (`crew-watch`, `fm-watch-supervisor`) and the
work it awaits is abort-aware end to end — the **whole** of `stuckPass`, not just its
loop:

- **Prologue.** `listCrewsAll` (the host-wide sweep: `bb.sdk.threads.list` + up to 20
  `getPluginMetadata` + opt-in read-through) runs BEFORE the per-crew loop, so it takes
  the signal too and each of its host calls is `raceAbort`-wrapped. A reload landing in
  the prologue — reliably reproducible under a degraded BB API, which was the real
  incident's actual condition — otherwise pins `crew-watch` exactly like the loop did.
- **Per-crew reads.** The signal is threaded through every read (`crewStatus`,
  `crewOutput`, `crewExcerpt`, `readToolActivity`, `resolveHostForProject`). Reads with
  no native signal/timeout (`bb.sdk.threads.*`, `bb.sdk.environments.*`) are wrapped in
  `raceAbort`, which stops **awaiting** the moment the signal fires or a per-call
  timebox (`STUCK_HOST_CALL_MS`) elapses. `stuckPass` checks the signal between crews
  and after each read, returning a **partial** pass promptly (next cycle re-runs), and
  is bounded overall by a per-pass wall-clock budget (`STUCK_PASS_BUDGET_MS`) folded in
  via `AbortSignal.any`.
- **Captain-page sends.** The last await inside the loop is a captain notify
  (`notifyCaptain` → `enqueueCaptainWake` host write + `deliverToCaptain` send). These
  are made abort-**responsive** (no artificial timeout — a healthy send completes as
  before), and on abort `stuckPass`'s `pageOrDefer` **defers**: it leaves the crew's
  alerted/stuck state uncommitted so the next pass re-pages. The alert is never dropped;
  the send just cannot pin the loop under a degraded API.
- **The interval sleep.** Both loops guard the sleep with an immediate `resolve()` when
  the signal is already aborted. This is the ONE guard that matters (there is no
  separate pre-sleep `break` — a single guard, so its mutation is honest): `stuckPass`
  now returns early on abort, so the loop reaches its sleep with the signal already
  fired, and a sleep whose only wake-up is the abort listener can never fire it (the
  event already dispatched) — it would block for the whole interval.
- **Sibling service.** `fm-watch-supervisor` gets the same treatment: `superviseFmWatch`
  / `stopFmWatchKeeper` already honoured the signal internally; the per-host loops check
  it between hosts, and `resolveFmWatchHosts` / `resolveFmWatchHostId` /
  `relayWatchReasons` thread it through their per-crew host resolves. A wedged sibling
  would defeat the fix as surely as a wedged `crew-watch`.

### A known, accepted over-tell

`STUCK_HOST_CALL_MS` (15s) is a timebox, so a healthy-but-pathologically-slow read
returns the degraded default and `crewStatus` can page "crew gone" for a crew that is
actually fine. This is the **safe** direction (over-tell, never under-tell: a real wedge
is never silently missed) and only fires when a read is genuinely slow, but it is a NEW
false-"gone" trigger and is recorded at the constant so nobody debugs it cold.

## Fair rotation over a growing host-global register (the surprising part)

`stuckPass` inspects at most `MAX_CREWS` per pass **starting from a persisted rotation
cursor** (`watch-meta.cursor`), advancing by the number actually inspected. Below the
cap the cursor is inert and every crew is inspected every pass, exactly as before —
but the register is host-global and keeps growing, and the old code `slice(0,
MAX_CREWS)`'d the eligible list, so any crew past the cap was **never** inspected
(silent starvation). Rotation makes successive passes sweep the whole list. Pruning is
done against the full eligible set, not the inspected subset, so a crew merely not
reached this rotation keeps its stuck timer.

A future reader tempted to "simplify" — drop the `raceAbort` wrappers, delete a
between-crews / post-read abort check as redundant, remove the pre-sleep guard, or go
back to a plain `slice` — would re-introduce the exact outage. The abort checks are
belt-and-suspenders on purpose: several are individually masked by `crewStatus` being
the first read, but they document the loop's abort contract and protect against a
future edit that reorders or inserts a non-abort-aware await ahead of them.

## Operator escape hatch

From the plugin side the durable fix is the service **self-limiting** so a wedge is
impossible: bounded per-call timebox + per-pass wall budget + prompt abort return,
proven by the acceptance test (a slow pass reloaded mid-flight stops within the grace
on the first attempt, repeatedly). `bb plugin reload` lacking a `--force` (and
`disable`/`enable` also reporting "did not stop") is a **BB-side** gap — worth raising
separately so operators have a hard escape even against a future plugin that wedges.

## Consequences

- `raceAbort` / `isAbortError` (server.ts) are the shared primitive; the host-read
  helpers re-used elsewhere take an **optional** trailing `signal`, so non-supervisor
  callers are unchanged.
- Mutation-proven (per CONTRIBUTING §2), each revert → the named test goes red:
  - signal into `stuckPass` ⇒ `ACCEPTANCE: a reload mid slow stuckPass …` (pass runs to
    completion, ~5.5s > grace).
  - the single sleep guard ⇒ same `ACCEPTANCE` (the reload never stops; `awaitWithin`
    fails at the grace — run with `--test-force-exit`, since the wedged loop otherwise
    keeps the process alive: that inability to exit IS the "did not stop" wedge).
  - signal into `listCrewsAll` ⇒ `ACCEPTANCE (prologue): a reload while listCrewsAll is
    in flight …`.
  - signal into the notify send (`pageOrDefer`) ⇒ `ABORT WIRING (notify): … stops within
    grace and DEFERS the page`.
  - the post-`crewStatus` / post-`crewExcerpt` / post-`suppress` checks ⇒ the matching
    `ABORT WIRING (…)` test pages the captain on a reload.
  - The post-activity and between-crews checks are defence-in-depth (masked by
    `crewStatus` being the first read) and kept deliberately — not claimed as
    independently tested.
