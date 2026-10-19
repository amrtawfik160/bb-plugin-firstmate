import assert from "node:assert/strict";
import test from "node:test";
import { OWNER_APPROVAL_CONTEXT } from "./owner-gate.ts";
import {
  canEnforceRequiredChecks,
  desiredProtection,
  mergeAllowedByRequiredStatus,
  protectionPutFromGet,
} from "./github-protection.ts";

const existingGet = {
  url: "https://api.github.com/repos/cyndra-ai/cyndra-saas/branches/main/protection",
  required_status_checks: {
    url: "https://api.github.com/repos/cyndra-ai/cyndra-saas/branches/main/protection/required_status_checks",
    strict: true,
    contexts: ["build", "lint"],
    checks: [{ context: "build", app_id: 12 }, { context: "lint", app_id: null }],
  },
  enforce_admins: { enabled: false, url: "https://example" },
  required_pull_request_reviews: {
    url: "https://example",
    dismiss_stale_reviews: true,
    require_code_owner_reviews: true,
    required_approving_review_count: 2,
    require_last_push_approval: true,
    dismissal_restrictions: { users: [{ login: "amrtawfik160" }], teams: [{ slug: "leads" }], apps: [] },
  },
  restrictions: { users: [{ login: "amrtawfik160" }], teams: [], apps: [{ slug: "github-actions" }] },
  required_linear_history: { enabled: true },
  allow_force_pushes: { enabled: false },
  allow_deletions: { enabled: false },
  block_creations: { enabled: true },
  required_conversation_resolution: { enabled: true },
  lock_branch: { enabled: false },
  allow_fork_syncing: { enabled: false },
};

test("plain gh pr merge is refused while Owner approval is a required check that is not success", () => {
  assert.equal(mergeAllowedByRequiredStatus({
    requiredContexts: ["build", OWNER_APPROVAL_CONTEXT],
    statuses: { build: "success", [OWNER_APPROVAL_CONTEXT]: "pending" },
  }), false);
  assert.equal(mergeAllowedByRequiredStatus({
    requiredContexts: ["build", OWNER_APPROVAL_CONTEXT],
    statuses: { build: "success", [OWNER_APPROVAL_CONTEXT]: "success" },
  }), true);
  assert.equal(mergeAllowedByRequiredStatus({
    requiredContexts: ["build"],
    statuses: { build: "success" },
  }), true);
});

test("the dry-run protection body keeps every existing rule and adds Owner approval with admins included", () => {
  const plan = desiredProtection(existingGet);
  assert.equal(plan.canEnforce, true);
  const next = plan.put;
  assert.equal(next.enforce_admins, true);
  assert.deepEqual(next.required_status_checks.strict, true);
  assert.ok(next.required_status_checks.contexts.includes("build"));
  assert.ok(next.required_status_checks.contexts.includes("lint"));
  assert.ok(next.required_status_checks.contexts.includes(OWNER_APPROVAL_CONTEXT));
  assert.ok(next.required_status_checks.checks.some((check: { context: string }) => check.context === "build"));
  assert.ok(next.required_status_checks.checks.some((check: { context: string }) => check.context === OWNER_APPROVAL_CONTEXT));
  assert.equal(next.required_pull_request_reviews.dismiss_stale_reviews, true);
  assert.equal(next.required_pull_request_reviews.require_code_owner_reviews, true);
  assert.equal(next.required_pull_request_reviews.required_approving_review_count, 2);
  assert.equal(next.required_pull_request_reviews.require_last_push_approval, true);
  assert.deepEqual(next.required_pull_request_reviews.dismissal_restrictions.users, ["amrtawfik160"]);
  assert.deepEqual(next.required_pull_request_reviews.dismissal_restrictions.teams, ["leads"]);
  assert.deepEqual(next.restrictions.users, ["amrtawfik160"]);
  assert.deepEqual(next.restrictions.apps, ["github-actions"]);
  assert.equal(next.required_linear_history, true);
  assert.equal(next.allow_force_pushes, false);
  assert.equal(next.allow_deletions, false);
  assert.equal(next.block_creations, true);
  assert.equal(next.required_conversation_resolution, true);
  assert.equal(next.lock_branch, false);
  assert.equal(next.allow_fork_syncing, false);

  assert.equal(plan.undo.enforce_admins, false);
  assert.equal(plan.undo.required_status_checks.contexts.includes(OWNER_APPROVAL_CONTEXT), false);
  assert.match(plan.undoCommand, /gh api -X PUT/);
});

test("a repo with no protection yet gets a PUT that only requires Owner approval, with an undo that deletes it", () => {
  const plan = desiredProtection(null);
  assert.equal(plan.put.enforce_admins, true);
  assert.deepEqual(plan.put.required_pull_request_reviews, null);
  assert.deepEqual(plan.put.restrictions, null);
  assert.ok(plan.put.required_status_checks.contexts.includes(OWNER_APPROVAL_CONTEXT));
  assert.match(plan.undoCommand, /gh api -X DELETE/);
});

test("a personal private repo that GitHub refuses cannot be enforced", () => {
  assert.equal(canEnforceRequiredChecks({ status: 403, message: "Upgrade to GitHub Pro or make this repository public to enable this feature." }).ok, false);
  assert.equal(canEnforceRequiredChecks({ status: 404, message: "Branch not protected" }).ok, true);
  assert.equal(canEnforceRequiredChecks(null).ok, true);
});

test("GET-to-PUT conversion does not drop a required reviews block when it is null", () => {
  const put = protectionPutFromGet({
    required_status_checks: null,
    enforce_admins: { enabled: true },
    required_pull_request_reviews: null,
    restrictions: null,
  });
  assert.equal(put.required_pull_request_reviews, null);
  assert.equal(put.restrictions, null);
  assert.equal(put.enforce_admins, true);
});
