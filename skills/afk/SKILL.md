---
name: afk
description: Enter away-mode supervision. Use when the user runs /afk, says they are going afk, or returning from afk.
---

# AFK

Away is a posture of this captain thread. It does not expand merge or destructive authority.

## Enter `/afk [words]`

1. Call `firstmate_afk` with `action: "on"` and `words` set to the captain's words verbatim (or `bb firstmate afk on -- "words"`).
2. Read the words back in one line as mandate notes, not orders. They are never executed as authority.
3. Keep `supervision on`. Routine done-pings are held. Failures, stuck crews, credentials, and review-ready PRs still surface.
4. Do not merge, forget --force, or treat AFK words as yolo.

## Return

The first unmarked captain message (not `/afk`) is return:

1. Call `firstmate_afk` `action: "off"` (or `bb firstmate afk off`).
2. Relay the return brief first: health, waiting-on-you, held pings, failed.
3. Then act on that message.

A message that starts `/afk` while already away refreshes the words; it does not exit.
