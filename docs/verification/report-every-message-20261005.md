# Every-message reporting continuation correction

Parent actual-provider evidence on frozen 0597d08 distinguishes two results:
final response 1145 is self-contained and includes the two findings, code/browser verification limits and the fix-both question;
intermediate message 1004 narrates pending report handling and violates native section 9.
After real handling, the queue is empty and the receipt is absent.
Evidence remains parent-owned at `/root/firstmate-bb-homes/thr_jm4qnewqmf/data/acceptance-0597d08/acceptance.md`, `report-events.json`, `report-result.json`.
This is not blanket model acceptance.

The private Stop continuation now prints the native every-message translation rule before receipt/queue handling instructions.
It also quotes native's evidence-to-outcome and final-message rules exactly.
The same words exist in both audited native revisions, verified by the executable hook regression.
The change adds no outgoing-text filter, public-message suppression, automatic acknowledgement or alternate reporting policy.
Native guard precedence, explicit receipt recovery/completion and bounded continuation remain intact.
The owning captain's reviewed deck refresh detects changed hook bytes through the existing hook hash; this author did not install or refresh any live hook.

## RED, GREEN and causal proof

```sh
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified node --test --experimental-strip-types --test-name-pattern='late audit notification' scripts/wake-receipt.test.ts
FIRSTMATE_TEST_NATIVE=/tmp/fm-launch-pr-verified node --test --experimental-strip-types --test-name-pattern='late audit notification|captain stop hook|real native drain' scripts/wake-receipt.test.ts
```

Before correction, the public hook test fails: the native every-message rule does not precede handling.
After correction, 4/4 hook and real disposable native-drain tests pass, with zero skips.
Removing the every-message sentence kills the same regression (exit 1); restored code passes (exit 0).
The test observes private feedback order, exact native bytes, unread reports, explicit receipt completion and recursion behavior.
It does not generate model prose or prove guaranteed future compliance.
Parent owns repeating actual ACP reporting acceptance, independent review and activation.

Logs are retained under `report-every-message-20261005-evidence/`.
Full integration checks follow the separately settled dispatch changes; no partial full-suite claim is made for this correction alone.
