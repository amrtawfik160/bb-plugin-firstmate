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
  input: { correlation, chatId, messageId, kind, text },
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

## Final-answer rule

Reply to the oldest unanswered item in that chat, never the latest. Use
`firstmate_reply` with `ref=oldest` or that item's `tg:<chat>:<msg>`. A later
ref is refused while an older row is still `received` or `acked`. Message ids
compare as numbers. Both refs resolve only to items owned by the calling
captain.

## Reminders

When a captain turn ends, Firstmate reminds it once about each item still
unanswered after 3 minutes, and once more after 10 minutes. Later reminders
back off from 10 minutes up to 2 hours.

## Flags

All of this is off until `fmReliability` JSON enables `inboundLedger`
(`shadow` or `on`) and `telegramThreading` (`on`). Shadow records the ledger
and writes no Telegram traffic.
