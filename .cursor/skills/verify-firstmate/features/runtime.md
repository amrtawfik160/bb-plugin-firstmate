# Bundled runtime

A captain receives a verified runtime. Damaged executable scripts or redirected sibling links must refuse before execution.

## Sub-features

- `runtime-install` installs and binds the shipped archive in a disposable home.
- `runtime-inspect` rejects changed generated scripts.
- `runtime-resolve` rejects a live sibling link pointing to another script.
- `runtime-reuse` rejects reusing a damaged release.

## How to get to it (user POV)

Use `/captain`, `bb firstmate deck`, and `bb firstmate runtime status`. Native execution resolves the selected runtime before calling its scripts.

## Driving it with verify-firstmate

Preconditions: the candidate's runtime package integrity check passes.

1. Run the helper with `--feature runtime --evidence "$FIRSTMATE_VERIFY_EVIDENCE"`.
2. The existing runtime fixture executes install, bind, inspect, resolve, and reinstall through the shipped helper.
3. Require corruption of launch, teardown, backend, and local merge scripts to return refusal. Their injected marker must never execute through runtime resolution.
4. Require a redirected native sibling link to refuse, and restored original bytes/links to pass.
5. Preserve `drive.tap` and require successful fixture cleanup.

## Gotchas

This drive proves shipped runtime scripts and their resolver. Public deck, native harness startup, and old captain runtime migration are separate paths. Existing captains keep their selected release until a supported guarded selection succeeds.
