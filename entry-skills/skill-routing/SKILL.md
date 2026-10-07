---
name: skill-routing
description: "Task-to-skill table for Firstmate supervisors and crewmates. Use before dispatching or starting a bug fix, slowdown, feature, refactor, unclear spec, investigation, review, PR body, or user-facing prose."
---

# Skill routing

Match the task to every row that fits and follow the named poteto pstack and
Matt Pocock skills. Read each skill's `SKILL.md` from `~/.agents/skills/<name>/`,
`~/.claude/skills/<name>/`, or `~/.codex/skills/<name>/`. Many are
user-invoke-only, so read the file directly. A poteto-mode playbook is
`poteto-mode/playbooks/<file>` in the same folders. When a named skill is not
installed, continue without it and say so in your report.

Firstmate adds a skills block to every dispatch brief. It names this skill,
poteto mode and the matched playbook. The supervisor names any other matched
skills. A crewmate follows the skills its brief names and any row that matches
its own work.

## Poteto mode on every crewmate task

Every crewmate task, ship or scout, runs in poteto mode. Read
`poteto-mode/SKILL.md` in full before any other step, then open the playbook
that matches the task (the rows below name it; use `investigation.md` for a
scout with no other match) and follow its steps. Firstmate names
`poteto-mode` and the playbook in every brief.

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
| Investigation of how or why | poteto-mode `investigation.md`; `how` or `why`, single-model |
| Design question that needs running code | `prototype` |
| Review or risk | `code-review`; `blast-radius` |
| PR body | `pr` |
| Prose for the user | `unslop`; `technical-writing` for docs |
| Editing a skill or agent instructions | `writing-for-agents` |
| Stuck or drifting | `zoom-out` |

## Firstmate rules win

Where a routed skill conflicts with Firstmate, follow Firstmate:

- Do every step in your own session. Where a skill spawns a `Task`, a
  `poteto-agent`, or parallel workers, do that work inline. The supervisor
  delegates only to crewmates through `firstmate_dispatch`.
- Run `how`, `why`, `swarm`, and `arena` single-model. Keep the provider, model,
  and effort you were given; ignore `/setup-pstack` model lines.
- `interrogate` and any extra reviewer are supervisor-only: scoped crewmate
  review assignments under existing review authority, with an agreed count bound.
- Firstmate owns concurrency, merge, delivery, and PR status. Follow the brief's
  delivery contract in place of poteto-mode's Babysit, Shipping, Autopilot,
  Orchestrate, Autonomous run, and Opening a PR merge or polling steps.
- Skip Cursor-only steps: `deslop`, `control-ui`, `control-cli`, `create-skill`,
  and `pstack-models.mdc`.
- A crewmate's questions go to the supervisor through the brief's result channel.
- Poteto mode's Autonomy and Subagents sections give way to the brief: pause
  where the brief or Firstmate says to, and spawn no `poteto-agent` or `Task`.
- Load only the skills a matched row names, plus poteto mode.
- Never print a secret value. Read variable names only. Do not print `.env`
  or secret files, environment dumps or credential values. If a value is
  printed by mistake, say so in your report so the owner can rotate it.
- Never use Telegram tools (`mcp__telegram__*`) and never send a message as
  the owner. Send questions to the supervisor through the brief's result channel.
- Crews share one host's memory. Run full type checks, full test suites,
  production builds, and any command that can use over 1 GB through
  `~/.bb-firstmate/bin/fm-heavy <command>`. It waits for a free slot, then runs
  the command. Run small targeted tests directly. If `fm-heavy` is missing, run
  the command directly and say so in your report.
