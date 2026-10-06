# Assignments and recovery

Each task retains its owner, full assignment, execution settings, and delivery contract across replacement and lost cache state.

## Sub-features

- `task-scope` preserves different tasks with one shared task ID.
- `task-replace` sends the owning supervisor's complete assignment to its replacement.
- `task-recover` restores the original assignment and execution after reload and cache loss.
- `task-legacy` refuses unproved legacy text and migrates only complete exact-worker evidence.

## How to get to it (user POV)

Use `bb firstmate dispatch`, `bb firstmate retry`, `bb firstmate crew`, and the corresponding dispatch/retry/crew tools.

## Driving it with verify-firstmate

Preconditions: package doctor passes. These cases use the plugin's public CLI harness with a simulated external BB SDK boundary and real SQLite.

1. Run the helper with `--feature assignments --evidence "$FIRSTMATE_VERIFY_EVIDENCE"`.
2. Require different supervisors with matching task IDs and prefixes to retain their own task tails after replacement and reload.
3. Require cache-loss recovery to reject changed retry text and restore the original worker without a new spawn.
4. Require unavailable original intake and ambiguous legacy storage to refuse before stopping or creating a worker.
5. Require complete exact-worker legacy evidence to preserve the original task and stored evidence.

## Gotchas

These CLI cases do not prove actual model behavior or native intake at both pins. Tool dispatch parity, native brief/resolver/backlog/spawn, owner handoff, and real worker execution remain separate mapped entry points covered by the repository's broader suites and live acceptance.
