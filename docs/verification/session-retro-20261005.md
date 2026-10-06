# Session retrospective - 2026-10-05

Scope: implementation checkout after `5147d19`; parent owns integration/activation. No product edits, live home operations, model launches, Telegram operations or delegation in this correction. Existing Python caches and prior work are preserved.

## Ranked findings

1. **Confirmed: existing checks had no repository CI gate.** `package.json` had a passing 833-test command plus fidelity/runtime verification, but no `.github` workflow or pre-commit hook. A clean machine also lacks BB and external native tool CLIs; running the command unchanged cannot represent verified integration. Added one workflow using existing checks, a locked BB 0.44.0 build tool and a declared offline test profile. No additional local hook framework is needed.
2. **Confirmed: fixture registration/reload did not prove enabled/running state.** Parent's first model attempt ran while Firstmate was disabled. Existing package-discovery acceptance only checked registered entry skills. Added a read-only preflight and extended that exact owned BB fixture. It proves disabled remains refused after reload, enabled/running succeeds, and wrong server/host/build identities refuse before model launch. Discovery, enabling, running, build identity, bundled integrity and per-captain selection are separate observations.
3. **Confirmed navigation gap: check/setup entry points were scattered across historical evidence.** Added conditional pointers in CONTRIBUTING and README to this current entry point. Registered operator help and dispatch mapping remain their existing owners. No new native instructions or global prose were added.
4. **Unresolved: one late stopped-responding notice after completed work.** Parent's successful acceptance reconciled the notice against ready-in-branch completion. The current source already filters completed/foreign native stale lines and deduplicates reports. Captured events alone do not identify a reproducible defect in that filter or the upstream watcher. No speculative suppression or policy change was made.
5. **Outside this repository: cumulative usage display and obsolete BB environment warning.** The session's token figure does not prove current-context usage. The warning for `BB_INFERENCE_FALLBACK` comes from official BB, including plugin build, rather than Firstmate. Preflight and CI clear inherited BB routing variables; BB core and Telegram remain untouched.

Primary sources read without dumping transcripts:

- Parent `data/dispatch-5147d19/acceptance.md` and targeted `acceptance-events.json` under `/root/.local/share/bb-firstmate/homes/thr_jm4qnewqmf`: distinct setup/task turns, one actual grok-4.5/high worker under grok-4.7/high captain, committed local-only completion, no extra PR question. Late-notice matches at events 203 and 1164; earlier role acceptance also has event 251. These matches include references, not proof of multiple independent stale alerts.
- Earlier `data/captain-role-89c5d14/` evidence: disabled initial fixture excluded; subsequent contract/dispatch corrections already accepted. Those fixes were not repeated.
- `data/telegram-production-verification/result.json`: all nine contract pages, successful startup, inbound verification and sent reply. This is parent-observed production evidence, not a new Telegram test here.

## Verification entry points

Use `npm run typecheck`, `npm run fidelity`, `npm run runtime:verify` and the package's `npm test` inventory as their single command owners. The workflow runs the first three, the declared `test:ci` profile, pinned BB build and tracked-diff checks.

### Clean CI

[checks.yml](../../.github/workflows/checks.yml) pins both official actions by commit, uses Node 24.18.0, root `npm ci` and the separate [locked tool package](../../scripts/ci-tools/package.json) for BB 0.44.0. It fetches only the two audited native commit IDs into an owned runner-temp fixture, installs the exact overlay and supplies that fixture to `npm run test:ci`. No separately installed native home or credentials are required. npm/Git/toolchain downloads still need network access; failure stays red. Native source versions and the plugin SDK pin are unchanged.

[ci-check.mjs](../../scripts/ci-check.mjs) owns the explicit environment-file inventory, prints every included/excluded file and reason, clears inherited BB/FM routing, denies real BB operations, runs actual assertions with the owned native scripts and rejects a skipped-test summary. Every colocated test must appear in `package.json`; stale classification or removed workflow checks fail the colocated CI tests. New test files enter the CI profile by default unless explicitly classified with an environment requirement.

Both exact native commits are fetched into named fixture refs. A first fresh-source trial fetched only objects: the old commit existed in that checkout but was unreachable when nested test fixtures cloned it, causing 19 old-pin failures. Retaining named refs fixes the fixture rather than excluding those assertions. The CI test guards both exact refspecs.

Ten test files require an acceptance environment and are listed there. This includes the large mixed `server.test.ts` file, startup prerequisite checks, actual BB package discovery, external CLI backlog/completion and runtime startup integration. The CI profile does not claim those assertions ran. Full `npm test` with native fixtures and the required tool CLIs still runs all tests. Live host/model/forge acceptance remains required for behavioral claims under CONTRIBUTING; no mocks replace it.

### Owned acceptance preflight

Before launching a model on an isolated fixture, supply an expectations JSON file to:

```sh
node scripts/acceptance-preflight.mjs /path/to/owned-expectations.json
```

Required fields:

```json
{
  "serverUrl": "http://127.0.0.1:<owned-port>",
  "launchId": "<exact-owned-server-launch-id>",
  "dataDir": "<exact-owned-BB-data-directory>",
  "pluginRoot": "<exact-installed-Firstmate-root>",
  "hostId": "<exact-connected-host-id>",
  "buildSha256": "<SHA-256-of-the-reviewed-dist/server.js>",
  "release": "<expected-runtime-assets/distribution.json-release>"
}
```

Record the reviewed build hash independently after building; computing it from an unknown installed candidate would not prove candidate identity. Add `projectId` before worker dispatch to require a ready environment on that exact host/project. The lookup is bounded to 20 ready rows and never scans unrelated homes. Server health must match the explicit launch ID before CLI reads. The script reads plugin/host status and installed assets only; it never enables, reloads, binds, dispatches or acknowledges reports. It reports the selected per-captain runtime as **unchecked**, with native selection read-back/harness startup still required after deck binding. Passing this preflight is not completed startup or model acceptance.

The actual package-discovery fixture creates its own server, host, HOME/data and ports. Only that fixture disables/reloads/enables its plugin to exercise preflight. Preflight itself has no mutation path. It preserves worker exclusion and shipped entry-skill discovery for both official BB entrypoints.

## Evidence and checks

Affected tests and actual-path proof:

```sh
node --test --experimental-strip-types scripts/ci-check.test.mjs scripts/acceptance-preflight.test.mjs
node --test --experimental-strip-types scripts/plugin-package-discovery.test.mjs
FIRSTMATE_TEST_NATIVE=/tmp/fm-crew-state-native-yq_lrbsn/home npm run test:ci
npm ci --prefix scripts/ci-tools
env -u BB_CLI -u BB_INFERENCE -u BB_INFERENCE_FALLBACK -u BB_TRANSCRIPTION \
  scripts/ci-tools/node_modules/.bin/bb plugin build .
```

Owned proof logs: `/tmp/fm-retro-unit-final.log`, `/tmp/fm-retro-preflight-live-final.log`, `/tmp/fm-retro-ci-final.log`, `/tmp/fm-retro-clean-tools.log`, `/tmp/fm-retro-locked-build-final.log`. Initial clean-profile trial exposed ten genuine missing-prerequisite failures; those files now have explicit environment coverage rather than fabricated prerequisites or skipped assertions. Actual preflight proof: 3/3 tests, zero failures/skips, both official entrypoints, no threads/models created. Offline profile: 320/320 tests, zero failures/skips.

Fresh root `npm ci` installed 120 packages into `/tmp/fm-retro-clean-ci-a3fyb907`, without using the shared `node_modules` symlink. Its restricted-PATH CI profile passed 320/320 with zero skips; `/tmp/fm-retro-clean-npm.log` and `/tmp/fm-retro-clean-profile.log`. The pinned BB tool package also installed through its lock and built successfully. Full suite passed **837/837**, zero failures/skips, 175692 milliseconds; `/tmp/fm-retro-full.log`. Typecheck, fidelity, runtime integrity and diff check passed. Existing BB core SDK-version/obsolete-setting notices during build were not suppressed or recast as plugin errors.

The same fresh-dependency checkout also passed 320/320 with zero failures/skips against freshly fetched shallow native sources retaining both named refs: 120266 milliseconds, `/tmp/fm-retro-fresh-native-profile-final.log`. Exact fetch and real overlay install succeeded into `/tmp/fm-retro-native-fetch-KujCnK`; `/tmp/fm-retro-native-fetch.log`, `/tmp/fm-retro-native-refs.log`, `/tmp/fm-retro-native-install.log`. This reproduces the workflow's source preparation without an existing native checkout. The first trial's 19 failures remain recorded, rather than relabeled as successful coverage.

Four isolated causal mutations failed, followed by exact restoration:

1. Remove the enabled/running preflight guard: the actual owned JavaScript-entrypoint BB test fails `assert.rejects` on the disabled plugin. `/tmp/fm-retro-mutation-disabled-preflight.log`.
2. Remove the workflow's runtime integrity command: the CI test fails its required workflow-command assertion. `/tmp/fm-retro-mutation-ci-runtime-gate.log`.
3. Permit a nonzero skipped-test summary: the CI test fails the expected rejection of `# skipped 1`. `/tmp/fm-retro-mutation-ci-skipped-tests.log`.
4. Remove named refs from both exact native fetch arguments: the CI test rejects the unreachable-source setup. `/tmp/fm-retro-mutation-ci-native-refs.log`. The actual fresh-source trial also failed 19 old-pin cases before this correction; `/tmp/fm-retro-fresh-native-profile.log`.

Restored focused tests passed 7/7 with zero failures/skips, including both actual BB entrypoints; `/tmp/fm-retro-focused-final.log`. No model inference was used to prove any guard.

Full-suite environment retains the existing owned fixture:

```sh
env -u BB_CLI -u BB_INFERENCE -u BB_INFERENCE_FALLBACK -u BB_TRANSCRIPTION \
  -u BB_THREAD_ID -u BB_PROJECT_ID -u BB_ENVIRONMENT_ID -u BB_HOST_ID \
  -u BB_SERVER_URL -u BB_HOST_DAEMON_PORT -u BB_DATA_DIR \
  FM_TEST_HOME=/tmp/fm-crew-state-native-yq_lrbsn/home \
  FIRSTMATE_TEST_NATIVE=/tmp/fm-crew-state-native-yq_lrbsn/home \
  FM_SCOUT_NATIVE_BIN=/tmp/fm-crew-state-native-yq_lrbsn/home/bin-bb \
  FM_CLASSIFY_LIB=/tmp/fm-crew-state-native-yq_lrbsn/home/bin/fm-classify-lib.sh npm test
```

No behavior claim is made about identical model behavior or elimination of late notices. CI workflow execution on GitHub requires parent integration/push; local reproduction is reported separately from hosted CI. Parent can run this same read-only preflight before future actual acceptance. No production activation is part of this assignment.
