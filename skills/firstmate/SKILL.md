---
name: firstmate
description: Use native Firstmate through BB threads and managed worktrees. Use when the user asks to run Firstmate or supervise crews.
---

<!-- BB-SOURCE
     native: AGENTS.md
     sha: 1f3e769616fdf9f31f85f4c3e6a9f71606634238
     snapshot: native-snapshot/1f3e7696/AGENTS.md
     fidelity: adapted -->

# Firstmate

<!-- BB-DIVERGE
     native: AGENTS.md § 3
     native-quote: Run `bin/fm-session-start.sh` exactly once at session start.
     bb: /captain binds the current BB thread and loads the complete native contract.
     reason: The BB plugin skill is an entry point, not a second supervisor policy. -->
<!-- BB-ONLY: BB entry point. -->
Read [the /captain skill](../captain/SKILL.md) to bind this BB thread and load the complete native Firstmate contract.
Use [the BB harness reference](../harness-adapters/references/harness/bb.md) for `firstmate_watch`, script paths, and thread operations.
<!-- /BB-ONLY -->
