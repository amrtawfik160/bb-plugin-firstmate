import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(process.cwd(), "scripts/skill-roots-check.sh");

function fakeHome() {
  const home = mkdtempSync(join(tmpdir(), "skill-roots-"));
  for (const root of [".claude/skills", ".codex/skills", ".agents/skills"]) mkdirSync(join(home, root), { recursive: true });
  const skill = (root, name, body, extra = {}) => {
    mkdirSync(join(home, root, name), { recursive: true });
    writeFileSync(join(home, root, name, "SKILL.md"), body);
    for (const [file, text] of Object.entries(extra)) writeFileSync(join(home, root, name, file), text);
  };
  return { home, skill };
}

const run = (home) => spawnSync("bash", [SCRIPT], { encoding: "utf8", env: { ...process.env, HOME: home } });

test("skills linked to one source pass", () => {
  const { home, skill } = fakeHome();
  try {
    skill(".agents/skills", "tdd", "matt tdd");
    symlinkSync("../../.agents/skills/tdd", join(home, ".claude/skills/tdd"));
    symlinkSync("../../.agents/skills/tdd", join(home, ".codex/skills/tdd"));
    skill(".claude/skills", "only-claude", "one root only");
    const r = run(home);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^skill roots ok: 1 shared skills match in claude, codex, agents$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a skill whose content differs between roots is reported by name and fails", () => {
  const { home, skill } = fakeHome();
  try {
    skill(".agents/skills", "tdd", "matt tdd");
    symlinkSync("../../.agents/skills/tdd", join(home, ".claude/skills/tdd"));
    skill(".codex/skills", "tdd", "pstack tdd");
    skill(".agents/skills", "grilling", "same", { "notes.md": "new" });
    skill(".codex/skills", "grilling", "same", { "notes.md": "old" });
    const r = run(home);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^SKILL_DIFFERS: tdd claude=[0-9a-f]{12} codex=[0-9a-f]{12} agents=[0-9a-f]{12}$/m);
    assert.match(r.stdout, /^SKILL_DIFFERS: grilling claude=none codex=[0-9a-f]{12} agents=[0-9a-f]{12}$/m);
    assert.match(r.stderr, /2 skills differ between skill roots or have a broken link: grilling tdd/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a broken skill link is reported", () => {
  const { home, skill } = fakeHome();
  try {
    skill(".agents/skills", "pr", "pr");
    symlinkSync("../../.agents/skills/missing", join(home, ".codex/skills/pr"));
    const r = run(home);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /^SKILL_BROKEN: pr codex .*\.codex\/skills\/pr$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
