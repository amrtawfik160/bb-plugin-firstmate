---
name: firstmate
description: Use native Firstmate through BB threads and managed worktrees. Use when the user asks to run Firstmate or supervise crews.
---

<!-- BB-SOURCE
     native: AGENTS.md
     sha: 8ba34f1da5d19004adc3a7521dc600d1815cf380
     snapshot: native-snapshot/8ba34f1d/AGENTS.md
     fidelity: adapted -->

# Firstmate

<!-- BB-DIVERGE
     native: AGENTS.md § 3
     native-quote: Run `bin/fm-session-start.sh` exactly once at session start.
     bb: /captain binds the current BB thread and loads the complete native contract.
     reason: The BB plugin skill is an entry point, not a second supervisor policy. -->
<!-- BB-ONLY: BB entry point. -->
Read [the /captain skill](../captain/SKILL.md) to bind this BB thread and load the complete native Firstmate contract.
Use [the BB harness reference](../captain/references/bb.md) for `firstmate_watch`, script paths, and thread operations.
<!-- /BB-ONLY -->
