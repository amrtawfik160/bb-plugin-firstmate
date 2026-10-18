// Owner layer: the owner's rules that every crew brief carries. lib/crew-contract.ts
// places them in the skills block. owner/ownership.json marks this file owner-owned.

export const PSTACK_FIRST = "pstack always has priority. If a skill or rule conflicts with it, pstack wins.";

export const HOUSE_RULES = [
  PSTACK_FIRST,
  // Q18: multi-agent pstack skills only where the playbook calls for them.
  "Spawn no sub-agents, except where your playbook calls for `arena` (a new UI or design choice with no example in the code) or `interrogate` (a risky PR): then spawn at most 3 extra agents for that step, and run their heavy commands through `~/.bb-firstmate/bin/fm-heavy`. Do everything else yourself, in this session.",
  // 18 Oct skills review G: Matt Pocock's code-review and implement-spec start sub-agents.
  "`code-review`: run its Standards and Spec reviews yourself, one after the other, not as sub-agents.",
  "`implement-spec`: never start its sub-agents and never merge a ticket. Build your brief's tickets on your branch and follow the delivery contract.",
  "Until the owner confirms otherwise: Firstmate decides who merges and deploys. Follow the brief's delivery contract for merge and deploy.",
  "Merge only via `bb firstmate merge <crew> --pr <n> --yes`; it refuses a PR with no verification record. Never use `gh pr merge` or GitHub's API.",
  "This host is shared. Run every type check, full test run and build as `~/.bb-firstmate/bin/fm-heavy <command>`; it waits for a host-wide slot.",
  "Do not start such commands in the background or as your own systemd service to skip the wait. Stop dev servers and browsers you started when you finish.",
] as const;

// A release or operator crew merges other crews' PRs; it records what it drove itself.
export const OPERATOR_MERGE_STEPS = [
  "To merge a PR, do these steps at its current head:",
  "Merge step 1: drive the change on the real surface, with the project's verify skill if it has one.",
  "Merge step 2: `bb firstmate deliveries verify <owner/repo#n> --commit <head sha> --driven \"<what you drove>\" --seen \"<what you saw>\"`.",
  "Merge step 3: `bb firstmate merge <crew> --pr <n> --yes`, where <crew> is the crew that opened the PR.",
  "After a new push, do steps 1 and 2 again. If you cannot drive the change, report \"blocked: <PR>: <reason>\".",
] as const;

export const PLAYBOOK_RULES = [
  "Report these steps as ✓, not as a skip:",
  "- A step or skill that spawns a sub-agent, reviewer or other model (delegate, architect, how, why, no-comments): do it yourself in this session, on your own model. Add \"(done in session)\".",
  "- Cursor-only tools: for create-skill read writing-for-agents; for /loop repeat the step yourself; for origin or gt use gh-axi; for Cursor Automations or cloud agents do the step yourself or report it blocked.",
  "- Bugbot: triage its comments as normal review threads. With no Bugbot check on the PR, do not wait for one.",
  "- Opening a PR, merge, deploy: follow the brief's delivery contract. If proof needs a deploy you may not run, prove it on the nearest surface you can and name what is left for Firstmate.",
  // 15 Oct: a crew left "Verify on the same surface" pending on CI and handed a
  // human a Telegram checklist; the PR merged and dropped every Telegram message.
  "CI and unit tests are not verification. Your verify step means you drive the real changed surface, with the project's verify skill if it has one (e.g. `.agents/skills/verify-<app>/`), and report what you ran and saw.",
  "If you cannot drive it, write \"blocked: <step>: <what stops you>\". Never mark it ✓ or pending, and never hand a human a manual checklist as verification.",
] as const;

export const SCREENSHOT_RULE = "Save each screenshot as its own full-size PNG file. Never combine, stitch or downscale screenshots; link each file separately.";

export const BUG_FIX_PROOF = "Bug-fix proof: your final report gives the commit id of the failing test, committed before the fix.";

// Mirrored in overlay/bin/backends/bb-worker-prompt.py (OBSTACLES_SECTION): the
// renderer points rule 5 here when a brief carries this section.
export const OBSTACLES = [
  "### Obstacles",
  "Clear an ordinary obstacle yourself: retry with a smaller query or pagination, restore or commit what your own install changed, use another tool, or wait and retry. If rule 5 under Rules says to stop after two failures, this section replaces it.",
  "Report blocked only for what only the captain or the owner can give: a secret, an approval, a decision, withheld access, or a destructive or irreversible step. Every other stop rule still applies.",
] as const;

// Q8: a checker crew reviews another crew's PR on a different model before it merges.
export function checkerSteps(skill: (name: string) => string): string[] {
  return [
    "### Checker (Firstmate adds this to a checker crew's brief)",
    "You check another crew's PR before it merges. Do not change its branch.",
    `1. Read the diff at the PR's current head. Review it with \`${skill("code-review")}\` and \`${skill("blast-radius")}\`.`,
    "2. Drive the changed surface yourself, with the project's verify skill if it has one.",
    "3. Record your verdict: `bb firstmate deliveries check <owner/repo#n> --commit <head sha> --verdict pass|fail --notes \"<what you checked, drove and saw>\"`.",
    "4. A fail verdict names each finding, numbered, in its notes, and adds `--findings <n>` with their count. A new push needs a new check.",
  ];
}
