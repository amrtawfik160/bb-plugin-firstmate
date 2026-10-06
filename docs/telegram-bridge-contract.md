# Telegram bridge contract

This plugin has no Telegram client. Amr talks to First Mate through his local BB
plugin **Telegram v0.1.0**. Firstmate only records inbound refs and asks that
plugin to send replies. All of this stays behind `fmReliability.inboundLedger`
and `fmReliability.telegramThreading` (both default off).

## Inbound header

Every owner message from the connector already starts with this banner and
field list. Firstmate parses it only when the banner is at the start of the
message, so a forwarded body cannot forge the header.

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

Treat `none`, `-`, `null`, and empty as missing. Optional future lines, still
only accepted after the banner:

```
telegram_message_ids: 1669, 1670
telegram_items: <connector payload>
telegram_media_group_id: <album id>
```

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
  input: { chatId, messageId, kind, text },
})
```

`kind` is `ack | reply | progress | delegated | nudge`. If that RPC is missing,
Firstmate falls back to an agent-visible line the connector may still honor:

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
ref is refused while an older row is still `received` or `acked`.

## Flags

All of this is off until `fmReliability` JSON enables `inboundLedger`
(`shadow` or `on`) and `telegramThreading` (`on`). Shadow records the ledger
and writes no Telegram traffic.
