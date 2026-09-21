# Contributing to bb-plugin-firstmate

This plugin maps the [firstmate](https://github.com/kunchenguid/firstmate)
captain/crew protocol onto BB primitives. The native scripts own policy; the
plugin owns transport and BB surfaces (see [docs/adr/](docs/adr/) and
[CONTEXT.md](CONTEXT.md)).

Do the normal things: keep the diff small, run `tsc` and `npm test` before you
open a PR, follow the surrounding code's idiom. The rest of this file is the one
part that is not optional.

## The verification standard

This standard exists because it had to. Fourteen PRs shipped native ownership of
dispatch / backlog / decisions / afk / quiet / memory / notify / supervision for
BB's `/captain`. The defining failure: the work **passed roughly seven review
rounds while doing nothing**. Reviews asserted the *shape* of the code —
"the function exists", "the flag is wired", "the teardown is called" — instead of
asserting that **the real path was taken at runtime**. The features were inert or
broken the entire time. It surfaced only when failures were made loud and the
captain ran an acceptance dispatch by hand.

Every one of the rules below is a direct scar. Follow them for any change that
claims a behaviour.

### 1. A behaviour claim needs a LIVE proof that executes the real scripts

If your PR claims "real transport spawns a crew", "the keeper re-arms the
watcher", "the wake plane is partitioned per captain" — anything about what
happens at runtime — you must prove it by running the **real native scripts**
end to end against a live host, not a stub or a mock.

Stub mocks are what produced the seven false passes. A mock returns whatever the
test author expected; it cannot tell you the real `fm-spawn.sh` refuses your
brief. The live proofs in [`scripts/`](scripts/) are the model:

- [`scripts/live-brief-intent-check.mjs`](scripts/live-brief-intent-check.mjs) —
  runs the **real** `fm-brief.sh` + `fm-spawn.sh` (`--backend bb --harness bb`)
  under a scratch `FM_HOME`, spawns and tears down real `bb` threads, and imports
  the **actual** `normalizeCaptainIntent` from `server.ts` (not a copy).
- [`scripts/live-host-transport-check.mjs`](scripts/live-host-transport-check.mjs)
  — mirrors `writeHostBytes` against the actual BB terminal transport and proves
  byte-exactness with `sha256sum` **on the host**.

These are deliberately **not** in `npm test` (they need `bb`, a connected host,
and the real scripts). They are the acceptance gate a reviewer or the captain
runs. Unit tests cover shape and edge cases; the live proof covers reality. A
behaviour PR without a live proof is unreviewable — say so and stop.

### 2. Every fix needs a test that DIES when the fix is reverted

A test that passes both with and without your fix proves nothing about your fix.
For each fix:

1. Write the test.
2. **Revert the fix** (in isolation) and confirm the test **fails**.
3. Restore the fix and confirm it passes.

In the PR, **name which mutation killed which test**: "reverting the
`normalizeCaptainIntent` strip makes `live-brief-intent-check` case
`ship: normalized brief SPAWNS via real transport` go red (the raw label is
refused by `fm_brief_intent_address_line`)." A reviewer must be able to see the
causal link between the defect and the test, not take it on faith.

If reverting your fix leaves every test green, you have not tested the fix. You
have tested something else.

### 3. Silent fallbacks must be LOUD

The brief-intent bug hid for the **entire** effort behind an info-level
`using native dispatch` log line. Real transport never once spawned; the fallback
to native looked identical to "real mode isn't configured", so nothing looked
wrong. A fallback that fires because a feature is **broken** must not be
indistinguishable from a fallback that fires because a feature is **off**.

- A degrade that happens because the real path *failed* (a refusal, a host error,
  a missing tool) logs at **warn/error** with the concrete reason and the crew
  id — not info, never silent.
- A degrade that happens because the feature is *off by design* (flag=native,
  no fmHome) may stay quiet.
- If you cannot tell those two apart from the logs, the logging is wrong. Fix the
  logging before you claim the feature works.

### 4. Acceptance asserts the real path was TAKEN, not that code exists

"The code path is present" is the false-pass shape that cost seven rounds.
Acceptance must assert a **runtime signature that only the real path emits**, and
assert the **absence of every fallback signature**:

- GOOD: dispatch emitted `real transport spawn crew=<id> ok`, a real `bb`
  thread id exists, and **zero** `using native dispatch` /
  `real transport unavailable` lines appear.
- BAD: the function `spawnViaRealTransport` is defined / is called / is unit-tested
  with a mock.

Pick a positive signature the real path prints and a negative set of fallback
signatures that must be absent. Assert both. Existence of code is not evidence.

### 5. Known false-pass shapes seen in this codebase

Reject these on sight — each one passed review here and then failed live:

- **Code-read claims about process teardown.** "The keeper self-exits / the
  pidfile is removed, I read the code" — the teardown actually did not fire under
  the live model until it was proven on-host by killing the watcher and watching a
  fresh keeper re-arm within the interval. Read-the-code is not proof of teardown.
- **Code-read claims about relay/wake scoping.** "Wake rows are scoped per
  captain, I read the `FM_STATE_OVERRIDE` wiring" — live, the raw pasted
  `fm-wake-drain.sh` carried no per-captain override and consumed **another
  captain's** rows. Scoping must be proven live (captain A never sees/consumes
  B's rows), not inferred from the wiring.
- **"Defaults inert" claims.** "This is safe because the flag defaults to off" —
  true, and useless: the flag was 100% broken *when enabled*. A feature being
  harmless while disabled says nothing about whether it works when turned on.
  "Off by default" is never a substitute for "proven on".

## Differential drift guard (ports of native shell logic)

`lib/policy.ts` hand-ports pieces of `fm-classify-lib.sh` (notably
`foldOpenDecisions` ← `status_open_decisions`). A hand port drifts **silently**:
the TS keeps compiling and the unit tests keep passing while the plugin quietly
disagrees with the real watcher/bearings. Once already shipped: the fold omitted
native's ship/scout terminal-collapse, so a retired crew surfaced a *phantom*
open decision (false NEEDS-DECISION, hidden ready crew) — and a unit test pinned
the wrong answer.

The defence is a **differential test**, not more unit tests:
`lib/policy.differential.test.ts` runs our fold and the **real** shell
`status_open_decisions` over one crafted `.status` corpus and fails on any
divergence, across every task kind (ship/scout collapse, secondmate/unknown do
not). Extend the corpus whenever you touch the fold or find a new native edge.

- It drives the script at `FM_CLASSIFY_LIB` (default
  `/root/firstmate/bin/fm-classify-lib.sh`). On a host **with** native it runs and
  proves equivalence; **without** native it **skips** (never a false green).
- It is part of `npm test`. To force it against a specific native copy:
  `FM_CLASSIFY_LIB=/path/to/fm-classify-lib.sh npm test`.
- New port helper, or a behaviour you "improved" over native? The contract is
  **equivalence**, not improvement — add the case to the corpus and make both
  folds agree.

## Docs and ADRs

- [`CONTEXT.md`](CONTEXT.md) is the glossary — terms only, no implementation
  detail. Add a term when it first needs disambiguating; keep definitions to a
  sentence or two.
- [`docs/adr/`](docs/adr/) records hard-to-reverse, surprising decisions with a
  real trade-off. Do not add an ADR for the obvious choice; do add one when a
  future reader would otherwise "fix" something that was deliberate. Use the
  format already in that directory.
