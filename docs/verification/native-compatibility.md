# Exact old/new native compatibility and FIFO inbox correction

The existing installer now supports both audited native sources, without changing the native pin or introducing an updater. Production activation is pending parent review/integration. This implementation agent made no production changes and launched no models.

Correction baseline: `56295c14f26381ed817e74a6cb6d8374b1fea162`. Parent independently verified the preceding prompt correction with 654 passing tests, eight mutation checks, real ship/scout acceptance (25 checks), and initial/replacement acceptance (eight checks).

## Implementation and audit

| Requirement | Code and evidence |
| --- | --- |
| Exact full-SHA version selection | [Registry](../../overlay/patch-sets.json) maps exactly the two audited full source SHAs to four patches each. [Installer](../../overlay/install-bb-backend.py) refuses unsupported/non-Git source identity and missing/unshipped/symlinked patch inputs. It retains fuzz-zero application and rejection of offsets/rejects. Selected source is held through generation and checked before publishing. |
| Old loader with old loop | [Old source patches](../../overlay/compat/2d833ff147cd26a5c461e914e06854e0eb2707ce) retain `siblings="fm-composer-lib.sh fm-transition-lib.sh"` with the native sibling-string loop. The newer patches retain positional `set --` with their native loop. Backend loading executes under `set -eu` and proves both sibling APIs exist. |
| All adaptations retained | Old patches were regenerated against pristine old source from the earlier adaptation, including the later startup-cd seam fix. Audit compared added/removed adaptation lines against newer patches; after excluding formatting-only closers/blank lines, only the deliberate loader clause differs. Both version-specific patch sets apply without offsets/fuzz. No upstream skill/snapshot/native pin changed. |
| Native lifecycle and authority | All eight generated scripts pass Bash syntax checks on both pins. Real native home-seed/spawn/teardown executes with a recording fake BB transport. Separate registered tests run guarded local merge, captain hold, cleanup, seeded secondmate, and stop failure on each pin. No BB worker/model is launched; native merge/cleanup applies only to disposable fixture repositories. |
| Manifest and fingerprint | Mirror records selected full SHA and selected patch-set digest. Verification checks them against the registry and detects missing/mismatched provenance or overlay drift. [Server](../../server.ts) and installer hash the same bundle, including registry and all four old patches. |
| Remote installation | The declared bundle can install and verify both pins. Actual registered `mark-captain` tests force the remote-upload branch, execute payload staging and the real remote installer, compare every uploaded file byte-for-byte, verify the mirror, and confirm seeded-home source SHA stays unchanged. |
| Atomic refusal and migration | Unknown source and a deliberately mismatched old/new patch selection both refuse without changing the working mirror. Migration proof now rejects a synthetic unsupported fast-forward, proves the mirror survives, then returns to audited source for refresh. Its old-order mutation still exposes a BB-less window. |
| FIFO blocking | [Inbox helper](../../overlay/bin/fm-inbox-take.py) uses `O_NONBLOCK` with `O_NOFOLLOW` before `fstat`. Pending read/ack and handled ack fixtures promptly exit 2 for FIFOs, preserving valid messages and handled evidence. Each reproduction has a two-second timeout; removing the flag fails causally. |

The registry is the installer’s sole version-selection owner. [Patch drift check](../../scripts/patch-drift-check.mjs) resolves through it, rather than maintaining another source map. Unknown upstream commits remain unsupported until audited. Existing legacy in-place patched tracked files retain the prior installer behavior: generate from committed native inputs and warn about preserved working-tree edits; never reset them automatically.

Historical old-home installer refusal is recorded in `/tmp/fm-prompt-old-installer.log`. This correction replaces that refusal with exact compatibility; it does not accept fuzzy patches, alter native sibling loops, or upgrade native sources. Existing explicit initialization/update commands retain their earlier behavior; activation here uses mirror refresh on an already-bound supported home.

## Validation

```bash
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified \
node --test --experimental-strip-types scripts/native-compat.test.mjs scripts/prompt-inbox.test.mjs

FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified \
FM_TEST_HOME=/tmp/fm-launch-pr-verified \
node --test --experimental-strip-types \
  --test-name-pattern='installer|failed re-install|registered remote overlay|shared-env BB crew|active BB crew' server.test.ts

FM_TEST_HOME=/tmp/fm-launch-pr-verified \
node --test --experimental-strip-types \
  --test-name-pattern='migration off the in-place patch|zero.window' server.test.ts

FM_TEST_HOME=/tmp/fm-launch-pr-verified node scripts/patch-drift-check.mjs --ref 2d833ff147cd26a5c461e914e06854e0eb2707ce
FM_TEST_HOME=/tmp/fm-launch-pr-verified node scripts/patch-drift-check.mjs --ref 1f3e769616fdf9f31f85f4c3e6a9f71606634238

FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified node scripts/compat-mutation-check.mjs
npx tsc --noEmit
npm run fidelity -- --native /tmp/fm-launch-pr-verified
bb plugin build .
git diff --check
```

Results: 18 prompt/compatibility tests pass; 12 affected server tests pass; migration test passes with its old-order mutation. Each pin additionally passes the same three native lifecycle server tests using a freshly installed disposable clone as `FM_TEST_HOME`:

```bash
FM_TEST_HOME=<installed-disposable-clone-at-the-pin> \
FIRSTMATE_TEST_NATIVE=<installed-disposable-clone-at-the-pin> \
FM_SCOUT_NATIVE_BIN=<installed-disposable-clone-at-the-pin>/bin-bb \
FM_CLASSIFY_LIB=<installed-disposable-clone-at-the-pin>/bin/fm-classify-lib.sh \
node --test --experimental-strip-types \
  --test-name-pattern='IT native local merge|IT BB secondmate launch|IT native secondmate seed' server.test.ts
```

All selected tests have zero failures and zero skips. All five compatibility/FIFO mutations kill their behavioral assertion. Exact drift checks pass all four patches at each source SHA. Typecheck, fidelity, build and diff check pass. SDK pin remains 0.4.104; build emits the existing host-SDK difference. No app/RPC schema changed.

Logs: `/tmp/fm-compat-target.log`, `/tmp/fm-compat-server.log`, `/tmp/fm-compat-remote.log`, `/tmp/fm-compat-native-lifecycle.log`, `/tmp/fm-compat-migration.log`, `/tmp/fm-compat-mutations.log`, `/tmp/fm-compat-drift-old.log`, `/tmp/fm-compat-drift-new.log`, `/tmp/fm-compat-adaptation-audit.log`, `/tmp/fm-compat-tsc.log`, `/tmp/fm-compat-fidelity.log`, `/tmp/fm-compat-build.log`.

Parent reported independent real old-source ship/scout acceptance passing 25 checks out of 25. Parent’s final integration suite passed 662 tests, with zero failures and zero skips (`/tmp/fm-compat-parent-full-final.log`). Tested source hashes match `/tmp/fm-compat-candidate-hashes.json`; independent compatibility review was clear. Parent owns production activation, which remains pending. The full suite was not unnecessarily repeated by this agent after affected checks passed. Existing workers retain their supplied prompt. Future source SHAs require audit before registration.
