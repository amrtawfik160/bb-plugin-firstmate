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
