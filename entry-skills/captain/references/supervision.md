# BB supervision transport

Native `AGENTS.md` section 8 and its referenced upstream skills own supervision policy.
Use [the BB harness reference](bb.md) for the event-driven watch handoff.

## Durable wake handling

<!-- BB-DIVERGE
     native: AGENTS.md § 3
     native-quote: Presented records remain durable until the handling turn runs the generation-bound acknowledgement printed by the drain.
     bb: firstmate_wake returns a durable receipt; handledWake completes it only after the batch is handled.
     reason: BB tools carry the receipt through model turns and complete it after successful actions. -->
<!-- BB-ONLY: BB receipts preserve unread work until handling completes. -->
Call `firstmate_wake` to read the batch and retain its receipt ID; `ack: true` on `firstmate_wake` is read-only compatibility.
Handle the whole batch, then pass its ID as `handledWake` on the final successful direct Firstmate tool, or call `firstmate_wake` with `handledWake` if no action remains (`bb firstmate wake --handled-wake <id>`).
If `firstmate_wake` reports truncation, read the full saved report before completing its receipt.
If receipt completion fails after a successful action, retry completion through `firstmate_wake` without repeating the action.
An uncertain action receipt requires reconciling external state before any retry. Generic `firstmate_fm` scripts complete their receipt afterward through `firstmate_wake`.
Legacy `firstmate_wake` `ackThrough` and `recoveryGeneration` must match an outstanding receipt; prefer `handledWake`.
<!-- /BB-ONLY -->

## Captain rules

### Owner standing approvals

- Standing approvals cover reversible preparation in their stated scope. Before any production change, send `firstmate_ask kind=approval` naming what changes, where it goes live, how to undo, and screenshots for visible changes. Pass the exact PR list in `prs=["owner/repo#N"]` and omit `options` and `recommended`. The plugin displays that list and supplies fixed Approve and No buttons. PR mentions in the question grant no permission. Wait for Approve and pass it to the crew. New author commits need a new card; a proven base-branch merge keeps approval, including manual conflict-resolution edits.
- A project’s `yolo` posture never replaces the owner’s approval card for a PR. Ship also waits for that card. Production includes a merge to a branch that deploys, website publish, OTA update, App Store or external TestFlight submit, customer server or fleet update, production database or config write, and live plugin or bot change. Read-only checks need no approval.
- Any other standing approval covers reversible choices in its stated scope. Act on your recommendation and report what you chose in one sentence.
- A standing approval never covers a production deploy, spending money, deleting data, a message to customers, a red merge, or another irreversible action. Ask for those with `firstmate_ask`.

### Crew work stays with crews

- Never resolve conflicts, rebase, commit or push to a crew branch yourself. Never open a crew's PR yourself.
- When a crew's PR needs a fix, a rebase or a conflict resolved, send that fix round to a crew. Use `firstmate_tell` while the owning crew is live. Otherwise use `firstmate_dispatch` with the PR URL, the branch and the original `sourceRefs`.
- Merge only through `firstmate_merge`. Never run `gh pr merge` or another merge command yourself.
- Merge with `firstmate_merge` crewId + pr: name the PR (`pr`, number or link; CLI `--pr`). A crew with more than one open PR refuses a merge without `pr` and lists its open PRs. Check that the first line of the result names the PR you meant. Without `yes: true` (CLI `--yes`) it merges nothing, whatever the posture, and returns a preview.
- A merge needs a verification record for the PR's current head. CI and unit tests are not verification. Have the crew drive the changed surface, read what it saw, then record it: `firstmate_deliveries` `action=verify` `id` `commitSha=<head>` `driven=<what was driven>` `seen=<what was seen>`; a crew that drove it may record it itself. A new push drops the record. Only the owner's own words waive it: `firstmate_merge` `allowUnverified: "<owner words>"` (CLI `--allow-unverified`), recorded with the merge.
- A crew report with its verify step pending, skipped or blocked comes with a NOT VERIFIED note. The report text is not judged; the evidence is the record's two fields, `driven` and `seen`. A PR merged outside Firstmate with no record shows as `merged-unverified`; verify the merged commit or tell the owner.
- `firstmate_merge` retires the crew at merge. When the crew still has work after its PR merges, pass `keepCrew: true` (`--keep-crew`); retire it later with `firstmate_forget` `stop=true`.

### Before a dispatch

- Read `poteto-help` and pick the playbook and skills for the task. Write them into the brief, with `playbook`. The skill-routing table fills any gap.
- If the request is unclear, run `sharpen`, then `in-your-own-words`, before you dispatch.
- For a big plan, run `interrogate` on it before you dispatch the crews.
- Before you tell the owner "done", prove it with `principle-prove-it-works` or `verify-this`. A crew report is not proof.
- Your own principles: `principle-never-block-on-the-human`, `principle-sequence-verifiable-units`, `principle-encode-lessons-in-structure` and `principle-guard-the-context-window`.

### Crew models

- Order: a model the owner named, then the model rule you pick, then the role default. The rules are in the home's `config/crew-dispatch.json`; `firstmate_models` lists them.
- When the owner named no model, pass the rule that fits the task best as `rule` (its id or when-text). Choose by your judgement. Omit `rule` when none fits.
- Without a rule, `role` decides. A builder (the default) uses the file's default (starter: claude-code `claude-opus-5-5`). A checker uses the checker rule (starter: codex `gpt-6.1-sol`) and never the model of the builder it checks; pass its `taskRef`. A `lookup` runs claude-code `claude-haiku-5-5`.
- Each rule lists models strongest first. Dispatch skips a model with less than 15% of its weekly quota left, and a model the provider catalog refuses. When every model is low, it keeps the strongest one.
- The dispatch result names the picked model and why in one line. Give a line that starts `Tell the owner:` to the owner.
- When the owner changes a rule ("use Opus for UI"), save it with `firstmate_models` `set` (`bb firstmate models set`). `reset` backs up a broken file and writes the starter rules.
- Pass `providerId`, `model` or `reasoningLevel` only when the owner named them for this task. They apply to that task's crews only. Example: "opus 5.5 medium for ui, grok 4.6 xhigh for logic, codex for checker" gives the UI crew `claude-opus-5-5` with `reasoningLevel=medium`, the logic crew `acp-grok` `grok-4.6` with `xhigh`, and the checker `providerId=codex`.
- Dispatch refuses a model that the provider does not offer, and nothing is spawned. Use the ids it lists.

### Checker before merge

- A PR that reaches customers or production needs a checker crew before it merges. The plugin's `owner/reach.json` decides this from the repo and the changed files. Deploy workflows and deploy configs always count as production. A small internal change self-checks.
- The checker rule covers every production merge, PRs opened before this version too. Dispatch a checker for an older PR only when you want to merge it.
- The P4 proof gate applies only to crews dispatched from this version on. An older crew's report needs no P4 line.
- Dispatch the checker with `role=checker`, the PR link and the head commit. It must be another crew on a different model than the builder. It records `pass` or `fail` with `bb firstmate deliveries check`.
- `firstmate_merge` refuses a production PR without a `pass` verdict for its current head. A new push needs a new check. Send a `fail` verdict's findings to the builder.
