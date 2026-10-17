# Learning loop and weekly automations

Owner decisions Q3, Q15, Q16 and Q21. Three BB script automations run the
weekly work; they use no model. Owner corrections go through the captain.

## Owner corrections

When the owner corrects the captain, or says it repeated a mistake, the
captain follows [the corrections reference](../entry-skills/captain/references/corrections.md):

1. `bb firstmate corrections add --ref <owner message ref> -- "<words>"`
   records the correction in `data/corrections.jsonl` in the captain home
   (created on the first write) and prints the crew task.
2. The crew uses pstack `correct` and `principle-encode-lessons-in-structure`
   and makes the smallest structural fix: a check, a tool refusal, a skill
   edit, or a captain.md rule. It ends with `FIX:` and `CHANGELOG:` lines.
3. `bb firstmate corrections fix C<n> --fix <ref> --changelog "<line>"`
   records the fix. The captain sends the owner the changelog line.

`data/captain.md` keeps at most 40 lines; old rules move to
`data/captain.archive.md`. The fix command refuses while captain.md is
longer. The re-pin guard treats the ledger and the archive as host files, so
a sync cannot change them.

## Weekly scorecard and reflect

`bb firstmate scorecard [--captain <thread-id>] [--since <iso>] [--until <iso>] [--json]`
counts one week (7 days up to now by default):

| Line | Source |
| --- | --- |
| Owner corrections | the corrections ledger |
| Redone work | owner task records: extra crews an owner task got in the week; checker crews are not counted |
| Checker findings | every `deliveries check` verdict is kept on the PR's record; fail verdicts in the week |
| Done claims without proof | each verification the P4 proof gate refused |
| Noise | `bb telegram status`: messages sent, and failed or not confirmed, since last week's run |

The checker and proof-gate history starts with this version, so the first
week counts only what happened after the reload. The connector reports
totals; the first run has no earlier total, so it shows totals and no weekly
number.

`scripts/weekly-scorecard.ts --send` sends the captain one message per week:
the scorecard to post unchanged in the Hanoon & tools topic, the reflect crew
to dispatch (pstack `reflect` over the week's corrections, checker verdicts,
refused proofs and redone work; it opens a PR or edits captain.md), and the
instruction to send the owner the reflect crew's CHANGELOG lines. Without
`--send` it prints that message and sends nothing.

Limit: the Telegram connector has no project field for a message that is not
a reply to an owner message. The captain posts the scorecard as its own
message. Its first line names the Hanoon & tools project, and the connector
picks the topic from the text.

## Setup

The automations run in this repo's project checkout. Create each one, then
pause it at once; resume it only after the merge and the reload. Replace the
placeholders: `<project>` is this repo's BB project, `<repair-thread>` the
thread that merges sync PRs, `<captain>` the live captain thread, `<home>` the
live captain home.

```sh
SYNC_ENV='{"FM_SYNC_MANAGER":"<repair-thread>","FM_SYNC_PROJECT":"<project>","FM_SYNC_LIVE_HOME":"<home>"}'
bb automation create --project <project> --name "Native sync (weekly)" \
  --cron "0 6 * * 0" --timezone Africa/Cairo --interpreter bash --working-directory project \
  --script "node scripts/native-sync.ts tick --start" --env-json "$SYNC_ENV"
bb automation create --project <project> --name "Native sync follow-up" \
  --cron "*/30 * * * *" --timezone Africa/Cairo --interpreter bash --working-directory project \
  --script "node scripts/native-sync.ts tick" --env-json "$SYNC_ENV"
bb automation create --project <project> --name "Weekly scorecard and reflect" \
  --cron "0 21 * * 0" --timezone Africa/Cairo --interpreter bash --working-directory project \
  --script "node scripts/weekly-scorecard.ts --send" \
  --env-json '{"FM_CAPTAIN_THREAD":"<captain>","FM_REFLECT_PROJECT":"<project>"}'
bb automation pause <automation-id> --project <project>   # once per automation
```

Before you resume them, dry-run each from the project checkout with the same
values:

```sh
FM_SYNC_MANAGER=<repair-thread> FM_SYNC_PROJECT=<project> node scripts/native-sync.ts tick --start --dry-run
FM_CAPTAIN_THREAD=<captain> FM_REFLECT_PROJECT=<project> node scripts/weekly-scorecard.ts
```

State files: `~/.bb-firstmate/native-sync/state.json` and
`~/.bb-firstmate/scorecard/state.json`. Delete one only to start that loop
over.
