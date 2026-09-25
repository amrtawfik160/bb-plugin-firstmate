# native-snapshot

Read-only, vendored copies of native
[firstmate](https://github.com/kunchenguid/firstmate) source at pinned commits.
They exist so `scripts/skill-fidelity.ts` can verify — fully offline, in
`npm test` — that this plugin's skills are still faithful copies of native's
instructions (see [CONTRIBUTING.md](../CONTRIBUTING.md) "Skill fidelity").

- Layout: `native-snapshot/<sha>/<native-path>`, mirroring native's own paths
  (e.g. `.agents/skills/afk/SKILL.md`), plus named slices like
  `AGENTS.section-9.md` for a single section of a larger native file.
- These files are **not** plugin skills and are **not** loaded at runtime — the
  plugin's skills live under `skills/`. Nothing here is edited by hand.
- To bump a pin: re-vendor from a native clone at the new SHA, update the
  `BB-SOURCE` `sha:`/`snapshot:` in the affected skill, and run
  `npm run fidelity -- --native /path/to/firstmate` to prove the snapshot matches
  the live clone.

Current snapshot: `b42d4fa8a752fad9a5f0235783b02534bce29219`, the audited
runtime/overlay pin. Every `BB-SOURCE` must use that full SHA; the offline fidelity
check rejects a skill or overlay pin that differs from `lib/upstream-surface.ts`.
Older snapshots remain historical fixtures and are never loaded at runtime.

The BB captain, firstmate, ahoy, quiet and stow adapters remain BB-specific
instructions; their policy coverage is not certified as verbatim by this check.
