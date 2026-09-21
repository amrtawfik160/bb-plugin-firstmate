---
name: afk
description: Enter away-mode supervision. Use when the user runs /afk, says they are going afk, or returning from afk.
---

<!-- BB-SOURCE: firstmate .agents/skills/afk/SKILL.md @ 804394e8
     Copied from native firstmate; edited only where BB forces it. Every
     divergence below is marked BB-DIVERGE. Re-sync and bump this SHA when native
     moves. See CONTRIBUTING.md "Skill fidelity". -->

# afk

Away mode is a POSTURE of the one supervision session, not a second architecture.
Being away changes exactly two things: how the captain is informed, and what
happens at a captain-owned decision point (hold for return, or the answer the
captain's away words already gave). It never changes the authority set.
Hold-for-return is the default and the only reach profile: there is no phone
channel, and the entry announcement says so aloud every time.

<!-- BB-DIVERGE: native writes the posture to `state/.afk-contract` via
     `bin/fm-afk-contract.sh`, presence-gated by `state/.afk`; BB records it
     through `firstmate_afk` (KV, mirrored to the durable contract when
     afkOwner=real). Reason: BB owns posture state in its own KV plane. -->

## Entering: `/afk [words]`

The captain's words are the whole mandate. They are recorded verbatim and never
parsed, tokenized, or classified — no clause fields, verbs, ids, or merge-grant
list are read out of them. Plain `/afk` with no words is a valid entry with no
mandate.

1. **Read the words back before you commit the posture.** Relay your own
   plain-sentence restatement of the words to the captain — what you read them as
   asking for, sentence by sentence, never a numbered field list — beside the
   expected return, the hold-for-return-only reach announcement (no phone
   channel), and any spend cap. Say plainly which sentence, if any, you could not
   act on while away (a red merge, a discard, anything on the never-set, local-only
   landing), so the captain can restate it or accept that it waits for their
   return. Then wait for the captain's go, so a misreading is caught before you
   commit.
   <!-- BB-DIVERGE: native runs `fm-afk-launch.sh propose` (writes the proposal +
        prints a read-back) then `confirm` on the captain's go as two script calls;
        BB's `firstmate_afk on` commits the durable contract in one call, so the
        read-back-and-wait happens in chat before that single call, not between two
        script runs. Reason: the BB tool has no separate propose step. -->
2. **Commit on the captain's go.** Call `firstmate_afk` with `action: "on"` and
   `words` set to the captain's words verbatim (or `bb firstmate afk on -- "words"`;
   pre-authorize a specific away merge with `--grant <task-id>`). Then relay the
   entry announcement in spirit: hold-for-return only, no phone channel, your
   instructions are recorded and the away session carries them out where it can,
   anything it is unsure of or that needs you waits for your return, and
   destructive, irreversible, and security-sensitive actions are never
   pre-authorizable whatever the words say. With no words, commit directly; the
   announcement says no instructions were recorded.
   <!-- BB-DIVERGE: native records a spend cap and per-task merge grants at entry
        (`--spend`, `--grant`) in the contract; BB's `firstmate_afk` tool takes
        only words. Grants are still available via `bb firstmate afk on --grant
        <id>`; no spend cap is enforced. Reason: the tool surface exposes action +
        words only. -->
3. **Keep the one supervision session running.** Keep `supervision on`. Routine
   done-pings are held for the return brief. Failures, stuck crews, credentials,
   and review-ready PRs still surface. Re-invoking `/afk` while already away with
   no new words is a refresh and leaves the standing record untouched; new words
   replace the mandate after the same read-back.

## While away

- The record exists, so the watcher never rechecks an item held for the captain;
  the return brief lists it instead. Declared external waits keep their bounded,
  condition-aware recheck cadence.
- The away session acts on the captain's words only through the guarded tools under
  standing authority, never by analogy, and holds with verdict captain on doubt.
  Any pull request green at its live head may merge under away authority; which one
  the words meant is the away session's reading, and a merge the words do not call
  for holds for the return. A red merge never proceeds while away, and local-only
  landing always waits for the captain.
- Destructive, irreversible, and security-sensitive actions are never
  pre-authorizable whatever the words say, and ask-user findings keep the
  `ask-user-authority` policy unless the words pre-answer the exact decision.

## The return

No `/back` is needed. The first genuine captain message — not starting with
`/afk`, and not a supervision escalation — is the return signal.

1. Call `firstmate_afk` `action: "off"` (or `bb firstmate afk off`) before acting
   on the message that brought the captain back.
2. Relay the return brief first, in native's order: supervisor health across the
   away window first (any gap leads), then the captain's instructions with the away
   session's account of every action it took under them, then what is waiting on
   the captain, then what was tried and failed or could not be fixed, then what was
   handled, then cost.
3. **Hold the catch-up gate: every open `blocked:` stays open until its own
   resolution is proven.** Remediate each blocker immediately through the normal
   lifecycle, or explicitly reclassify it with a durable reason and close its
   decision key (`tell --resolve-key <key>`, which writes the `resolved [key=...]`
   line). Captain-verdict outcomes listed under "waiting on you" do NOT exempt open
   blockers. Acting on the fleet — dispatching, steering, merging, or any other
   ordinary captain work — waits until every open blocker is cleared. A `/bearings`
   request may be answered while the gate is open; surface the catch-up state as a
   Charted Next warning naming what still holds it.
   <!-- BB-DIVERGE: native's `bin/fm-afk-return.sh` / `... check` enforces the
        catch-up gate as a script that ordinary fleet work must pass; BB's
        `firstmate_afk off` prints the return brief but does not block, so the mate
        holds the gate as policy. Reason: no blocking return script in the BB
        tool. -->

A message that starts `/afk` while already away refreshes the words; it does not
exit. Bias ambiguous cases toward exit: a present captain beats token savings, and
a false exit is self-correcting.

## Orthogonal to approval authority

afk changes how the captain is informed and what happens at a captain-owned
decision point, **not who approves what**. "Away" never means "approves more" or
"approves less." A PR ready for merge keeps the merge authority from the captain
contract, and a needs-decision finding keeps the `ask-user-authority` policy;
anything requiring the captain still waits for the captain's explicit word. Away
authority never releases a captain hold, and it expires when the away record is
archived. Do not merge red, `forget --force`, or treat AFK words as yolo.

<!-- BB-DIVERGE / NECESSARY-OMITTED: native's afk is ~85% daemon/harness machinery
     — the U+2063 FM_OPERATIONAL_PREFIX injection contract, the busy-guard /
     composer-state guard, the type-once/verified-submit model, the auto-discovered
     tmux/herdr supervisor pane, and the max-defer wedge alarm. None of it applies
     here: BB has no tmux/herdr pane, no composer to read, and no keystroke-
     injection plane — BB delivers steers through its own thread transport.
     Importing those mechanics would mislead a BB crew, so they are omitted rather
     than copied. Reason: no pane/composer/daemon plane in BB. -->
