# The fmHome overlay must not edit tracked files in the third-party clone

`fmHome` is a clone of the third-party firstmate repo (origin
`kunchenguid/firstmate`) that the plugin overlays and reuses on the host. The
plugin refreshes a reused clone with `git fetch` + **ff-only** merge, which
requires a **clean working tree**. Therefore the overlay must never edit tracked
files in that clone: additions go in untracked overlay paths, never in-place
patches to files git already tracks.

An in-place patch leaves the tree dirty. A dirty tree makes the ff-only
auto-update **silently fail** — it does not error loudly, it just stops
fast-forwarding — so the clone freezes at whatever commit it was on. This was
observed live: a clone frozen 9 commits behind upstream, still passing because
nothing surfaced the stall. A frozen clone runs stale policy scripts while the
plugin reports real mode active.

## Consequences

- Overlay content lives in untracked paths (`overlay/`); the plugin adds, it never
  edits tracked upstream files.
- The refresh is ff-only against a clean tree — if that invariant is broken the
  update stops without a loud error, so treat any tracked-file edit in the clone as
  a correctness bug, not a style nit.
- When diagnosing "real mode looks active but behaves like an old version", check
  the clone's HEAD against upstream and check for a dirty tree first.
