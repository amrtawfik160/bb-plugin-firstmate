#!/usr/bin/env node
// Weekly native sync (owner decisions Q3, Q12, Q13). Run by two BB script automations:
//   node scripts/native-sync.ts tick --start   Sunday 06:00 Cairo: may start a sync crew
//   node scripts/native-sync.ts tick           every 30 minutes: moves an open sync on
// Each run reads the pin (GitHub main), upstream HEAD, the open sync PRs and the threads it
// started, then does at most one step from owner/native-sync.ts. --dry-run prints the step only.
// --retry starts the current upstream HEAD again after a failed or closed sync was reported.
// Before a spawn or a message, the run saves its operation id; a later run looks for that id
// (thread title, repair-thread log) before it acts again.
// Env: FM_SYNC_MANAGER (the repair thread), FM_SYNC_PROJECT (this repo's BB project).
// Optional: FM_SYNC_LIVE_HOME (the live captain home, for the guard), FM_SYNC_STATE (state
// file), FM_SYNC_UPSTREAM, FM_SYNC_REPO.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { marker, nextSyncStep, opTag, SYNC, type SyncState, type SyncStep } from "../owner/native-sync.ts";
import { bbJson, findMessage, markedChildren } from "./bb-calls.ts";
import { singleRun } from "./single-run.ts";

const args = process.argv.slice(2);
if (args[0] !== "tick") {
  console.error("Usage: node scripts/native-sync.ts tick [--start] [--retry] [--dry-run]");
  process.exit(2);
}
const manager = process.env.FM_SYNC_MANAGER ?? "";
const project = process.env.FM_SYNC_PROJECT ?? "";
if (manager === "" || project === "") {
  console.error("native-sync: set FM_SYNC_MANAGER and FM_SYNC_PROJECT to the repair thread and this repo's BB project.");
  process.exit(2);
}
const statePath = process.env.FM_SYNC_STATE || join(homedir(), ".bb-firstmate", "native-sync", "state.json");
singleRun(`${statePath}.lock`, "native-sync");

const start = args.includes("--start");
const retry = args.includes("--retry");
const dry = args.includes("--dry-run");
const upstream = process.env.FM_SYNC_UPSTREAM || SYNC.upstream;
const repo = process.env.FM_SYNC_REPO || SYNC.repo;

const run = (cmd: string, argv: string[]) => execFileSync(cmd, argv, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], timeout: 120_000, killSignal: "SIGKILL" });
const json = (cmd: string, argv: string[]) => (cmd === "bb" ? bbJson(argv) : JSON.parse(run(cmd, argv)));
// A spawn's thread is created within this long after its saved intent.
const LAUNCH_WINDOW_MS = 10 * 60_000;
const SEARCH_BUDGET_MS = Number(process.env.FM_SYNC_SEARCH_BUDGET_MS) || 3 * 60_000;
const save = (next: SyncState) => {
  writeFileSync(`${statePath}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${statePath}.tmp`, statePath);
};

let state: SyncState = {};
try { state = JSON.parse(readFileSync(statePath, "utf8")); } catch { state = {}; }

const surface = run("gh", ["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/lib/upstream-surface.ts?ref=main`]);
const pin = /UPSTREAM_FIRSTMATE_SHA = "([0-9a-f]{40})"/.exec(surface)?.[1];
if (pin === undefined) throw new Error(`no UPSTREAM_FIRSTMATE_SHA in ${repo} main lib/upstream-surface.ts`);
const head = run("git", ["ls-remote", upstream, "HEAD"]).split(/\s/)[0] ?? "";
if (!/^[0-9a-f]{40}$/.test(head)) throw new Error(`git ls-remote ${upstream} HEAD returned no commit`);

type GhPr = { number: number; url: string; headRefName: string; headRefOid: string; mergedAt?: string | null };
const toPr = (pr: GhPr) => ({ number: pr.number, url: pr.url, branch: pr.headRefName, head: pr.headRefOid });
const prs = (json("gh", ["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,url,headRefName,headRefOid"]) as GhPr[])
  .filter((pr) => pr.headRefName.startsWith(SYNC.branchPrefix))
  .sort((a, b) => a.number - b.number)
  .map(toPr);
const files = prs[0] === undefined ? [] : (json("gh", ["pr", "view", String(prs[0].number), "--repo", repo, "--json", "files"]).files as { path: string }[]).map((f) => f.path);
const syncBranch = state.sync === undefined ? undefined : `${SYNC.branchPrefix}${state.sync.target.slice(0, 8)}`;
const closed = syncBranch === undefined || prs.length > 0 ? [] : (json("gh", ["pr", "list", "--repo", repo, "--state", "closed", "--head", syncBranch, "--limit", "20", "--json", "number,url,headRefName,headRefOid,mergedAt"]) as GhPr[])
  .filter((pr) => !pr.mergedAt)
  .map(toPr);

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

// Only an operation without its result needs these reads. A lost spawn is looked for among
// the repair thread's children created inside its window; a lost message in the repair
// thread's whole log since its intent.
const launched: Record<string, string[]> = {};
for (const pending of [state.sync, state.check]) {
  if (pending === undefined || pending.threadId !== undefined) continue;
  const at = Date.parse(pending.at);
  launched[pending.op] = markedChildren(manager, opTag(pending.op), at - 5_000, at + LAUNCH_WINDOW_MS);
}
const delivered: Record<string, "found" | "absent" | "unknown"> = {};
if (state.outbox !== undefined) delivered[state.outbox.op] = findMessage(manager, marker(state.outbox.op), Date.parse(state.outbox.at), SEARCH_BUDGET_MS);

const step: SyncStep = nextSyncStep({
  start, retry, pin, upstream: head, prs, closed, files, threads, launched, delivered,
  newOp: randomBytes(4).toString("hex"),
  liveHome: process.env.FM_SYNC_LIVE_HOME || undefined,
}, state);

const label = step.action === "none" ? step.why
  : step.action === "adopt" ? `${step.slot} ${step.threadId}`
  : step.action === "tell" || step.action === "delivered" ? step.key
  : step.title;
const finished = (key: string): SyncState => ({ ...state, outbox: undefined, done: [...(state.done ?? []), key].slice(-50) });

if (step.action === "none") {
  console.log(`native-sync: none: ${label}`);
} else if (dry) {
  console.log(`native-sync: ${step.action}: ${label} (dry run, nothing started)`);
  if (step.action === "tell") console.log(step.text);
  if (step.action === "spawn-sync" || step.action === "spawn-check") console.log(step.prompt);
} else if (step.action === "adopt") {
  save({ ...state, [step.slot]: { ...state[step.slot]!, threadId: step.threadId } });
  console.log(`native-sync: adopt: ${label}`);
} else if (step.action === "delivered") {
  save(finished(step.key));
  console.log(`native-sync: delivered: ${label}`);
} else {
  const scratch = mkdtempSync(join(tmpdir(), "native-sync-"));
  const file = join(scratch, "text.md");
  try {
    if (step.action === "tell") {
      save({ ...state, outbox: { key: step.key, op: step.op, text: step.text, at: new Date().toISOString() } });
      writeFileSync(file, step.text);
      const receipt = json("bb", ["thread", "tell", manager, "--message-file", file, "--json"]);
      save({ ...finished(step.key), receipts: Object.fromEntries([...Object.entries(state.receipts ?? {}), [step.key, receipt]].slice(-20)) });
      console.log(`native-sync: tell: ${label} sent to ${manager}`);
    } else {
      const at = new Date().toISOString();
      const intent: SyncState = step.action === "spawn-sync"
        ? { done: state.done, sync: { op: step.op, target: step.target, attempt: step.attempt, at } }
        : { ...state, check: { op: step.op, head: step.head, pr: step.pr, at } };
      save(intent);
      const who = step.action === "spawn-sync" ? SYNC.builder : SYNC.checker;
      const base = step.action === "spawn-sync" ? "origin/main" : `origin/${step.branch}`;
      writeFileSync(file, step.prompt);
      const spawned = json("bb", ["thread", "spawn", "--json", "--project", project, "--parent-thread", manager, "--new-environment", "worktree", "--base-branch", base, "--provider", who.providerId, "--model", who.model, "--title", step.title, "--prompt-file", file]);
      const id = String(spawned.id ?? spawned.thread?.id ?? "");
      if (id === "") throw new Error(`bb thread spawn returned no thread id: ${JSON.stringify(spawned).slice(0, 200)}`);
      const slot = step.action === "spawn-sync" ? "sync" : "check";
      save({ ...intent, [slot]: { ...intent[slot]!, threadId: id } });
      console.log(`native-sync: ${step.action}: ${label} as ${id}`);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
