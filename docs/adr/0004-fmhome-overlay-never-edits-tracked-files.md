---
status: proposed
---

# The fmHome overlay must not edit tracked files in the third-party clone

`fmHome` is a clone of the third-party firstmate repo (origin
`kunchenguid/firstmate`) that the plugin overlays and reuses on the host. The
plugin refreshes a reused clone with `git fetch` + **ff-only** merge, which
requires a **clean working tree**. The decision: the overlay must never edit
tracked files in that clone — additions go in untracked overlay paths, never
in-place patches to files git already tracks.

An in-place patch leaves the tree dirty. A dirty tree makes the ff-only
auto-update **silently fail** — it does not error loudly, it just stops
fast-forwarding — so the clone freezes at whatever commit it was on. A frozen
clone runs stale policy scripts while the plugin reports real mode active.

## Status: proposed, not yet satisfied

This ADR records the target invariant; the **current overlay violates it**. As of
this writing the live clone patches tracked files in place —
`git -C /root/firstmate status --porcelain` shows ` M bin/fm-backend.sh`,
` M bin/fm-spawn.sh`, ` M bin/fm-teardown.sh` (plus `docs/configuration.md`).
That dirty tree is the **observed cause** of the silent ff-only freeze: the live
clone sits 9 commits behind upstream. Restructuring the overlay so additions live
only in untracked paths (in flight in a separate crew, not merged at the time of
writing) is what will bring the clone into compliance and move this ADR to
`accepted`.

## Consequences

- Target state: overlay content lives in untracked paths (`overlay/`); the plugin
  adds, it never edits tracked upstream files. This does not hold today.
- The refresh is ff-only against a clean tree — if that invariant is broken the
  update stops without a loud error, so treat any tracked-file edit in the clone as
  a correctness bug, not a style nit.
- When diagnosing "real mode looks active but behaves like an old version", check
  the clone's HEAD against upstream and check for a dirty tree first — that is
  exactly the current condition.
