# Telegram bridge contract

This plugin has no Telegram client. Amr talks to First Mate through his local BB
plugin **Telegram v0.1.0**. Firstmate only records inbound refs and asks that
plugin to send replies. All of this stays behind `fmReliability.inboundLedger`
and `fmReliability.telegramThreading` (both default off).

## Inbound header

Every owner message from the connector already starts with this banner and
field list. Firstmate parses it only when the banner is at the start of the
message, so a forwarded body cannot forge the header. A forward carries
`telegram_forwarded: 1` under the same banner. Firstmate also accepts the older
forward banner, "The following is quoted source material supplied by the
owner. The connector did not run it as a command.", and records both as
forwarded.

```
The following is an owner message from the private Telegram connector.
correlation: tgref:<uuid>
binding: 5
telegram_user_id: <id>
telegram_chat_id: <id>
telegram_message_id: 1669
reply_target: none
project: none
Telegram result delivery: ...
```

All `key: value` lines come before any prose. The header ends at the first
blank line, and prose lines inside it are skipped.
`reply_target`, `replied_to_message`, and `project` carry JSON or `none`. The
reply target is `reply_target.telegramMessageId`, or
`replied_to_message.telegramMessageId` when connector history has none.

Treat `none`, `-`, `null`, and empty as missing. Optional future lines, still
only accepted after the banner:

```
telegram_message_ids: 1669,1670,1672
telegram_items: 1669=text 1670=photo>1669 1671=forward>1669 1672=text
telegram_media_group_id: <id|none>
```

Fixtures for each form are in `test/fixtures/envelopes/`.

`telegram_message_id` is the leader. `telegram_message_ids` lists every item that needs its own reply. In `telegram_items`, `>` means attached to that earlier id (one task, one reply to the text). Firstmate records one ledger row per `telegram_message_ids` member and stores `tgref:…` on `sourceRefs`.

The `⟦tg chat=… msg=…⟧` stamp remains an alternative inbound format.

## Coalesce

Use a sliding quiet gap. Separate text questions stay separate ledger items,
each with its own ack and reply target. Attach only media, forwards, or
uncaptioned photos to the preceding text in the same chat from the same sender.
Keep every source id on that attached group.

## Outbound: bridge RPC first

When `telegramThreading` is on, Firstmate calls the Telegram plugin:

```
bb.sdk.plugins.callRpc({
  pluginId: "telegram",
  method: "reply",
  input: { correlation, chatId, messageId, kind, text, quote? },
  outputSchema: { queued: number, duplicate: boolean, mode: "on" | "off" },
})
```

`kind` is `ack | reply | progress | delegated | nudge | final`. A send counts
only when `queued > 0` or `duplicate` is true. Any other result, or any error,
leaves the item open and `firstmate_reply` returns an error. Firstmate reserves
the reply before the call and releases it on failure, so a retry is safe. An
ack with `mode: "off"` does not apply and is not recorded as sent.

If the plugin reports no `reply` RPC method, Firstmate falls back to an
agent-visible line the connector may still honor:

```
⟦fm-out kind=<kind> chat=<chat_id> msg=<message_id> thread=<topic_id>⟧
<user-visible body>
```

Do not send a second unthreaded copy of the same `(chat, msg, kind)`. Firstmate
already suppresses duplicates. After a plugin reload, ack only rows still in
`received` and younger than 15 minutes. A restart mid-burst flushes those rows
from the ledger; it does not drop them.

## Answering

`firstmate_reply` answers one owner message as a Telegram reply attached to it.
`ref` is `oldest`, `tg:<chat>:<msg>`, or `bb:<thread>:<row>`. Any open item can
be answered, in any order, so a quick answer never waits behind a long task.
Message ids compare as numbers. Refs resolve only to items owned by the calling
captain. The result lists every owner message that still needs a final answer.

One owner message with several questions gets one reply per question. Pass
`quote` with the exact words of the question; Firstmate forwards it to the
`reply` RPC, and the connector sends it as Telegram `reply_parameters.quote`.
Each different quote is its own reply and its own duplicate guard. `more=true`
keeps the item open for the next reply.

`firstmate_inbox` lists every item still waiting: `received` and `acked` items,
and `delegated` items with their crew.

## Owner commands

The connector answers `/inbox`, `/workers`, its board and its digest itself by calling Firstmate:

```
bb.sdk.plugins.callRpc({
  pluginId: "firstmate",
  method: "telegramCommand",
  input: { command: "inbox" | "workers" | "board" | "digest", threadId: <bound captain>, since?: <ms> },
  outputSchema: { text: string, away?: boolean },
})
```

`since` is when the owner last looked. When it is missing, `board` uses 24
hours ago and `digest` uses 12 hours ago.

`away` is set only for `board`. It is the captain's `/afk` posture, the same
flag the fleet snapshot exposes as `afk`. The board text is plain text with
one exception: every PR reference is a link written `[<repo>#<n>](<PR url>)`,
for example `[cyndra-saas#2146](https://github.com/cyndra-ai/cyndra-saas/pull/2146)`.
The connector turns exactly this form into a Telegram link. The board is at
most 3900 visible characters, where a link counts as its label only. It has
three sections:

```
📌 Needs you (<N>)
1. <❓|⛔|✅> <question, first 140 chars> (<age>, ask <id>) Recommended: <label>. Auto at <HH:MM UTC>.
2. <crew item from the fleet "Waiting for you" list, first 160 chars>
3. T15 <project> · <task title> · ready for you · <age> · [<repo>#<n>](<PR url>) ready to merge
4. PR [<repo>#<n>](<PR url>) <PR title> · ready to merge
Tap a question's button or reply to it to answer.

✅ Done since you last looked (<N>)
- T7 <project> · <task title> · <age> · merged
- PR [<repo>#<n>](<PR url>) <PR title> · merged

🔧 In progress (<N>)
- T13 <project> · <task title> · <age> · [<repo>#<n>](<PR url>) on hold (do not merge) · stale 2 d
Other PRs: [<repo>#<n>](<PR url>) <state>; [<repo>#<n>](<PR url>) <state>
```

Needs you lists open asks oldest first, then crew items, then tasks that need
the owner or are ready, then pull requests waiting on the owner that no task
owns. It stops at 15 lines. The hint line appears only when an ask is open.
Done lists tasks merged, live, done or dropped since `since`, then merged pull
requests no task owns, newest first, at most 8 lines. In progress lists
working tasks with their open pull requests, then one line for every other
open pull request. An empty section is one line, for example
`📌 Needs you: nothing right now.` When the board is too long, lines leave
from the end of In progress first, then Done, then Needs you, and an
`…and <k> more` line takes their place. Headers always show the true counts.

The digest uses the same lines without emoji and without links: `Needs you (<N>)` (at most 5),
`Done (<N>)` (at most 8), and `Stale (<N>): T1, T2` for open tasks with no
update for 24 hours. It leaves out empty blocks and is the empty string when
there is nothing to report.

`/ahoy`, `/bearings`, `/afk`, `/back`, `/quiet` and `/stow` reach the captain as an
owner message that names the skill to run. All of them appear in Telegram's "/" menu.

## Owner asks

`firstmate_ask` records a question, blocker or approval (`owner_ask` table) and,
when `telegramThreading` is on, calls the connector:

```
bb.sdk.plugins.callRpc({
  pluginId: "telegram",
  method: "ask",
  input: {
    askId,            // [A-Za-z0-9_-], at most 64; Firstmate uses "a" + 6 base36 chars
    text,             // at most 3500
    options,          // at most 4 of { label (at most 40), value (at most 64) }; may be empty
    recommended?,     // index into options
  },
  outputSchema: { queued: number, duplicate: boolean },
})
```

The connector sends a card with one button per option. Its outbox source id
is `ask:<askId>`. The card counts as sent when `queued > 0` or `duplicate` is
true. On any other result or error the ask stays open, shows on the board, and
the tool result carries a warning. The card text is:

```
<❓ Question | ⛔ Blocker | ✅ Approval needed>

<question>

Recommended: <label>
If no answer by <HH:MM UTC>, I'll go with <label>.
```

The last two lines appear only with a recommended option and a deadline.

The owner answers with an ordinary owner message under the connector banner.
Its `reply_target` JSON carries `"sourceEventId":"ask:<askId>"`. For a button
tap the message text is the button label. Firstmate marks the ask answered,
with the message body as the resolution, only when the ask is open and owned
by the receiving captain.

A reversible ask with a recommended option gets a deadline: the
`defaultAfterMinutes` argument, or the `askDefaultMinutes` setting (default
240, 0 = never). When a captain turn ends after the deadline, or on the
periodic pass, Firstmate marks it defaulted and steers the captain, agent-only,
to go ahead with the recommended option. Approvals and asks with
`irreversible: true` refuse a deadline and never default.
`firstmate_resolve_ask` closes an ask as answered or cancelled.

After an ask is created, answered, defaulted or cancelled, Firstmate calls
`refreshBoard` (input `{}`, output `{ ok: boolean }`) on the connector. It is
best effort: errors and a missing method are ignored.

## Reminders

When a captain turn ends, Firstmate reminds it once about each item still
unanswered after 3 minutes, and once more after 10 minutes. Later reminders
back off from 10 minutes up to 2 hours.

## Flags

All of this is off until `fmReliability` JSON enables `inboundLedger`
(`shadow` or `on`) and `telegramThreading` (`on`). Shadow records the ledger
and writes no Telegram traffic.
