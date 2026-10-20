import assert from "node:assert/strict";
import test from "node:test";
import { OWNER_APPROVAL_CONTEXT } from "./owner-gate.ts";
import { postStatusArgs, postStatusCommand } from "./github-status.ts";

const SHA = "a".repeat(40);

test("the posted commit status uses context Owner approval and clips the description to 140 characters", () => {
  const posted = postStatusArgs("cyndra-ai/cyndra-saas", SHA, {
    state: "pending",
    description: `${"x".repeat(200)} extra`,
  });
  assert.equal(posted.path, `repos/cyndra-ai/cyndra-saas/statuses/${SHA}`);
  assert.equal(posted.body.context, OWNER_APPROVAL_CONTEXT);
  assert.equal(posted.body.state, "pending");
  assert.equal(posted.body.description.length, 140);

  const ok = postStatusArgs("cyndra-ai/cyndra-saas", SHA, { state: "success", description: "Owner Approve at this head" });
  assert.equal(ok.body.state, "success");
  assert.equal(ok.body.description, "Owner Approve at this head");
});

test("the gh command posts the status and never talks to a live remote from the helper itself", () => {
  const command = postStatusCommand("cyndra-ai/cyndra-saas", SHA, { state: "pending", description: "Needs owner Approve" });
  assert.match(command, /gh api -X POST/);
  assert.match(command, /Owner approval/);
  assert.match(command, /Needs owner Approve/);
  assert.doesNotMatch(command, /https:\/\/api\.github\.com/);
});
