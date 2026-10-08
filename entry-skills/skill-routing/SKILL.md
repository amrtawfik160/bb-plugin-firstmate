---
name: skill-routing
description: "Task-to-skill table for Firstmate supervisors and crewmates. Use before dispatching or starting a bug fix, slowdown, feature, refactor, unclear spec, investigation, review, PR body, or user-facing prose."
---

# Skill routing

pstack always has priority. If a skill or rule conflicts with it, pstack wins.

Match the task to every row that fits and follow the named poteto pstack and
Matt Pocock skills. Read each skill's `SKILL.md` from the skills folder the
brief names, or from `~/.agents/skills/<name>/`, `~/.claude/skills/<name>/`,
`~/.codex/skills/<name>/`, `~/.grok/skills/<name>/`, `~/.gemini/skills/<name>/`,
`~/.cursor/skills/<name>/` or `~/.pi/agent/skills/<name>/`. Many are
user-invoke-only, so read the file directly. A poteto-mode playbook is
`poteto-mode/playbooks/<file>` in the same folders. When a named skill is not
installed on this host, continue without it and say so in your report. That is
the only reason to skip a pstack skill.

Firstmate adds a skills block to every dispatch brief. It gives the full path
to poteto mode and to the playbook chosen from the dispatch title. The
supervisor can pass `playbook` to `firstmate_dispatch` to choose it instead.
A deploy or operator task gets no playbook and follows the delivery contract.
The supervisor names any other matched skills. A crewmate follows the skills
its brief names and any row that matches its own work.

## Poteto mode on every crewmate task

Every crewmate task, ship or scout, runs in poteto mode. Read
`poteto-mode/SKILL.md` in full before any other step, then open the playbook
that matches the task (the rows below name it; use `investigation.md` for a
scout with no other match) and follow its steps. Firstmate names
`poteto-mode` and the playbook in every brief. Copy every playbook step into
your to-do list before any other to-do. Your final report lists each step as
"✓ <step>" or "skip: <step>: <reason>". A bug fix also reports the commit id
of the failing test committed before the fix, and proof on the real product
or "not possible: <reason>".

Poteto mode is for crewmate work only. The supervisor's own replies to the
user keep the user's reply style. Principle names and evidence labels go in
the crewmate's result report, never in a message for the user.

| Task | Skills |
|---|---|
| Bug, failure, crash, or flaky test | `diagnosing-bugs`; poteto-mode `bug-fix.md`; `tdd` for the regression test |
| Slowness or perf regression | `diagnosing-bugs`; poteto-mode `perf-issue.md`; `benchmark-checklist` before reporting a number |
| Feature or behavior change | poteto-mode `feature.md`; `tdd` |
| Refactor or architecture | poteto-mode `refactoring.md`; `codebase-design`; `improve-codebase-architecture`; the `principle-*` skills the playbook names |
| Unclear spec or contested design | Supervisor: `grill-with-docs` with the user, then `to-spec` and `to-tickets` for work that spans crews; `interrogate` under the review bound below. Crewmate: report the open question in your result |
| Investigation of how or why, or a spec | poteto-mode `investigation.md`; `how` or `why`, single-model |
| Design question that needs running code | poteto-mode `prototype.md`; `prototype` |
| Pixel-exact UI match | poteto-mode `visual-parity.md` |
| PR review threads, conflicts or red CI | poteto-mode `babysit.md` |
| Deploy, merge or other operator task | No playbook: follow the brief's delivery contract |
| Review or risk | `code-review`; `blast-radius` |
| PR body | `pr` |
| Prose for the user | `unslop`; `technical-writing` for docs |
| Editing a skill or agent instructions | `writing-for-agents` |
| Stuck or drifting | `zoom-out` |

## Firstmate rules

pstack always has priority. If a skill or rule conflicts with it, pstack wins.
The two lines below are the only exceptions:

- Until the owner confirms otherwise: crews spawn no sub-agents. Where a skill
  spawns a `Task`, a `poteto-agent`, parallel workers or extra reviewers
  (`how`, `why`, `swarm`, `arena`, `interrogate`), do that work yourself in
  your own session with the provider, model and effort you were given. The
  supervisor delegates only to crewmates through `firstmate_dispatch`.
- Until the owner confirms otherwise: Firstmate decides who merges and deploys.
  Follow the brief's delivery contract for merge and deploy in place of the
  merge and deploy steps of poteto-mode's playbooks.

Other Firstmate rules:

- Load the skills the matched rows name, plus poteto-mode, plus every skill
  the chosen playbook names.
- Before you open a PR, run `/no-comments` over your diff.
- A crewmate's questions go to the supervisor through the brief's result channel.
- Never print a secret value. Read variable names only. Do not print `.env`
  or secret files, environment dumps or credential values. If a value is
  printed by mistake, say so in your report so the owner can rotate it.
- When a task needs Telegram, use the Telegram tools (`mcp__telegram__*`)
  connected to this host. Send questions to the supervisor through the brief's
  result channel.
- Crews share one host's memory. Run full type checks, full test suites,
  production builds, and any command that can use over 1 GB through
  `~/.bb-firstmate/bin/fm-heavy <command>`. It waits for a free slot, then runs
  the command. Run small targeted tests directly. If `fm-heavy` is missing, run
  the command directly and say so in your report.
