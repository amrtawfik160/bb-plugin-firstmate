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
First call `firstmate_deck` or, on ACP/CLI, `bb firstmate deck --json` whose response binds this BB thread and gives the exact native home and agent-shell startup command, with readiness pending.
Then read `firstmate_contract` without a section or `bb firstmate contract` to obtain the complete upstream supervisor contract, verbatim.
Read [calm](../calm/SKILL.md) for default /captain reporting.
If the native startup digest is absent, execute the command returned by `firstmate_deck` once through this agent's shell, using `firstmate_fm script=session-start` or `bb firstmate fm session-start --json` to retrieve the same bound command if needed.
For `firstmate_dispatch`, a failed prerequisite, native lock refusal or truncated startup remains unresolved under the native contract, so report its named failure before retry and obtain a complete successful digest before orchestrating.
After successful native startup use [the BB harness reference](../harness-adapters/references/harness/bb.md) for `firstmate_watch`, script paths, thread operations and optional `bb firstmate session` rather than searching plugin internals.
<!-- /BB-ONLY -->
