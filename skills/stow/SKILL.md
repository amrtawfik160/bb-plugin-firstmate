---
name: stow
description: Close-out sweep for durable knowledge. Use when the user runs /stow or before reset/compaction.
---

# Stow

1. Sweep this session for durable facts that exist only in chat.
2. File them:
   - follow-up work → `bb firstmate queue add --project <id> -- "<title>"`
   - captain prefs → `bb firstmate memory set-captain -- "..."` (inspect-then-update)
   - fleet facts → `bb firstmate memory add-learning -- "..."` (dated, evidence-backed)
3. Correct wrong records. Answer or defer open decisions.
4. `bb firstmate forget <id> --stop` retired idle crews (refuses dirty work without `--force`).
5. Leave a compact map: landed / underway / open decisions / learnings.

Omit trivia and anything already in memory/queue. Rewrite and prune rather than appending forever.
