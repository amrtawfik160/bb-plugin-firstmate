# Native scripts own policy; the plugin owns transport + BB surfaces

The firstmate captain/crew behaviour (briefs, backlog, gate/DoD, afk, quiet,
memory, wake, supervision) is owned by the upstream native `bin/fm-*.sh` scripts,
run under `FM_BACKEND=bb`. This plugin owns only the transport (spawning BB
threads + managed worktrees, host file I/O, event wiring) and the BB surfaces
(Fleet UI, `firstmate_*` tools). Policy decisions route *through* the real scripts
rather than being re-decided in TypeScript.

## Considered options

- **Port all policy to TypeScript** (rejected). The policy surface is large and
  fast-moving upstream. Duplicating it in TS recreates the drift problem: every
  upstream change would have to be re-implemented and re-verified here, and the two
  copies would silently diverge in edge cases (the exact refusal predicates, the
  status grammar, the recovery/ack state machine). Keeping one authoritative copy —
  the native scripts — and mapping it onto BB primitives is the only way the plugin
  stays faithful to a protocol it does not own.

## Consequences

- Real state (`state/`, `data/backlog.md`, contracts, memory files) is
  authoritative; BB KV is a rebuildable cache/projection.
- Behaviour must be verified against the real scripts, not a TS reimplementation
  (see `CONTRIBUTING.md`). A TS stub cannot tell you the real gate refuses a brief.
