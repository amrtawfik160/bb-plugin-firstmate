# Parent acceptance: legacy launch adoption

The final candidate `5f00f7e81cea525b9e4fd34a725939c0e06eab7f` passed independent review and was activated on 2026-10-04.

## Verification

- Full final suite: **686 tests passed; zero failures, cancellations, or skips**. Executed from an immutable candidate against a fresh disposable native installation.
- Parent TypeScript and fidelity checks passed. Source build passed. Every integrated file matched the reviewed commit byte for byte; pre-existing source changes were preserved.
- The first candidate run had one stale disposable-helper failure. Refreshing that fixture cleared the test. The final full run above includes the refreshed fixture and both review corrections.
- Independent review reproduced the original branch-contract defect, then confirmed the same reproduction passed unchanged after correction. Six additional focused correction tests passed.
- Plugin reloaded; four plugin services running. All **15 installed adapters** verified. Native HEAD and tracked/untracked status remained unchanged in each home.

## Live repair

The owning captain is `thr_mhk69hwvxe`, task `574cbb72`, worker `thr_bu9ygrwxem`, project `proj_5s59gfpfqq`.

The supported `launches adopt ... --check` command confirmed eligibility using the actual SDK identity, original prompt, native task, environment, and repository evidence. The same command without `--check` completed registration. `firstmate crew 574cbb72` returned the existing worker, owner, execution settings, preserved native done state, and no open decisions.

Native metadata preserves `branch=fm/574cbb72`. It records explicit repair, original admission unconfirmed, and `yolo=off`. Adoption does not create merge authority.

Before/after checks confirmed unchanged task files (including brief, status, artifacts and existing inbox contents), HEAD, current branch, dirty state, and all task branch refs. No replacement worker, restart, forge write, or merge was performed. Historical task `4b4adda5` was not repaired or changed.

Separate durable obligations were registered for [PR 2043](https://github.com/Cyndra-AI/cyndra-saas/pull/2043) and [PR 2047](https://github.com/Cyndra-AI/cyndra-saas/pull/2047). Both retain the owning captain and original merged requirement. Current forge checks and guarded merge remain the captain's responsibility. The captain received the verified repair result and these limits.

## Evidence

Raw parent logs and preservation snapshots are under `/tmp/fm-adoption-parent/`. Durable selected evidence is under `/root/firstmate-bb-homes/thr_jm4qnewqmf/data/legacy-launch-adoption-20261004/`.

This acceptance proves registration and delivery tracking. It does not claim either PR has merged.
