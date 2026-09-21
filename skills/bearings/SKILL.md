---
name: bearings
description: Fleet digest from live BB crew state. Use when the user runs /bearings or asks for status, catch-up, or what's underway.
---

<!-- BB-SOURCE: firstmate .agents/skills/bearings/SKILL.md @ 804394e8
     Copied from native firstmate; edited only where BB forces it. Every
     divergence below is marked BB-DIVERGE. See CONTRIBUTING.md "Skill fidelity". -->

# bearings

Gather live fleet state with one deterministic command. Call `firstmate_bearings`
or `bb firstmate bearings` and render what it returns. It is the single bounded
fleet-state source for Bearings — do not create or consult a second fleet-state
reader, scrape chat, tail status events, or run an ad-hoc `gh`/`gh-axi` query to
supplement it.

<!-- BB-DIVERGE: native's source command is `bin/fm-bearings-snapshot.sh --json`;
     BB reads the `firstmate_bearings` tool (KV cache, or the real snapshot when
     read-through is on). Reason: BB owns the fleet-state read in its own plane. -->

## Chat-response contract

This skill is the one owner of the `/bearings` chat-response format. Every response
renders these sections, in THIS order, each ALWAYS rendered even when empty with
its short empty-state sentence — never omit a section. It is a complete snapshot,
never a delta.

1. **Captain's Call** — ONLY items that need the captain's own action now: a
   decision to make, a PR to approve or merge (with its full `https://...` URL), a
   credential or login to provide, or a blocker only the captain can clear. An idle
   crew with an open `needs-decision` belongs here, not in a review section.
   Empty: "Nothing needs your action right now."
2. **Recently Landed** — the bounded recent-completions baseline: merged PRs,
   completed scouts, finished local-only merges. Empty: "No recent completions."
3. **Ready to review** — crews that finished and sit idle awaiting `deliver`.
   Empty: "Nothing waiting for review."
   <!-- BB-DIVERGE: native renders EXACTLY four sections ("there is no At Anchor
        section") and folds review-ready PRs into Captain's Call. BB adds this
        fifth section because a finished BB crew thread idles awaiting an explicit
        `deliver`/merge — a distinct BB lifecycle state with no native analogue
        (native scouts are delivered and retired by the owner scripts, not left
        idle). The `firstmate_bearings` tool (lib/policy.ts) renders these five
        sections, so the skill matches the tool. Reason: BB crew delivery is an
        explicit, idle-awaiting-deliver step. -->
4. **Underway** — live work progressing on its own, one line of current state per
   direct report. Empty: "Nothing underway."
5. **Charted Next** — queued or gated work waiting on the fleet or a date, deferred
   or aged captain-hold safety gates, plus action-free fleet-integrity warnings.
   Empty: "Nothing queued."

Omit crew ids in chat unless the captain needs them to act.

## Read-only

A digest is operationally read-only. During it, never tear down a task, merge a PR,
dispatch new work, steer a worker, answer a decision, clean up work, or mutate
backlog or task state. Any board answers are acted on later under the normal
authority rules. Open the Fleet panel for the same snapshot as a board.
