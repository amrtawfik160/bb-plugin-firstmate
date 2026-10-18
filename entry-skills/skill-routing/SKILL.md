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
| Bug, failure, crash, or flaky test | Code pipeline (bug) below; poteto-mode `bug-fix.md` |
| Slowness or perf regression | `diagnosing-bugs`; poteto-mode `perf-issue.md`; `benchmark-checklist` before reporting a number |
| Feature or behavior change | Code pipeline (feature) below; poteto-mode `feature.md` |
| Refactor or architecture | poteto-mode `refactoring.md`; `codebase-design`; `improve-codebase-architecture`; the `principle-*` skills the playbook names |
| Unclear spec or contested design | Supervisor: `grill-with-docs` with the user, then `to-spec` and `to-tickets` for work that spans crews; `interrogate` under the review bound below. Crewmate: report the open question in your result |
| Owner asks for `/to-spec`, `/to-tickets`, `/implement-spec`, `/implement` or `/grill-me` | Supervisor: dispatch a crew that loads the named skill, `to-spec`, `to-tickets`, `implement-spec` or `implement`; for `implement-spec`, one crew per ticket under a firstmate_program; for /grill-me, run `grilling` yourself with the owner. Crewmate: follow the skill your brief names, under the sub-agent rule below |
| Investigation of how or why, or a spec | poteto-mode `investigation.md`; `how` or `why`, single-model |
| Research or writing, no code | No fixed pipeline: the supervisor names the playbook and skills in the brief |
| Check another crew's PR before merge (checker crew) | `code-review`; `blast-radius`; `interrogate` under the sub-agent rule below; record the verdict with bb firstmate deliveries check, then send it straight to the crew that must act on it, one message per PR head, not through the supervisor |
| Design question that needs running code | poteto-mode `prototype.md`; `prototype` |
| Frontend or UI work (new screen, redesign, visual change) | `frontend-design`; the project's own design system and tokens win where they pin a choice |
| Pixel-exact UI match | poteto-mode `visual-parity.md` |
| PR review threads, conflicts or red CI | poteto-mode `babysit.md`; wait for CI with one blocking watch command, never a sleep loop or repeated polls |
| Deploy, merge or other operator task | No playbook: follow the brief's delivery contract |
| Review or risk | `code-review`; `blast-radius` |
| PR body | `pr` |
| Prose for the user | `unslop`; `technical-writing` for docs |
| Editing a skill or agent instructions | `writing-for-agents` |
| Stuck or drifting | `zoom-out` |
| Change to retries, exactly-once delivery or a race | `create-formal-verification-skill` once per area, then that area's verify skill |

## Code pipeline

Bug and feature work follows a fixed pipeline. Firstmate writes it into the
brief as steps P1 to P7. Refactor and perf work keep their rows above.

| Pipeline | Steps |
|---|---|
| Bug | `diagnosing-bugs`; failing test with `tdd`; fix at the root; prove on the real surface with the project's verify skill, else `verify-this`; `blast-radius`; `no-comments`; `pr` |
| Feature | `sharpen`; `architect`; build with `tdd`; prove on the real surface with the project's verify skill, else `verify-this`; `code-review`; `no-comments`; `pr` |

The report has one line per step: "✓ P<n> <step>: <evidence>" or
"skip: P<n> <step>: <reason>". Evidence names the test, or what you drove and
what you saw. `bb firstmate deliveries verify` refuses a pipeline crew's PR
until its report has "✓ P4 Prove on the real surface for <owner/repo#n> at
<head sha>: driven <what>; seen <what>" for that PR at its current head. Only
the crew's `report.md` counts. A blocked, pending or skipped P4 line for the same
PR and head wins over a done one. After a new push, add a new P4 line.

A PR that reaches customers or production needs a checker crew on a different
model before it merges. The plugin's `owner/reach.json` decides that from the
repo and the changed files. Deploy workflows, deploy configs and agent prompts
always count as production. `firstmate_merge` refuses such a PR without a pass
verdict from a crew that is not the builder.

The P4 gate applies to crews dispatched from Firstmate's pipeline version on.
The checker rule applies to every production merge, older PRs too.

## Core principles

Every brief names four principles to read in full:
`principle-prove-it-works`, `principle-fix-root-causes`,
`principle-attack-the-premise` and `principle-test-behavior-not-implementation`.
poteto-mode loads the other principles by their triggers.

## Firstmate rules

pstack always has priority. If a skill or rule conflicts with it, pstack wins.
The lines below are the only exceptions:

- Until the owner confirms otherwise: crews spawn no sub-agents, except for
  `arena` or `interrogate` where the playbook calls for them: `arena` for a new
  UI or design choice with no example in the code, `interrogate` for a risky
  PR. Then spawn at most 3 extra agents for that step, and run their heavy
  commands through `~/.bb-firstmate/bin/fm-heavy`. Where another skill spawns
  a `Task`, a `poteto-agent`, parallel workers or extra reviewers (`how`,
  `why`, `swarm`), do that work yourself in your own session with the
  provider, model and effort you were given. The supervisor delegates only to
  crewmates through `firstmate_dispatch`.
- Matt Pocock's `code-review` and `implement-spec` start sub-agents too.
  `code-review` starts two review sub-agents: run its Standards review, then
  its Spec review, yourself in your own session. `implement-spec` starts
  implementer and merger sub-agents and merges tickets on its own. A crew never
  starts them and never merges a ticket: it builds the tickets its brief names
  on its own branch and follows the brief's delivery contract. The supervisor
  turns the other tickets into crews with `firstmate_program`.
- `tdd` means Matt Pocock's `tdd`, the one installed at
  `<skills folder>/tdd/SKILL.md`. pstack's `tdd` is not installed under that
  name. A playbook's advice to skip an expensive test does not replace the
  pipeline's failing-test step: write the test, or report the step as skipped
  with the reason.
- Until the owner confirms otherwise: Firstmate decides who merges and deploys.
  Follow the brief's delivery contract for merge and deploy in place of the
  merge and deploy steps of poteto-mode's playbooks.

Other Firstmate rules:

- Load the skills the matched rows name, plus poteto-mode, plus every skill
  the chosen playbook names.
- When a skill says to call the Skill tool with a skill name and you have no
  Skill tool, read that skill's `SKILL.md` from the skills folder your brief
  names.
- Bugbot: triage its comments like any other review thread. Do not wait for
  Bugbot when the PR has no Bugbot check. Do a Cursor Automations or cloud
  agent step yourself, or report it blocked.
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
- Do not start a heavy command in the background or as your own systemd
  service to skip the wait. Stop the dev servers and browsers you started when
  you finish.
