import test from "node:test";
import assert from "node:assert/strict";
import { changeReach, REACH } from "./reach.ts";
import { crewExecution, ROLE_DEFAULTS } from "./crew-roles.ts";

const table = { internalPaths: ["docs/", "test/", "*.md", "*.test.*"], repos: { "amrtawfik160/notes": { reach: "internal" as const } } };

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

test("a directory pattern matches at any depth, a file pattern matches the file name only", () => {
  assert.equal(changeReach({ repo: "o/r", files: ["packages/api/test/a.ts"], complete: true }, table).reach, "internal");
  assert.equal(changeReach({ repo: "o/r", files: ["latest/a.ts"], complete: true }, table).reach, "production");
  assert.equal(changeReach({ repo: "o/r", files: ["md/a.ts"], complete: true }, table).reach, "production");
});

test("the shipped table parses and lists no repo as internal without the owner", () => {
  assert.ok(REACH.internalPaths.length > 0);
  for (const [repo, row] of Object.entries(REACH.repos)) assert.ok(row.reach === "internal" || row.reach === "production", repo);
});

test("each role has a real default provider and model", () => {
  assert.deepEqual(ROLE_DEFAULTS, {
    builder: { providerId: "claude-code", model: "claude-opus-5-5" },
    checker: { providerId: "codex", model: "gpt-6-astra" },
    lookup: { providerId: "claude-code", model: "claude-haiku-5-5" },
  });
});

test("a dispatch with no execution choice gets its role's default; a builder is the default role", () => {
  assert.deepEqual(crewExecution({}), { role: "builder", providerId: "claude-code", model: "claude-opus-5-5", reasoningLevel: undefined, named: false });
  assert.deepEqual(crewExecution({ role: "checker" }), { role: "checker", providerId: "codex", model: "gpt-6-astra", reasoningLevel: undefined, named: false });
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
