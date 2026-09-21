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
  proves equivalence.
- **Equivalence is conditional on passing the crew's real kind.** The fold only
  matches native when the caller supplies the kind native derives from the crew's
  `state/<id>.meta` — a metaless crew is `unknown` (which does NOT terminal-collapse),
  NOT `ship`. `classifyMetaKind` (policy.ts) is that pure derivation and is itself
  differential-tested against native `_fm_status_kind`; `server.ts` `foldKind` reads
  the on-host `.meta` and feeds it to every fold call site. Do **not** hardcode a
  kind — it silently suppresses real captain decisions on metaless crews.
- **Never-inert:** without native the differential/kind cases skip, but a dedicated
  gate test **fails loudly** so a green run on a native-less CI can't masquerade as a
  verified port. Point CI at a native host, or set `FM_ALLOW_NO_NATIVE=1` to
  knowingly accept an unverified run. Force a specific copy with
  `FM_CLASSIFY_LIB=/path/to/fm-classify-lib.sh npm test`.
- New port helper, or a behaviour you "improved" over native? The contract is
  **equivalence**, not improvement — add the case to the corpus and make both
  folds agree.

**Known divergence (recorded, not fixed):** `foldOpenDecisions` strips a trailing
`\r` from each line (`policy.ts`, pre-existing), so a CRLF-terminated decision line
yields note `"q"` vs native's `read -r` `"q\r"`. It affects note *text* only — never
the open/close/collapse decision — and real host status files are LF, so on-host
impact is nil. A CRLF case is deliberately kept OUT of the differential corpus (it
would correctly fail the guard); revisit only if CRLF status files ever appear.

## Skill fidelity: copy native, mark every divergence

The skills under [`skills/`](skills/) are not independent BB rewrites of firstmate
policy — they are **native firstmate's own instructions, copied**, with edits only
where BB's environment forces them. Native
([kunchenguid/firstmate](https://github.com/kunchenguid/firstmate)) is the source
of truth for policy wording. Paraphrasing native for its own sake is how these
skills drifted to ~0% of native's text before this convention existed; copy the
wording instead.

The convention is **mechanically checkable**, not a matter of reviewer diligence:
`npm test` runs `scripts/skill-fidelity.ts`, which fails when a skill's rendered
prose differs from its pinned native source without a marker, and flags a marker
whose native anchor no longer resolves. **An unmarked difference from native is a
bug, and the check will catch it.**

### The vendored native snapshot

The pinned native source is vendored, read-only, under `native-snapshot/<sha>/…`,
mirroring native's own paths (`.agents/skills/<name>/SKILL.md`, or a named slice
such as `AGENTS.section-9.md`). This is what the check diffs against, so it runs
fully offline. It is a copy of native at the pin — never edit it by hand; re-vendor
from the native clone when you bump a pin. Native is currently at `804394e8`.

### Pin the native source per skill (`BB-SOURCE`)

Every re-derived skill carries, right after its frontmatter, a machine-parseable
`BB-SOURCE` header:

    <!-- BB-SOURCE
         native: .agents/skills/afk/SKILL.md
         sha: 804394e8
         snapshot: native-snapshot/804394e8/.agents/skills/afk/SKILL.md
         fidelity: adapted        # verbatim | adapted
         note: … -->

`fidelity: verbatim` means the rendered prose is native's own, byte-for-byte modulo
whitespace/markdown (e.g. `ask-user-authority`, `diagnostic-reasoning`).
`fidelity: adapted` means it is copied but restructured for BB, so BB-specific text
is fenced (below). Either way, **every rendered sentence outside a fence must appear
verbatim in the pinned snapshot**, or the check fails.

### Two ways to mark a divergence

**`BB-DIVERGE`** — a comment with a machine-parseable anchor to the native text it
diverges from. `native-quote` must be a contiguous phrase that resolves verbatim in
the snapshot; the check fails a quote that no longer resolves (native drift):

    <!-- BB-DIVERGE
         native: .agents/skills/afk/SKILL.md § Entering
         native-quote: Run `bin/fm-afk-launch.sh confirm`
         bb: BB's `firstmate_afk on` commits the durable contract in one call; the read-back happens in chat before that call.
         reason: the BB tool has no separate propose step. -->

**`BB-ONLY`** — a fence around BB-specific *rendered* text that has no native source
(a tool call, a BB-only section). A fence is **not** a blind trust boundary; the
checker constrains it so a rewrite cannot hide inside one:

    <!-- BB-DIVERGE
         native: .agents/skills/afk/SKILL.md § Entering
         native-quote: Run `bin/fm-afk-launch.sh confirm`
         bb: BB commits the durable contract in one tool call.
         reason: the BB tool has no separate propose step. -->
    <!-- BB-ONLY: BB commits the durable contract in one tool call. -->
    Call `firstmate_afk` with `action: "on"` …
    <!-- /BB-ONLY -->

Every fence must satisfy all of:

- **Adjacent `BB-DIVERGE` that describes the fence.** A fence must sit next to a
  `BB-DIVERGE` that names the native it replaces, and that marker's `bb:` field must
  share a BB token with the fence it authorises — so a marker cannot rubber-stamp a
  fence it does not describe. This makes the marker *load-bearing*: delete it and the
  fence fails. (Fixes the hole where a `BB-DIVERGE` was decorative.)
- **BB-anchored per sentence.** Every sentence inside the fence must carry a token
  from the BB allow-list (`firstmate_*`, `bb firstmate`, `supervision on`,
  `Ready to review`, `--grant`/`--resolve-key`/`--yes`/`--allow-red`, `/afk` … ,
  `deliver`). Free prose with no BB token cannot live in a fence — that is what
  closes the "wrap a rewrite in a fence" hole.
- **No native-derived content.** A sentence that resolves verbatim in native may not
  be fenced; un-fence it so it is actually checked.
- **Bounded per fence AND per skill.** At most six sentences per fence, and at most
  ten fenced sentences per skill total — so the per-fence cap cannot be dodged by
  minting many small fences. Each authorising marker's `native-quote` must also be
  distinct, so a valid anchor cannot be cloned to mint fences. The reason must be
  non-empty and of real length. A fence cannot grow into a parallel skill.

The reason must be a real environmental constraint (no tmux pane, no composer to
read, BB threads not windows, no blocking stop hook, a tool that folds two native
steps into one, the KV cache plane, etc.). "Shorter" or "reads better" is not a
reason — copy native's wording instead.

**What the check can and cannot catch (be honest).** It catches every *unmarked*
divergence, every *unfenced* non-native sentence, an anchor that stops resolving,
native content smuggled into a fence, any fenced sentence with no BB token, a fence
whose marker does not describe it, and fence-count/size inflation (per fence, per
skill, and anchor reuse) — so the "wrap the rewrite in a fence", "delete the
marker", and "mint many small fences" escapes all fail. It does **not** semantically
judge prose: a fabricated claim welded into a single sentence that also references a
real BB tool (or the same lie split across token-bearing clauses) carries a token
and passes the vocabulary gate. That residue is a human-review responsibility —
widening the token rules to chase it would only produce false failures. The check
makes casual and fenced drift fail loudly and shrinks the reviewer's job to reading
a few labelled, bounded fences and judging whether each reason is true; it does not
catch every conceivable adversarial sentence.

Do **not** import native instructions that would mislead a BB crew (tmux/herdr pane
mechanics, keystroke injection, the away daemon) just to raise a fidelity number.
Mark that whole block `BB-DIVERGE` with `bb: NECESSARY-OMITTED …` and an anchor to a
representative native phrase, rather than copying dead mechanics.

Out of scope stays listed, not silently dropped: when a native section is deferred
to a later pass (e.g. stow's tiered-memory/decay/budget contract, or the captain
skill's hard-rules and intake wording), say so in the skill or PR so the remaining
gap is tracked, not forgotten.

### Running the check

- `npm test` runs the offline structural + snapshot-membership check (no native
  clone needed — it reads the vendored snapshot).
- `npm run fidelity` runs the same check standalone.
- `npm run fidelity -- --native /path/to/firstmate` additionally proves the vendored
  snapshot still matches a live native clone at the pinned SHA, so a stale snapshot
  (and every anchor resting on it) fails after a native bump.

When native moves and you re-sync a skill: re-vendor its snapshot from the clone,
bump the `sha` in `BB-SOURCE`, re-anchor any `native-quote` that native reworded,
and restore/re-mark any prose that native changed — the check tells you exactly
which sentences and anchors need attention.

## Docs and ADRs

- [`CONTEXT.md`](CONTEXT.md) is the glossary — terms only, no implementation
  detail. Add a term when it first needs disambiguating; keep definitions to a
  sentence or two.
- [`docs/adr/`](docs/adr/) records hard-to-reverse, surprising decisions with a
  real trade-off. Do not add an ADR for the obvious choice; do add one when a
  future reader would otherwise "fix" something that was deliberate. Use the
  format already in that directory.
