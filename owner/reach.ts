// Owner layer (decision Q8): a PR that reaches customers or production needs a checker
// crew on a different model before it merges. The answer comes from the PR's repo and
// changed files, never from words in the PR. The table is owner/reach.json.
import { readFileSync } from "node:fs";

export type Reach = "production" | "internal";
export type ReachTable = { internalPaths: readonly string[]; repos: Readonly<Record<string, { reach: Reach }>> };

export const REACH: ReachTable = JSON.parse(readFileSync(new URL("./reach.json", import.meta.url), "utf8"));

// "docs/" matches a folder at any depth; "*.md" matches the file name.
function internalPath(path: string, patterns: readonly string[]): boolean {
  const segments = path.split("/");
  const name = segments.at(-1) ?? "";
  return patterns.some((pattern) => pattern.endsWith("/")
    ? segments.slice(0, -1).includes(pattern.slice(0, -1))
    : new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`).test(name));
}

// complete=false: the file list could not be read in full, so nothing proves it internal.
export function changeReach(pr: { repo: string; files: readonly string[]; complete: boolean }, table: ReachTable = REACH): { reach: Reach; why: string } {
  const repo = Object.entries(table.repos).find(([name]) => name.toLowerCase() === pr.repo.toLowerCase())?.[1];
  if (repo?.reach === "internal") return { reach: "internal", why: `${pr.repo} is listed as internal` };
  if (!pr.complete || pr.files.length === 0) return { reach: "production", why: `the changed files of ${pr.repo} could not be read in full` };
  const outside = pr.files.find((file) => !internalPath(file, table.internalPaths));
  if (outside === undefined) return { reach: "internal", why: "every changed file is an internal path" };
  return { reach: "production", why: `${pr.repo} is not listed as internal, and ${outside} is not an internal path` };
}
