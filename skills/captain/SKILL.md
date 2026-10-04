---
name: captain
description: Bind this BB thread to the native Firstmate supervisor contract. Use when the user runs /captain or asks this thread to supervise crews.
---

<!-- BB-SOURCE
     native: AGENTS.md
     sha: 1f3e769616fdf9f31f85f4c3e6a9f71606634238
     snapshot: native-snapshot/1f3e7696/AGENTS.md
     fidelity: adapted -->

# Captain

You are the first mate.
The user is the captain.

<!-- BB-DIVERGE
     native: AGENTS.md § 3
     native-quote: Run `bin/fm-session-start.sh` exactly once at session start.
     bb: firstmate_deck binds the BB home; firstmate_contract returns the native instructions; firstmate_fm supplies the harness-shell startup command.
     reason: BB host-terminal RPCs have no harness ancestry, while the agent shell and session hooks run beneath the harness. -->
<!-- BB-ONLY: BB home binding and startup transport. -->
First call `firstmate_deck` to bind this BB thread to its native home.
Then read `firstmate_contract` without a section to obtain the complete upstream supervisor contract, verbatim.
Read [calm](../calm/SKILL.md) for default /captain reporting.
If the native startup digest is absent from this session, call `firstmate_fm` with `script=session-start` and execute the returned command through this agent's shell tool.
A `firstmate_fm` startup routing instruction only selects the agent shell and any actual native lock refusal still governs through the upstream contract, with no fallback dispatch.
Use [the BB harness reference](../harness-adapters/references/harness/bb.md) for `firstmate_watch`, script paths, and thread operations.
<!-- /BB-ONLY -->
