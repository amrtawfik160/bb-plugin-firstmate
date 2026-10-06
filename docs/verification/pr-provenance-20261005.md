# Public PR source provenance — 2026-10-05

## Evidence and bounded correction

Parent actual isolated worker `thr_gzkskzz5ks`, ACP Grok4.7/high, read worker entry, decision-trail and `/pr` through `firstmate_methods` at seq167/244/285. The last read delivered the complete 4169-byte skill body through the terminal marker, SHA256 `ab63f1cf78647389edcd386c9427c5dfca27ed2836930c24773ffee834c19bcd`. The page showed a transport snapshot, but no resolved SDK source revision. The worker then searched broader paths for the requested revision; parent stopped that scope drift. This is a provenance usability defect, not a failed byte-delivery claim or proof that missing metadata alone caused all model behavior.

Read-only evidence supplied by parent: `/root/firstmate-bb-homes/thr_jm4qnewqmf/data/acceptance-0e521d6/worker-read-proof.json` and `worker-events.json`. Only that authorized worker evidence was inspected. Parent owns the same-worker read/artifact repeat after refreshing the isolated package. No new worker, replacement, production setting or activation was performed.

`installedPrResource` already obtains and verifies the exact SDK source ID, opaque source revision and SHA256 of complete `SKILL.md`. The correction exposes those existing fields before `BEGIN_PAGE` on **every paged PR response**, including continuations:

```text
FIRSTMATE_METHODS_PAGE … snapshot=<transport identity>
… existing continuation or end instruction …
FIRSTMATE_PR_SOURCE {"id":"<resolved SDK ID>","revision":"<SDK source revision>","sha256":"<SHA256 of complete SKILL.md>"}
Source revision identifies complete SKILL.md; snapshot identifies this transport read.
BEGIN_PAGE
<unchanged skill page bytes>
END_PAGE
```

Source revision is not inferred from the transport snapshot and need not itself be a content hash. Source JSON is validated by the existing strict schema. Metadata stays outside the unmodified body; all pages reconstruct that body exactly. ID/revision values containing quotes, backslashes, newlines, multibyte characters and JavaScript replacement tokens remain literal data. Unpaged operator CLI output remains the complete original body without metadata. Only PR reads acquire this header; native policy and other methods remain unchanged.

## Bounds, identity and limits

- Metadata JSON must fit 2048 UTF-8 bytes **after escaping**. Oversized source evidence refuses, without truncation or a partial page.
- The complete response must stay below 12000 UTF-8 bytes, consistent with the existing bounded native-skill response tests. The body page limit remains 8000 UTF-8 bytes. The check counts the actual rendered metadata/header/cursor/body plus activity marker, serialized in the CLI JSON envelope, including its final newline. This is conservative for both returned tool text and actual paged CLI output. It does not claim a bound on BB-core/provider-owned outer wire envelopes.
- Highly escaped body pages can also exceed the complete-response limit despite fitting the raw body limit. They refuse explicitly; the existing unpaged operator read remains lossless. No source or policy bytes are shortened.
- Existing selected ID/revision/hash validation, actual author workspace lookup, role/mode ownership, owner/home-pinned cursors, changed-source refusal, SDK cancellation and symlink refusal remain authoritative. No new filesystem fallback, source registry, skill policy or PR/merge authority was introduced.
- Exact metadata availability is deterministic adapter proof. Actual worker behavior on the refreshed package remains parent-owned acceptance; it cannot guarantee against broader model drift.

## Public TDD and causal verification

| Slice / command | RED | GREEN |
| --- | --- | --- |
| `node --test --experimental-strip-types --test-name-pattern='public paged PR reads expose' server.methods.test.mjs` | Missing source metadata in actual registered tool result | Tool and paged CLI expose exact source on every page; complete body reconstructed; unpaged output unchanged |
| `node --test --experimental-strip-types --test-name-pattern='public PR reads refuse oversized' server.methods.test.mjs` | Oversized metadata accepted | Multibyte/JSON-escaped metadata and complete escaped response refuse through tool and CLI, without partial pages; operator body still complete |
| Add literal JavaScript replacement-token bait to SDK ID in first public test | String replacement interprets source as substitution syntax and duplicates page data | Callback replacement retains literal source evidence and exact body |

[Initial RED](pr-provenance-20261005-evidence/public-red.log), [size RED](pr-provenance-20261005-evidence/budget-red.log), [literal-source RED](pr-provenance-20261005-evidence/literal-source-red.log), [methods GREEN](pr-provenance-20261005-evidence/methods-green.log).

Run the four bounded causal mutations (each restores the exact source in `finally`):

```sh
python3 docs/verification/pr-provenance-20261005-evidence/causal-mutations.py
```

All four were killed by the public tool/CLI tests: omitted provenance, omitted metadata bound, omitted complete serialized bound, interpreted replacement tokens. Exact commands/results are in [the script](pr-provenance-20261005-evidence/causal-mutations.py) and [result JSON](pr-provenance-20261005-evidence/causal-results.json).

## Checks and delivery

| Command | Observed result |
| --- | --- |
| `node --test --experimental-strip-types server.methods.test.mjs` | 12/12, zero failures/skips; includes existing owner/workspace/revision/reload/cancellation/mode cases |
| `FIRSTMATE_TEST_NATIVE=$(cat /tmp/fm-runtime-native-fixture-final-path) node --test --experimental-strip-types --test-name-pattern='selected .*native policy and complete contract' server.native-policy.test.mjs` | 2/2 actual native composition cases, both audited pins; zero failures/skips |
| `npm run typecheck` | Passed |
| `npm run fidelity` | Passed: 33 skills; no native byte change |
| `npm run runtime:verify` | Passed; native runtime/adapter release unchanged |
| `env -u BB_CLI -u BB_INFERENCE -u BB_INFERENCE_FALLBACK -u BB_TRANSCRIPTION scripts/ci-tools/node_modules/.bin/bb plugin build .` | Passed with locked BB 0.44.0; existing local inference/SDK comparison notices remain |
| `git diff --check` | Passed |

Native proof log: [composition GREEN](pr-provenance-20261005-evidence/native-composition-green.log). This is public adapter/script proof, not a fresh model launch claim. Prior CI-only HEAD 9b2bdaa passed both hosted checks 333/333. This correction is a separate commit; PR53 body uses `/pr`, branch is pushed, and both hosted runs must be monitored before handoff. No merge or production activation is authorized here. Failed every-message reporting acceptance and the external no-mistakes author-read limitation remain open.
