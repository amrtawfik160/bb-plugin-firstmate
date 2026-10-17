import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BRIEF_SKILLS, crewPipeline, crewPlaybook, crewSkillBlock, crewSkillRoot, notVerifiedNote, notVerifiedRequest, pipelineProofGap, PLAYBOOK_CHOICES, playbookStepCount, reportGapNote, reportGapRequest, reportGaps, skillCheckScript, skillRoutingLinkScript, verifyStepGap } from "./crew-contract.ts";
import { CODE_PIPELINES } from "../owner/pipelines.ts";

const HOME = homedir();

const IN_PLACE_OF_A_SKIP = [
  "Report these steps as ✓, not as a skip:",
  "- A step or skill that spawns a sub-agent, reviewer or other model (delegate, architect, how, why, no-comments): do it yourself in this session, on your own model. Add \"(done in session)\".",
  "- Cursor-only tools: for create-skill read writing-for-agents; for /loop repeat the step yourself; for origin or gt use gh-axi.",
  "- Opening a PR, merge, deploy: follow the brief's delivery contract. If proof needs a deploy you may not run, prove it on the nearest surface you can and name what is left for Firstmate.",
];

const OBSTACLES = [
  "### Obstacles",
  "Clear an ordinary obstacle yourself: retry with a smaller query or pagination, restore or commit what your own install changed, use another tool, or wait and retry. If rule 5 under Rules says to stop after two failures, this section replaces it.",
  "Report blocked only for what only the captain or the owner can give: a secret, an approval, a decision, withheld access, or a destructive or irreversible step. Every other stop rule still applies.",
];

const SKILLS_READ = "Your final report has a line \"Skills read: <paths>\" for those files, or \"not read: <path>: <reason>\".";

const HOUSE_RULES = [
  "pstack always has priority. If a skill or rule conflicts with it, pstack wins.",
  "Spawn no sub-agents, except where your playbook calls for `arena` (a new UI or design choice with no example in the code) or `interrogate` (a risky PR): then spawn at most 3 extra agents for that step, and run their heavy commands through `~/.bb-firstmate/bin/fm-heavy`. Do everything else yourself, in this session.",
  "Until the owner confirms otherwise: Firstmate decides who merges and deploys. Follow the brief's delivery contract for merge and deploy.",
];

const VERIFY_RULES = [
  "CI and unit tests are not verification. Your verify step means you drive the real changed surface, with the project's verify skill if it has one (e.g. `.agents/skills/verify-<app>/`), and report what you ran and saw.",
  "If you cannot drive it, write \"blocked: <step>: <what stops you>\". Never mark it ✓ or pending, and never hand a human a manual checklist as verification.",
];

const MERGE_RULE = "Merge only via `bb firstmate merge <crew> --pr <n> --yes`; it refuses a PR with no verification record. Never use `gh pr merge` or GitHub's API.";

// PR 129 review: a release crew's brief (no playbook) did not say how to drive, record
// and merge each PR.
const MERGE_SEQUENCE = [
  "To merge a PR, do these steps at its current head:",
  "Merge step 1: drive the change on the real surface, with the project's verify skill if it has one.",
  "Merge step 2: `bb firstmate deliveries verify <owner/repo#n> --commit <head sha> --driven \"<what you drove>\" --seen \"<what you saw>\"`.",
  "Merge step 3: `bb firstmate merge <crew> --pr <n> --yes`, where <crew> is the crew that opened the PR.",
  "After a new push, do steps 1 and 2 again. If you cannot drive the change, report \"blocked: <PR>: <reason>\".",
];

const HOST_LIMIT = [
  "This host is shared. Run every type check, full test run and build as `~/.bb-firstmate/bin/fm-heavy <command>`; it waits for a host-wide slot.",
  "Do not start such commands in the background or as your own systemd service to skip the wait. Stop dev servers and browsers you started when you finish.",
];

test("the playbook comes from the dispatch title, not the task body", () => {
  const body = "Fix the failing error, then deploy and merge.";
  for (const [title, playbook] of [
    ["Deploy + merge #2155", "none"],
    ["Perf 1: workflow admission contention", "perf-issue"],
    ["Cyndra: spec for Slack connect", "investigation"],
    ["Redesign Import from screenshots", "feature"],
    ["Fix agent computer feature", "bug-fix"],
    ["Refactor error handling into one boundary", "refactoring"],
    ["Prototype the inbox layout", "prototype"],
    ["Match the Figma for the settings page", "visual-parity"],
    ["Babysit PR #88 to green", "babysit"],
    ["Add a CSV export", "feature"],
  ] as const) {
    assert.equal(crewPlaybook({ shape: "ship", title, task: body }), playbook, title);
  }
});

test("without a title the first non-heading task line is the title", () => {
  assert.equal(crewPlaybook({ shape: "ship", task: "## Captain's intent\nAdd CSV export\n\nfix nothing else" }), "feature");
  assert.equal(crewPlaybook({ shape: "ship", task: "fix the crash on save" }), "bug-fix");
});

test("a captain's explicit playbook overrides the title, and a scout investigates", () => {
  assert.equal(crewPlaybook({ shape: "ship", title: "Fix agent computer feature", task: "", playbook: "refactoring" }), "refactoring");
  assert.equal(crewPlaybook({ shape: "ship", title: "Add CSV export", task: "", playbook: "none" }), "none");
  assert.equal(crewPlaybook({ shape: "scout", title: "Fix nothing; find why Telegram stalls", task: "" }), "investigation");
});

test("a feature brief gives full paths, the pipeline checklist, the core principles and the pstack rule", () => {
  const root = `${HOME}/.claude/skills`;
  assert.equal(crewSkillBlock({ shape: "ship", title: "Add a CSV export", task: "", providerId: "claude-code" }), [
    "### Skills (Firstmate adds this to every brief)",
    "First action, before any other command: read the files in steps 1 to 3.",
    `1. Read \`${root}/skill-routing/SKILL.md\`. Load every skill its matched rows and your playbook name.`,
    `2. Read \`${root}/poteto-mode/SKILL.md\` in full.`,
    `3. Follow \`${root}/poteto-mode/playbooks/feature.md\`.`,
    "4. Copy every pipeline step, then the playbook steps, into your to-do list, before any other to-do.",
    "5. Your final report lists each pipeline step as the Pipeline section says.",
    SKILLS_READ,
    principles(root),
    `Skills on this host are in \`${root}/<name>/SKILL.md\`. Load a skill by reading that file. Do not rely on a Skill tool for pstack skills; they are user-invocable only.`,
    "If a skill is not installed, continue and say so in your report.",
    ...HOUSE_RULES,
    MERGE_RULE,
    ...HOST_LIMIT,
    ...IN_PLACE_OF_A_SKIP,
    ...VERIFY_RULES,
    "### Pipeline (feature). Do every step, in this order:",
    `P1. Sharpen: read \`${root}/sharpen/SKILL.md\`. Evidence: the sharpened request in one sentence.`,
    `P2. Architect: read \`${root}/architect/SKILL.md\`. Evidence: the data shape and the design you chose.`,
    `P3. TDD build: read \`${root}/tdd/SKILL.md\`. Evidence: the test names, each failing before its code.`,
    `P4. Prove on the real surface: use the project's verify skill if it has one (e.g. \`.agents/skills/verify-<app>/\`), else read \`${root}/verify-this/SKILL.md\`. Evidence: the PR and head you proved, what you drove and what you saw.`,
    `P5. Code review: read \`${root}/code-review/SKILL.md\`. Evidence: the findings and what you fixed.`,
    `P6. No comments: read \`${root}/no-comments/SKILL.md\`. Evidence: the comments you removed, or none.`,
    `P7. PR: read \`${root}/pr/SKILL.md\`. Evidence: the PR link.`,
    "Your final report has one line per pipeline step: \"✓ P<n> <step>: <evidence>\" or \"skip: P<n> <step>: <reason>\".",
    "Write that report to your report file before you record verification. `bb firstmate deliveries verify` refuses this crew's PR until the report has \"✓ P4 Prove on the real surface for <owner/repo#n> at <head sha>: driven <what>; seen <what>\" for that PR at its current head. After a new push, add a new P4 line.",
    "Save each screenshot as its own full-size PNG file. Never combine, stitch or downscale screenshots; link each file separately.",
    ...OBSTACLES,
  ].join("\n"));
});

// 9 Oct: 7 of 10 Sonnet crews never opened poteto-mode/SKILL.md, though every
// crew read the playbook, the one file the report had to account for.
test("the file reads are the first lines of the block and the report must name the files read", () => {
  for (const providerId of ["claude-code", "codex", "acp-grok"]) {
    const root = crewSkillRoot(providerId);
    for (const shape of ["ship", "scout"] as const) {
      for (const playbook of PLAYBOOK_CHOICES) {
        const lines = crewSkillBlock({ shape, title: "x", task: "", providerId, playbook }).split("\n");
        const reads = playbook === "none" ? "steps 1 and 2" : "steps 1 to 3";
        assert.equal(lines[0], "### Skills (Firstmate adds this to every brief)");
        assert.equal(lines[1], `First action, before any other command: read the files in ${reads}.`);
        assert.ok(lines[2]!.startsWith(`1. Read \`${root}/skill-routing/SKILL.md\`.`), lines[2]);
        assert.equal(lines[3], `2. Read \`${root}/poteto-mode/SKILL.md\` in full.`);
        if (playbook !== "none") assert.equal(lines[4], `3. Follow \`${root}/poteto-mode/playbooks/${playbook}.md\`.`);
        const report = lines.indexOf(SKILLS_READ);
        assert.equal(report, playbook === "none" ? 5 : 7, `${providerId} ${shape} ${playbook}`);
        assert.equal(lines[report + 1], principles(root), `${providerId} ${shape} ${playbook}`);
        for (const rule of HOUSE_RULES) assert.ok(lines.indexOf(rule) > report, rule);
      }
    }
  }
});

test("a bug-fix brief asks for the failing-test commit in its pipeline; the verify rules ask for proof on the real surface", () => {
  const block = crewSkillBlock({ shape: "ship", title: "Fix agent computer feature", task: "", providerId: "codex" });
  assert.ok(block.includes(`3. Follow \`${HOME}/.codex/skills/poteto-mode/playbooks/bug-fix.md\`.`), block);
  assert.ok(block.includes("Evidence: the test name and the commit id of the failing test."), block);
  assert.ok(block.includes(VERIFY_RULES.join("\n")), block);
  assert.ok(block.endsWith(OBSTACLES.join("\n")), block);
  const refactor = crewSkillBlock({ shape: "ship", title: "x", task: "", providerId: "codex", playbook: "refactoring" });
  assert.ok(refactor.includes(`Before you open a PR, run /no-comments (\`${HOME}/.codex/skills/no-comments/SKILL.md\`) over your diff.`), refactor);
});

test("a deploy brief has no playbook and follows the delivery contract", () => {
  const block = crewSkillBlock({ shape: "ship", title: "Deploy + merge #2155", task: "", providerId: "acp-grok" });
  assert.ok(block.includes("3. No playbook: this is a deploy or operator task. Follow the brief's delivery contract."), block);
  assert.ok(!block.includes("/playbooks/"), block);
  assert.ok(!block.includes("Copy every step"), block);
});

test("each provider's brief points at the folder where that provider reads skills", () => {
  for (const [providerId, root] of [
    ["claude-code", ".claude/skills"],
    ["codex", ".codex/skills"],
    ["acp-cursor", ".cursor/skills"],
    ["acp-grok", ".grok/skills"],
    ["acp-antigravity", ".gemini/skills"],
    ["pi", ".pi/agent/skills"],
    [null, ".agents/skills"],
    ["some-new-provider", ".agents/skills"],
  ] as const) {
    const block = crewSkillBlock({ shape: "ship", title: "Perf 1: workflow admission contention", task: "", providerId });
    assert.ok(block.includes(`2. Read \`${HOME}/${root}/poteto-mode/SKILL.md\` in full.`), `${providerId}: ${block}`);
    assert.ok(block.includes(`3. Follow \`${HOME}/${root}/poteto-mode/playbooks/perf-issue.md\`.`), `${providerId}: ${block}`);
  }
});

test("every brief says to load skills as files, names the skill-routing file and counts in-session delegate steps as done", () => {
  for (const [providerId, root] of [["claude-code", ".claude/skills"], ["codex", ".codex/skills"], [null, ".agents/skills"]] as const) {
    const block = crewSkillBlock({ shape: "ship", title: "Fix agent computer feature", task: "", providerId });
    assert.ok(block.includes("Load a skill by reading that file. Do not rely on a Skill tool for pstack skills; they are user-invocable only."), block);
    assert.ok(block.includes(`1. Read \`${HOME}/${root}/skill-routing/SKILL.md\`.`), block);
    assert.ok(block.includes(IN_PLACE_OF_A_SKIP.join("\n")), block);
    assert.ok(block.includes("Spawn no sub-agents, except"), block);
  }
  const deploy = crewSkillBlock({ shape: "ship", title: "Deploy + merge #2155", task: "" });
  assert.ok(deploy.includes(`1. Read \`${HOME}/.agents/skills/skill-routing/SKILL.md\`.`), deploy);
  assert.ok(!deploy.includes("(done in session)"), deploy);
});

test("the skill-routing link step links a missing entry, repairs a broken link and leaves a real folder or a working link alone", () => {
  const home = mkdtempSync(join(tmpdir(), "fm-skill-link-"));
  try {
    const target = join(home, "plugin/entry-skills/skill-routing");
    const other = join(home, "other/skill-routing");
    for (const dir of [target, other]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "SKILL.md"), "routing\n");
    }
    mkdirSync(join(home, ".claude"));
    mkdirSync(join(home, ".codex/skills"), { recursive: true });
    symlinkSync(join(home, "gone/skill-routing"), join(home, ".codex/skills/skill-routing"));
    mkdirSync(join(home, ".cursor/skills/skill-routing"), { recursive: true });
    writeFileSync(join(home, ".cursor/skills/skill-routing/SKILL.md"), "owner copy\n");
    mkdirSync(join(home, ".grok/skills"), { recursive: true });
    symlinkSync(other, join(home, ".grok/skills/skill-routing"));
    const run = () => spawnSync("bash", ["-c", skillRoutingLinkScript(target)], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home } });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(first.stdout.trim().split("\n").sort(), [
      `skill-routing-link kept ${home}/.cursor/skills/skill-routing`,
      `skill-routing-link kept ${home}/.grok/skills/skill-routing`,
      `skill-routing-link linked ${home}/.claude/skills/skill-routing`,
      `skill-routing-link repaired ${home}/.codex/skills/skill-routing`,
    ]);
    assert.equal(readlinkSync(join(home, ".claude/skills/skill-routing")), target);
    assert.equal(readlinkSync(join(home, ".codex/skills/skill-routing")), target);
    assert.ok(lstatSync(join(home, ".cursor/skills/skill-routing")).isDirectory(), "a real folder is never replaced");
    assert.equal(readFileSync(join(home, ".cursor/skills/skill-routing/SKILL.md"), "utf8"), "owner copy\n");
    assert.equal(readlinkSync(join(home, ".grok/skills/skill-routing")), other, "a working link is never replaced");
    for (const absent of [".gemini", ".pi", ".agents"]) assert.ok(!existsSync(join(home, absent)), `${absent} must not be created`);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.ok(second.stdout.trim().split("\n").every((line) => line.startsWith("skill-routing-link kept ")), second.stdout);
    const missing = spawnSync("bash", ["-c", skillRoutingLinkScript(join(home, "no-plugin/skill-routing"))], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home } });
    assert.equal(missing.status, 0, missing.stderr);
    assert.match(missing.stdout, /^skill-routing-link target-missing /);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a scout brief investigates and has no PR step", () => {
  const block = crewSkillBlock({ shape: "scout", title: "Why does Telegram stall", task: "" });
  assert.ok(block.includes(`3. Follow \`${HOME}/.agents/skills/poteto-mode/playbooks/investigation.md\`.`), block);
  assert.ok(!block.includes("/no-comments"), block);
});

test("every playbook a brief can name exists in this host's pstack install", (t) => {
  const root = `${HOME}/.agents/skills/poteto-mode/playbooks`;
  if (!existsSync(root)) return t.skip("pstack is not installed on this host");
  for (const playbook of PLAYBOOK_CHOICES.filter((choice) => choice !== "none")) {
    assert.ok(existsSync(`${root}/${playbook}.md`), playbook);
  }
});

test("skill-routing states the pstack rule, its two exceptions and the load rule", () => {
  const routing = readFileSync(new URL("../entry-skills/skill-routing/SKILL.md", import.meta.url), "utf8").replace(/\s*\n\s*/g, " ");
  for (const text of [
    "pstack always has priority. If a skill or rule conflicts with it, pstack wins.",
    "Until the owner confirms otherwise: crews spawn no sub-agents, except for `arena` or `interrogate` where the playbook calls for them",
    "Until the owner confirms otherwise: Firstmate decides who merges and deploys.",
    "Load the skills the matched rows name, plus poteto-mode, plus every skill the chosen playbook names.",
    "Before you open a PR, run `/no-comments` over your diff.",
    "That is the only reason to skip a pstack skill.",
  ]) assert.ok(routing.includes(text), text);
  for (const removed of ["Load only the skills", "Skip Cursor-only steps", "Firstmate rules win", "give way to the brief"]) {
    assert.ok(!routing.includes(removed), removed);
  }
});

test("the captain Telegram guide gives the same screenshot rule as the crew brief", () => {
  const guide = readFileSync(new URL("../entry-skills/captain/references/telegram.md", import.meta.url), "utf8").replace(/\s*\n\s*/g, " ");
  assert.ok(guide.includes("Save each screenshot as its own full-size PNG file. Never combine, stitch or downscale screenshots; link each file separately."), guide);
  for (const shape of ["ship", "scout"] as const) {
    assert.ok(crewSkillBlock({ shape, title: "Redesign Import from screenshots", task: "" }).includes("Never combine, stitch or downscale screenshots; link each file separately."), shape);
  }
});

// 15 Oct: the owner asked to run Matt Pocock's /to-spec, /to-tickets, /implement-spec,
// /implement and /grill-me from Telegram.
const MATT_COMMANDS = [
  ["/to-spec", "to-spec"],
  ["/to-tickets", "to-tickets"],
  ["/implement-spec", "implement-spec"],
  ["/implement", "implement"],
  ["/grill-me", "grilling"],
] as const;

test("the toolchain check declares the skills the owner's Telegram skill commands load", () => {
  const declared = new Set<string>(BRIEF_SKILLS);
  for (const [, skill] of MATT_COMMANDS) assert.ok(declared.has(skill), skill);
  assert.match(skillCheckScript(), / implement implement-spec /);
});

test("skill-routing and the captain Telegram guide route each Matt Pocock skill command", () => {
  const routing = readFileSync(new URL("../entry-skills/skill-routing/SKILL.md", import.meta.url), "utf8");
  const row = routing.split("\n").find((line) => line.startsWith("| Owner asks for "));
  assert.ok(row, "skill-routing has a row for owner skill commands");
  for (const [command, skill] of MATT_COMMANDS) assert.ok(row.includes(`\`${command}\``) && row.includes(`\`${skill}\``), command);
  const guide = readFileSync(new URL("../entry-skills/captain/references/telegram.md", import.meta.url), "utf8").replace(/\s*\n\s*/g, " ");
  for (const [command] of MATT_COMMANDS) assert.ok(guide.includes(`\`${command}\``), command);
  for (const text of [
    "dispatch a scout or ship crew",
    "GitHub issues",
    "`firstmate_program`",
    "dispatch every ready ticket",
    "Run the `grilling` skill yourself",
    "one question per `firstmate_reply`",
  ]) assert.ok(guide.includes(text), text);
});

test("every brief tells a worker to work through an ordinary obstacle and when blocked is allowed", () => {
  for (const [shape, title] of [["ship", "Add a CSV export"], ["ship", "Deploy + merge #2155"], ["scout", "Why does Telegram stall"]] as const) {
    const block = crewSkillBlock({ shape, title, task: "", providerId: "codex" });
    assert.ok(block.endsWith(OBSTACLES.join("\n")), block);
  }
});

const ROUTING = readFileSync(new URL("../entry-skills/skill-routing/SKILL.md", import.meta.url), "utf8");

function routingTableNames(): { skills: string[]; playbooks: string[] } {
  const names = ROUTING.split("\n").filter((line) => /^\| [^|]+ \| .+ \|$/.test(line) && !line.startsWith("| Task ") && !line.startsWith("|---"))
    .flatMap((line) => [...line.split("|")[2]!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!));
  return {
    skills: names.filter((name) => !name.endsWith(".md") && name !== "principle-*"),
    playbooks: names.filter((name) => name.endsWith(".md")).map((name) => name.slice(0, -3)),
  };
}

test("a brief names only skills from the declared table, under the provider's own folder", () => {
  const declared = new Set<string>(BRIEF_SKILLS);
  const playbooks = new Set<string>(PLAYBOOK_CHOICES);
  for (const providerId of ["claude-code", "codex", "acp-grok"]) {
    const root = crewSkillRoot(providerId);
    for (const shape of ["ship", "scout"] as const) {
      for (const playbook of PLAYBOOK_CHOICES) {
        const block = crewSkillBlock({ shape, title: "x", task: "", providerId, playbook });
        const paths = [...block.matchAll(/`(\/[^`]+)`/g)].map((m) => m[1]!);
        assert.ok(paths.length >= 3, block);
        for (const path of paths) {
          assert.ok(path.startsWith(`${root}/`), `${providerId} brief names a path outside ${root}: ${path}`);
          const [skill, ...rest] = path.slice(root.length + 1).split("/");
          assert.ok(skill === "<name>" || declared.has(skill!), `${providerId} brief names undeclared skill: ${path}`);
          if (rest[0] === "playbooks") assert.ok(playbooks.has(rest[1]!.replace(/\.md$/, "")), `undeclared playbook: ${path}`);
          else assert.deepEqual(rest, ["SKILL.md"], path);
        }
        for (const [, name] of block.matchAll(/(?:^|[\s(])\/([a-z][a-z-]+)\b/gm)) {
          assert.ok(declared.has(name!) || name === "loop", `${providerId} brief names undeclared slash skill: /${name}`);
        }
        for (const [, name] of block.matchAll(/for ([a-z-]+) read ([a-z-]+)/g)) assert.ok(!declared.has(name!), `${name} has a stand-in, so it must not be declared`);
        for (const [, , standIn] of block.matchAll(/for ([a-z-]+) read ([a-z-]+)/g)) assert.ok(declared.has(standIn!), `stand-in is undeclared: ${standIn}`);
      }
    }
  }
});

test("the routing table names only declared skills and playbooks", () => {
  const declared = new Set<string>(BRIEF_SKILLS);
  const { skills, playbooks } = routingTableNames();
  assert.ok(skills.length >= 15 && playbooks.length >= 8, "the table parser found the rows");
  for (const skill of skills) assert.ok(declared.has(skill), `skill-routing names undeclared skill: ${skill}`);
  for (const playbook of playbooks) assert.ok((PLAYBOOK_CHOICES as readonly string[]).includes(playbook), `skill-routing names undeclared playbook: ${playbook}`);
  for (const absent of ["diagnose", "create-skill"]) assert.ok(!declared.has(absent), `${absent} is not an installable skill`);
});

test("the live skill check reports each installed provider's missing skills and playbooks", () => {
  const home = mkdtempSync(join(tmpdir(), "fm-skill-check-"));
  try {
    const install = (root: string, skip: readonly string[]) => {
      for (const skill of BRIEF_SKILLS) {
        if (skip.includes(skill)) continue;
        mkdirSync(join(home, root, skill), { recursive: true });
        writeFileSync(join(home, root, skill, "SKILL.md"), "x\n");
      }
      mkdirSync(join(home, root, "principle-prove-it-works"), { recursive: true });
      writeFileSync(join(home, root, "principle-prove-it-works/SKILL.md"), "x\n");
      mkdirSync(join(home, root, "poteto-mode/playbooks"), { recursive: true });
      for (const playbook of PLAYBOOK_CHOICES) if (playbook !== "none" && !skip.includes(`${playbook}.md`)) writeFileSync(join(home, root, "poteto-mode/playbooks", `${playbook}.md`), "x\n");
    };
    install(".claude/skills", []);
    install(".codex/skills", ["pr", "tdd", "babysit.md"]);
    mkdirSync(join(home, ".grok"));
    const result = spawnSync("bash", ["-c", skillCheckScript()], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", HOME: home } });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(result.stdout.trim().split("\n"), [
      `skills ok: claude-code ${home}/.claude/skills`,
      `SKILLS_MISSING: codex ${home}/.codex/skills: tdd pr poteto-mode/playbooks/babysit.md`,
      `SKILLS_MISSING: acp-grok ${home}/.grok/skills: no skills folder`,
    ]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

// 10 Oct: three 8 GB type checks ran at once outside the limiter, and checks
// started as crew-owned systemd services ran outside the crews' memory group.
test("every brief sends heavy commands through the host limiter, for every provider, shape and playbook", () => {
  for (const providerId of ["claude-code", "codex", "acp-cursor", "acp-grok", "acp-antigravity", "pi", null]) {
    for (const shape of ["ship", "scout"] as const) {
      for (const playbook of PLAYBOOK_CHOICES) {
        const block = crewSkillBlock({ shape, title: "x", task: "", providerId, playbook });
        assert.ok(block.includes(HOST_LIMIT.join("\n")), `${providerId} ${shape} ${playbook}`);
      }
    }
  }
});

// 17 Oct: the four core principles added about 420 characters to every brief, and the
// code pipeline about 1,400 more to a bug-fix or feature brief.
test("the block stays short for every provider, shape, playbook and role", () => {
  for (const providerId of ["claude-code", "codex", "acp-grok", "acp-antigravity", "pi"]) {
    for (const shape of ["ship", "scout"] as const) {
      for (const playbook of PLAYBOOK_CHOICES) {
        for (const role of ["builder", "checker"] as const) {
          const input = { shape, title: "x", task: "", providerId, playbook, role };
          const size = crewSkillBlock(input).length;
          const bound = crewPipeline(input) === null ? 3900 : 5300;
          assert.ok(size <= bound, `${providerId} ${shape} ${playbook} ${role}: ${size} characters`);
        }
      }
    }
  }
});

// 13-14 Oct: Codex crews wrote the playbook steps into <home>/data/<crew>/todo.md
// (17 of 17); Claude Code and Grok crews kept no to-do list at all (0 of 19).
test("a playbook brief names one to-do file in the crew's data folder for every provider", () => {
  const dataDir = "/root/.local/share/bb-firstmate/homes/thr_cap/data/0151f78d";
  const line = `4. Write every step of that playbook into \`${dataDir}/todo.md\` before any other work. Tick each step there as you go.`;
  for (const providerId of ["claude-code", "codex", "acp-grok", "acp-cursor", "pi", null]) {
    for (const playbook of PLAYBOOK_CHOICES) {
      const lines = crewSkillBlock({ shape: "ship", title: "x", task: "", providerId, playbook, dataDir }).split("\n");
      if (playbook === "none") assert.ok(!lines.some((l) => l.includes("todo.md")), `${providerId} none`);
      else if (playbook === "bug-fix" || playbook === "feature") assert.equal(lines[5], `4. Write every pipeline step into \`${dataDir}/todo.md\`, then the playbook steps, before any other work. Tick each step there as you go.`, `${providerId} ${playbook}`);
      else assert.equal(lines[5], line, `${providerId} ${playbook}`);
    }
  }
});

const FEATURE_PLAYBOOK = [
  "### Feature", "", "**You own this task.**", "",
  "1. `how` over the affected subsystem.", "2. `architect` for parallel design exploration.",
  "3. Write the throughput checkpoint as four todo items:", "   - Parallelism: fan-out.", "4. Delegate code-writing.",
  "5. Verify on the matching surface.", "6. Rebase into small, ordered commits.", "", "7. If the design is contested, `interrogate`.", "8. Run **Opening a PR**.",
].join("\n");

test("the step count of a playbook is its numbered top-level lines", () => {
  assert.equal(playbookStepCount(FEATURE_PLAYBOOK), 8);
  assert.equal(playbookStepCount(""), 0);
});

// Real reports from 14 Oct. 0151f78d (Claude Code, feature) had neither part;
// 26f314d4 (Grok, bug-fix) and 2ac602f3 (Codex, babysit) had both.
test("a DONE report missing the skills line or step lines names what is missing", () => {
  const claude0151 = "# Per-re-import webhook event key\n\n14 October 2026. Worker 0151f78d. PR: https://github.com/Cyndra-AI/cyndra-saas/pull/2413\nNothing was deployed.\n\nDONE: PR 2413 open";
  assert.deepEqual(reportGaps(claude0151, 8), ["a \"Skills read:\" line", "playbook step lines (0 of 8)"]);
  const grok26f3 = [
    "- ✓ 1. Reproduce it yourself on the matching surface via the control skill.",
    "- ✓ 2. Binary-search the cause. (done in session)",
    "- ✓ 3. Plan the fix. (done in session)",
    "- ✓ 4. Verify on the same surface. Original repro now passes.",
    "- ✓ 5. Stage the commits so the failing repro lands before the fix in git history.",
    "- ✓ 6. Run Opening a PR: PR 305 updated in place. No merge, no deploy.",
    "", "## Skills read", "", "- /root/.grok/skills/skill-routing/SKILL.md",
  ].join("\n");
  assert.deepEqual(reportGaps(grok26f3, 6), []);
  const codex2ac6 = "✓ Declare the mode.\n✓ Work the merge frontier.\nskip: Triage Bugbot: no findings\nSkills read: /root/.codex/skills/poteto-mode/SKILL.md";
  assert.deepEqual(reportGaps(codex2ac6, 3), []);
  assert.deepEqual(reportGaps(grok26f3.split("\n").slice(2).join("\n"), 6), ["playbook step lines (4 of 6)"]);
  assert.deepEqual(reportGaps("not read: /root/.claude/skills/tdd/SKILL.md: not installed\n✓ one", 1), []);
});

test("the captain note and the crew request name the crew and the missing parts", () => {
  const gaps = ["a \"Skills read:\" line", "playbook step lines (0 of 8)"];
  assert.equal(reportGapNote("0151f78d", gaps), "Report check: crew 0151f78d's DONE report lacks a \"Skills read:\" line; playbook step lines (0 of 8). Asked the crew to add them. Its delivery is not held.");
  assert.equal(reportGapRequest(gaps), [
    "REPORT INCOMPLETE: your final report lacks a \"Skills read:\" line; playbook step lines (0 of 8).",
    "Reply with only the missing parts: a line \"Skills read: <paths>\", and one line per playbook step, \"✓ <step>\" or \"skip: <step>: <reason>\".",
    "Do not redo the task. End with your DONE: line again.",
  ].join("\n"));
});

// 15 Oct: crew 0940c38e (Grok, bug-fix) reported DONE with "pending: Verify on the same
// surface (waiting Secret and dependency scan + the other five required jobs)" and a
// manual Telegram checklist for a human. PR 2315 merged, and every incoming Telegram
// message was dropped after the next restart.
const BUG_FIX_PLAYBOOK = [
  "### Bug fix", "",
  "1. Reproduce it yourself on the matching surface via the control skill (Non-negotiables).",
  "2. Binary-search the cause.",
  "3. Plan the fix.",
  "4. Verify on the same surface. The original repro now passes. \"Inconclusive\" or wrong-surface is not a pass. Flag it.",
  "5. Stage the commits so the failing repro lands before the fix in git history.",
  "6. Run **Opening a PR**.",
].join("\n");
const REPORT_0940C38E = [
  "## Playbook steps", "",
  "- ✓ Reproduce it yourself on the matching surface (gitleaks CI / local gitleaks --redact)",
  "- ✓ Binary-search the cause (done in session)",
  "- ✓ Plan the fix. Architect yourself. (done in session)",
  "- pending: Verify on the same surface (waiting Secret and dependency scan + the other five required jobs)",
  "- ✓ Stage the commits so the failing repro lands before the fix",
  "- ✓ Opening a PR (done in session). Delivery contract: direct-PR, no merge/deploy.",
].join("\n");

test("the 0940c38e report's pending verify step is NOT VERIFIED", () => {
  assert.equal(verifyStepGap(REPORT_0940C38E, BUG_FIX_PLAYBOOK),
    "pending: \"Verify on the same surface (waiting Secret and dependency scan + the other five required jobs)\"");
});

test("a verify step that is skipped, blocked or missing is NOT VERIFIED", () => {
  const withStep = (line: string) => REPORT_0940C38E.replace(/^- pending: Verify.*$/m, line);
  assert.match(verifyStepGap(withStep("- skip: Verify on the same surface: no staging access"), BUG_FIX_PLAYBOOK) ?? "", /^skipped: /);
  assert.match(verifyStepGap(withStep("- blocked: Verify on the same surface: no bot token"), BUG_FIX_PLAYBOOK) ?? "", /^blocked: /);
  assert.equal(verifyStepGap(withStep(""), BUG_FIX_PLAYBOOK), "missing: no \"Verify on the same surface\" line");
});

test("a verify step that drove the real surface passes, and a playbook without a verify step is not checked", () => {
  const driven = REPORT_0940C38E.replace(/^- pending: Verify.*$/m,
    "- ✓ Verify on the same surface: sent hello to the staging bot in an allowed chat; the reply arrived (screenshot telegram-hello.png)");
  assert.equal(verifyStepGap(driven, BUG_FIX_PLAYBOOK), null);
  assert.equal(verifyStepGap(REPORT_0940C38E.replace(/^- pending: Verify.*$/m, "✓ 4. step"), BUG_FIX_PLAYBOOK), null);
  const investigation = "### Investigation\n\n1. Route through the **how** skill.\n2. Throughput checkpoint stays one line.\n3. Produce the output.\n4. Apply the **unslop** skill.\n";
  assert.equal(verifyStepGap("✓ how\n✓ checkpoint", investigation), null);
});

test("the NOT VERIFIED note goes to the captain and says the PR cannot merge without a record", () => {
  const note = notVerifiedNote("0940c38e", "pending: \"Verify on the same surface\"");
  assert.equal(note, [
    "NOT VERIFIED: crew 0940c38e's DONE report has its verify step pending: \"Verify on the same surface\".",
    "CI and unit tests are not verification.",
    "Its PRs cannot merge until a verification record exists for the PR head: drive the changed surface, then firstmate_deliveries action=verify with the head commit, driven and seen.",
    "Only the owner's own words can waive it: firstmate_merge allowUnverified=\"<owner words>\".",
  ].join("\n"));
  assert.match(notVerifiedRequest("pending: \"Verify on the same surface\""), /^VERIFY STEP NOT DONE: your report has the verify step pending/);
});

test("every playbook brief says CI is not verification, and a blocked surface is a blocker, not a checklist", () => {
  for (const playbook of PLAYBOOK_CHOICES.filter((p) => p !== "none")) {
    const block = crewSkillBlock({ shape: "ship", title: "x", task: "", providerId: "acp-grok", playbook });
    assert.ok(block.includes(VERIFY_RULES.join("\n")), `${playbook}\n${block}`);
  }
  assert.ok(!crewSkillBlock({ shape: "ship", title: "Deploy + merge #2155", task: "" }).includes(VERIFY_RULES[0]!));
});

test("every brief says merges go only through bb firstmate merge, never gh pr merge or the API", () => {
  for (const playbook of PLAYBOOK_CHOICES) {
    const block = crewSkillBlock({ shape: "ship", title: "Release the 21 green PRs", task: "", playbook });
    assert.ok(block.includes(MERGE_RULE), `${playbook}\n${block}`);
  }
});

test("a release or operator brief gives the per-PR drive, record and merge steps after the host rules", () => {
  assert.equal(crewPlaybook({ shape: "ship", title: "Release the green PRs", task: "" }), "none");
  const release = crewSkillBlock({ shape: "ship", title: "Release the green PRs", task: "Merge the approved PRs", providerId: "codex" });
  assert.ok(release.includes([MERGE_RULE, ...HOST_LIMIT, ...MERGE_SEQUENCE].join("\n")), release);
  assert.ok(!crewSkillBlock({ shape: "ship", title: "Add a CSV export", task: "" }).includes(MERGE_SEQUENCE[0]!));
});

// PR 129 verdict 3: the captain rules promised a NOT VERIFIED note for a report naming
// only CI; the report check reads the step's state, not its wording.
test("the captain rules describe the report check and the record as they work", () => {
  const rules = readFileSync(new URL("../entry-skills/captain/references/supervision.md", import.meta.url), "utf8");
  assert.doesNotMatch(rules, /naming only CI/);
  assert.match(rules, /verify step pending, skipped or blocked comes with a NOT VERIFIED note/);
  assert.match(rules, /The report text is not judged; the evidence is the record's two fields, `driven` and `seen`\./);
});

// 16-17 Oct owner decisions Q4, Q8, Q18, Q19: a fixed pipeline for code work, a checker
// crew for production changes, four core principles in every brief, and sub-agents only
// for arena or interrogate.
const principles = (root: string) =>
  `Core principles: read \`${root}/principle-prove-it-works/SKILL.md\`, \`${root}/principle-fix-root-causes/SKILL.md\`, \`${root}/principle-attack-the-premise/SKILL.md\` and \`${root}/principle-test-behavior-not-implementation/SKILL.md\` in full. poteto-mode loads the other principles by their triggers.`;

test("a bug-fix brief carries the fixed pipeline in order, with each skill's path and the evidence its report line gives", () => {
  const root = `${HOME}/.codex/skills`;
  const block = crewSkillBlock({ shape: "ship", title: "Fix the crash on save", task: "", providerId: "codex", dataDir: "/fm/data/c1" });
  assert.ok(block.includes([
    "### Pipeline (bug fix). Do every step, in this order:",
    `P1. Diagnose: read \`${root}/diagnosing-bugs/SKILL.md\`. Evidence: the root cause and how you found it.`,
    `P2. Failing test: read \`${root}/tdd/SKILL.md\`. Evidence: the test name and the commit id of the failing test.`,
    "P3. Fix at the root. Evidence: where the system first went wrong and the fix commit id.",
    `P4. Prove on the real surface: use the project's verify skill if it has one (e.g. \`.agents/skills/verify-<app>/\`), else read \`${root}/verify-this/SKILL.md\`. Evidence: the PR and head you proved, what you drove and what you saw.`,
    `P5. Blast radius: read \`${root}/blast-radius/SKILL.md\`. Evidence: what else the change could break and what you ran to rule it out.`,
    `P6. No comments: read \`${root}/no-comments/SKILL.md\`. Evidence: the comments you removed, or none.`,
    `P7. PR: read \`${root}/pr/SKILL.md\`. Evidence: the PR link.`,
    "Your final report has one line per pipeline step: \"✓ P<n> <step>: <evidence>\" or \"skip: P<n> <step>: <reason>\".",
    "Write that report to `/fm/data/c1/report.md` before you record verification. `bb firstmate deliveries verify` refuses this crew's PR until the report has \"✓ P4 Prove on the real surface for <owner/repo#n> at <head sha>: driven <what>; seen <what>\" for that PR at its current head. After a new push, add a new P4 line.",
  ].join("\n")), block);
  assert.ok(block.includes("4. Write every pipeline step into `/fm/data/c1/todo.md`, then the playbook steps, before any other work. Tick each step there as you go."), block);
  assert.ok(block.includes("5. Your final report lists each pipeline step as the Pipeline section says."), block);
  assert.ok(block.includes(principles(root)), block);
});

test("a feature brief carries sharpen, architect, tdd build, proof, code review, no-comments and pr", () => {
  const block = crewSkillBlock({ shape: "ship", title: "Add a CSV export", task: "", providerId: "claude-code" });
  const steps = block.split("\n").filter((line) => /^P\d+\. /.test(line)).map((line) => line.split(/[:.] /)[1]);
  assert.deepEqual(steps, ["Sharpen", "Architect", "TDD build", "Prove on the real surface", "Code review", "No comments", "PR"]);
  assert.ok(block.includes("### Pipeline (feature). Do every step, in this order:"), block);
});

test("refactor, perf, research and operator briefs carry no pipeline; every brief names the four core principles", () => {
  for (const providerId of ["claude-code", "codex", null]) {
    const root = crewSkillRoot(providerId);
    for (const shape of ["ship", "scout"] as const) {
      for (const playbook of PLAYBOOK_CHOICES) {
        const block = crewSkillBlock({ shape, title: "x", task: "", providerId, playbook });
        assert.ok(block.includes(principles(root)), `${providerId} ${shape} ${playbook}`);
        const piped = shape === "ship" && (playbook === "bug-fix" || playbook === "feature");
        assert.equal(block.includes("### Pipeline"), piped, `${shape} ${playbook}`);
      }
    }
  }
});

test("a checker brief reviews the PR head on a different model and records a verdict; it has no pipeline", () => {
  const block = crewSkillBlock({ shape: "ship", title: "Check PR #12", task: "", providerId: "codex", role: "checker" });
  assert.ok(block.includes([
    "### Checker (Firstmate adds this to a checker crew's brief)",
    "You check another crew's PR before it merges. Do not change its branch.",
    `1. Read the diff at the PR's current head. Review it with \`${HOME}/.codex/skills/code-review/SKILL.md\` and \`${HOME}/.codex/skills/blast-radius/SKILL.md\`.`,
    "2. Drive the changed surface yourself, with the project's verify skill if it has one.",
    "3. Record your verdict: `bb firstmate deliveries check <owner/repo#n> --commit <head sha> --verdict pass|fail --notes \"<what you checked, drove and saw>\"`.",
    "4. A fail verdict names each finding. A new push needs a new check.",
  ].join("\n")), block);
  assert.ok(!block.includes("### Pipeline"), block);
  assert.ok(!block.includes("/playbooks/"), block);
  assert.equal(crewPlaybook({ shape: "ship", title: "Fix the crash", task: "", role: "checker" }), "none");
});

test("crews spawn sub-agents only for arena or interrogate, at most 3, with heavy work through fm-heavy", () => {
  const rule = "Spawn no sub-agents, except where your playbook calls for `arena` (a new UI or design choice with no example in the code) or `interrogate` (a risky PR): then spawn at most 3 extra agents for that step, and run their heavy commands through `~/.bb-firstmate/bin/fm-heavy`. Do everything else yourself, in this session.";
  for (const playbook of PLAYBOOK_CHOICES) {
    const block = crewSkillBlock({ shape: "ship", title: "x", task: "", playbook });
    assert.ok(block.includes(rule), playbook);
    assert.ok(!block.includes("spawn no sub-agents (no Task"), playbook);
  }
  const skip = crewSkillBlock({ shape: "ship", title: "Add a CSV export", task: "" });
  assert.ok(skip.includes("- A step or skill that spawns a sub-agent, reviewer or other model (delegate, architect, how, why, no-comments): do it yourself in this session, on your own model. Add \"(done in session)\"."), skip);
  const routing = ROUTING.replace(/\s*\n\s*/g, " ");
  assert.ok(routing.includes("crews spawn no sub-agents, except for `arena` or `interrogate` where the playbook calls for them"), "skill-routing states the exception");
});

const HEAD = "abc1234def5678abc1234def5678abc1234def56";
const PR = { pr: "o/r#9", head: HEAD };
const PROOF = `✓ P4 Prove on the real surface for o/r#9 at ${HEAD.slice(0, 7)}: driven a save on the staging app with the lock held; seen the row saved after release`;
const BUG_REPORT = [
  "✓ P1 Diagnose: the queue drops a row when the lock times out",
  "✓ P2 Failing test: drops no row on lock timeout (commit abc1234)",
  "✓ P3 Fix at the root: lock wait moved before the read (commit def5678)",
  PROOF,
  "✓ P5 Blast radius: the two other lock callers run the same path; their tests pass",
  "✓ P6 No comments: none",
  "✓ P7 PR: https://github.com/o/r/pull/9",
].join("\n");
const withProof = (line: string) => BUG_REPORT.replace(/^✓ P4 .*$/m, line);

test("a P4 line for this PR at its head, with what was driven and seen, passes the proof check", () => {
  assert.equal(pipelineProofGap(BUG_REPORT, 4, PR), null);
  assert.equal(pipelineProofGap(BUG_REPORT, 4), null, "the DONE check needs one well-formed P4 line");
  assert.equal(pipelineProofGap(withProof(`- ✓ P4 Prove on the real surface for O/R#9 at ${HEAD}: driven x; seen y`), 4, PR), null);
});

test("a P4 line that is skipped, pending, blocked or missing names why", () => {
  assert.equal(pipelineProofGap(withProof("skip: P4 Prove on the real surface: no staging access"), 4, PR), "skipped: \"P4 Prove on the real surface: no staging access\"");
  assert.equal(pipelineProofGap(withProof("pending: P4 Prove on the real surface: waiting on CI"), 4, PR), "pending: \"P4 Prove on the real surface: waiting on CI\"");
  assert.equal(pipelineProofGap(withProof("blocked: P4 Prove on the real surface: no bot token"), 4), "blocked: \"P4 Prove on the real surface: no bot token\"");
  assert.equal(pipelineProofGap(withProof(""), 4), "missing: no \"✓ P4 Prove on the real surface\" line");
});

// FM138 verdict 1, finding 2.
test("a P4 line with an empty driven or seen field, or at the wrong step, is refused", () => {
  const empty = "malformed: the line must read \"✓ P4 Prove on the real surface for <owner/repo#n> at <head sha>: driven <what>; seen <what>\", with both fields filled";
  assert.equal(pipelineProofGap(withProof("✓ P4 Prove on the real surface for o/r#9 at abc1234: driven ; seen"), 4, PR), empty);
  assert.equal(pipelineProofGap(withProof("✓ P4 Prove on the real surface for o/r#9 at abc1234: driven the app; seen  "), 4, PR), empty);
  assert.equal(pipelineProofGap(withProof("✓ P4 Prove on the real surface: CI is green"), 4, PR), empty);
  assert.equal(pipelineProofGap(withProof("✓ P99 Prove on the real surface for o/r#9 at abc1234: driven browser; seen page"), 4, PR), "missing: no \"✓ P4 Prove on the real surface\" line");
  assert.equal(pipelineProofGap(withProof("✓ Prove on the real surface for o/r#9 at abc1234: driven browser; seen page"), 4, PR), "missing: no \"✓ P4 Prove on the real surface\" line");
});

// FM138 verdict 1, finding 3.
test("a P4 line for another PR or an older head does not prove this PR at this head", () => {
  const want = `missing: no "✓ P4 Prove on the real surface for o/r#9 at ${HEAD.slice(0, 7)}" line`;
  assert.equal(pipelineProofGap(withProof("✓ P4 Prove on the real surface for o/other#9 at abc1234: driven x; seen y"), 4, PR), want);
  assert.equal(pipelineProofGap(withProof("✓ P4 Prove on the real surface for o/r#10 at abc1234: driven x; seen y"), 4, PR), want);
  assert.equal(pipelineProofGap(withProof("✓ P4 Prove on the real surface for o/r#9 at 0000000: driven x; seen y"), 4, PR), want);
  assert.match(pipelineProofGap(withProof("✓ P4 Prove on the real surface for o/r#9 at abc12: driven x; seen y"), 4, PR) ?? "", /^malformed: /, "fewer than 7 characters names no commit");
  const two = `${BUG_REPORT}\n✓ P4 Prove on the real surface for o/r#10 at 1111111: driven y; seen z`;
  assert.equal(pipelineProofGap(two, 4, PR), null, "one report can prove two PRs, one line each");
  assert.equal(pipelineProofGap(two, 4, { pr: "o/r#10", head: "1111111aaaa" }), null);
});

test("a pipeline crew's DONE report is counted against the pipeline steps, and the request asks for pipeline lines", () => {
  assert.match(reportGapRequest(["playbook step lines (3 of 7)"], true), /one line per pipeline step, "✓ P<n> <step>: <evidence>" or "skip: P<n> <step>: <reason>"\./);
  assert.deepEqual(reportGaps(`${BUG_REPORT}\nSkills read: /x`, CODE_PIPELINES["bug-fix"].length), []);
  assert.deepEqual(reportGaps(`${BUG_REPORT.split("\n").slice(0, 3).join("\n")}\nSkills read: /x`, CODE_PIPELINES["bug-fix"].length), ["playbook step lines (3 of 7)"]);
});

test("the captain rules name the dispatch skills, the crew models and the checker rule", () => {
  const rules = readFileSync(new URL("../entry-skills/captain/references/supervision.md", import.meta.url), "utf8").replace(/\s*\n\s*/g, " ");
  for (const text of [
    "Read `poteto-help` and pick the playbook and skills for the task.",
    "run `sharpen`, then `in-your-own-words`",
    "run `interrogate` on it",
    "prove it with `principle-prove-it-works` or `verify-this`",
    "`principle-never-block-on-the-human`, `principle-sequence-verifiable-units`, `principle-encode-lessons-in-structure` and `principle-guard-the-context-window`",
    "A builder (the default) runs claude-code `claude-opus-5-5`. A checker runs codex `gpt-6-astra`.",
    "They apply to that task's crews only.",
    "`firstmate_merge` refuses a production PR without a `pass` verdict for its current head.",
  ]) assert.ok(rules.includes(text), text);
});

// FM138 verdict 2, finding 2: an open P4 line for this PR at this head wins over a done one.
test("a blocked, pending or skipped P4 line for this PR and head wins over a done one, in either order", () => {
  const blocked = `blocked: P4 Prove on the real surface for o/r#9 at ${HEAD.slice(0, 7)}: staging is down`;
  for (const report of [`${BUG_REPORT}\n${blocked}`, `${blocked}\n${BUG_REPORT}`]) {
    assert.equal(pipelineProofGap(report, 4, PR), `blocked: "P4 Prove on the real surface for o/r#9 at ${HEAD.slice(0, 7)}: staging is down"`);
  }
  assert.match(pipelineProofGap(`${BUG_REPORT}\npending: P4 Prove on the real surface for o/r#9 at ${HEAD}: waiting`, 4, PR) ?? "", /^pending: /);
  assert.match(pipelineProofGap(`${BUG_REPORT}\nskip: P4 Prove on the real surface for o/r#9 at ${HEAD.slice(0, 7)}: no access`, 4, PR) ?? "", /^skipped: /);
  assert.equal(pipelineProofGap(`${BUG_REPORT}\nblocked: P4 Prove on the real surface for o/r#10 at ${HEAD.slice(0, 7)}: other PR`, 4, PR), null, "another PR's open line is independent");
  assert.equal(pipelineProofGap(`${BUG_REPORT}\nblocked: P4 Prove on the real surface for o/r#9 at 1111111: older head`, 4, PR), null, "an older head's open line is independent");
});
