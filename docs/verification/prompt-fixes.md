# BB worker prompt and exact-message acknowledgement corrections

The prompt and helper corrections are implemented in the isolated plugin checkout. Existing old native homes cannot be refreshed with the current full installer: its exact patch set targets a different native source. No production plugin, native home, fleet, worker, or model was changed during this work.

Review baseline: `33d5cb0e6ed2e8abcb45bf36d911e830abeb6b16`. This correction builds on the completed launch/PR work, rather than replacing it. Parent-owned [acceptance evidence](parent-launch-pr-acceptance.md) remains unchanged. The prompt findings originate in `/tmp/firstmate-prompt-review.JUSIMU/review.md` and its actual-helper `probe.py` reproduction.

## Review findings and implementation

| Finding | Implemented boundary | Causal verification |
| --- | --- | --- |
| 1. An arrival after read was acknowledged without action | [Bash entry](../../overlay/bin/fm-inbox-take.sh) delegates exact immutable basenames to [helper](../../overlay/bin/fm-inbox-take.py). Bare `--ack` refuses before mutation; read prints handled-set command. Validation opens task namespace/message files without following symlinks, preflights requested IDs and never overwrites handled evidence. | Read 001, add 002, refuse bare ack, acknowledge 001, retain 002; multiple IDs; already-handled retry; unknown/malformed/traversal IDs; symlinked files/directories; mixed unknown batch; interrupted link/unlink recovery. Old bulk helper fails the arrival test. |
| 2. Contradictory browser and inbox policies | [Shared renderer](../../overlay/bin/backends/bb-worker-prompt.py) translates recognised native Rules/Inbox anchors once. Task, copied captain intent and home additions stay verbatim. Source briefs stay unchanged for native gates. | Both native source pins, rule-like Task text, Task script-path bait, exact body preservation; missing/changed policy anchors refuse with no output. Removing the browser translation or rewriting Task fails assertions. |
| 3. Generic artifacts and contradictory write scope | Renderer resolves `<home>/data/<task>/` once, names own status/inbox/handled/artifacts and native scout report. [Transport fragment](../../overlay/bin/backends/bb-worker-transport.txt) uses the resolved path. [Server](../../server.ts) no longer appends the generic artifact footer. Native status command, including fleet-ledger authority, survives intact. | Ship/scout paths and scoped write rule; rendered legacy footer removed while source stays unchanged; generic placeholder/broad rule mutations fail. |
| 4. Task buried under duplicated and conditional text | Native current role, Task, execution constraints, and completion come first. Full conditional Herdr, daemon and Lavish material remains in end references with strong inline pointers. Herdr default hard gate and shared daemon/worktree administration restrictions stay inline. | Ship direct-PR/no-mistakes/local-only and scout, Herdr lab/default, sparse status/exact-key/no-self-merge/pushed-head/non-draft/native-mode checks; complete native Herdr lab contract preserved; opt-in waiting stays opt-in. |
| 5. Replacement used stale source and companions could be absent | [Adapter](../../overlay/bin/backends/bb.sh) shares one native-validated renderer for initial/replacement. Replacement prefers native `launch-brief.md`, preserves intent and validates delivery mode; readable source fallback receives fresh native role. [Installer](../../overlay/install-bb-backend.py) ships both Python companions; manifest and runtime checks compare actual owned file hashes. Thin SDK instructions point to the native-rendered policy. | Actual initial adapter with fake CLI, actual registered replacement retry, seeded metadata checks already retained, missing brief/wrong mode refusal before stopping, stale-helper refusal before stop/spawn, install/backend-source/verify/missing-file checks. Selecting stale brief or omitting companion/integrity fails assertions. |
| Additional obsolete doorbell caller | Server steering doorbell and compatibility contract now name explicit handled IDs; helper usage also requires IDs. | Caller/helper searches and existing exact-inbox server regressions. |
| Old-home activation | Full installer deliberately retains exact application; no updater, compatibility guessing or pin change added. | Actual disposable deployed-pin clone install fails; previous mirror bytes/marker and tracked native tree survive. |

The renderer is a marked BB transport boundary, not a new native policy owner. Native task-content/operator-address checks and current-role generation run before rendering. Only recognised native scaffolding is adapted. Unknown or ambiguous scaffold structure refuses; it does not emit a contradictory fallback or modify the source. This is deliberately stricter than accepting arbitrary custom briefs.

Conditional references remain **in the prompt**. Their placement clarifies when they apply; it does not remove their tokens or establish model-quality improvement. Actual model compliance and token savings have not been measured. No real worker/model launch was used for these tests.

The inbox helper uses the native Bash library to decode its envelope, preserving native body bytes. A legacy plain-body inbox without that library remains readable; a structured native envelope without its decoder refuses. Exact ack uses same-filesystem no-overwrite hard links, then removes the pending link. Same-inode interrupted acknowledgements recover safely. This adapter targets the existing Linux/Python host environment, including `/proc/self/fd` and `O_NOFOLLOW`; it is not a new cross-platform inbox implementation.

## Validation

All native inputs were read from or cloned out of `/tmp/fm-launch-pr-verified`. The installer was run only on this scratch home and disposable clones. Its tracked native source stayed at the audited pin. The full test fixture's owned transport mirror was refreshed before its lifecycle tests; the new integrity check correctly refuses an older helper.

```bash
python3 overlay/install-bb-backend.py --home /tmp/fm-launch-pr-verified
python3 overlay/install-bb-backend.py --home /tmp/fm-launch-pr-verified --verify

FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified \
FM_TEST_HOME=/tmp/fm-launch-pr-verified \
FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb \
FM_CLASSIFY_LIB=/tmp/fm-launch-pr-verified/bin/fm-classify-lib.sh \
node --test --experimental-strip-types \
  --test-name-pattern='native replacement|native worker transport|native local merge|BB bootstrap|BB adapter.*prompt|inbox.take' server.test.ts

FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified node --test scripts/prompt-inbox.test.mjs

FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified \
FM_TEST_HOME=/tmp/fm-launch-pr-verified \
FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb \
FM_CLASSIFY_LIB=/tmp/fm-launch-pr-verified/bin/fm-classify-lib.sh \
node scripts/prompt-fix-mutation-check.mjs

FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified \
FM_TEST_HOME=/tmp/fm-launch-pr-verified \
FM_SCOUT_NATIVE_BIN=/tmp/fm-launch-pr-verified/bin-bb \
FM_CLASSIFY_LIB=/tmp/fm-launch-pr-verified/bin/fm-classify-lib.sh npm test

npx tsc --noEmit
npm run fidelity -- --native /tmp/fm-launch-pr-verified
bb plugin build .
git diff --check
```

Results: full suite 654 passed, zero failed, zero skipped (179979 ms). Affected server tests: 7 passed, zero skipped. Native prompt/inbox tests: 12 passed, zero skipped. Mutation checks: all 8 removed fixes produce assertion failures. Typecheck, build and diff check pass. Fidelity passes: 33 skills, 12 marked adaptations, 7 authorised BB-only sections, snapshots fresh against the scratch native source. Build reports the existing SDK version difference; the contract pin remains 0.4.104. No app/RPC schema changed.

Logs: `/tmp/fm-prompt-affected-final.log`, `/tmp/fm-prompt-target-final.log`, `/tmp/fm-prompt-mutations-final.log`, `/tmp/fm-prompt-full-final.log`, `/tmp/fm-prompt-tsc-final.log`, `/tmp/fm-prompt-fidelity-final.log`, `/tmp/fm-prompt-build-final.log`. Earlier development runs exposed a missing Python `-c` flag and an incorrectly selected ordinary retry in the new test; both were corrected before final verification. A subsequent lifecycle fixture run correctly rejected old scratch transport bytes; refreshing that scratch mirror restored its existing guarded merge test.

[Sanitized rendered example](prompt-example.md) uses actual native generation and the shared renderer, with substituted example paths and bounded task details. No customer attachments are copied.

## Activation limit and bounded next actions

Disposable deployed native source: `2d833ff147cd26a5c461e914e06854e0eb2707ce`. Current full installer patches: `1f3e769616fdf9f31f85f4c3e6a9f71606634238`. Running the existing installer on the older clone fails non-zero:

```text
INSTALL FAILED: a hunk of firstmate-bb-backend.patch did not apply to the pristine native source
patch exit=1; rejects: bin/fm-backend.sh.rej
The mirror was NOT changed; any previously-working bin-bb is intact.
```

Evidence: `/tmp/fm-prompt-old-installer.log`; automated reproduction in `scripts/prompt-inbox.test.mjs`. The loader difference is substantive: older native uses `siblings=...`, newer native uses positional `set -- ...`. Retaining a newer clause against the older native loop cannot be treated as compatibility. Rendering tests on both sources prove prompt compatibility, **not** successful installation of the full newer patch set on an older home.

1. Parent reviews these corrections and retains isolated live acceptance ownership. Existing running workers keep their previously supplied prompts; this change does not rewrite their context.
2. Before old-home activation, prepare and audit an exact old-pin patch set in the **existing installer**, selected by full native source SHA. Keep the older loader clause with its older loop, retain the new audited patch set separately, and refuse unknown source versions. Test all patched scripts and backend source loading on disposable clones, including seeded secondmate and teardown. Do not copy helpers into production as an undocumented partial refresh.
3. After that compatibility work passes review, parent can refresh mirrors and run isolated initial/replacement/inbox acceptance. No native upgrade or new updater is proposed here. `refreshMirror` still calls the full installer, so an old-home refresh remains blocked until compatibility is audited.
