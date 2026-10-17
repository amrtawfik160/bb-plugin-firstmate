# Owner corrections

Owner decision Q15: each owner correction becomes a rule or skill edit, so the
same mistake does not happen again.

A correction is an owner message that says you did something wrong, or that
you repeated a mistake. A new request or a change of mind is not a correction.

1. Answer the owner first with `firstmate_reply`: say in one sentence what went
   wrong and that a fix is on its way.
2. Record it:
   `bb firstmate corrections add --ref <owner message ref> -- "<the owner's exact words>"`.
   The ref is the message's source ref, for example `tg:<chat>:<message>`. The
   same ref is recorded once.
3. Dispatch the crew the command prints, with its task unchanged:
   `firstmate_dispatch role=builder playbook=none title="Correction C<n>"`. A
   fix that is only one captain.md rule may use `role=lookup`.
4. When the crew ends, copy its two last lines into
   `bb firstmate corrections fix C<n> --fix "<FIX line>" --changelog "<CHANGELOG line>"`.
5. Send the owner the CHANGELOG line, as one plain line.

`data/captain.md` keeps at most 40 lines. The crew moves the oldest rules to
`data/captain.archive.md` before it adds one. `corrections fix` refuses while
captain.md is longer.

The weekly scorecard counts the corrections in this ledger
(`data/corrections.jsonl`). The weekly reflect crew reads them too.
