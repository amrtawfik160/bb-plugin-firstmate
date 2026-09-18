# bb-plugin-firstmate

Run [firstmate](https://github.com/kunchenguid/firstmate)-style crews inside BB:
one captain thread dispatches crewmate child threads and brings back finished work.

Install the plugin, then run `/captain` in any thread (it calls `bb firstmate deck`).

- `server.ts` — crews in kv + thread pluginMetadata; `bb firstmate` CLI; `firstmate_*` tools; thread idle/fail events; Fleet RPC.
- `app.tsx` — Fleet nav panel + thread-header chip.
- `skills/` — `captain`, `firstmate`, `afk`, `ahoy`, `bearings`, `quiet`, `stow`.

Native BB mapping: worktrees, threads, `threads.wait`, environment diffs/PRs, ff-only local land.

Real firstmate `bin/` scripts are the policy engine. BB is a session backend (`backends/bb.sh`), same role as tmux/orca. `bb firstmate init --real` clones firstmate, overlays that adapter, sets `config/backend=bb`. Then `bb firstmate fm <script>` runs any `bin/fm-*.sh` on the host.

Install: `bb plugin install path:/root/github_projects/bb-plugin-firstmate --yes`
then `/captain`.
