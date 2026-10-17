import test from "node:test";
import assert from "node:assert/strict";
import { authFailure, signedIn, signInCommand, withoutWakeWarning } from "./action-guards.ts";

test("the queued-wakes warning is dropped, so the line that refused leads (17 Oct, spawn of 042900a1)", () => {
  const native = "WARNING: queued wakes pending - drain them with bin/fm-wake-drain.sh before anything else.\nerror: spawn refused for 042900a1: cannot determine whether /repo shares firstmate's history";
  assert.equal(withoutWakeWarning(native), "error: spawn refused for 042900a1: cannot determine whether /repo shares firstmate's history");
});

test("sign-in reads: Codex prints Logged in, Claude Code prints JSON", () => {
  assert.equal(signInCommand("codex")?.command, "codex login status");
  assert.equal(signInCommand("acp-grok"), null);
  assert.equal(signedIn("codex", 0, "Logged in using ChatGPT"), true);
  assert.equal(signedIn("codex", 1, "Not logged in"), false);
  assert.equal(signedIn("codex", 0, "Not logged in"), false);
  assert.equal(signedIn("claude-code", 0, '{"loggedIn": true, "authMethod": "claude.ai"}'), true);
  assert.equal(signedIn("claude-code", 0, '{"loggedIn": false}'), false);
});

test("a 401 from the provider is a sign-in failure (crew thr_uhwgmvpsds, 12 times)", () => {
  assert.equal(authFailure("unexpected status 401 Unauthorized: Missing bearer or basic authentication in header"), true);
  assert.equal(authFailure("Claude Code process exited with code 0"), false);
});
