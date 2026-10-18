// Owner decision Q6 (18 Oct): crew commits that exist on no remote branch are backed up every
// hour. 34 Dr Woo commits and Areliaa work once lived only on this host. The backup pushes HEAD to
// wip/<crew>-<branch> on the crew branch's own remote, with a lease on that wip branch only. It
// never pushes main or the crew's PR branch, never opens a PR, and never commits for the crew:
// uncommitted files are only listed, so the captain can be told.

export type WipPush = "pushed" | "none" | "failed" | "no-remote" | "missing";

export type WipBackupResult = {
  push: WipPush;
  /** Commits on HEAD that no remote branch (and not the base branch) has. */
  unpushed: number;
  /** Uncommitted paths, as `git status --porcelain` names them. */
  dirty: string[];
  branch: string;
  remote: string;
  target: string;
  detail: string;
};

const CREW_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The wip branch for one crew branch. A detached HEAD gets `detached`. */
export function wipBranchFor(crewId: string, branch: string): string {
  if (!CREW_ID.test(crewId) || crewId.includes("..")) throw new Error(`Refusing a wip branch for crew id ${JSON.stringify(crewId)}.`);
  return `wip/${crewId}-${branch === "" ? "detached" : branch}`;
}

function shQuote(text: string): string {
  return `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * One bash command that backs up one worktree and prints `FM_WIP` lines for parseWipBackup.
 * `base` is the crew's base branch; its local commits are not the crew's work.
 */
export function wipBackupScript(path: string, crewId: string, base: string): string {
  const prefix = wipBranchFor(crewId, "x").slice(0, -1);
  const baseRef = shQuote(`refs/heads/${base}`);
  // A git command that fails is a failed backup, never "nothing to push" or "no files".
  const fail = (what: string) => `{ echo "FM_WIP push=failed cannot read ${what}"; exit 0; }`;
  return [
    `cd ${shQuote(path)} 2>/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "FM_WIP push=missing"; exit 0; }`,
    `export GIT_TERMINAL_PROMPT=0`,
    `st=$(git status --porcelain=v1 --untracked-files=all 2>/dev/null) || ${fail("uncommitted files")}`,
    `printf '%s\\n' "$st" | head -n 200 | while IFS= read -r l; do [ -n "$l" ] && printf 'FM_WIP_DIRTY %s\\n' "\${l:3}"; done`,
    `branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null || true)`,
    `head=$(git rev-parse --verify --quiet HEAD 2>/dev/null || true)`,
    `exclude=""; git rev-parse --verify --quiet ${baseRef} >/dev/null 2>&1 && exclude=${baseRef}`,
    `n=0; if [ -n "$head" ]; then n=$(git rev-list --count "$head" --not --remotes $exclude -- 2>/dev/null) || ${fail("commits not on a remote")}; fi`,
    `case "$n" in ''|*[!0-9]*) ${fail("commits not on a remote")} ;; esac`,
    `remote=""; [ -n "$branch" ] && remote=$(git config --get "branch.$branch.remote" 2>/dev/null || true); [ "$remote" = "." ] && remote=""`,
    `remotes=$(git remote 2>/dev/null) || ${fail("remotes")}`,
    `[ -z "$remote" ] && { printf '%s\\n' "$remotes" | grep -qx origin && remote=origin || remote=$(printf '%s\\n' "$remotes" | head -n 1); }`,
    `target=${shQuote(prefix)}"\${branch:-detached}"`,
    `echo "FM_WIP unpushed=$n branch=$branch remote=$remote target=$target"`,
    `[ "$n" -gt 0 ] || { echo "FM_WIP push=none"; exit 0; }`,
    `[ -n "$remote" ] || { echo "FM_WIP push=no-remote"; exit 0; }`,
    `case "$target" in ${shQuote(prefix)}*) ;; *) echo "FM_WIP push=failed bad target"; exit 0;; esac`,
    // The lease names the value this checkout last pushed or fetched; an unknown branch must not exist yet.
    `seen=$(git rev-parse --verify --quiet "refs/remotes/$remote/$target" || true)`,
    `if ! out=$(timeout 90 git push --no-verify --porcelain --force-with-lease="refs/heads/$target:$seen" "$remote" "$head:refs/heads/$target" 2>&1); then echo "FM_WIP push=failed $(printf '%s' "$out" | tr '\\n' ' ' | cut -c1-300)"; exit 0; fi`,
    // Keep the pushed value even when the fetch refspec does not cover wip/ (a single-branch
    // clone): the next lease needs it, and the retire check then sees the commits as pushed.
    `git update-ref "refs/remotes/$remote/$target" "$head" || { echo "FM_WIP push=failed pushed, but could not record refs/remotes/$remote/$target"; exit 0; }`,
    `echo "FM_WIP push=pushed"`,
  ].join("\n");
}

export function parseWipBackup(output: string): WipBackupResult {
  const result: WipBackupResult = { push: "failed", unpushed: 0, dirty: [], branch: "", remote: "", target: "", detail: "no backup output" };
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("FM_WIP_DIRTY ")) { result.dirty.push(line.slice("FM_WIP_DIRTY ".length)); continue; }
    if (!line.startsWith("FM_WIP ")) continue;
    const body = line.slice("FM_WIP ".length);
    const push = /^push=(\S+)\s*(.*)$/.exec(body);
    if (push !== null) {
      result.push = (["pushed", "none", "failed", "no-remote", "missing"] as const).find((p) => p === push[1]) ?? "failed";
      result.detail = push[2] ?? "";
      continue;
    }
    const facts = /^unpushed=(\d+) branch=(\S*) remote=(\S*) target=(\S*)$/.exec(body);
    if (facts !== null) {
      result.unpushed = Number(facts[1]);
      result.branch = facts[2]!;
      result.remote = facts[3]!;
      result.target = facts[4]!;
    }
  }
  return result;
}
