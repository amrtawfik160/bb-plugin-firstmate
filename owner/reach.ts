// Owner layer (decision Q8): a PR that reaches customers or production needs a checker
// crew on a different model before it merges. The answer comes from the PR's repo and
// changed files, never from words in the PR. The table is owner/reach.json.
import { readFileSync } from "node:fs";

export type Reach = "production" | "internal";
export type ReachTable = {
  internalPaths: readonly string[];
  productionPaths: readonly string[];
  repos: Readonly<Record<string, { reach: Reach; productionPaths?: readonly string[] }>>;
};

export const REACH: ReachTable = JSON.parse(readFileSync(new URL("./reach.json", import.meta.url), "utf8"));

const glob = (pattern: string) => new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`, "i");

// "test/" and ".github/workflows/" are folders at any depth, "/docs/" a folder at the root,
// "/docs/pins.json" a full path from the root, "*.md" a file name.
function matches(path: string, patterns: readonly string[]): boolean {
  const folders = path.split("/");
  const name = folders.pop() ?? "";
  return patterns.some((pattern) => {
    if (!pattern.endsWith("/")) {
      if (!pattern.slice(1).includes("/")) return glob(pattern).test(name);
      const full = glob(pattern.replace(/^\//, ""));
      return pattern.startsWith("/") ? full.test(path) : path.split("/").some((_, i, parts) => full.test(parts.slice(i).join("/")));
    }
    const want = pattern.replace(/^\/|\/$/g, "").split("/");
    const at = (i: number) => want.every((part, j) => folders[i + j] === part);
    return pattern.startsWith("/") ? at(0) : folders.some((_, i) => at(i));
  });
}

// complete=false: the file list could not be read in full, so nothing proves it internal.
export function changeReach(pr: { repo: string; files: readonly string[]; complete: boolean }, table: ReachTable = REACH): { reach: Reach; why: string } {
  const repo = Object.entries(table.repos).find(([name]) => glob(name).test(pr.repo))?.[1];
  if (repo?.reach === "internal") return { reach: "internal", why: `${pr.repo} is listed as internal` };
  if (!pr.complete || pr.files.length === 0) return { reach: "production", why: `the changed files of ${pr.repo} could not be read in full` };
  const deploys = pr.files.find((file) => matches(file, [...table.productionPaths, ...(repo?.productionPaths ?? [])]));
  if (deploys !== undefined) return { reach: "production", why: `${deploys} is a production path` };
  const outside = pr.files.find((file) => !matches(file, table.internalPaths));
  if (outside === undefined) return { reach: "internal", why: "every changed file is an internal path" };
  return { reach: "production", why: `${pr.repo} is not listed as internal, and ${outside} is not an internal path` };
}
