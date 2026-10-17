# Code pipeline, checker rule and crew models (Firstmate steps 3 and 4)

Owner decisions Q4, Q8, Q9, Q10, Q11, Q18, Q19 and Q20 of 16-17 October 2026.

## What changed

- `owner/pipelines.ts`: the fixed bug and feature pipelines (P1 to P7) and
  the four core principles. The brief renders them. The DONE report check
  counts the pipeline lines.
- `bb firstmate deliveries verify` refuses a bug-fix or feature crew's PR
  until the crew's report has "✓ P4 Prove on the real surface: driven …;
  seen …".
- `owner/reach.json` and `owner/reach.ts`: a PR reaches production unless
  its repo is listed as internal or every changed file is an internal path
  (docs, tests, `.github`, `*.md`). An unreadable file list counts as
  production.
- `bb firstmate deliveries check` records a checker crew's verdict. It
  refuses the builder and a crew on the builder's model.
  `firstmate_merge` refuses a production PR without a pass verdict for its
  current head.
- `owner/crew-roles.ts`: `firstmate_dispatch role` picks the default model.
  Builder: claude-code `claude-opus-5-5`. Checker: codex `gpt-6-astra`.
  Lookup: claude-code `claude-haiku-5-5`. A named provider, model or effort
  applies to that dispatch only. The role default replaces the
  `defaultProvider` setting, which now only redirects ship work moved off
  acp-antigravity.
- Dispatch refuses a model that the provider's catalog does not list.
- Crews may spawn up to 3 extra agents, only for `arena` or `interrogate`.
- The captain's supervision reference names its dispatch skills, the crew
  models and the checker rule.

## Isolated-server run (17 October)

An isolated BB server and host daemon (own data folder, ports 39720 and
39721), with a copy of the step 2 canary data. This branch was installed
there. A new test captain (Claude Opus 5.5) ran its own new home on native
15ad1bd6. The live server and the live captain home were not touched.
Scratch repo: `amrtawfik160/fm-canary-step2-20261017`, seeded with a slug CLI
that has a known bug (`slug "My Post Title"` printed `my-post title`).

1. The captain dispatched a bug task and a feature task with no model named.
   Both crews ran claude-code `claude-opus-5-5`. Each brief carried its
   pipeline, the four principles and the new sub-agent rule.
2. Both reports listed P1 to P7 with evidence. Each crew recorded its own
   verification, and the new gate accepted it (PR #5 at `32efc45`, PR #6 at
   `b54a98d`).
3. With the proof line changed to `pending:` in crew B's report, verifying
   PR #6 was refused: `Refusing to record verification for …#6: crew
   canary34-crew-b-slug-max's report has its proof step pending: …`. With
   the report restored, the same command recorded it.
4. `firstmate_merge` on PR #5 was refused: `Refusing: #5 reaches production
   (amrtawfik160/fm-canary-step2-20261017 is not listed as internal, and
   src/slug.js is not an internal path) and has no checker verdict for its
   head 32efc45; nothing was merged.`
5. The captain dispatched `role=checker`. The checker ran codex
   `gpt-6-astra`. Its brief had the Checker section and no pipeline. It
   recorded `pass` at `32efc45`.
6. `firstmate_merge` on PR #5 then merged it: `Merged #5 … Checked: crew
   canary34-checker-pr5 (gpt-6-astra) passed head 32efc45.` GitHub shows
   #5 merged at 03:42:54 UTC.

Not shown live: a checker on the builder's model and a fail verdict. The
tests in `server.code-pipeline.test.mjs` cover both.

## Fixes after the independent check (verdict 1: FIX)

1. Deploy files are production. `owner/reach.json` gains `productionPaths`:
   `.github/workflows/`, `.github/actions/`, Dockerfiles and compose files,
   platform deploy configs (fly, vercel, netlify, nixpacks, railway, render,
   Procfile, Expo `app.json`, `eas.json`, `app.config.*`) and agent prompts
   (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `SKILL.md`, `skills/`, `prompts/`).
   A production path wins over an internal one. `docs/` is internal only at
   the repo root, so `apps/docs/app/api/route.ts` is production. A repo row
   can add its own production paths, such as the folder it deploys from.
   Only the scratch and demo repos (`*/fm-canary-*`, `*/firstmate-demo`)
   are internal. The isolated run above used an `fm-canary-*` repo, which is
   now internal; the tests use production repos for the refusal.
2. P4 is parsed, not searched: the line must be `✓ P4 Prove on the real
   surface for <owner/repo#n> at <head sha>: driven <what>; seen <what>`,
   at the pipeline's proof step number, with both fields filled.
3. `deliveries verify` accepts only a P4 line for that PR at its current
   head (7 or more characters of the commit). Proof for another PR or an
   older head does not count. One report can hold one P4 line per PR.
4. Dispatch refuses when the provider list or the model catalog cannot be
   read, is empty, or failed to load. Nothing is spawned.
5. Migration: a crew dispatched by this version records `dispatchVersion: 2`.
   Only such crews get the P4 verify gate and the pipeline DONE check, because
   an older crew's report was written without P4. The checker rule applies to
   every production merge, older PRs too. The captain dispatches a checker for
   an older PR only when he wants to merge it, so the open PRs are not all
   checked up front.
