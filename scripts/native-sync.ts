#!/usr/bin/env node
// Weekly native sync (owner decisions Q3, Q12, Q13). Run by two BB script automations:
//   node scripts/native-sync.ts tick --start   Sunday 06:00 Cairo: may start a sync crew
//   node scripts/native-sync.ts tick           every 30 minutes: moves an open sync on
// Each run reads the pin (GitHub main), upstream HEAD, the open sync PRs and the threads it
// started, then does at most one step from owner/native-sync.ts. --dry-run prints the step only.
// Env: FM_SYNC_MANAGER (the repair thread), FM_SYNC_PROJECT (this repo's BB project).
// Optional: FM_SYNC_LIVE_HOME (the live captain home, for the guard), FM_SYNC_STATE (state
// file), FM_SYNC_UPSTREAM, FM_SYNC_REPO.
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { nextSyncStep, SYNC, type SyncState } from "../owner/native-sync.ts";

const args = process.argv.slice(2);
if (args[0] !== "tick") {
  console.error("Usage: node scripts/native-sync.ts tick [--start] [--dry-run]");
  process.exit(2);
}
const start = args.includes("--start");
const dry = args.includes("--dry-run");
const manager = process.env.FM_SYNC_MANAGER ?? "";
const project = process.env.FM_SYNC_PROJECT ?? "";
if (manager === "" || project === "") {
  console.error("native-sync: set FM_SYNC_MANAGER and FM_SYNC_PROJECT to the repair thread and this repo's BB project.");
  process.exit(2);
}
const upstream = process.env.FM_SYNC_UPSTREAM || SYNC.upstream;
const repo = process.env.FM_SYNC_REPO || SYNC.repo;
const statePath = process.env.FM_SYNC_STATE || join(homedir(), ".bb-firstmate", "native-sync", "state.json");

const run = (cmd: string, argv: string[]) => execFileSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
const json = (cmd: string, argv: string[]) => JSON.parse(run(cmd, argv));

// One run at a time. A lock older than 15 minutes belongs to a run that died.
mkdirSync(dirname(statePath), { recursive: true });
const lock = `${statePath}.lock`;
try {
  closeSync(openSync(lock, "wx"));
} catch {
  if (Date.now() - statSync(lock).mtimeMs < 15 * 60_000) {
    console.log("native-sync: none: another run holds the lock");
    process.exit(0);
  }
  writeFileSync(lock, "");
}

function tick(): void {
  let state: SyncState = {};
  try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { state = {}; }

  const surface = run("gh", ["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/lib/upstream-surface.ts?ref=main`]);
  const pin = /UPSTREAM_FIRSTMATE_SHA = "([0-9a-f]{40})"/.exec(surface)?.[1];
  if (pin === undefined) throw new Error(`no UPSTREAM_FIRSTMATE_SHA in ${repo} main lib/upstream-surface.ts`);
  const head = run("git", ["ls-remote", upstream, "HEAD"]).split(/\s/)[0] ?? "";
  if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`git ls-remote ${upstream} HEAD returned no commit`);

  const prs = (json("gh", ["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,url,headRefName,headRefOid"]) as { number: number; url: string; headRefName: string; headRefOid: string }[])
    .filter((pr) => pr.headRefName.startsWith(SYNC.branchPrefix))
    .sort((a, b) => a.number - b.number)
    .map((pr) => ({ number: pr.number, url: pr.url, branch: pr.headRefName, head: pr.headRefOid }));
  const files = prs[0] === undefined ? [] : (json("gh", ["pr", "view", String(prs[0].number), "--repo", repo, "--json", "files"]).files as { path: string }[]).map((f) => f.path);

  const threads: Record<string, { status: string; output: string } | undefined> = {};
  for (const id of [state.sync?.threadId, state.check?.threadId]) {
    if (id === undefined || id in threads) continue;
    let thread: { status?: string; archivedAt?: unknown } | undefined;
    try { thread = json("bb", ["thread", "show", id, "--json"]).thread; } catch { thread = undefined; }
    if (thread === undefined) { threads[id] = undefined; continue; }
    const status = thread.archivedAt ? "archived" : String(thread.status);
    const done = ["idle", "error", "archived"].includes(status);
    threads[id] = { status, output: done ? String(json("bb", ["thread", "output", id, "--json"]).output ?? "") : "" };
  }

  const step = nextSyncStep({ start, pin, upstream: head, prs, files, threads, liveHome: process.env.FM_SYNC_LIVE_HOME || undefined }, state);
  if (step.action === "none") {
    console.log(`native-sync: none: ${step.why}`);
    return;
  }
  const label = step.action === "report" ? `PR #${step.pr}` : step.title;
  if (dry) {
    console.log(`native-sync: ${step.action}: ${label} (dry run, nothing started)`);
    console.log(step.action === "report" ? step.message : step.prompt);
    return;
  }

  const scratch = mkdtempSync(join(tmpdir(), "native-sync-"));
  const file = join(scratch, "text.md");
  const save = (next: SyncState) => {
    writeFileSync(`${statePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
    renameSync(`${statePath}.tmp`, statePath);
  };
  try {
    if (step.action === "report") {
      writeFileSync(file, step.message);
      run("bb", ["thread", "tell", manager, "--message-file", file]);
      save({ ...state, reported: step.head });
      console.log(`native-sync: report: PR #${step.pr} sent to ${manager}`);
    } else {
      const who = step.action === "start-sync" ? SYNC.builder : SYNC.checker;
      const base = step.action === "start-sync" ? "origin/main" : `origin/${step.branch}`;
      writeFileSync(file, step.prompt);
      const spawned = json("bb", ["thread", "spawn", "--json", "--project", project, "--parent-thread", manager, "--new-environment", "worktree", "--base-branch", base, "--provider", who.providerId, "--model", who.model, "--title", step.title, "--prompt-file", file]);
      const id = String(spawned.id ?? spawned.thread?.id ?? "");
      if (id === "") throw new Error(`bb thread spawn returned no thread id: ${JSON.stringify(spawned).slice(0, 200)}`);
      const at = new Date().toISOString();
      save(step.action === "start-sync"
        ? { sync: { target: step.target, threadId: id, at } }
        : { ...state, check: { head: step.head, threadId: id, pr: step.pr, at } });
      console.log(`native-sync: ${step.action}: ${label} as ${id}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  tick();
} finally {
  rmSync(lock, { force: true });
}
