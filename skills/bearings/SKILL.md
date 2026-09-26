---
name: bearings
description: Fleet digest from live BB crew state. Use when the user runs /bearings or asks for status, catch-up, or what's underway.
---

<!-- BB-SOURCE
     native: .agents/skills/bearings/SKILL.md
     sha: 4299683d5b656a70ced609d7d929499ddc0d675a
     snapshot: native-snapshot/4299683d/.agents/skills/bearings/SKILL.md
     fidelity: adapted
     note: Chat-response contract, the four section descriptions and the
     single-source rule are copied verbatim from native and are checked; the data
     command and the BB-only fifth section are fenced BB-ONLY, each authorised by
     an adjacent BB-DIVERGE. See CONTRIBUTING.md "Skill fidelity". -->

# bearings

Gather live fleet state with one deterministic command.
It is the single bounded, deterministic fleet-state source for Bearings.
Do not create or consult a second fleet-state reader, parser contract, status-event-tail interpretation, visible-session recap, ad-hoc project probe, or ad-hoc `gh-axi`/`gh` query.

<!-- BB-DIVERGE
     native: .agents/skills/bearings/SKILL.md § What it does
     native-quote: bin/fm-bearings-snapshot.sh --json
     bb: BB reads the `firstmate_bearings` tool (KV cache, or the real snapshot when read-through is on) instead of running the native snapshot script.
     reason: BB owns the fleet-state read in its own plane. -->
<!-- BB-ONLY: BB's fleet-state command. -->
In BB, call `firstmate_bearings` or `bb firstmate bearings` and render what it returns.
<!-- /BB-ONLY -->

## Chat-response contract

This skill is the one owner of the `/bearings` chat-response format; the snapshot and classifier own the data that feeds it, and no other file restates this contract.
Every section ALWAYS renders, even when empty, with its short empty-state sentence; never omit a section.
Every chat digest and file-mode report is a complete current snapshot, never a delta against a prior report.

1. **Captain's Call** - ONLY unsuppressed items that need the captain's own action now: a decision to make, a PR to approve or merge, a credential or login to provide, or a blocker only the captain can clear.
2. **Recently Landed** - the bounded current recent-completions baseline: merged PRs, completed scouts, and finished local-only merges across the main fleet and every registered secondmate home.
3. **Underway** - live work progressing on its own, one line of current state per direct report.
4. **Charted Next** - queued or gated work waiting on the fleet or a date, deferred or aged captain-hold safety gates, plus action-free fleet-integrity warnings.

<!-- BB-DIVERGE
     native: .agents/skills/bearings/SKILL.md § Chat-response contract
     native-quote: EXACTLY these four sections, in THIS order
     bb: BB renders a FIFTH section, "Ready to review", for crews that finished and sit idle awaiting an explicit deliver/merge (native folds review-ready into Captain's Call). The firstmate_bearings tool (lib/policy.ts) hardcodes the five, so the digest matches the tool.
     reason: a finished BB crew idles awaiting deliver, a distinct BB delivery step. NOTE — the independent review classes the fifth section as a BB DESIGN CHOICE, not an environmental force; per the captain it is to be reconciled to native's four (unless collapsing loses captain-visible information) in the PR that may touch lib/policy.ts, not this docs-only PR. This marker is retained here per the captain's instruction. -->
<!-- BB-ONLY: BB's extra section, rendered by firstmate_bearings between Recently Landed and Underway. -->
BB additionally renders a **Ready to review** section for crews that finished and sit idle awaiting `deliver`.
<!-- /BB-ONLY -->

## Read-only

During that invocation it never tears down a task, merges a PR, dispatches new work, steers a worker, answers a decision, cleans up work, or mutates backlog or task state.
