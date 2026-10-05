# Entry skill package discovery correction

Baseline: `e3e516142476322a4a50c9d9054b28de2c4e21bc`. Parent actual BB acceptance reported `configure() selected unknown skill id "firstmate" owned by plugin "firstmate"`.

## Cause and change

BB 0.44.0 treats `bb.skills` as a list of **parent directories**. Its installed `readPluginManifest` resolves those roots, then `readSkillNames` enumerates immediate real child directories containing regular `SKILL.md` files. The old manifest listed `skills/captain` and `skills/firstmate` themselves, so neither entry was discovered. Fake tests supplied their IDs from individual file frontmatter or the entire source directory and therefore bypassed discovery.

The manifest now registers only `entry-skills`. The existing captain and firstmate directories and all their resources moved there without changing their instruction bytes. This is one canonical source tree, without generated duplicate bodies or symlink aliases. Native and optional method source directories remain under unregistered `skills`; no native policy or extra method is restored to automatic registration. Relative firstmate-to-captain and captain reference links retain their sibling layout. Source-only calm/harness links now point to the relocated canonical BB references.

[SDK fixtures](../../scripts/plugin-skill-fixture.mjs) now derive IDs from the actual manifest parent directories. [Actual BB regression](../../scripts/plugin-package-discovery.test.mjs) installs the candidate in an owned disposable BB server and host, runs supported `bb skill list --json`, requires exactly the two plugin entry skills, checks their reference closure, and uses those actually discovered IDs for registered plugin configuration. Ordinary and captain configuration select those two entries; crew configuration selects no skills or captain tools. The actual server verifies its unique launch identity before installation and uses its normal loopback enrollment seam; no production credentials or direct database edits are used. No model thread or native home is launched.

[The causal mutation](../../scripts/plugin-package-discovery-mutation.mjs) restores individual-skill directory paths in a private candidate whose directories really exist. Actual BB discovery then fails the causal assertion. Syntax/load errors do not count. The regression is part of `npm test` and requires installed BB; it does not skip the real discovery proof.

## Commands and results

```sh
FIRSTMATE_KEEP_PACKAGE_EVIDENCE=1 node --test --experimental-strip-types scripts/plugin-package-discovery.test.mjs
node scripts/plugin-package-discovery-mutation.mjs
FIRSTMATE_TEST_NATIVE=/tmp/fm-prompt-fixture-hGuT6L node --test --experimental-strip-types server.methods.test.mjs server.native-policy.test.mjs scripts/skill-fidelity.test.ts
npx tsc --noEmit
npm run fidelity
bb plugin build .
git diff --check
```

Actual BB discovery: 1/1 passed (7467 ms test duration); evidence `/tmp/fm-package-discovery-E2vjZq/evidence.json` and its owned server/daemon logs. The server lists `captain` and `firstmate`, plugin scope/owner `firstmate`, with canonical `entry-skills` paths. No global native or method skill appears for this plugin. Source/configuration/fidelity regressions: 44/44 passed, zero failures/skips; affected existing server skill/escalation checks 4/4 passed. Individual-directory mutation killed, and the seven trigger/reference mutations still fail their causal assertions after relocation. Typecheck, fidelity, build and diff check pass. Fidelity retains 33 checked native-derived files, 12 divergence anchors and 7 authorized fences. The existing SDK pin mismatch build warning remains; no SDK, CLI, native pin or runtime asset changed.

Logs: `/tmp/fm-package-discovery-real.log`, `/tmp/fm-package-discovery-mutation.log`, `/tmp/fm-package-discovery-affected.log`, `/tmp/fm-package-discovery-tsc.log`, `/tmp/fm-package-discovery-fidelity.log`, `/tmp/fm-package-discovery-build.log`. Initial owned-fixture failures exposed missing daemon bootstrap/CLI-directory setup and an incorrect expected captain skill list; the final fixture uses matching enrollment identity and the installed CLI directory, and preserves the unchanged two-entry captain selection.

## Parent refresh and limits

Parent owns integration, final full suite, fresh-model acceptance and production reload. After reload, refresh captain configuration and inspect actual BB skill discovery/status before orchestration. Busy skill runtimes can defer catalog refresh under the SDK contract. Read the complete selected-runtime native contract and trigger catalog after refresh. No captain state, native home, task brief, worker environment, execution selection, delivery requirement or standing authority is migrated by this correction.

This proves real installed-package discovery and registered configuration using actual discovered IDs. It does not prove fresh-model behavior, actual per-thread runtime staging or production activation. Those remain parent acceptance work. All disposable servers and daemons are stopped, and only owned fixture paths are cleaned; the parent's server on port 38990 and its captain were untouched.

## Official CLI entrypoint fixture correction

Baseline `ca5b91ca32e397065d0303c827377e68e7c4ce32`. Parent's clean-environment full run passed 816/817 tests; the discovery fixture alone assumed that `command -v bb` resolved to `host-daemon/dist/bb`. In the required PATH it resolves to the official `bb-app/dist/bb.js` launcher. Walking up two directories from that launcher selected the wrong package root and attempted to open `node_modules/server/dist/index.js`.

[The installed-runtime fixture resolver](../../scripts/bb-runtime-fixture.mjs) walks at most six parent directories, verifies `package.json` identifies `bb-app` and declares the official JavaScript CLI, accepts either official CLI entrypoint, and requires the installed server, daemon and both CLI artifacts. Unsupported entrypoints refuse; there is no source checkout fallback. The daemon's `BB_CLI_DIR` always refers to the compiled CLI directory, independently of which launcher the test calls. Only test transport changed; the plugin manifest and all policy/runtime bytes remain unchanged.

The actual discovery test now runs separately through both entrypoints. Each server has its own HOME, data directory, loopback ports, launch nonce and enrollment credential. All inherited `BB_*` variables remain cleared before owned settings are applied. The test never launches a model or accesses a production server. It also resolves both real entrypoints back to the same verified runtime and rejects the server script as a CLI entrypoint.

```sh
env -u BB_CLI -u BB_INFERENCE -u BB_INFERENCE_FALLBACK -u BB_TRANSCRIPTION \
  -u BB_THREAD_ID -u BB_PROJECT_ID -u BB_ENVIRONMENT_ID -u BB_HOST_ID \
  -u BB_SERVER_URL -u BB_HOST_DAEMON_PORT -u BB_DATA_DIR \
  HOME=/root SHELL=/bin/bash PATH=/root/.local/bin:/root/.bun/bin:/usr/local/bin:/usr/bin:/bin \
  FIRSTMATE_KEEP_PACKAGE_EVIDENCE=1 \
  node --test --experimental-strip-types scripts/plugin-package-discovery.test.mjs
node scripts/bb-runtime-fixture-mutation.mjs
node scripts/plugin-package-discovery-mutation.mjs
```

Clean-environment result: 3/3 passed, zero skips, 15925 ms total. JavaScript launcher: 8260 ms; compiled CLI: 7386 ms. Owned evidence: `/tmp/fm-package-discovery-gEfnVr/evidence.json` and `/tmp/fm-package-discovery-kTMzU7/evidence.json`; both processes are stopped. Evidence contains no enrollment credential.

The fixed-depth lookup mutation is killed by the package-resolution check and actual JavaScript-launcher test; the compiled-CLI test still passes. The earlier individual-skill-directory mutation remains killed by actual discovery. Mutations execute private copies and leave source and production untouched.

Full suite used the same clean environment above, with `FM_TEST_HOME` and `FIRSTMATE_TEST_NATIVE` set to `/tmp/fm-prompt-fixture-hGuT6L`, `FM_SCOUT_NATIVE_BIN` to its `bin-bb`, and `FM_CLASSIFY_LIB` to its `bin/fm-classify-lib.sh`, running `/usr/bin/npm test`. Result: **819/819 passed**, zero failures/skips, 174490 ms. Final targeted entrypoint coverage also passed after tightening each actual test to resolve its selected launcher directly. Typecheck, fidelity, build and diff check pass. Logs: `/tmp/fm-runtime-lookup-{clean,full,mutation,discovery-mutation,tsc,fidelity,build}.log`.

Parent independently observed fresh captain skill discovery, contract read and startup success. Delegation acceptance remains parent-owned. This correction does not claim production activation or model behavior.
