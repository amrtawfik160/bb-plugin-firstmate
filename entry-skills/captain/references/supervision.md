# BB supervision transport

Native `AGENTS.md` section 8 and its referenced upstream skills own supervision policy.
Use [the BB harness reference](bb.md) for the event-driven watch handoff.

## Durable wake handling

<!-- BB-DIVERGE
     native: AGENTS.md § 3
     native-quote: Presented records remain durable until the handling turn runs the generation-bound acknowledgement printed by the drain.
     bb: firstmate_wake returns a durable receipt; handledWake completes it only after the batch is handled.
     reason: BB tools carry the receipt through model turns and complete it after successful actions. -->
<!-- BB-ONLY: BB receipts preserve unread work until handling completes. -->
Call `firstmate_wake` to read the batch and retain its receipt ID; `ack: true` on `firstmate_wake` is read-only compatibility.
Handle the whole batch, then pass its ID as `handledWake` on the final successful direct Firstmate tool, or call `firstmate_wake` with `handledWake` if no action remains (`bb firstmate wake --handled-wake <id>`).
If `firstmate_wake` reports truncation, read the full saved report before completing its receipt.
If receipt completion fails after a successful action, retry completion through `firstmate_wake` without repeating the action.
An uncertain action receipt requires reconciling external state before any retry. Generic `firstmate_fm` scripts complete their receipt afterward through `firstmate_wake`.
Legacy `firstmate_wake` `ackThrough` and `recoveryGeneration` must match an outstanding receipt; prefer `handledWake`.
<!-- /BB-ONLY -->
