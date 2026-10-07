# Pinned native runtime

New captains use a bundled Firstmate release when `fmHome` is blank. Existing externally managed homes stay external. Installing the plugin does not bundle BB, system tools, credentials or models.

## Install and start

1. Install the tested BB plugin release, then run `/captain` or `bb firstmate deck --json` in the owning thread.
2. Binding transfers the plugin-owned archive and helper through public SDK host files. It installs offline on that thread's actual execution host, verifies native and adapter bytes, and atomically publishes a durable captain home.
3. Run the returned startup command through the agent shell. Require the complete native digest, prerequisites and successful native lock. Deck reports readiness pending until this native startup runs.
4. Inspect `bb firstmate runtime status --json` when setup fails. No external checkout or network-update fallback is attempted.

The host store is `$HOME/.local/share/bb-firstmate/versions/<release-sha256>/`. Each selected version contains a filtered Git snapshot of unchanged upstream source, matching `bin-bb` adapter, license and hash manifest. A real single-commit Git repository preserves native clone, `HEAD`, tracked-script and pristine-source contracts; it carries no upstream history, remote, credentials or session files. Source generation is maintainer-only, from the audited SHA. Runtime startup never obtains an unpinned source.

Captain homes live separately at `$HOME/.local/share/bb-firstmate/homes/<thread-id>/` and retain config, state, task briefs, inboxes, reports and projects. Their `config/bb-runtime-selected.json` records the exact host/captain, selected release, code root and helper identity. BB KV mirrors that binding for discovery; the on-host selection remains authoritative after interrupted publication. Native-seeded secondmates retain separate homes and their parent's selected release. Worker prompts and replacements resolve code through the selected version while writing only their existing task-owned paths.

## Update, migrate and roll back

`bb plugin update firstmate` updates plugin assets. It does not upgrade native code under an existing worker or select a new runtime. From the owning captain:

```sh
bb firstmate runtime status --json
bb firstmate runtime install                    # stages current plugin bundle only
bb firstmate runtime select <exact-release> --check
bb firstmate runtime select <exact-release>      # explicit authorized selection
```

For an existing external home, use `migrate` instead of `select`. Migration checks the full external source SHA against the audited registry and verifies its matching mirror. Native task records, session/spawn/control locks, active watchers and reserved/running/uncertain BB launches refuse migration or selection. The native task-set lock serializes publication against admission. Checks are read-only snapshots; the mutating call repeats the checks under locks.

Migration changes only the runtime selection file. It does not remove the external checkout, copy or reset state, change ownership, resume workers, change execution settings, rewrite tasks or grant merge authority. A home with retained task identities must keep its runtime until those native records are legitimately retired. One exception: a select or rollback whose target has the same upstream commit, snapshot commit, state contract and native file digests as the selected release, so only BB adapter files (`overlay/`, `runtime-host.py`) differ. Running crews keep the release root they recorded; that folder stays installed, and `runtime status` reports it in `referencedReleases`. Keep the old home/code intact; do not delete records or locks to force migration.

```sh
bb firstmate runtime migrate <exact-release> --check
bb firstmate runtime migrate <exact-release>
bb firstmate runtime rollback <recorded-previous-release> --check
bb firstmate runtime rollback <recorded-previous-release>
# After migrating from an external home, its recorded previous target is external:
bb firstmate runtime rollback external --check
bb firstmate runtime rollback external
```

Rollback requires the same supported state contract and a recorded previous runtime. External rollback additionally requires the original external Git identity and verified mirror. It restores selection, preserves all newer task state, and retains both runtime releases. There is no state-schema downgrade or automatic garbage collection. Hooks/watchers and worker paths can still name older releases; never manually remove them while referenced.

If an operation loses its response, inspect `runtime status --json` to recover the actual selection and pending BB journal, then retry the exact target if required. Do not choose a new target while the earlier publication is unresolved. Interrupted installation leaves either a fully verified immutable release or an unselected staging directory; an identical retry converges on one verified release. Unknown sources, escaping paths, mismatched bytes and foreign captain/host bindings refuse.

## Dependencies and scope

Required transport/install tools: BB CLI and connected host, SDK 0.4.104 or newer, Git, Python 3 with POSIX locks, Bash, GNU patch and ordinary Unix tools. Native bootstrap remains the authoritative dependency detector for tasks-axi, quota-axi, gh-axi, no-mistakes and Lavish. `/browser` replaces the native AXI browser in BB; forge credentials remain host-local. Conditional native workflows retain their own Herdr, treehouse, systemd, SSH, tmux or harness prerequisites; bundling native scripts does not enable an unsupported BB backend or provider.

Native development lint/test commands require the upstream development checkout, which is excluded from the runtime. Bundled `firstmate_fm` refuses `update`, `test-run`, `test-isolation-proof`, `lint` and `lint-workflows` with an actionable release/development instruction. Operational scripts, contracts, skills, static hooks, templates and docs are included. Native optional preferences remain opt-in.

MIT copyright/permission notice is shipped in `runtime-assets/LICENSE.firstmate` and each installed release; attribution is in `NOTICE`. The release manifest records upstream source/commit, distinct packaging Git identity, adapter fingerprint and every payload hash. See [verification](verification/self-contained-runtime.md) for exact evidence and remaining acceptance obligations.
