# Parent acceptance: wake command size

Activated candidate `279e8da` on 2026-10-04 after independent review and verification.

- Full final suite: **695 passed, zero failed or skipped**. Immutable candidate; full log saved with durable evidence.
- Previous candidate: 689 passed and six old timeout fixtures failed. Correction updated only those tests; the final suite above includes all eight timeout cases.
- Independent standards/spec reviews found no blockers. Exact receipt execution budgets and no-retry behavior remain tested. The timeout fixture simulates base64 scratch deletion during rename, so its empty-file assertion alone does not prove scratch cleanup; actual live cleanup was checked separately.
- Parent typecheck, fidelity and build passed. Integrated files matched the final candidate byte for byte. Existing source changes were preserved.
- Parent causal mutation reproduced the original `10011 > 10000` refusal before host execution. The final full suite ran afterward without mutations.
- Actual host transport proof passed five cases: 10-byte, 10-KB, 200-KB, quote/unicode content, and failed-write preservation.

## Activation and actual wake

Plugin reloaded with all four services running. This change modifies server transport only; no native upgrade or adapter installation was needed.

The real owning captain `thr_example03` successfully read its wake queue through the staged script. A second read returned the same receipt with the replay marker. At handoff, receipt `d720626489e14c8dbcb641e8c514bd7e` was `ready`; no acknowledgement was requested. The full report remained in the captain's native `.bb-wake-reports` directory. No newly created temporary receipt scripts remained after execution.

The owning captain received the receipt and report location, with instructions to read and handle the entire report before completing the receipt. This acceptance does not claim its reports have been handled.

Durable evidence: `$CAPTAIN_HOMES/thr_example04/data/wake-command-size-20261004/`. It includes final tests, causal mutation, live transport results, queue snapshots, retained report, live replay, and receipt state at handoff.
