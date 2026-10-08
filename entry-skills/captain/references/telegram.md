# Telegram

The captain often reads only Telegram. A message that stays in the BB thread may never be seen.
These rules apply when owner messages arrive from the private Telegram connector (the message
starts with "The following is an owner message from the private Telegram connector.").

## Write for the owner

Lead with the answer in a few short lines. Send one message per piece of news.
Do not repeat in-progress lists; the pinned board shows them. The final text already
reaches Telegram; never write "on Telegram". After `firstmate_reply`, closing text
in that turn goes to the digest, so do not repeat your reply.

For specs, explanations, plans, comparisons or long details, build a Lavish artifact.
Run `lavish-axi --help` and `lavish-axi playbook <id>` for the format. Export one
standalone file with `lavish-axi export <file> --out /tmp/<short-name>.html`, then
link that `/tmp` file in the short message so the connector sends it as a document.
Do not use `lavish-axi share`; it publishes to a third-party site.

Save each screenshot as its own full-size PNG file. Never combine, stitch or downscale
screenshots; link each file separately.

A turn that only handled crew wakes, with nothing for the owner, ends with no text.

## Track every owner message

- Each Telegram message is its own item, however many arrive and however fast. A burst of
  messages delivered together is still one item per message (`telegram_message_ids`).
- Call `firstmate_inbox` to list every owner message that still needs a final answer, with its
  ref and age. Call it as the last step of every turn that handled an owner message, and answer
  or dispatch every item it lists before the turn ends.
- When a crew takes a task, pass the item's ref in `sourceRefs` on `firstmate_dispatch`. In a turn an
  owner message started, a dispatch without it still runs, but opens no owner task and returns a
  warning. The dispatch opens an owner task on the
  board. A reply never closes it: its PR merging does, or `firstmate_task` close with done or
  dropped (dropped needs a reason). Work you do yourself gets a task through `firstmate_task` open.
- Each owner job gets its own dispatch and task; a job from another thread or your own passes `origin` instead.
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
  ask. Supply `impact`, one plain sentence explaining what it means for the business.
  Put option text in `options`, not in the question. Put the recommended option first,
  and give at most 4 options.
- Keep working on everything else while an ask is open. A `blocker` ask names what is blocked
  and what you are doing in the meantime.
- Set `irreversible: true` for a gated action. Approvals and irreversible asks never proceed
  without an answer. A reversible ask with a recommended option proceeds with it at its deadline,
  and Firstmate then tells you to go ahead and to tell the captain that you did.
- A button tap or a reply with just its letter answers a card. Other replies are normal
  owner messages. When you learn the answer another way, correct it with `firstmate_resolve_ask`,
  even after it was answered; `reopen=true` opens it again. Cancel asks that no longer matter.
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
