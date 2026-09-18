---
name: quiet
description: Batch routine pings while the captain is present. Use when the user runs /quiet or /quiet off.
---

# Quiet

Presentation only. Decisions, failures, review-ready work, and credentials still surface immediately.

- `/quiet` → `firstmate_quiet` `action: "on"` (or `bb firstmate quiet on`)
- `/quiet off` → `firstmate_quiet` `action: "off"` (ordinary chat does not exit quiet)
- Routine idle "done" pings wait for the next natural reply.
