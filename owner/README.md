# Owner layer

The owner layer holds the owner's own rules for this Firstmate install: how
the captain talks to the owner, how crews work, Telegram behaviour, and the
behaviour fixes we keep on top of native Firstmate. Native Firstmate stays a
clean copy below it.

## Ownership

[`ownership.json`](ownership.json) puts every file in one of three groups. A
path that ends in `/` covers that folder; any other path covers that file only.

- **Native-owned:** `native-snapshot/`, `runtime-assets/`, `third-party/`,
  `lib/upstream-surface.ts`, `overlay/patch-base.txt`, and every skill copy
  with `fidelity: verbatim`. A re-pin rewrites these from the pinned commit.
- **Mixed:** the skills with `fidelity: adapted` (the captain and firstmate
  entry skills, `afk`, `harness-adapters`, the escalation reference). Their
  native regions are the `BB-SOURCE` header and the `native:` and
  `native-quote:` fields of each `BB-DIVERGE` comment. Every other byte is
  owner-owned.
- **Owner-owned:** every other file. This includes `owner/crew-rules.ts`
  (the rules every crew brief carries), `owner/handoff-contract.ts` (the
  captain intake fixes), `entry-skills/skill-routing/`, the captain
  references, and the plugin code.

Host files are owner-owned too, and outside the repo:
`~/.bb-server/AGENTS.md` (reply style, project credentials),
`~/.claude/CLAUDE.md` (changelog), and the captain home's
`data/captain.md` (Hanoon's owner rules). The owner and the captain edit them
on purpose, so nothing checks their sentences. A re-pin must not change them.

Rules inside plugin skills stay in `entry-skills/`, because BB loads plugin
skills only from that folder. The Claude, Codex and agents skill roots link to
`entry-skills/skill-routing`.

## The guard

`node scripts/refresh-native-pin.mjs <native clone> <sha>` records every
owner-owned byte and each host file, then runs the writer
(`scripts/vendor-native-pin.mjs`). It prints `PIN REFUSED` and exits 1 when:

1. an owner-owned entry or an owner region changed, was added or was deleted
   (`OWNER_BYTES_CHANGED`). An entry is its type, mode, bytes or link target;
   links are never followed. The entry is restored, missing folders are
   recreated, and a final check prints `RESTORE FAILED` for any entry it could
   not restore.
2. a host file changed (`HOST_FILE_CHANGED`). The file is restored. Set
   `FM_HOME` to the captain home so `data/captain.md` is included.
3. a native copy differs from the pinned commit (`NATIVE_COPY_DIFFERS`).
4. skill fidelity finds native text that differs outside a BB marker. The new
   native files stay written, so the sync can fix the skills that copy them.
