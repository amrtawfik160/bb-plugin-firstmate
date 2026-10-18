import test from "node:test";
import assert from "node:assert/strict";
import { changeReach, REACH } from "./reach.ts";
import { crewExecution, ROLE_DEFAULTS } from "./crew-roles.ts";

const table = { internalPaths: ["/docs/", "test/", "*.md", "*.test.*"], productionPaths: [".github/workflows/", "Dockerfile", "SKILL.md"], repos: { "amrtawfik160/notes": { reach: "internal" as const } } };

test("a code change in a repo the table does not list reaches production", () => {
  assert.deepEqual(changeReach({ repo: "amrtawfik160/Safi", files: ["artifacts/mobile/app/index.tsx", "docs/a.md"], complete: true }, table),
    { reach: "production", why: "amrtawfik160/Safi is not listed as internal, and artifacts/mobile/app/index.tsx is not an internal path" });
});

test("a change that only touches internal paths self-checks", () => {
  assert.equal(changeReach({ repo: "amrtawfik160/Safi", files: ["docs/plan.md", "lib/a.test.ts", "test/fixtures/x.json", "README.md"], complete: true }, table).reach, "internal");
});

test("a repo listed as internal never needs a checker", () => {
  assert.equal(changeReach({ repo: "AmrTawfik160/Notes", files: ["src/server.ts"], complete: true }, table).reach, "internal");
});

test("an unreadable or truncated file list reaches production", () => {
  assert.equal(changeReach({ repo: "amrtawfik160/Safi", files: [], complete: false }, table).reach, "production");
  assert.equal(changeReach({ repo: "amrtawfik160/Safi", files: ["docs/a.md"], complete: false }, table).reach, "production");
  assert.equal(changeReach({ repo: "amrtawfik160/Safi", files: [], complete: true }, table).reach, "production");
});

test("a directory pattern matches at any depth, a leading slash anchors it at the repo root, a file pattern matches the file name only", () => {
  assert.equal(changeReach({ repo: "o/r", files: ["packages/api/test/a.ts"], complete: true }, table).reach, "internal");
  assert.equal(changeReach({ repo: "o/r", files: ["docs/plan.md", "docs/a.png"], complete: true }, table).reach, "internal");
  assert.equal(changeReach({ repo: "o/r", files: ["apps/docs/app/api/route.ts"], complete: true }, table).reach, "production", "a docs folder below the root can hold app code");
  assert.equal(changeReach({ repo: "o/r", files: ["latest/a.ts"], complete: true }, table).reach, "production");
  assert.equal(changeReach({ repo: "o/r", files: ["md/a.ts"], complete: true }, table).reach, "production");
});

// FM138 verdict 1, finding 1: a deploy workflow is production, even in an internal folder.
test("a production path wins over an internal path", () => {
  assert.deepEqual(changeReach({ repo: "o/r", files: [".github/workflows/deploy.yml"], complete: true }, table),
    { reach: "production", why: ".github/workflows/deploy.yml is a production path" });
  assert.equal(changeReach({ repo: "o/r", files: ["docs/Dockerfile"], complete: true }, table).reach, "production");
  assert.equal(changeReach({ repo: "o/r", files: ["skills/review/SKILL.md"], complete: true }, table).reach, "production", "an agent prompt is not a plain doc");
});

test("a repo's own production paths add to the shared ones", () => {
  const own = { ...table, repos: { "o/r": { reach: "production" as const, productionPaths: ["/docs/"] } } };
  assert.equal(changeReach({ repo: "o/r", files: ["docs/index.md"], complete: true }, own).reach, "production", "this project deploys its site from docs/");
  assert.equal(changeReach({ repo: "o/other", files: ["docs/index.md"], complete: true }, own).reach, "internal");
});

test("the shipped table lists only the scratch and demo repos as internal, and treats deploy files as production", () => {
  for (const repo of ["amrtawfik160/fm-canary-step2-20261017", "amrtawfik160/fm-canary-x", "amrtawfik160/firstmate-demo"]) {
    assert.equal(changeReach({ repo, files: ["src/app.ts"], complete: true }).reach, "internal", repo);
  }
  for (const repo of ["amrtawfik160/Safi", "Cyndra-AI/cyndra-saas", "amrtawfik160/bb-plugin-firstmate"]) {
    assert.equal(changeReach({ repo, files: ["src/app.ts"], complete: true }).reach, "production", repo);
  }
  for (const file of [".github/workflows/deploy.yml", ".github/workflows/release.yml", "Dockerfile", "docker-compose.yml", "fly.toml", "vercel.json", "eas.json", "nixpacks.toml", "Procfile", "AGENTS.md", "CLAUDE.md", "skills/x/SKILL.md"]) {
    assert.equal(changeReach({ repo: "o/r", files: [file], complete: true }).reach, "production", file);
  }
  for (const file of ["docs/guide.md", "README.md", "test/a.test.ts", "src/a.test.ts", "CHANGELOG.md"]) {
    assert.equal(changeReach({ repo: "o/r", files: [file], complete: true }).reach, "internal", file);
  }
});

test("each role has a real default provider and model", () => {
  assert.deepEqual(ROLE_DEFAULTS, {
    builder: { providerId: "claude-code", model: "claude-opus-5-5" },
    checker: { providerId: "codex", model: "gpt-6.1-sol" },
    lookup: { providerId: "claude-code", model: "claude-haiku-5-5" },
  });
});

test("a dispatch with no execution choice gets its role's default; a builder is the default role", () => {
  assert.deepEqual(crewExecution({}), { role: "builder", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: undefined, named: false });
  assert.deepEqual(crewExecution({ role: "checker" }), { role: "checker", providerId: "codex", model: "gpt-6.1-sol", reasoningLevel: undefined, named: false });
});

// Owner example: "opus 5.5 medium for ui, grok 4.6 xhigh for logic, codex for checker".
test("a provider, model or effort the owner names wins for that crew only", () => {
  assert.deepEqual(crewExecution({ role: "builder", providerId: "acp-grok", model: "grok-4.6", reasoningLevel: "xhigh" }),
    { role: "builder", providerId: "acp-grok", model: "grok-4.6", reasoningLevel: "xhigh", named: true });
  assert.deepEqual(crewExecution({ role: "builder", reasoningLevel: "medium" }),
    { role: "builder", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: "medium", named: false });
  assert.deepEqual(crewExecution({ role: "checker", providerId: "codex" }),
    { role: "checker", providerId: "codex", model: undefined, reasoningLevel: undefined, named: true });
  assert.deepEqual(crewExecution({ role: "builder", model: "claude-sonnet-5-5" }),
    { role: "builder", providerId: "claude-code", model: "claude-sonnet-5-5", reasoningLevel: undefined, named: true });
  assert.deepEqual(crewExecution({}), crewExecution({ role: "builder" }), "the next dispatch is back on the default");
});

// FM138 verdict 2, finding 1: the captain's shipped instructions and the hashes that pin
// them change how the live captain behaves.
test("in the Firstmate plugin repo, captain prompt files and their pinned hashes are production", () => {
  for (const files of [
    ["entry-skills/captain/references/supervision.md", "docs/verification/native-transport-allowlist.v1.json"],
    ["entry-skills/captain/SKILL.md"],
    ["entry-skills/skill-routing/SKILL.md"],
    ["docs/verification/native-transport-allowlist.v1.json"],
    ["runtime-assets/AGENTS.md"],
  ]) {
    assert.equal(changeReach({ repo: "amrtawfik160/bb-plugin-firstmate", files, complete: true }).reach, "production", files.join(" "));
  }
  assert.deepEqual(changeReach({ repo: "amrtawfik160/bb-plugin-firstmate", files: ["entry-skills/captain/references/supervision.md"], complete: true }),
    { reach: "production", why: "entry-skills/captain/references/supervision.md is a production path" });
  assert.equal(changeReach({ repo: "amrtawfik160/bb-plugin-firstmate", files: ["docs/verification/code-pipeline-2026-10-17.md"], complete: true }).reach, "internal", "a plain verification note is still a doc");
  assert.equal(changeReach({ repo: "o/r", files: ["data/captain.md"], complete: true }).reach, "production", "a captain prompt file in any repo");
});

test("a path pattern with a folder and a file name matches that full path", () => {
  const own = { internalPaths: ["/docs/"], productionPaths: [], repos: { "o/r": { reach: "production" as const, productionPaths: ["/docs/verification/pins.json"] } } };
  assert.equal(changeReach({ repo: "o/r", files: ["docs/verification/pins.json"], complete: true }, own).reach, "production");
  assert.equal(changeReach({ repo: "o/r", files: ["docs/verification/other.json"], complete: true }, own).reach, "internal");
  assert.equal(changeReach({ repo: "o/r", files: ["x/docs/verification/pins.json"], complete: true }, own).reach, "production", "x/ is not docs/ at the root, so nothing marks it internal");
});
