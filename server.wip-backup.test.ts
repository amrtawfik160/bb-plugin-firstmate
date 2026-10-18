// Owner decision Q6: the hourly wip backup and the retire/forget refusal, end to end through the
// plugin, with real git. The crew's remote is a bare repository on local disk; no network.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { stubProviderCatalog } from "./test/provider-catalog.mjs";
import plugin from "./server.ts";

type Host = ReturnType<typeof createFakePluginHost>;
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

function remoteRef(remote: string, ref: string): string | null {
  const r = spawnSync("git", ["--git-dir", remote, "rev-parse", "--verify", "--quiet", ref], { encoding: "utf8", env: GIT_ENV });
  return r.status === 0 ? r.stdout.trim() : null;
}

// Recover the inner command from wrapHostCommand's `__fm_cmd='<escaped>'; set +e; "…` envelope.
function unwrap(wrapped: string): string {
  const m = /^__fm_cmd='([\s\S]*?)'; set \+e; "/.exec(wrapped);
  return m ? m[1]!.replace(/'\\''/g, "'") : wrapped;
}

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fm-wip-srv-"));
  const remote = join(root, "remote.git");
  const main = join(root, "main");
  const wt = join(root, "wt");
  git(root, "init", "-q", "--bare", "-b", "main", remote);
  git(root, "init", "-q", "-b", "main", main);
  commit(main, "README", "base\n");
  git(main, "remote", "add", "origin", remote);
  git(main, "push", "-q", "origin", "main");
  git(main, "worktree", "add", "-q", "-b", "fm/c1-task", wt, "main");

  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["captain", "firstmate"] });
  await plugin(host.bb);
  stubProviderCatalog(host);
  await host.bb.storage.kv.set("crews", [{
    id: "c1", task: "fix login", projectId: "proj_1", threadId: "thr_crew", parentThreadId: "thr_cap",
    providerId: null, model: null, reasoningLevel: null, worktree: true, shape: "ship", posture: "local-only",
    createdAt: "2026-09-18T00:00:00.000Z",
  }]);
  const commands: string[] = [];
  const terminals = new Map<string, string>();
  let n = 0;
  // Git commands run for real in the fixture; any other host command answers empty.
  host.harness.sdk.stub("terminals.create", async (args: { start?: { command?: string } }) => {
    const id = `t_${++n}`;
    terminals.set(id, unwrap(args.start?.command ?? ""));
    return { id };
  });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async (args: { terminalId: string }) => {
    const cmd = terminals.get(args.terminalId) ?? "";
    commands.push(cmd);
    const real = cmd.includes("FM_WIP") || cmd.includes("rev-list");
    const r = real ? spawnSync("bash", ["-c", cmd], { encoding: "utf8", env: GIT_ENV }) : { stdout: "", stderr: "", status: 0 };
    const payload = `${r.stdout}${r.stderr}\n__FM_HOST_RC:${r.status ?? 1}\n`;
    return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(payload).toString("base64") }] };
  });
  host.harness.sdk.stub("threads.get", async (args: { threadId: string }) =>
    makeThreadResponse({ id: args.threadId, status: "idle", environmentId: args.threadId === "thr_crew" ? "env_wt" : "env_cap" }));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.getPluginMetadata", async () => ({}));
  host.harness.sdk.stub("threads.updatePluginMetadata", async () => ({}));
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threads.stop", async () => ({}));
  host.harness.sdk.stub("threads.archive", async () => ({}));
  host.harness.sdk.stub("threads.output", async () => ({ output: "DONE: shipped" }));
  host.harness.sdk.stub("environments.list", async () => [{ hostId: "host_1", status: "ready", isWorktree: false, path: main }]);
  host.harness.sdk.stub("environments.get", async () => ({ id: "env_wt", hostId: "host_1", path: wt, isWorktree: true, status: "ready", mergeBaseBranch: "main" }));
  // BB's own uncommitted-file read, answered from the real worktree.
  host.harness.sdk.stub("environments.diffFiles", async () => ({
    files: git(wt, "status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean).map((line) => ({ path: line.slice(3) })),
  }));
  host.harness.sdk.stub("environments.pullRequest", async () => ({ pullRequest: null }));
  host.harness.sdk.stub("environments.delete", async () => ({ ok: true as const }));
  const sent = () => host.harness.sdk.callsTo("threads.send")
    .map((c) => c[0] as { threadId: string; input: Array<{ text: string }> })
    .filter((a) => a.threadId === "thr_cap")
    .map((a) => a.input.map((b) => b.text).join("\n"));
  const crews = async () => ((await host.bb.storage.kv.get("crews")) as Array<{ id: string }> | undefined ?? []).map((c) => c.id);
  return { host, root, remote, main, wt, commands, sent, crews, done: async () => { await host.harness.lifecycle.dispose(); rmSync(root, { recursive: true, force: true }); } };
}

const cli = (h: Host, ...args: string[]) => h.harness.behavior.runCli(args, { projectId: "proj_1", threadId: "thr_cap" });

test("the hourly wip backup pushes unpushed crew commits to wip/<crew>-<branch> and reports uncommitted files once a day", async () => {
  const f = await fixture();
  try {
    const mainBefore = remoteRef(f.remote, "refs/heads/main");
    const head = commit(f.wt, "a.txt", "1\n");
    writeFileSync(join(f.wt, "draft.txt"), "not committed\n");
    await f.host.harness.behavior.runSchedule("wip-backup");
    assert.equal(remoteRef(f.remote, "refs/heads/wip/c1-fm/c1-task"), head, "the crew commit is on the remote");
    assert.equal(remoteRef(f.remote, "refs/heads/main"), mainBefore, "main is untouched");
    assert.equal(remoteRef(f.remote, "refs/heads/fm/c1-task"), null, "the crew branch is not pushed");
    assert.ok(f.commands.every((cmd) => !/gh pr create/.test(cmd)), "no PR is opened");
    assert.equal(git(f.wt, "status", "--porcelain"), "?? draft.txt", "nothing was committed for the crew");
    const reports = f.sent();
    assert.equal(reports.length, 1, reports.join("\n---\n"));
    assert.match(reports[0]!, /crew c1: 1 uncommitted file\(s\), not backed up/);
    // The next hour, the same day: nothing new to push and no second report.
    await f.host.harness.behavior.runSchedule("wip-backup");
    assert.equal(f.sent().length, 1);
  } finally { await f.done(); }
});

test("retire refuses unpushed commits until the wip backup pushed them; a bare --force is refused", async () => {
  const f = await fixture();
  try {
    commit(f.wt, "a.txt", "1\n");
    const before = await cli(f.host, "forget", "c1", "--stop");
    assert.notEqual(before.exitCode, 0);
    assert.match(before.stderr, /committed but UNPUSHED/);
    // Forget without --stop drops the record, so it refuses too.
    const noStop = await cli(f.host, "forget", "c1");
    assert.notEqual(noStop.exitCode, 0);
    assert.match(noStop.stderr, /committed but UNPUSHED/);
    const bare = await cli(f.host, "forget", "c1", "--stop", "--force");
    assert.notEqual(bare.exitCode, 0);
    assert.match(bare.stderr, /Quote the owner's words/);
    assert.deepEqual(await f.crews(), ["c1"]);
    assert.equal(f.host.harness.sdk.callsTo("threads.archive").length, 0);
    const backup = await cli(f.host, "wip-backup");
    assert.equal(backup.exitCode, 0, backup.stderr);
    assert.match(backup.stdout, /pushed +c1: 1 unpushed commit\(s\) -> origin\/wip\/c1-fm\/c1-task/);
    const after = await cli(f.host, "forget", "c1", "--stop");
    assert.equal(after.exitCode, 0, after.stderr);
    assert.deepEqual(await f.crews(), []);
  } finally { await f.done(); }
});

test("forget refuses uncommitted files; --force with the owner's words discards and records them", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.wt, "draft.txt"), "not committed\n");
    const refused = await cli(f.host, "forget", "c1");
    assert.notEqual(refused.exitCode, 0);
    assert.match(refused.stderr, /1 uncommitted file\(s\) \(draft\.txt\)/);
    assert.deepEqual(await f.crews(), ["c1"]);
    const forced = await cli(f.host, "forget", "c1", "--stop", "--force", "drop the c1 draft, I don't need it");
    assert.equal(forced.exitCode, 0, forced.stderr);
    assert.match(forced.stdout, /forced on the owner's words: "drop the c1 draft, I don't need it"/);
    assert.ok(f.host.harness.logEntries.some((e) => e.level === "warn" && /forget c1 --force on the owner's words: drop the c1 draft/.test(e.message)));
    assert.deepEqual(await f.crews(), []);
    unlinkSync(join(f.wt, "draft.txt"));
  } finally { await f.done(); }
});

test("firstmate_forget refuses force without ownerWords", async () => {
  const f = await fixture();
  try {
    const tool = f.host.harness.inspection.registrations.agentTools.find((t) => t.name === "firstmate_forget")!;
    const result = await tool.execute({ crewId: "c1", stop: true, force: true }, { threadId: "thr_cap" } as never);
    assert.match(JSON.stringify(result), /Quote the owner's words/);
    assert.deepEqual(await f.crews(), ["c1"]);
  } finally { await f.done(); }
});

// The native BB backend's worktree release, sourced on its own with BB calls stubbed.
const ADAPTER = join(dirname(fileURLToPath(import.meta.url)), "overlay/bin/backends/bb.sh");
function nativeRelease(wt: string, vars: string, extra = "") {
  return spawnSync("bash", ["-c", `
    source ${JSON.stringify(ADAPTER)}
    fm_backend_bb_thread_id() { echo thr_crew; }
    fm_backend_bb_show() { echo '{"path":"${wt}"}'; }
    fm_backend_bb_kill() { echo KILLED; }
    fm_backend_bb_tool_check() { return 0; }
    fm_backend_bb_run_json() { echo "{}"; }
    fm_backend_bb_mark_env_deleted() { :; }
    bb() { echo CALLED_BB "$@"; }
    ${extra}
    ${vars}
    fm_backend_bb_remove_worktree thr_crew
  `], { encoding: "utf8", env: GIT_ENV });
}

test("native release refuses a ship with unpushed commits, a dirty scout, and a bare force", async () => {
  const f = await fixture();
  try {
    commit(f.wt, "only-local.txt", "work\n");
    const ship = nativeRelease(f.wt, "KIND=ship");
    assert.notEqual(ship.status, 0, ship.stdout);
    assert.match(ship.stderr, /commits on no remote and not landed/);
    assert.doesNotMatch(ship.stdout, /KILLED|CALLED_BB/, "nothing stopped or archived");
    // fm-teardown.sh's own landed check (a merged PR) still lets landed work go.
    const landed = nativeRelease(f.wt, `KIND=ship WT=${JSON.stringify(f.wt)}`, "work_is_landed() { return 0; }");
    assert.equal(landed.status, 0, landed.stderr);
    assert.match(landed.stdout, /CALLED_BB thread archive thr_crew/);
    git(f.wt, "reset", "-q", "--hard", "main");
    writeFileSync(join(f.wt, "draft.txt"), "work\n");
    const scout = nativeRelease(f.wt, "KIND=scout");
    assert.notEqual(scout.status, 0, scout.stdout);
    assert.match(scout.stderr, /uncommitted changes/);
    assert.doesNotMatch(scout.stdout, /KILLED|CALLED_BB/);
    const bare = nativeRelease(f.wt, "KIND=ship FORCE=--force");
    assert.notEqual(bare.status, 0, bare.stdout);
    assert.match(bare.stderr, /quote the owner's words/);
    const owned = nativeRelease(f.wt, `KIND=ship FORCE=--force FM_FORCE_OWNER_WORDS="drop it"`);
    assert.equal(owned.status, 0, owned.stderr);
    assert.match(owned.stderr, /on the owner's words: drop it/);
    // Lavish review pages are scratch, as the plugin counts them.
    rmSync(join(f.wt, "draft.txt"));
    writeFileSync(join(f.wt, ".tmp-notes.md"), "scratch\n");
    assert.equal(nativeRelease(f.wt, "KIND=scout").status, 0);
  } finally { await f.done(); }
});

test("a forced native scout teardown carries the owner's words to the native script", async () => {
  const f = await fixture();
  try {
    await f.host.bb.storage.kv.set("crews", [{
      id: "c1", task: "look", projectId: "proj_1", threadId: "thr_crew", parentThreadId: "thr_cap", nativeHome: "/pinned-home",
      providerId: null, model: null, reasoningLevel: null, worktree: true, shape: "scout", posture: "scout", createdAt: "2026-09-18T00:00:00.000Z",
    }]);
    await cli(f.host, "forget", "c1", "--stop", "--force", "owner: drop the scout");
    const teardown = f.commands.find((cmd) => cmd.includes("fm-teardown.sh"));
    assert.ok(teardown, f.commands.join("\n---\n"));
    assert.match(teardown!, /export FM_FORCE_OWNER_WORDS='owner: drop the scout'/);
  } finally { await f.done(); }
});

test("forget without --stop fails closed when the crew's environment cannot be read", async () => {
  const f = await fixture();
  try {
    commit(f.wt, "only-local.txt", "work\n");
    f.host.harness.sdk.stub("threads.get", async (args: { threadId: string }) => makeThreadResponse({ id: args.threadId, status: "idle", environmentId: null }));
    const r = await cli(f.host, "forget", "c1");
    assert.notEqual(r.exitCode, 0, r.stdout);
    assert.match(r.stderr, /environment unavailable/);
    assert.deepEqual(await f.crews(), ["c1"]);
  } finally { await f.done(); }
});

test("a PR merged outside the captain does not retire a crew with uncommitted files", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.wt, "draft.txt"), "work\n");
    f.host.harness.sdk.stub("environments.pullRequest", async () => ({ outcome: "available", pullRequest: { url: "https://github.com/o/r/pull/1", number: 1, title: "t", state: "merged", checks: { state: "no_checks", failedCount: 0, pendingCount: 0, passedCount: 0 } } }));
    const r = await cli(f.host, "bearings");
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(f.host.harness.sdk.callsTo("threads.archive").length, 0);
    assert.equal(f.host.harness.sdk.callsTo("threads.stop").length, 0);
    assert.deepEqual(await f.crews(), ["c1"]);
  } finally { await f.done(); }
});

test("the CLI backup joins a scheduled backup that is still running", async () => {
  const f = await fixture();
  let release: () => void = () => {};
  let entered: () => void = () => {};
  const gate = new Promise<void>((r) => { release = r; });
  const started = new Promise<void>((r) => { entered = r; });
  let active = 0, max = 0, calls = 0;
  try {
    f.host.harness.sdk.stub("terminals.output", async () => {
      active++; calls++; max = Math.max(max, active); entered(); await gate; active--;
      return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from("FM_WIP push=none\n__FM_HOST_RC:0\n").toString("base64") }] };
    });
    const scheduled = f.host.harness.behavior.runSchedule("wip-backup");
    await started;
    const manual = cli(f.host, "wip-backup");
    await new Promise((r) => setTimeout(r, 100));
    release();
    const [, out] = await Promise.all([scheduled, manual]);
    assert.equal(max, 1, "two passes inspected the worktree at once");
    assert.equal(calls, 1);
    assert.equal(out.exitCode, 0, out.stderr);
  } finally { release(); await f.done(); }
});

test("native release refuses when HEAD cannot be read, and allows an unborn branch", async () => {
  const f = await fixture();
  try {
    commit(f.wt, "one.txt", "work\n");
    const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    writeFileSync(join(f.root, "git"), `#!/bin/sh\ncase " $* " in *" rev-parse --verify --quiet HEAD "*) exit 128;; esac\nexec ${real} "$@"\n`);
    chmodSync(join(f.root, "git"), 0o755);
    const r = spawnSync("bash", ["-c", `
      source ${JSON.stringify(ADAPTER)}
      fm_backend_bb_thread_id() { echo thr_crew; }
      fm_backend_bb_show() { echo '{"path":"${f.wt}"}'; }
      fm_backend_bb_kill() { echo KILLED; }
      fm_backend_bb_tool_check() { return 0; }
      bb() { echo CALLED_BB "$@"; }
      KIND=ship
      fm_backend_bb_remove_worktree thr_crew
    `], { encoding: "utf8", env: { ...GIT_ENV, PATH: `${f.root}:${GIT_ENV.PATH}` } });
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stderr, /cannot read HEAD/);
    assert.doesNotMatch(r.stdout, /KILLED|CALLED_BB/);
  } finally { await f.done(); }
  const empty = mkdtempSync(join(tmpdir(), "fm-wip-srv-"));
  try {
    spawnSync("git", ["init", "-q", "-b", "fm/c3-task", empty], { env: GIT_ENV });
    const r = nativeRelease(empty, "KIND=ship");
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /CALLED_BB thread archive thr_crew/);
  } finally { rmSync(empty, { recursive: true, force: true }); }
});
