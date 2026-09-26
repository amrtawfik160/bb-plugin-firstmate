---
name: decision-hold-lifecycle
description: >-
  Renamed pointer kept for in-flight briefs: the decisions concept collapsed into "a task held for the captain".
  Load captain-hold-lifecycle instead; this stub only redirects and will be removed one release after the collapse.
user-invocable: false
metadata:
  internal: true
---

<!-- BB-SOURCE
     native: .agents/skills/decision-hold-lifecycle/SKILL.md
     sha: bb69be62e1f8df465d674a35f7e2ce707b900501
     snapshot: native-snapshot/bb69be62/.agents/skills/decision-hold-lifecycle/SKILL.md
     fidelity: verbatim
-->

# decision-hold-lifecycle (renamed)

The separate decision concept was collapsed into the one primitive the captain cares about: a task held for the captain.
Read and follow `.agents/skills/captain-hold-lifecycle/SKILL.md`; it owns the completion gate, the recorded-answer rule, and every command this skill used to describe.
Where an older brief says `bin/fm-decision-hold.sh`, that command still works as a one-release compatibility shim over `bin/fm-captain-hold.sh`.
