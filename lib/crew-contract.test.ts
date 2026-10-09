import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { BRIEF_SKILLS, crewPlaybook, crewSkillBlock, crewSkillRoot, PLAYBOOK_CHOICES, skillCheckScript, skillRoutingLinkScript } from "./crew-contract.ts";

const HOME = homedir();

const IN_PLACE_OF_A_SKIP = [
  "Report these steps as ✓, not as a skip:",
  "- A step or skill that spawns a sub-agent, reviewer or other model (delegate, architect, interrogate, how, why, no-comments): do it yourself in this session, on your own model. Add \"(done in session)\".",
  "- Cursor-only tools: for create-skill read writing-for-agents; for /loop repeat the step yourself; for origin or gt use gh-axi.",
  "- Opening a PR, merge, deploy: follow the brief's delivery contract. If proof needs a deploy you may not run, prove it on the nearest surface you can and name what is left for Firstmate.",
];

const OBSTACLES = [
  "### Obstacles",
  "Clear an ordinary obstacle yourself: retry with a smaller query or pagination, restore or commit what your own install changed, use another tool, or wait and retry. If rule 5 under Rules says to stop after two failures, this section replaces it.",
  "Report blocked only for what only the captain or the owner can give: a secret, an approval, a decision, withheld access, or a destructive or irreversible step. Every other stop rule still applies.",
];

const SKILLS_READ = "Your final report has a line \"Skills read: <paths>\" for those files. For one you did not read, add \"not read: <path>: <reason>\".";

const HOUSE_RULES = [
  "pstack always has priority. If a skill or rule conflicts with it, pstack wins.",
  "Until the owner confirms otherwise: spawn no sub-agents (no Task, poteto-agent or parallel workers). Do that work yourself, in this session.",
  "Until the owner confirms otherwise: Firstmate decides who merges and deploys. Follow the brief's delivery contract for merge and deploy.",
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

test("a feature brief gives full paths, the step checklist, no-comments and the pstack rule", () => {
  assert.equal(crewSkillBlock({ shape: "ship", title: "Add a CSV export", task: "", providerId: "claude-code" }), [
    "### Skills (Firstmate adds this to every brief)",
    "First action, before any other command: read the files in steps 1 to 3 in full.",
    `1. Read \`${HOME}/.claude/skills/skill-routing/SKILL.md\`. Load the skills its matched rows name, plus poteto-mode, plus every skill the chosen playbook names.`,
    `2. Read \`${HOME}/.claude/skills/poteto-mode/SKILL.md\` in full.`,
    `3. Follow \`${HOME}/.claude/skills/poteto-mode/playbooks/feature.md\`.`,
    "4. Copy every step of that playbook into your to-do list, before any other to-do.",
    "5. Your final report lists each playbook step as \"✓ <step>\" or \"skip: <step>: <reason>\".",
    SKILLS_READ,
    `Skills on this host are in \`${HOME}/.claude/skills/<name>/SKILL.md\`. Load a skill by reading that file. Do not rely on a Skill tool for pstack skills; they are user-invocable only.`,
    "If a skill is not installed, continue without it and say so in your report.",
    ...HOUSE_RULES,
    ...IN_PLACE_OF_A_SKIP,
    "Save each screenshot as its own full-size PNG file. Never combine, stitch or downscale screenshots; link each file separately.",
    `Before you open a PR, run /no-comments (\`${HOME}/.claude/skills/no-comments/SKILL.md\`) over your diff.`,
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
        assert.equal(lines[1], `First action, before any other command: read the files in ${reads} in full.`);
        assert.ok(lines[2]!.startsWith(`1. Read \`${root}/skill-routing/SKILL.md\`.`), lines[2]);
        assert.equal(lines[3], `2. Read \`${root}/poteto-mode/SKILL.md\` in full.`);
        if (playbook !== "none") assert.equal(lines[4], `3. Follow \`${root}/poteto-mode/playbooks/${playbook}.md\`.`);
        const report = lines.indexOf(SKILLS_READ);
        assert.equal(report, playbook === "none" ? 5 : 7, `${providerId} ${shape} ${playbook}`);
        for (const rule of HOUSE_RULES) assert.ok(lines.indexOf(rule) > report, rule);
      }
    }
  }
});

test("a bug-fix brief asks for the failing-test commit and proof on the real product", () => {
  const block = crewSkillBlock({ shape: "ship", title: "Fix agent computer feature", task: "", providerId: "codex" });
  assert.ok(block.includes(`3. Follow \`${HOME}/.codex/skills/poteto-mode/playbooks/bug-fix.md\`.`), block);
  assert.ok(block.endsWith([
    "Bug-fix proof: your final report gives the commit id of the failing test, committed before the fix.",
    "It also gives proof that the fix works on the real product, or \"not possible: <reason>\".",
    ...OBSTACLES,
  ].join("\n")), block);
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
    assert.ok(block.includes("spawn no sub-agents"), block);
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
    "Until the owner confirms otherwise: crews spawn no sub-agents.",
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

test("the block stays short for every provider, shape and playbook", () => {
  for (const providerId of ["claude-code", "codex", "acp-grok", "acp-antigravity", "pi"]) {
    for (const shape of ["ship", "scout"] as const) {
      for (const playbook of PLAYBOOK_CHOICES) {
        const size = crewSkillBlock({ shape, title: "x", task: "", providerId, playbook }).length;
        assert.ok(size <= 2700, `${providerId} ${shape} ${playbook}: ${size} characters`);
      }
    }
  }
});
