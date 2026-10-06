---
name: verify-firstmate
description: Verify Firstmate's BB CLI installation, bundled runtime integrity, task recovery, PR follow-up, and role instructions after changes or before release.
---

# Verify Firstmate

Read [the feature map](features/README.md), then select the changed user paths. This skill drives a private BB server and host. Its doctor checks the exact server, installed build, host, and bundled release before driving them.

## Launch

Run from the plugin checkout. Install missing dependencies from the existing lockfiles. The pinned build tool is BB 0.44.0.

```sh
npm ci
npm ci --prefix scripts/ci-tools
npm run typecheck
npm run runtime:verify
env -u BB_CLI -u BB_INFERENCE -u BB_INFERENCE_FALLBACK -u BB_TRANSCRIPTION scripts/ci-tools/node_modules/.bin/bb plugin build .
export FIRSTMATE_VERIFY_EVIDENCE="$(mktemp -d /tmp/verify-firstmate-evidence-XXXXXX)"
node .cursor/skills/verify-firstmate/scripts/verify-firstmate.mjs --feature package --evidence "$FIRSTMATE_VERIFY_EVIDENCE"
```

The executable helper starts the installed official BB server and daemon on distinct free loopback ports. It uses a new HOME and data directory, clears inherited routing and credentials, installs this candidate, and tears down both owned processes. Each invocation requires a new empty evidence directory.

Readiness requires the exact launch ID in `/health`, a connected owned host, and a passing doctor. The final JSON must say `passed: true`. An error preserves evidence and returns a nonzero exit code.

## Doctor

The helper runs `acceptancePreflight` before every drive and saves `doctor.json`. During an active invocation, this same read-only check can be repeated:

```sh
node scripts/acceptance-preflight.mjs "$FIRSTMATE_VERIFY_EVIDENCE/expectations.json"
```

Require the expected installed root, server build hash, release, host, and enabled/running plugin. Selected captain runtime and native startup remain explicitly unchecked by this doctor. After cleanup, the doctor must refuse because the server is gone.

## Drive

Use one feature per invocation. Replace `package` with `runtime`, `assignments`, `pull-requests`, or `instructions`, as specified in the map. Create a new evidence directory for each invocation.

The package drive uses actual public BB CLI commands. Runtime drives execute the shipped helper and real native scripts in disposable homes. Assignment, PR, and instruction drives exercise the actual plugin through its SDK harness. Their external BB or forge boundary is simulated; their SQLite state is real. These drives do not prove model compliance, a live worker launch, or a live forge mutation.

For full coverage, run the existing package-owned commands `npm test`, `npm run test:ci`, `npm run fidelity`, and `npm run runtime:verify`. `test:ci` requires an owned native fixture containing both audited commits. See [the existing CI fixture recipe](../../../docs/verification/session-retro-20261005.md#clean-ci). Report those suites separately.

## Evidence

Preserve `expectations.json`, `doctor.json`, `commands.json`, `result.json`, `cleanup.json`, server/daemon logs, and `drive.tap` when a test drive runs. Commands include arguments, stdout, stderr, and exit codes. The result identifies every simulated boundary.

Require the action and resulting state assertions, including no duplicate creation, preserved task ownership, independent check recovery, and corruption refusal. A saved final state alone is insufficient. Model, Telegram, UI, and live forge paths remain separate acceptance requirements.

## Cleanup

The helper stops only the process handles it created, removes its private HOME and data directory, and preserves the evidence directory. Require `cleanup.json` to report `stopped`, `scratchRemoved`, and `evidenceRetained` as true. Verify `result.json` still exists after cleanup.

If a run fails, inspect its saved command or service log, correct the named cause, and rerun with a fresh directory. Preserve the failed evidence. Production reload and captain runtime migration are separate operations; this skill gives them no authority.

## Helpers

`scripts/verify-firstmate.mjs` is executable. Invoke it through Node as shown above, or directly from this skill directory:

```sh
./scripts/verify-firstmate.mjs --feature package --evidence "$FIRSTMATE_VERIFY_EVIDENCE"
```

Use `/maintain-verification-skill` when commands or feature entry points change.
