#!/usr/bin/env node
/** Dry-run (default) or apply Owner approval as a required status on each repo Firstmate merges into. */
import { spawnSync } from "node:child_process";
import { PROJECTS } from "../owner/projects.ts";
import { canEnforceRequiredChecks, desiredProtection, GITHUB_FREE_PLAN_REASON, isExactRepo, isGithubFreePlanRepo, listedRepoPatterns } from "../lib/github-protection.ts";

type GhResult = { exitCode: number; stdout: string; stderr: string };

function gh(args: string[], stdin?: string): GhResult {
  const run = spawnSync("gh", args, { encoding: "utf8", input: stdin });
  return { exitCode: run.status ?? 1, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

function parseArgs(argv: string[]) {
  const repos: string[] = [];
  let apply = false;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--apply") apply = true;
    else if (arg === "--dry-run") apply = false;
    else if (arg === "--json") json = true;
    else if (arg === "--repo") {
      const next = argv[++i];
      if (next) repos.push(next);
    } else if (arg.startsWith("--repo=")) repos.push(arg.slice("--repo=".length));
  }
  return { apply, json, repos };
}

function expand(pattern: string): string[] {
  if (isExactRepo(pattern)) return [pattern];
  const owner = pattern.split("/")[0] ?? "";
  if (owner !== "" && owner !== "*") {
    const listed = gh(["repo", "list", owner, "--limit", "1000", "--json", "nameWithOwner", "-q", ".[].nameWithOwner"]);
    const names = listed.stdout.split(/\s+/).map((row) => row.trim()).filter(Boolean);
    const regex = new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "i");
    return names.filter((name) => regex.test(name));
  }
  return [];
}

function defaultBranch(repo: string): string {
  const view = gh(["repo", "view", repo, "--json", "defaultBranchRef"]);
  const parsed = parseJson(view.stdout);
  const ref = typeof parsed === "object" && parsed !== null ? (parsed as { defaultBranchRef?: { name?: unknown } }).defaultBranchRef : undefined;
  return typeof ref?.name === "string" && ref.name !== "" ? ref.name : "main";
}

function protectionOf(repo: string, branch: string): { existing: unknown; error: { status: number; message: string } | null } {
  const read = gh(["api", `repos/${repo}/branches/${branch}/protection`]);
  if (read.exitCode === 0) return { existing: parseJson(read.stdout) ?? null, error: null };
  const message = (read.stderr || read.stdout).trim();
  const status = /(?:HTTP |^)(403|404|422)\b/.exec(message)?.[1];
  if (read.exitCode !== 0 && /Not Found|Branch not protected|404/.test(message)) {
    return { existing: null, error: { status: 404, message } };
  }
  return { existing: null, error: { status: status ? Number(status) : 403, message } };
}

function reportRepo(repo: string, apply: boolean) {
  if (isGithubFreePlanRepo(repo)) {
    return {
      repo,
      branch: "",
      dryRun: !apply,
      canEnforce: false,
      reason: GITHUB_FREE_PLAN_REASON,
      put: null,
      undoCommand: "none",
      rulesets: [],
      applied: false,
      skipped: true,
    };
  }
  const branch = defaultBranch(repo);
  const { existing, error } = protectionOf(repo, branch);
  const enforceable = canEnforceRequiredChecks(error?.status === 404 ? { status: 404, message: error.message } : error);
  const plan = desiredProtection(existing, repo, branch);
  const canEnforce = enforceable.ok && plan.canEnforce;
  let applied = false;
  let applyError: string | undefined;
  if (apply && canEnforce) {
    const put = gh(["api", "-X", "PUT", `repos/${repo}/branches/${branch}/protection`, "--input", "-"], JSON.stringify(plan.put));
    applied = put.exitCode === 0;
    if (!applied) applyError = (put.stderr || put.stdout).trim();
  }
  const rulesets = gh(["api", `repos/${repo}/rulesets`]);
  return {
    repo,
    branch,
    dryRun: !apply,
    canEnforce,
    reason: applyError ?? enforceable.reason,
    put: plan.put,
    undoCommand: plan.undoCommand,
    rulesets: parseJson(rulesets.stdout) ?? [],
    applied,
    skipped: false,
  };
}

function format(row: ReturnType<typeof reportRepo>): string {
  if (row.skipped) {
    return [
      `skip ${row.repo}`,
      `can enforce: no (${row.reason})`,
      "applied: no",
    ].join("\n");
  }
  const lines = [
    `${row.dryRun ? "dry-run" : "apply"} ${row.repo} (branch ${row.branch})`,
    `can enforce: ${row.canEnforce ? "yes" : "no"}${row.reason ? ` (${row.reason})` : ""}`,
    `applied: ${row.applied ? "yes" : "no"}`,
    `change: PUT /repos/${row.repo}/branches/${row.branch}/protection`,
    JSON.stringify(row.put, null, 2),
    `undo: ${row.undoCommand}`,
  ];
  return lines.join("\n");
}

const args = parseArgs(process.argv.slice(2));
const patterns = args.repos.length > 0 ? args.repos : listedRepoPatterns([...PROJECTS.projects]);
const repos = [...new Set(patterns.flatMap(expand))];
if (repos.length === 0) {
  console.error("No repositories to inspect. Pass --repo owner/repo.");
  process.exit(2);
}

const rows = repos.map((repo) => reportRepo(repo, args.apply));
if (args.json) console.log(JSON.stringify(rows, null, 2));
else console.log(rows.map(format).join("\n\n"));
if (args.apply && rows.some((row) => row.canEnforce && !row.applied)) process.exit(2);
