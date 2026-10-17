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

`node scripts/refresh-native-pin.mjs <native clone> <sha>` never writes this
checkout, and refuses to start unless it is clean (`LIVE_CHECKOUT_DIRTY`). It runs the writer (`scripts/vendor-native-pin.mjs`) in a fresh git
worktree on a new branch `native-pin/<sha8>`, with an empty `HOME` and no
`FM_HOME`. Then it reads what git recorded on that branch against its base:
names, modes, content and links. It prints `PIN REFUSED` and exits 1 when:

1. an owner-owned path or an owner region changed, was added or was deleted
   (`OWNER_CHANGED`);
2. a native copy differs from the pinned commit (`NATIVE_COPY_DIFFERS`);
3. a host file changed (`HOST_FILE_CHANGED`). The guard hashes the content the
   captain reads, through a link, and records the link itself. Set `FM_HOME`
   to the captain home so `data/captain.md` is included;
4. this checkout changed (`LIVE_CHECKOUT_CHANGED`: HEAD, status, tracked
   changes and each untracked file's content or link), or the writer failed.

A refused branch is deleted and never used. The guard restores nothing.
Folder modes are not part of the result, because git records none.

When only skill fidelity fails (native text differs outside a BB marker), the
branch stays, so the sync can fix the skills that copy native there.
