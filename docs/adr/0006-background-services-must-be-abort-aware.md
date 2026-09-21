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
work it awaits is abort-aware end to end:

- The `AbortSignal` is threaded into `stuckPass` and through every per-crew host/SDK
  read it makes (`crewStatus`, `crewOutput`, `crewExcerpt`, `readToolActivity`,
  `resolveHostForProject`). Reads with no native signal/timeout (`bb.sdk.threads.*`,
  `bb.sdk.environments.*`) are wrapped in `raceAbort`, which stops **awaiting** a call
  the moment the signal fires or a per-call timebox (`STUCK_HOST_CALL_MS`) elapses, so
  one slow or unreachable host cannot pin a pass.
- `stuckPass` checks the signal between crews and after each host read, and returns a
  **partial** pass promptly on abort (the next cycle re-runs). It is additionally
  bounded by a per-pass wall-clock budget (`STUCK_PASS_BUDGET_MS`) combined into the
  same `passSignal` via `AbortSignal.any`, so even absent a reload a pathological pass
  self-limits.
- Both service loops guard their interval sleep: `if (signal.aborted) break;` before
  sleeping, plus an immediate `resolve()` inside the sleep when already aborted. A
  sleep is never entered against an already-fired abort.
- `fm-watch-supervisor` gets the same treatment: `superviseFmWatch` /
  `stopFmWatchKeeper` already honoured the signal internally; the per-host loops now
  check it between hosts, and `resolveFmWatchHosts` / `resolveFmWatchHostId` /
  `relayWatchReasons` thread it through their per-crew host resolves. A wedged sibling
  service would defeat the fix as surely as a wedged `crew-watch`.

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
- Mutation-proven (per CONTRIBUTING §2): reverting the signal into `stuckPass` makes
  `ACCEPTANCE: a reload mid slow stuckPass stops crew-watch within the grace …` go red
  (the pass runs to completion, ~5.5s > grace); removing the pre-sleep guard makes the
  same test hang (the literal "did not stop"); removing the post-crewStatus /
  post-crewExcerpt / post-suppress checks makes the matching `ABORT WIRING (…)` test
  page the captain on a reload. The post-activity and between-crews checks are
  defence-in-depth (masked by `crewStatus`-first) and kept deliberately.
