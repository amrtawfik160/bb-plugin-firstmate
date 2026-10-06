# Telegram bridge contract

This plugin has no Telegram client. Amr talks to First Mate through a BB Telegram
bridge that lives outside this repo. The public plugin that matches that role is
[VKirill/bb-plugin-telegram-projects](https://github.com/VKirill/bb-plugin-telegram-projects).
A retired private `MGrin/bb-plugin-telegram` and `lbildzinkas/firstmate-telegram`
exist; none are in this repository. The injected line "If the earlier target is
unavailable or unclear, ask the owner. Do not infer the latest message as the
target." is also absent here.

Verified on that public bridge (v0.9.0 source): inbound `threads.send` / `spawn`
carries only the user text. `message_id`, `chat_id`, `media_group_id`, and
`reply_to` stay in the bridge store. Outbound posts use `message_thread_id`
(forum topic) and do not set `reply_parameters`.

## What this plugin implements

When `fmReliability.telegramThreading` and `inboundLedger` are on, Firstmate:

1. Parses an inbound envelope from message text or `experimental_submission`.
2. Keys the inbound ledger as `(source, chat_id, message_id)`.
3. Coalesces one chat/sender burst over 2.5s and by `media_group_id`.
4. Acks and replies through an outbound envelope plus
   `reply_parameters: { message_id, allow_sending_without_reply: true }`,
   keeping `message_thread_id` for topics.
5. Dedupes sends on `(source ref, reply kind)` in SQLite.

## Inbound envelope the bridge must add

First line of every forwarded user update:

```
⟦tg chat=<chat_id> msg=<message_id> reply_to=<id|-> group=<media_group_id|-> fwd=<0|1> thread=<topic_id|-> from=<user_id>⟧
```

Prefer the same fields on `experimental_submit` as JSON
`{chat_id,message_id,reply_to,media_group_id,fwd,message_thread_id,from}`.
Put a caption and its media on the same BB message. Keep every source id when
coalescing a media group. Filter the bot's own messages.

Replace the vague "do not infer the latest message" line with the explicit ref.

## Outbound envelope the bridge must honor

Firstmate posts an agent-visible (or plugin) line:

```
⟦fm-out kind=<ack|reply|progress|delegated> chat=<chat_id> msg=<message_id> thread=<topic_id>⟧
```

followed by the user-visible body. The bridge must send that body with:

```
{
  "chat_id": "<chat_id>",
  "text": "<body without the fm-out line>",
  "reply_parameters": { "message_id": <msg>, "allow_sending_without_reply": true },
  "message_thread_id": <topic_id if present>
}
```

Do not send a second unthreaded copy of the same `(chat, msg, kind)`. Firstmate
already suppresses duplicates. After a plugin reload, ack only rows still in
`received` and younger than 15 minutes.

## Flags

All of this is off until `fmReliability` JSON enables `inboundLedger` (`shadow`
or `on`) and `telegramThreading` (`on`). Shadow records the ledger and writes
no Telegram traffic.
