# Self-contained runtime implementation progress

Baseline: `0d0f03c` (startup implementation `e581c36` plus parent activation evidence).
Authorized implementation only; production integration/migration remains parent-owned.

Discovery completed:
- Audited upstream `1f3e769616fdf9f31f85f4c3e6a9f71606634238` and legacy
  compatibility pin `2d833ff147cd26a5c461e914e06854e0eb2707ce` remain unchanged.
- Upstream LICENSE is MIT, copyright 2026 Kun Chen. Redistributed copies must
  retain copyright/permission notice. Ship complete license plus attribution.
- Native `fm-home-seed`, remote-home provisioning, secondmate control,
  `fm-on`, bootstrap primary identity and overlay pristine-source checks require
  Git identity/committed files; a plain export is insufficient.
- Existing server init clones/fetches upstream; captain home provisioning clones
  a shared external base. These are the paths to replace for clean installs.
- Existing external homes and recorded worker paths must stay supported;
  bundled selection is explicit for them, with no in-place native update.
- Native FM_HOME/config/state/data overrides permit separate durable homes and
  versioned code roots. Relative SCRIPT_DIR siblings require a complete runtime.
- Public SDK files.write/remove plus structured host terminals are the transfer seam. No core/private packaging API or server path
  will be assumed accessible on the execution host.

Implemented architecture:
- Reproducible filtered single-commit Git snapshot (original upstream bytes,
  no credentials/history/tests/development configs), manifest records distinct
  upstream SHA and synthetic package Git identity. Include native runtime/hook/
  skill/doc resources; matching adapters staged as part of the same release.
- Atomic, hash-verified host publication under user-owned persistent data;
  immutable version directories retained, separate captain state directories.
- Existing external mode stays unchanged. Upgrade/migration/rollback selection
  is explicit, guarded against active runtime consumers and retains old code
  and task state. No automatic provider/model/owner/task-contract mutation.
- One runtime CLI/tool status/selection surface; native update stays release-
  managed for bundled installations. Native policy remains authoritative.

Implemented: filtered Git generation, matching adapter archive/manifest/license,
public SDK host staging with late-write cleanup, serialized native task-set guarded
selection, external migration/rollback, preserved old versions, clean/seeded captain
bindings, worker initial/replacement code-root selection, status CLI/tool and docs.

Final observed verification:
- Clean source CLI/tool bindings, built entrypoint, native startup under current
  harness, all ship/scout delivery modes with real scripts/fake BB, replacement
  work preservation, both external pins/migration/rollback, concurrent install,
  checksum/source/ownership refusals, publication faults and KV reload recovery.
- Ten causal mutations killed their named behavioural regressions in private copies
  (`/tmp/fm-self-contained-runtime-mutations-release/results.json`).
- First full run: 791 tests, 787 passed, 4 failed; three affected presentation/path
  fixture assertions corrected, one stale private native fixture replaced with an
  owned current mirror. No production state involved.
- Final complete native startup proof: installed/bound in 1218 milliseconds,
  startup 6968 milliseconds, archive 2666874 bytes; no external native repository.
  Earlier measurements used earlier package bytes and are superseded.
- Final release `597623fe465df0234bb58eee41b06fc0d4cc686e3949530e9654461ea7574ae9`:
  798/798 full tests, zero failures/skips; 30 affected runtime tests and 7 built
  SDK factory tests passed; typecheck, fidelity, build, diff check and byte-for-byte
  generation/packaging reproducibility passed.

Evidence and procedures: [self-contained-runtime.md](self-contained-runtime.md).
Implementation and local/native verification are complete, pending parent review.
Parent must perform real BB-host/model worker completion/delivery/reload acceptance
on an isolated server; the agent is forbidden to launch/delegate model workers.
No activation or migration performed. No claim of complete live acceptance.
