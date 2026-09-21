---
name: bearings
description: Fleet digest from live BB crew state. Use when the user runs /bearings or asks for status, catch-up, or what's underway.
---

<!-- BB-SOURCE
     native: .agents/skills/bearings/SKILL.md
     sha: 804394e8
     snapshot: native-snapshot/804394e8/.agents/skills/bearings/SKILL.md
     fidelity: adapted
     note: Chat-response contract and single-source rule copied verbatim from
     native; the data command and the section list are BB-specific and fenced
     BB-ONLY, with every departure marked BB-DIVERGE. See CONTRIBUTING.md
     "Skill fidelity". -->

# bearings

<!-- BB-ONLY: BB reads fleet state through its own tool rather than the native
     snapshot script; the command differs but the single-source rule below does not. -->
Gather live fleet state with one deterministic command: call `firstmate_bearings`
or `bb firstmate bearings` and render what it returns.
<!-- /BB-ONLY -->
<!-- BB-DIVERGE
     native: .agents/skills/bearings/SKILL.md § What it does
     native-quote: bin/fm-bearings-snapshot.sh --json
     bb: BB reads the `firstmate_bearings` tool (KV cache, or the real snapshot when read-through is on).
     reason: BB owns the fleet-state read in its own plane. -->

It is the single bounded, deterministic fleet-state source for Bearings.
Do not create or consult a second fleet-state reader, parser contract, status-event-tail interpretation, visible-session recap, ad-hoc project probe, or ad-hoc `gh-axi`/`gh` query.

## Chat-response contract

This skill is the one owner of the `/bearings` chat-response format; the snapshot and classifier own the data that feeds it, and no other file restates this contract.
Every section ALWAYS renders, even when empty, with its short empty-state sentence; never omit a section.
Every chat digest and file-mode report is a complete current snapshot, never a delta against a prior report.

<!-- BB-DIVERGE
     native: .agents/skills/bearings/SKILL.md § Chat-response contract
     native-quote: EXACTLY these four sections, in THIS order
     bb: BB renders FIVE sections — it adds "Ready to review" for crews that finished and idle awaiting an explicit deliver/merge (native folds review-ready into Captain's Call). The firstmate_bearings tool (lib/policy.ts) hardcodes these five, so the skill matches the tool.
     reason: a finished BB crew idles awaiting deliver, a distinct BB delivery step. NOTE — the independent review classes the fifth section as a BB DESIGN CHOICE, not an environmental force; per the captain it is to be reconciled to native's four (unless collapsing loses captain-visible information) in the PR that may touch lib/policy.ts, not this docs-only PR. This marker is retained here per the captain's instruction. -->
<!-- BB-ONLY: the five sections the firstmate_bearings tool (lib/policy.ts) renders, in tool order. -->
1. **Captain's Call** — items that need the captain's own action now: a decision to
   make, a PR to approve or merge (with its full `https://...` URL), a credential or
   login to provide, or a blocker only the captain can clear. An idle crew with an
   open `needs-decision` belongs here, not in a review section.
   Empty: "Nothing needs your action right now."
2. **Recently Landed** — merged PRs, completed scouts, finished local-only merges.
   Empty: "No recent completions."
3. **Ready to review** — crews that finished and sit idle awaiting `deliver`.
   Empty: "Nothing waiting for review."
4. **Underway** — live work progressing on its own, one line per direct report.
   Empty: "Nothing underway."
5. **Charted Next** — queued or gated work waiting on the fleet or a date, deferred
   or aged captain-hold safety gates, plus action-free fleet-integrity warnings.
   Empty: "Nothing queued."
<!-- /BB-ONLY -->

<!-- BB-ONLY: BB surfaces crew ids in the digest; keep them out of chat unless needed. -->
Omit crew ids in chat unless the captain needs them to act.
<!-- /BB-ONLY -->

## Read-only

During that invocation it never tears down a task, merges a PR, dispatches new work, steers a worker, answers a decision, cleans up work, or mutates backlog or task state.
