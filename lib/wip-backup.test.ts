// Real git fixtures: a bare repository on local disk is the crew's remote. No network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseWipBackup, wipBackupScript, wipBranchFor } from "./wip-backup.ts";

const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t", GIT_CONFIG_NOSYSTEM: "1", HOME: tmpdir() };

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", env: GIT_ENV });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function commit(cwd: string, file: string, text: string): string {
  writeFileSync(join(cwd, file), text);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", `edit ${file}`);
  return git(cwd, "rev-parse", "HEAD");
}

/** A bare remote, a main checkout with main pushed, and a crew worktree on its own branch. */
function fixture(branch = "fm/c1-task") {
  const root = mkdtempSync(join(tmpdir(), "fm-wip-"));
  const remote = join(root, "remote.git");
  const main = join(root, "main");
  const wt = join(root, "wt");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", main);
  commit(main, "README", "base\n");
  git(main, "remote", "add", "origin", remote);
  git(main, "push", "-q", "origin", "main");
  git(main, "worktree", "add", "-q", "-b", branch, wt, "main");
  return { root, remote, main, wt, done: () => rmSync(root, { recursive: true, force: true }) };
}

function backup(path: string, crewId: string, base = "main") {
  const r = spawnSync("bash", ["-c", wipBackupScript(path, crewId, base)], { encoding: "utf8", env: GIT_ENV });
  return parseWipBackup(`${r.stdout}${r.stderr}`);
}

function remoteRef(remote: string, ref: string): string | null {
  const r = spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", "--quiet", ref], { encoding: "utf8", env: GIT_ENV });
  return r.status === 0 ? r.stdout.trim() : null;
}

test("wip branch names stay under wip/ and carry the crew id and its branch", () => {
  assert.equal(wipBranchFor("c1", "fm/c1-task"), "wip/c1-fm/c1-task");
  assert.equal(wipBranchFor("c1", ""), "wip/c1-detached");
  assert.throws(() => wipBranchFor("../main", "x"), /crew id/);
});

test("unpushed crew commits are pushed to wip/<crew>-<branch> on the crew's remote, never to main or the crew branch", () => {
  const f = fixture();
  try {
    const mainBefore = remoteRef(f.remote, "refs/heads/main");
    commit(f.wt, "a.txt", "1\n");
    const head = commit(f.wt, "b.txt", "2\n");
    const r = backup(f.wt, "c1");
    assert.equal(r.push, "pushed", r.detail);
    assert.equal(r.unpushed, 2);
    assert.equal(r.target, "wip/c1-fm/c1-task");
    assert.equal(r.remote, "origin");
    assert.equal(remoteRef(f.remote, "refs/heads/wip/c1-fm/c1-task"), head);
    assert.equal(remoteRef(f.remote, "refs/heads/main"), mainBefore, "main untouched");
    assert.equal(remoteRef(f.remote, "refs/heads/fm/c1-task"), null, "the crew's own branch is not pushed");
    // The push updated the local remote-tracking ref, so the work now counts as pushed.
    assert.equal(git(f.wt, "rev-list", "--count", "HEAD", "--not", "--remotes"), "0");
    // Nothing new: the next hour pushes nothing.
    assert.equal(backup(f.wt, "c1").push, "none");
  } finally { f.done(); }
});

test("a later commit moves the wip branch forward with a lease; a wip branch changed by someone else is not overwritten", () => {
  const f = fixture();
  try {
    commit(f.wt, "a.txt", "1\n");
    assert.equal(backup(f.wt, "c1").push, "pushed");
    const second = commit(f.wt, "a.txt", "2\n");
    // Amend history (rebase-like): force-with-lease replaces our own earlier backup.
    git(f.wt, "reset", "-q", "--hard", "HEAD~2");
    const rewritten = commit(f.wt, "c.txt", "3\n");
    assert.notEqual(rewritten, second);
    const r = backup(f.wt, "c1");
    assert.equal(r.push, "pushed", r.detail);
    assert.equal(remoteRef(f.remote, "refs/heads/wip/c1-fm/c1-task"), rewritten);
    // Someone else moves the remote wip branch; our tracking ref does not know that commit.
    const other = join(f.root, "other");
    git(f.root, "clone", "-q", f.remote, other);
    git(other, "checkout", "-q", "wip/c1-fm/c1-task");
    const foreign = commit(other, "x.txt", "foreign\n");
    git(other, "push", "-q", "origin", "HEAD:refs/heads/wip/c1-fm/c1-task");
    commit(f.wt, "d.txt", "4\n");
    const refused = backup(f.wt, "c1");
    assert.equal(refused.push, "failed");
    assert.equal(remoteRef(f.remote, "refs/heads/wip/c1-fm/c1-task"), foreign, "the lease kept the foreign commit");
  } finally { f.done(); }
});

test("uncommitted files are counted and listed, never committed", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.wt, "README"), "changed\n");
    writeFileSync(join(f.wt, "new.txt"), "new\n");
    const r = backup(f.wt, "c1");
    assert.equal(r.push, "none");
    assert.deepEqual([...r.dirty].sort(), ["README", "new.txt"]);
    assert.equal(git(f.wt, "rev-list", "--count", "main..HEAD"), "0", "no auto-commit");
    assert.equal(git(f.wt, "status", "--porcelain").split("\n").length, 2, "files left as they were");
  } finally { f.done(); }
});

test("the crew branch's own upstream remote is used; no remote is reported, not guessed", () => {
  const f = fixture();
  try {
    const fork = join(f.root, "fork.git");
    git(f.root, "init", "-q", "--bare", "-b", "main", fork);
    git(f.wt, "remote", "add", "fork", fork);
    git(f.wt, "push", "-q", "fork", "HEAD:refs/heads/fm/c1-task");
    git(f.wt, "branch", "-q", "--set-upstream-to=fork/fm/c1-task");
    const head = commit(f.wt, "a.txt", "1\n");
    const r = backup(f.wt, "c1");
    assert.equal(r.remote, "fork", r.detail);
    assert.equal(remoteRef(fork, "refs/heads/wip/c1-fm/c1-task"), head);
    assert.equal(remoteRef(fork, "refs/heads/fm/c1-task"), git(f.main, "rev-parse", "main"), "the crew's PR branch is not moved");
    assert.equal(remoteRef(f.remote, "refs/heads/wip/c1-fm/c1-task"), null);
  } finally { f.done(); }
  const lonely = mkdtempSync(join(tmpdir(), "fm-wip-"));
  try {
    git(lonely, "init", "-q", "-b", "main");
    commit(lonely, "a.txt", "1\n");
    const r = backup(lonely, "c2", "develop");
    assert.equal(r.push, "no-remote");
    assert.equal(r.unpushed, 1);
  } finally { rmSync(lonely, { recursive: true, force: true }); }
});

test("a missing worktree path is reported as missing", () => {
  const r = backup(join(tmpdir(), "fm-wip-does-not-exist"), "c1");
  assert.equal(r.push, "missing");
});

test("a single-branch checkout keeps backing up: the pushed value is kept for the next lease", () => {
  const f = fixture();
  try {
    git(f.wt, "config", "remote.origin.fetch", "+refs/heads/main:refs/remotes/origin/main");
    commit(f.wt, "one.txt", "1\n");
    assert.equal(backup(f.wt, "c1").push, "pushed");
    const head = commit(f.wt, "two.txt", "2\n");
    const r = backup(f.wt, "c1");
    assert.equal(r.push, "pushed", r.detail);
    assert.equal(remoteRef(f.remote, "refs/heads/wip/c1-fm/c1-task"), head);
    assert.equal(git(f.wt, "rev-list", "--count", "HEAD", "--not", "--remotes"), "0", "the retire check sees the commits as pushed");
  } finally { f.done(); }
});

test("a git command that fails is a failed backup, never nothing to push or no files", () => {
  for (const broken of ["rev-list", "status"]) {
    const f = fixture();
    try {
      commit(f.wt, "one.txt", "1\n");
      const wrapper = join(f.root, "git");
      writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = ${broken} ]; then exit 128; fi\nexec ${spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim()} "$@"\n`);
      chmodSync(wrapper, 0o755);
      const r = spawnSync("bash", ["-c", wipBackupScript(f.wt, "c1", "main")], { encoding: "utf8", env: { ...GIT_ENV, PATH: `${f.root}:${GIT_ENV.PATH}` } });
      const parsed = parseWipBackup(r.stdout);
      assert.equal(parsed.push, "failed", `${broken}: ${r.stdout}`);
      assert.match(parsed.detail, /cannot read/);
      assert.equal(remoteRef(f.remote, "refs/heads/wip/c1-fm/c1-task"), null);
    } finally { f.done(); }
  }
});
