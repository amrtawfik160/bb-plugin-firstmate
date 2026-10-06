# Role instructions

Captain and worker contexts receive their own methods. Direct PR authors read the complete selected `/pr` source with verified provenance.

## Sub-features

- `instructions-defaults` retains native defaults when methods are unconfigured.
- `instructions-role` separates captain and worker method resources.
- `instructions-pages` preserves complete source bytes across bounded reads.
- `instructions-pr` refuses missing, changed, or conflicting `/pr` sources.

## How to get to it (user POV)

Use `/captain`, `bb firstmate methods status`, `bb firstmate methods read`, and `firstmate_methods` in the assigned role.

## Driving it with verify-firstmate

Preconditions: package doctor passes. Role and skill APIs are exercised through the existing SDK harness.

1. Run the helper with `--feature instructions --evidence "$FIRSTMATE_VERIFY_EVIDENCE"`.
2. Require all existing method composition and public reader cases to pass with zero skipped cases.
3. Require full paged source reconstruction, pinned source identity, and refusal of conflicting or changed sources.
4. Preserve the resulting TAP output and the package discovery evidence.

## Gotchas

Configuration equality does not prove model compliance. External no-mistakes author skill loading, every-message reporting, complete live contract delivery, and real worker skill reads remain separate acceptance requirements.
