---
name: bearings
description: Fleet digest from live BB crew state. Use when the user runs /bearings or asks for status, catch-up, or what's underway.
---

# Bearings

Call `firstmate_bearings` or `bb firstmate bearings`. That command owns the five sections. Do not scrape chat instead.

1. **Captain's Call** — decisions due, failed crews, PRs ready to merge with full `https://...` URL.
2. **Recently Landed** — merged PRs, completed scouts.
3. **Ready to review** — idle crews.
4. **Underway** — live work.
5. **Charted Next** — queued/gated work and deferred decisions.

Every section always renders. Complete snapshot, never a delta. Omit crew ids in chat unless the captain needs them to act.

Read-only: never dispatch, steer, merge, or forget during a digest. Open the Fleet panel for the same snapshot as a board.
