import test from "node:test";
import assert from "node:assert/strict";
import { acceptedCatalogModels, cliAcceptsModel, parseCliModels, providerModelsCommand } from "./provider-cli-models.ts";

// `agy models` on host_m4jkvpkw67, 20 Oct 11:20 UTC. BB's catalog listed gemini-4-argon; agy did not.
const AGY = [
  "Fetching available models...",
  "gemini-3.8-flash-high\tGemini 3.8 Flash (High)",
  "gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)",
  "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
  "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
  "claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)",
  "gpt-oss-120b-medium\tGPT-OSS 120B (Medium)",
].join("\n");
const CATALOG = ["gemini-4-argon", "gemini-3.8-flash", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"];

test("the Antigravity CLI lists its own models; other providers have no list to read", () => {
  assert.equal(providerModelsCommand("acp-antigravity")?.command, "agy models");
  assert.equal(providerModelsCommand("claude-code"), null);
  assert.equal(providerModelsCommand(undefined), null);
});

test("model ids are read from tab or dash lines; the progress line is not a model", () => {
  assert.deepEqual(parseCliModels(AGY), ["gemini-3.8-flash-high", "gemini-3.8-flash-medium", "gemini-3.8-flash-low", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]);
  assert.deepEqual(parseCliModels("gemini-4-argon - Gemini 4 Argon\n"), ["gemini-4-argon"]);
  assert.deepEqual(parseCliModels(""), []);
});

test("a catalog model is accepted as listed or with an effort suffix, never as a longer model name", () => {
  const ids = parseCliModels(AGY);
  assert.equal(cliAcceptsModel("gemini-3.8-flash", ids), true);
  assert.equal(cliAcceptsModel("claude-opus-4-6-thinking", ids), true);
  assert.equal(cliAcceptsModel("gemini-4-argon", ids), false, "agy refused gemini-4-argon-high (crews 9ade6f3a, 43864fce)");
  assert.equal(cliAcceptsModel("claude-sonnet-4", ids), false, "claude-sonnet-4-6 is another model, not an effort of claude-sonnet-4");
  assert.deepEqual(acceptedCatalogModels(CATALOG, ids), ["gemini-3.8-flash", "claude-sonnet-4-6", "claude-opus-4-6-thinking", "gpt-oss-120b-medium"]);
});
