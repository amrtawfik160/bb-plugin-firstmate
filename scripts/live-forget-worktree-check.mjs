#!/usr/bin/env node
// LIVE proof for forget's unlanded-work safety (F1 + D2), CONTRIBUTING rules 1 + 4.
//
// The plugin's `forget --stop` teardown deletes the crew's managed worktree via BB's
// `environments.delete`, whose underlying primitive is `git worktree remove` on the
// shared parent repo. The unit tests (server.test.ts) prove the GUARD wiring and DIE
// when reverted (F1 committed-unpushed refusal, D2 dirty refusal), but they are
// mock-only — the exact false-pass shape CONTRIBUTING §5 names. This script defends
// the guarantee with the REAL git primitive on a THROWAWAY repo, proving the two
// facts the guard's safety contract rests on:
//
//   1. `git worktree remove` removes the WORKING TREE ONLY — it never deletes the
//      crew branch and never drops git stash entries; both live in the shared parent
//      repo and survive removal. (So even the undetectable case cannot lose commits.)
//   2. `git worktree remove` (no --force) REFUSES a dirty tree — matching the guard's
//      own dirty refusal, and proving --force is the only way to discard.
//
// Everything runs in an isolated temp repo and is torn down. No bb, no host, no
// network; safe to run anywhere git is present:
//
//   node scripts/live-forget-worktree-check.mjs
//
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
function git(cwd, ...args) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 1 << 26 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}

const root = mkdtempSync(join(tmpdir(), "fm-forget-live-"));
const repo = join(root, "parent");
try {
  // ── throwaway parent repo ──────────────────────────────────────────────────
  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "live@firstmate.test");
  git(repo, "config", "user.name", "fm-live");
  writeFileSync(join(repo, "README.md"), "seed\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "seed");

  // ── (1) committed-but-unpushed work survives worktree removal ──────────────
  const wtA = join(root, "wtA");
  git(repo, "worktree", "add", "-q", "-b", "crew/clean", wtA);
  writeFileSync(join(wtA, "feature.ts"), "export const x = 1;\n");
  git(wtA, "add", "-A");
  git(wtA, "commit", "-q", "-m", "crew work (committed, never pushed)");
  const sha = git(wtA, "rev-parse", "HEAD").out;

  const removeClean = git(repo, "worktree", "remove", wtA); // the real primitive
  record("git worktree remove succeeds on a CLEAN worktree", removeClean.code === 0, removeClean.out || "removed");
  record("the worktree directory is gone from disk", !existsSync(join(wtA, "feature.ts")), wtA);

  const branchStillThere = git(repo, "rev-parse", "--verify", "crew/clean");
  record("the crew branch SURVIVES in the parent repo", branchStillThere.code === 0 && branchStillThere.out === sha,
    `crew/clean → ${branchStillThere.out.slice(0, 12)}`);
  const commitBody = git(repo, "log", "-1", "--format=%s", "crew/clean");
  record("the committed-but-unpushed commit SURVIVES", commitBody.out === "crew work (committed, never pushed)", commitBody.out);
  const wtList = git(repo, "worktree", "list");
  record("git worktree list no longer references the removed worktree", !wtList.out.includes(wtA), wtList.out.replace(/\n/g, " | "));

  // ── (2) dirty tree: the primitive REFUSES (matches the guard) ──────────────
  const wtB = join(root, "wtB");
  git(repo, "worktree", "add", "-q", "-b", "crew/dirty", wtB);
  writeFileSync(join(wtB, "wip.ts"), "uncommitted work in progress\n"); // untracked
  const removeDirty = git(repo, "worktree", "remove", wtB); // no --force
  record("git worktree remove REFUSES a dirty worktree (no --force)", removeDirty.code !== 0, removeDirty.out.split("\n")[0]);
  record("the dirty worktree is left intact on disk", existsSync(join(wtB, "wip.ts")), wtB);
  const removeForce = git(repo, "worktree", "remove", "--force", wtB);
  record("--force is required to discard a dirty worktree", removeForce.code === 0, removeForce.out || "removed with --force");

  // ── (3) git stash entries survive worktree removal ─────────────────────────
  const wtC = join(root, "wtC");
  git(repo, "worktree", "add", "-q", "-b", "crew/stash", wtC);
  writeFileSync(join(wtC, "README.md"), "seed\nstashed change\n");
  git(wtC, "stash", "push", "-u", "-m", "fm-live-stash");
  const cleanForRemove = git(wtC, "status", "--porcelain");
  const removeStashWt = git(repo, "worktree", "remove", cleanForRemove.out === "" ? wtC : "--force", cleanForRemove.out === "" ? "" : wtC).code;
  const stashList = git(repo, "stash", "list");
  record("git stash entries SURVIVE worktree removal (shared parent ref)", stashList.out.includes("fm-live-stash"), stashList.out.replace(/\n/g, " | ") || "(empty)");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${failed.length === 0 ? "ALL PASS" : `${failed.length} FAILED`}  (${results.length} checks)`);
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  // full teardown: prune worktree registrations, remove the temp tree
  git(repo, "worktree", "prune");
  rmSync(root, { recursive: true, force: true });
  console.log(`teardown: removed ${root}`);
}
