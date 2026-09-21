---
name: afk
description: Enter away-mode supervision. Use when the user runs /afk, says they are going afk, or returning from afk.
---

<!-- BB-SOURCE
     native: .agents/skills/afk/SKILL.md
     sha: 804394e8
     snapshot: native-snapshot/804394e8/.agents/skills/afk/SKILL.md
     fidelity: adapted
     note: Away-posture policy copied verbatim from native firstmate. BB tool
     calls that replace native's scripts are fenced BB-ONLY, and every departure
     is marked BB-DIVERGE. Native's ~85% daemon/tmux/composer machinery is
     omitted (see the NECESSARY-OMITTED marker at the end). See CONTRIBUTING.md
     "Skill fidelity". -->

# afk

Away mode is a POSTURE of the one supervision session, not a second architecture.
Being away changes exactly two things: how the captain is informed, and what happens at a captain-owned decision point (hold for return, or the answer the captain's away words already gave).
It never changes the authority set.
Hold-for-return is the default and the only reach profile this release records: there is no phone channel, and the entry announcement says so aloud every time.

<!-- BB-DIVERGE
     native: .agents/skills/afk/SKILL.md
     native-quote: written only by `bin/fm-afk-contract.sh`
     bb: BB records the posture through `firstmate_afk` (KV, mirrored to the durable `state/.afk-contract` when afkOwner=real).
     reason: BB owns posture state in its own KV plane. -->

## Entering: `/afk [words]`

Plain `/afk` with no words is a valid entry with no mandate.

### Read the words back, then wait for the captain's go

Then relay your own plain-sentence restatement of the words to the captain in `AGENTS.md` section 9 language - what you read them as asking for, sentence by sentence, never a numbered field list - beside the expected return, the spend cap, and the one-sentence reach announcement, so the captain can catch a misreading before saying go.
Say plainly which sentence, if any, you could not act on while away (a red merge, a discard, anything on the never-set, local-only landing), so the captain can restate it or accept that it waits for their return.

<!-- BB-DIVERGE
     native: .agents/skills/afk/SKILL.md § Entering
     native-quote: beside the expected return, the spend cap, and the one-sentence reach announcement
     bb: relay the spend cap in the read-back, but BB's `firstmate_afk` tool takes only `words`; per-task merge grants are available via `bb firstmate afk on --grant <id>` and no spend cap is enforced by the tool.
     reason: the BB tool surface exposes action + words only. -->

### On the captain's go, commit the posture

<!-- BB-ONLY: BB commits the durable contract in one tool call. -->
Call `firstmate_afk` with `action: "on"` and `words` set to the captain's words verbatim (or `bb firstmate afk on -- "words"`, pre-authorizing a specific away merge with `--grant <task-id>`), or commit directly when there are no words.
<!-- /BB-ONLY -->
<!-- BB-DIVERGE
     native: .agents/skills/afk/SKILL.md § Entering
     native-quote: Run `bin/fm-afk-launch.sh confirm`
     bb: native runs `fm-afk-launch.sh propose` (writes the proposal + read-back) then `confirm` on the go as two script calls; BB's `firstmate_afk on` commits the durable contract in one call, so the read-back-and-wait happens in chat before that single call.
     reason: the BB tool has no separate propose step. -->

Relay that announcement verbatim in spirit: hold-for-return only, no phone channel, your instructions are recorded and the away session will carry them out where it can, anything it is unsure of, or that needs you, waits for your return, and destructive, irreversible, and security-sensitive actions are never pre-authorizable whatever the words say.
Re-invoking `/afk` while already away with no new words is a refresh and leaves the standing record untouched; new words replace the mandate after the same read-back, preserve the original session entry, and archive the superseded words for the return brief.

<!-- BB-DIVERGE
     native: .agents/skills/afk/SKILL.md
     native-quote: keeps the one supervision session running
     bb: BB keeps `supervision on` and holds routine done-pings for the return brief; failures, stuck crews, credentials, and review-ready PRs still surface.
     reason: BB has one supervision session and holds pings in its own transport. -->
<!-- BB-ONLY: BB holds routine pings while supervision stays on. -->
Keep `supervision on` so routine done-pings hold for the return brief, while failures, stuck crews, credentials, and review-ready PRs still surface.
<!-- /BB-ONLY -->

## While away

The away session acts on the captain's words.
Destructive, irreversible, and security-sensitive actions are never pre-authorizable whatever the words say, and ask-user findings keep the `ask-user-authority` policy unless the words pre-answer the exact decision; anything else that needs the captain holds for their return.

## The return

No `/back` is needed. The first genuine message is the return signal:

<!-- BB-DIVERGE
     native: .agents/skills/afk/SKILL.md § How to exit: the return
     native-quote: before acting on the message that brought the captain back
     bb: BB runs `firstmate_afk off` (which prints the return brief) instead of native's `fm-afk-return.sh`.
     reason: BB owns the return transition in its tool. -->
<!-- BB-ONLY: BB prints the return brief through the tool; act on the message after. -->
Call `firstmate_afk` `action: "off"` (or `bb firstmate afk off`) before acting on the message that brought the captain back.
<!-- /BB-ONLY -->

Relay the return brief in section 9 language and in its own order: supervisor health across the away window first (any gap leads), then the captain's instructions verbatim with the away session's account of every action it took under them, then what is waiting on the captain, then what was tried and failed or could not be fixed, then what was handled, then cost.
The gate keeps every open `blocked:` event until that blocker's own resolution is proven: remediate each immediately through the normal lifecycle, or explicitly reclassify it with a durable reason and close its decision key with `resolved [key=...]`, then run `bin/fm-afk-return.sh check`.
Captain-verdict outcomes are listed under "waiting on you", but do not exempt open blockers: per-blocker provenance is deferred with no owner, and the gate fails safe by keeping every open blocker.
A Bearings request may be answered while the gate is open, and the digest surfaces the catch-up state as a Charted Next `(return-catchup)` warning row naming what still holds it.
Acting on the fleet - dispatching, steering, merging, or any other ordinary captain work - still waits until the check exits successfully.

<!-- BB-DIVERGE
     native: .agents/skills/afk/SKILL.md § How to exit: the return
     native-quote: then run `bin/fm-afk-return.sh check`
     bb: BB has no blocking return script; `firstmate_afk off` prints the brief but does not block, so the mate holds the catch-up gate as policy and closes each key with `tell --resolve-key <key>`.
     reason: no blocking return script in the BB tool. -->

## Orthogonal to approval authority

afk changes how the captain is informed and what happens at a captain-owned decision point, **not who approves what**.
"Away" never means "approves more" or "approves less."
A PR ready for merge keeps the merge authority from `AGENTS.md` section 7, and a needs-decision finding keeps the `ask-user-authority` policy; anything requiring the captain still waits for the captain's explicit word.
Away authority never releases a captain hold, and it expires when the away record is archived.

<!-- BB-DIVERGE
     native: .agents/skills/afk/SKILL.md § The daemon, where it still runs
     native-quote: FM_OPERATIONAL_PREFIX
     bb: NECESSARY-OMITTED. Native's ~85% daemon/harness machinery — the U+2063 FM_OPERATIONAL_PREFIX injection contract, the busy-guard / composer-state guard, the type-once/verified-submit model, the auto-discovered tmux/herdr supervisor pane, and the max-defer wedge alarm — has no BB analogue. BB has no tmux/herdr pane, no composer to read, and no keystroke-injection plane; it delivers steers through its own thread transport. Importing those mechanics would mislead a BB crew, so they are omitted rather than copied.
     reason: no pane/composer/daemon plane in BB. -->
