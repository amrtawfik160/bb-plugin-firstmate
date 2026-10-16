# Owner layer

The owner layer holds the owner's own rules for this Firstmate install: how
the captain talks to the owner, how crews work, Telegram behaviour, and the
behaviour fixes we keep on top of native Firstmate. Native Firstmate stays a
clean copy below it.

`owner/rules.json` is the register. Each entry names one rule, the file that
applies it, and an exact anchor sentence from that file. Print the map (rule,
old place, new place) with:

```sh
node scripts/owner-layer-check.mjs --map
```

## Where the rules live

- `owner/` holds the rule text that code imports: `crew-rules.ts` (the rules
  every crew brief carries) and `handoff-contract.ts` (the captain intake
  fixes). Dispatch and captain binding apply them on top of native.
- Rules inside plugin skills stay in `entry-skills/`. BB loads plugin skills
  only from that folder, and the Claude, Codex and agents skill roots link to
  `entry-skills/skill-routing`. The register guards each of these rules.
- Host rules live outside the repo: `~/.bb-server/AGENTS.md` (reply style,
  project credentials), `~/.claude/CLAUDE.md` (changelog), the captain home's
  `data/captain.md` (Hanoon's owner rules), and the skill roots. The captain
  edits `data/captain.md` itself, so the repo does not overwrite it.
- The `pr`-skill rule for PR bodies also lives in the BB custom-instructions
  plugin setting, which no file check can read.

## The guard

`node scripts/owner-layer-check.mjs` fails when a registered rule is missing
or reworded, or when a plugin rule sits in a file that a re-pin rewrites
(`native-snapshot/`, `runtime-assets/`, a `fidelity: verbatim` skill).
`--host` also checks the host files; set `FM_HOME` to the captain home.

`scripts/refresh-native-pin.mjs` runs this guard and `scripts/skill-fidelity.ts`
after it vendors a new pin. It refuses the pin when an owner rule is gone or a
native file differs from the new pin outside its BB markers.

To change a rule on purpose, edit the rule and its entry in
`owner/rules.json` in the same commit.
