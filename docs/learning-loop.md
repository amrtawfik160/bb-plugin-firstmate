# Learning loop and weekly automations

Owner decisions Q3, Q15, Q16 and Q21. Three BB script automations run the
weekly work; they use no model. Owner corrections go through the captain.

## Owner corrections

When the owner corrects the captain, or says it repeated a mistake, the
captain follows [the corrections reference](../entry-skills/captain/references/corrections.md):

1. `bb firstmate corrections add --ref <owner message ref> -- "<words>"`
   records the correction in `data/corrections.jsonl` in the captain home
   (created on the first write) and prints the crew task. A ref that is
   already recorded prints its state and asks for no second crew.
2. The crew uses pstack `correct` and `principle-encode-lessons-in-structure`
   and makes the smallest structural fix: a check, a tool refusal, a skill
   edit, or a captain.md rule. It ends with `FIX:` and `CHANGELOG:` lines.
3. `bb firstmate corrections fix C<n> --fix <ref> --changelog "<line>"`
   records the fix. The captain sends the owner the changelog line.

The ledger is append-only. The plugin changes it one command at a time, and
writes with a compare-and-swap on the bytes it read: when another writer
changed the file in between, it reads again and appends to the new content.
No event is lost, and each correction gets its own id.

`data/captain.md` keeps at most 40 lines; old rules move to
`data/captain.archive.md`. The fix command refuses while captain.md is
longer. The re-pin guard treats the ledger and the archive as host files, so
a sync cannot change them.

## Weekly scorecard and reflect

`bb firstmate scorecard [--captain <thread-id>] [--since <iso>] [--until <iso>] [--json]`
counts one week (7 days up to now by default) for one captain. A worker
thread passes `--captain`; so does the reflect crew.

| Line | Unit | Source |
| --- | --- | --- |
| Owner corrections | corrections | the corrections ledger |
| Redone work | redone crews | a re-dispatch record, written when an owner task gets another crew of the same role and shape as an earlier one. A lookup then a builder, a scout then a ship, and checkers are not redone work. |
| Checker findings | findings, in fail verdicts | one record per checker verdict (PR, head, checker crew), with its notes and its `--findings <n>` count. A fail verdict without a count is named as such. |
| Done claims without proof | claims, by crews | one record per crew run whose done report missed its proof step, from the done-report check or the verify gate, whichever sees it first |
| Noise | Telegram messages | `bb telegram export`: the connector's outbox rows created in the week: sent, not delivered (failed or uncertain), still queued |

The records are kept in the plugin's database, one row per distinct event,
with no cap, so a whole week is always there. They start with this version:
nothing before the reload is counted.

The connector prunes old rows (after 14 days by default). When its oldest
kept row is newer than the week's start, the noise line says the count is not
available instead of a number. The connector does not report its dropped
messages to the CLI, and the line says so.

`scripts/weekly-scorecard.ts --send` covers the scheduled week: the 7 days up
to the Sunday 21:00 Cairo run on or before now, so a late retry covers the
same week. It sends the captain one message per scheduled week: the
scorecard to post unchanged in the Hanoon & tools topic, the reflect crew to
dispatch (pstack `reflect` over the week's corrections, checker verdicts,
done claims without proof and redone work, read for the named captain; it
opens a PR or edits captain.md), and the instruction to send the owner the
reflect crew's CHANGELOG lines. Before it sends, it saves the week and an
operation id; the message's first line carries both. A later run finds that
line in the captain's log and does not send again. One run at a time
(`flock`). Without `--send` it prints the message and sends nothing.

Limit: the Telegram connector has a project field only on replies and cards.
The captain posts the scorecard as its own message. Its first line names the
Hanoon & tools project, and the connector's classifier picks the topic from
the text. This is a fallback, not a guarantee: an unknown project goes to
General. A structured project field on the connector is the real fix.

## Setup

The automations run in this repo's project checkout. Create each one paused
(`--disabled`); resume it only after the merge, the reload and a dry run. Replace the
placeholders: `<project>` is this repo's BB project, `<repair-thread>` the
thread that merges sync PRs, `<captain>` the live captain thread, `<home>` the
live captain home.

```sh
SYNC_ENV='{"FM_SYNC_MANAGER":"<repair-thread>","FM_SYNC_PROJECT":"<project>","FM_SYNC_LIVE_HOME":"<home>"}'
bb automation create --project <project> --name "Native sync (weekly)" \
  --cron "0 6 * * 0" --timezone Africa/Cairo --interpreter bash --working-directory project \
  --script "node scripts/native-sync.ts tick --start" --env-json "$SYNC_ENV" --disabled
bb automation create --project <project> --name "Native sync follow-up" \
  --cron "*/30 * * * *" --timezone Africa/Cairo --interpreter bash --working-directory project \
  --script "node scripts/native-sync.ts tick" --env-json "$SYNC_ENV" --disabled
bb automation create --project <project> --name "Weekly scorecard and reflect" \
  --cron "0 21 * * 0" --timezone Africa/Cairo --interpreter bash --working-directory project \
  --script "node scripts/weekly-scorecard.ts --send" --timeout 10m --disabled \
  --env-json '{"FM_CAPTAIN_THREAD":"<captain>","FM_REFLECT_PROJECT":"<project>"}'
bb automation resume <automation-id> --project <project>   # once per automation, when ready
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
