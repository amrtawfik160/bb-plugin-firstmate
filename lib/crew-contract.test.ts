import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { crewPlaybook, crewSkillBlock, PLAYBOOK_CHOICES, skillRoutingLinkScript } from "./crew-contract.ts";

const HOME = homedir();

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
    "pstack always has priority. If a skill or rule conflicts with it, pstack wins.",
    "Until the owner confirms otherwise: spawn no sub-agents (no Task, poteto-agent or parallel workers). Do that work yourself, in this session.",
    "Until the owner confirms otherwise: Firstmate decides who merges and deploys. Follow the brief's delivery contract for merge and deploy.",
    `Skills on this host are in \`${HOME}/.claude/skills/<name>/SKILL.md\`. Load a skill by reading that file. Do not rely on a Skill tool for pstack skills; they are user-invocable only.`,
    "If a skill is not installed, continue without it and say so in your report.",
    `1. Read \`${HOME}/.claude/skills/skill-routing/SKILL.md\`. Load the skills its matched rows name, plus poteto-mode, plus every skill the chosen playbook names.`,
    `2. Read \`${HOME}/.claude/skills/poteto-mode/SKILL.md\` in full.`,
    `3. Follow \`${HOME}/.claude/skills/poteto-mode/playbooks/feature.md\`.`,
    "4. Copy every step of that playbook into your to-do list, before any other to-do.",
    "5. Your final report lists each playbook step as \"✓ <step>\" or \"skip: <step>: <reason>\".",
    "When a playbook step says to delegate to a sub-agent, do that step yourself in this session and report it as ✓ with \"(done in session)\", not as a skip.",
    "Save each screenshot as its own full-size PNG file. Never combine, stitch or downscale screenshots; link each file separately.",
    `Before you open a PR, run /no-comments (\`${HOME}/.claude/skills/no-comments/SKILL.md\`) over your diff.`,
  ].join("\n"));
});

test("a bug-fix brief asks for the failing-test commit and proof on the real product", () => {
  const block = crewSkillBlock({ shape: "ship", title: "Fix agent computer feature", task: "", providerId: "codex" });
  assert.ok(block.includes(`3. Follow \`${HOME}/.codex/skills/poteto-mode/playbooks/bug-fix.md\`.`), block);
  assert.ok(block.endsWith([
    "Bug-fix proof: your final report gives the commit id of the failing test, committed before the fix.",
    "It also gives proof that the fix works on the real product, or \"not possible: <reason>\".",
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
    assert.ok(block.includes("When a playbook step says to delegate to a sub-agent, do that step yourself in this session and report it as ✓ with \"(done in session)\", not as a skip."), block);
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
