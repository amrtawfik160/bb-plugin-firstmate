# PR follow-up

A manager reconciles check results independently. A recovered check stops appearing as a current failure while another check still fails.

## Sub-features

- `pr-register` retains the original task and delivery requirement.
- `pr-reconcile` updates independent check status on one commit.
- `pr-inspect` reports only current unresolved failures.
- `pr-account` refuses accounting against a resolved failure.

## How to get to it (user POV)

Use `bb firstmate deliveries register`, `reconcile`, `inspect`, and `account`, or the corresponding deliveries tool actions.

## Driving it with verify-firstmate

Preconditions: package doctor passes. The plugin's CLI harness uses real SQLite and simulated forge output at its external command boundary.

1. Run the helper with `--feature pull-requests --evidence "$FIRSTMATE_VERIFY_EVIDENCE"`.
2. Register an owned PR through the public CLI and reconcile two failing checks.
3. Reconcile one passing check while the other still fails.
4. Inspect through the public CLI. Require only the second check to remain unresolved.
5. Attempt accounting for the passing check. Require refusal.

## Gotchas

Real forge observation, notifications, merge authority, and background follow-up are separate entry points. Incomplete or unknown observations must retain unresolved evidence. The focused SQLite regression covers that branch separately.
