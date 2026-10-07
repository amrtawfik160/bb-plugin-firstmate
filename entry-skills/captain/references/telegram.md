# Telegram

The captain often reads only Telegram. A message that stays in the BB thread may never be seen.
These rules apply when owner messages arrive from the private Telegram connector (the message
starts with "The following is an owner message from the private Telegram connector.").

## What reaches Telegram

- The last message of each turn always goes to Telegram.
- An earlier message in the same turn goes only when it is a report (about 300 characters or more)
  or asks the captain a question. Short working notes ("Checking CI now.") stay in BB.
- So put every result, decision and question for the captain in a report or in the last message.
  Do not end a turn with "see my last message": the captain may not have that message.
- Do not send "nothing has changed" messages. If nothing needs the captain, say nothing new.
- A turn that only handled crew wakes, with nothing for the captain, ends with no text at all.
  Do not write "nothing new", a status recap or a note about an idle crew: any final text goes to Telegram.

## Track every owner message

- Each Telegram message is its own item, however many arrive and however fast. A burst of
  messages delivered together is still one item per message (`telegram_message_ids`).
- Call `firstmate_inbox` to list every owner message that still needs a final answer, with its
  ref and age. Call it as the last step of every turn that handled an owner message, and answer
  or dispatch every item it lists before the turn ends.
- When a crew takes a task, pass the item's ref in `sourceRefs` on `firstmate_dispatch`. The item
  then shows as "with crew" until you reply with the crew's result.
- Turn-end reminders name any item left unanswered. Answer it or dispatch it; never drop it.

## Reply to the message you are answering

- Answer with `firstmate_reply` and the item's ref (`tg:<chat>:<msg>`), not with plain turn text.
  Telegram shows the reply attached to the captain's message, so the captain knows what it answers.
- Answer items in any order. A quick answer does not wait for a long task.
- One message with several questions: send one reply per question. Pass `quote` with the exact
  words of that question from the captain's message, and `more=true` on every reply except the last.
- Several messages on one topic: reply to each one, or reply once to the oldest and say which
  later messages it also answers.
- Keep each reply short and self-contained. Lead with the answer.

## Questions and blockers for the captain

The captain often gives many tasks and then leaves. A question buried in routine updates waits
for hours. Ask rarely, and make each ask easy to find and to answer.

- Check the owner's standing approvals first ([the supervision reference](supervision.md)). Act
  on work they cover without asking.
- Decide reversible choices yourself when they are within your authority. Act, then say in one
  sentence what you chose and how the captain can change it. Do not ask.
- Ask only for a real product or preference call, missing access or credentials, or a gated
  action: a deploy to production, spending money, deleting data, or a message to customers.
- Use `firstmate_ask` for every such ask, never a plain-text question. Put one question in each
  ask. Put the recommended option first, and give at most 4 options.
- Keep working on everything else while an ask is open. A `blocker` ask names what is blocked
  and what you are doing in the meantime.
- Set `irreversible: true` for a gated action. Approvals and irreversible asks never proceed
  without an answer. A reversible ask with a recommended option proceeds with it at its deadline,
  and Firstmate then tells you to go ahead and to tell the captain that you did.
- An answer arrives as an owner message that replies to the ask card, or as the label of the
  button the captain tapped. Act on it. When you learn the answer another way, or the ask no
  longer matters, close it with `firstmate_resolve_ask`.
- While the captain is away, the connector may batch routine progress. Asks, blockers, failures
  and results the captain asked for always go out at once.

## Open pull requests

- Every PR that you or a crew opens must be tracked by Firstmate; the board lists open tracked PRs.
- Firstmate finds PRs on a crew's branch by itself. If you opened a PR outside a crew, register it:
  `firstmate_deliveries action=register url=<PR url>` (shell: `bb firstmate deliveries register --url <PR url>`).
- Never end a day with an open PR that is not on the board.

## Telegram commands

- `/ahoy`, `/bearings`, `/afk`, `/quiet` and `/stow` arrive as an owner message that starts with
  the command. Load the Firstmate skill of that name with `firstmate_skill`, follow it, and answer
  with `firstmate_reply`. Text after "Note:" is the captain's own words.
- `/back` means the captain has returned: leave the away posture as the `afk` skill describes, then
  give the `/ahoy` recap.
- `/inbox`, `/workers` and the captain's board of open asks are answered by the connector from
  Firstmate's records. They never reach you, so keep `firstmate_inbox`, open asks and the fleet
  state accurate.
