import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { OWNER_APPROVAL_CONTEXT } from "../lib/owner-gate.ts";
import { desiredProtection } from "../lib/github-protection.ts";

const SCRIPT = new URL("./install-owner-approval.ts", import.meta.url).pathname;

const existingGet = {
  required_status_checks: {
    strict: false,
    contexts: ["ci"],
    checks: [{ context: "ci", app_id: null }],
  },
  enforce_admins: { enabled: true },
  required_pull_request_reviews: {
    dismiss_stale_reviews: false,
    require_code_owner_reviews: false,
    required_approving_review_count: 1,
    require_last_push_approval: false,
  },
  restrictions: null,
  required_linear_history: { enabled: false },
  allow_force_pushes: { enabled: true },
  allow_deletions: { enabled: false },
};

function fakeGh(dir: string, protection: unknown, mode: "ok" | "forbidden" = "ok") {
  const bin = join(dir, "gh");
  const forbidden = mode === "forbidden";
  writeFileSync(bin, `#!/bin/sh
args="$*"
log="${dir}/calls"
if echo "$args" | grep -q -- '-X PUT'; then
  printf '%s\\n' "PUT $args" >> "$log"
  cat > "${dir}/put.json"
  printf '%s\\n' '{}'
  exit 0
fi
if echo "$args" | grep -q 'repo view'; then
  printf '%s\\n' '{"defaultBranchRef":{"name":"main"},"isPrivate":true,"owner":{"__typename":"Organization"}}'
  exit 0
fi
if echo "$args" | grep -q 'branches/.*/protection'; then
  ${forbidden ? `echo 'gh: Upgrade to GitHub Pro or make this repository public to enable this feature. (HTTP 403)' >&2
  exit 1` : `cat <<'JSON'
${JSON.stringify(protection)}
JSON
  exit 0`}
fi
if echo "$args" | grep -q 'rulesets'; then
  printf '%s\\n' '[]'
  exit 0
fi
echo "unexpected gh $args" >&2
exit 2
`);
  chmodSync(bin, 0o755);
}

test("the install script dry-run for a fake repo with existing protection keeps every existing rule", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-approval-gh-"));
  fakeGh(dir, existingGet);
  const run = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, "--dry-run", "--repo", "cyndra-ai/cyndra-saas"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    timeout: 15_000,
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /cyndra-ai\/cyndra-saas/);
  assert.match(run.stdout, /Owner approval/);
  assert.match(run.stdout, /"strict": false/);
  assert.match(run.stdout, /"ci"/);
  assert.match(run.stdout, /allow_force_pushes": true/);
  assert.match(run.stdout, /required_approving_review_count": 1/);
  assert.match(run.stdout, /undo/i);
  assert.doesNotMatch(run.stdout + run.stderr, /live GitHub call blocked/);
  const plan = desiredProtection(existingGet);
  assert.ok(plan.put.required_status_checks.contexts.includes("ci"));
  assert.ok(plan.put.required_status_checks.contexts.includes(OWNER_APPROVAL_CONTEXT));
  assert.equal(plan.put.allow_force_pushes, true);
  assert.equal(plan.put.required_status_checks.strict, false);
});

test("the install script defaults to dry-run and never applies without --apply", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-approval-gh-"));
  fakeGh(dir, existingGet);
  const run = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, "--repo", "o/r"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    timeout: 15_000,
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.match(run.stdout, /dry-run/i);
  assert.doesNotMatch(run.stdout, /^apply /m);
  assert.equal(existsSync(join(dir, "put.json")), false);
  assert.equal(existsSync(join(dir, "calls")), false);
});

test("the install script --apply PUTs Owner approval and keeps every existing rule", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-approval-gh-"));
  fakeGh(dir, existingGet);
  const run = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, "--apply", "--json", "--repo", "cyndra-ai/cyndra-saas"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    timeout: 15_000,
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const rows = JSON.parse(run.stdout) as Array<{ repo: string; applied: boolean; put: { required_status_checks: { contexts: string[] } } }>;
  assert.equal(rows[0]?.repo, "cyndra-ai/cyndra-saas");
  assert.equal(rows[0]?.applied, true);
  assert.ok(rows[0]?.put.required_status_checks.contexts.includes("ci"));
  assert.ok(rows[0]?.put.required_status_checks.contexts.includes(OWNER_APPROVAL_CONTEXT));
  const put = JSON.parse(readFileSync(join(dir, "put.json"), "utf8")) as { required_status_checks: { contexts: string[] }; enforce_admins: boolean };
  assert.ok(put.required_status_checks.contexts.includes("ci"));
  assert.ok(put.required_status_checks.contexts.includes(OWNER_APPROVAL_CONTEXT));
  assert.equal(put.enforce_admins, true);
  assert.match(readFileSync(join(dir, "calls"), "utf8"), /-X PUT/);
});

test("the install script --apply does not PUT when required checks cannot be enforced", () => {
  const dir = mkdtempSync(join(tmpdir(), "owner-approval-gh-"));
  fakeGh(dir, existingGet, "forbidden");
  const run = spawnSync(process.execPath, ["--experimental-strip-types", SCRIPT, "--apply", "--json", "--repo", "amrtawfik160/safi"], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH}` },
    timeout: 15_000,
  });
  assert.equal(run.status, 0, run.stderr + run.stdout);
  const rows = JSON.parse(run.stdout) as Array<{ canEnforce: boolean; applied: boolean }>;
  assert.equal(rows[0]?.canEnforce, false);
  assert.equal(rows[0]?.applied, false);
  assert.equal(existsSync(join(dir, "put.json")), false);
});
