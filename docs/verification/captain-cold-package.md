# Captain cold-entry package correction

Scope: correction after `44234d5`. Parent owns integration and live acceptance.
No plugin install/reload, production home change, worker turn, or model launch
was performed for this correction.

## Defect and package boundary

The actual isolated runtime package
`a2137237aaa4c39a2fe60866cfb96a901a95285226644687f47e94b4b3f03eef`
contains `firstmate/SKILL.md` but omits its relative captain dependency and Calm.
The source checkout containing those files cannot satisfy a provider's selected
runtime package. The new read-only package check reproduces ENOENT for
`captain/SKILL.md` against that actual package, before any startup operation.

Ordinary threads now select exactly five skill directories: `firstmate`,
`captain`, `calm`, `catch-up`, and `harness-adapters`. These contain the complete
relative reference graph reached by the typed Firstmate and direct `/captain`
startup routes, including escalation, receipt handling, the BB harness reference,
and the report editor. The BB route selects its BB harness reference; native
references for other harnesses retain their native-home path contract.

The report editor moved unchanged from
`captain-methods/references/reporting.md` to `calm/references/reporting.md`.
Calm, catch-up, and captain-methods all use that single resource. This keeps
role methods out of the ordinary-thread package while preserving reporting on
startup failure. Historical bounded-methods evidence describes its prior location.

Before captain metadata, the agent gets only `firstmate_deck` and
`firstmate_contract`. The captain skill retrieves the startup command from deck
or the existing CLI. After binding, configuration supplies the full captain
selection; native startup remains required before orchestration. Workers retain
only `worker-methods`, zero captain tools, and zero captain bootstrap skills,
even with both crew and captain markers. Configuration makes no SDK calls.
Native policy, pin, lock checks, startup readiness, and instruction size limits
are unchanged. The captain adjustment remains in its existing marked BB fence.

## Verification

1. Actual SDK configure driver, reload, selected-directory package, and startup
   paths on both audited native pins:

   ```sh
   FM_TEST_HOME=/tmp/fm-launch-pr-verified FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb node --test --experimental-strip-types --test-concurrency=1 server.methods.test.mjs server.captain-startup.test.mjs
   ```

   **17/17 passed**, zero failures/skips. Log:
   `/tmp/fm-cold-package-targeted.log`. The package tests physically copy only
   directories selected by the actual public SDK configure driver; reference
   traversal cannot fall back to the checkout. Typed and explicit slash routes
   are checked before binding and after plugin reload, followed by captain and
   worker selection checks. The SDK does not expose the core runtime-package
   compiler as a public testing API; this fixture tests its selected-directory
   boundary, not a substitute provider launch.

2. Existing registered role-selection cases:

   ```sh
   FM_TEST_HOME=/tmp/fm-launch-pr-verified FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb node --test --experimental-strip-types --test-name-pattern='unmarked threads|captain metadata|crew threads' server.test.ts
   ```

   **2/2 selected tests passed**. Log: `/tmp/fm-cold-package-role.log`.
   Worker exclusion also passes in the five method/package tests, rerun after
   extracting the reusable package checker: `/tmp/fm-cold-package-methods-final.log`.

3. Causal mutations in an isolated copy:

   ```sh
   node scripts/captain-packaging-mutation.mjs
   ```

   **4/4 killed**: restore ordinary `firstmate`-only packaging; omit Calm while
   shipping captain; restore the unshipped captain-methods report link; expose
   orchestration tools before binding. Both package routes fail for each mutation.
   Log: `/tmp/fm-cold-package-mutations.log`. Source files remain unchanged.

4. Actual isolated old package, read-only:

   ```sh
   node scripts/captain-packaging-check.mjs /tmp/firstmate-implementation-20261004/bb-acceptance/runtime/global-skills/a2137237aaa4c39a2fe60866cfb96a901a95285226644687f47e94b4b3f03eef/skills
   ```

   Expected **exit 1**, exact missing captain file. Log:
   `/tmp/fm-cold-package-original-runtime.log`. The same command accepts a fresh
   core-generated candidate package path for parent acceptance and checks both
   entry routes plus all their transitive local links without modifying files.

5. `npx tsc --noEmit`,
   `npm run fidelity -- --native /tmp/fm-launch-pr-verified`,
   `bb plugin build .`, and `git diff --check`: **passed**.
   Logs: `/tmp/fm-cold-package-{tsc-final,fidelity-final,build}.log`.
   Fidelity verifies all 33 skills and fresh pinned native snapshots; no new
   policy fence or native pin change. Build retains SDK 0.4.104 and reports the
   existing installed-builder SDK 0.5.29 advisory; no dependency upgrade.

## Parent acceptance still required

The parent verified the preceding startup commit with 766 passing tests,
typecheck, fidelity, build, and two native startup proofs. That result predates
this packaging correction. Parent runs final integration and the isolated ACP
cold entry with the newly generated package. Use the read-only package checker
before launching that acceptance turn. Production activation remains pending.
