import { readFileSync } from 'node:fs';
import type { Workstream, WorkstreamRepo } from './workstreams.ts';
const shQuote = (text: string) => "'" + text.replaceAll("'", "'\"'\"'") + "'";

export function provisionScript(source: string, path: string, branch: string): string {
  return [
    'set -eu', `cd -- ${shQuote(source)}`,
    'git fetch origin main',
    `if [ ! -d ${shQuote(path)} ]; then mkdir -p -- ${shQuote(path.slice(0, path.lastIndexOf('/')))}; if git show-ref --verify --quiet ${shQuote(`refs/heads/${branch}`)}; then git worktree add ${shQuote(path)} ${shQuote(branch)}; else git worktree add -b ${shQuote(branch)} ${shQuote(path)} origin/main; fi; fi`,
    `[ "$(git -C ${shQuote(path)} symbolic-ref --short HEAD)" = ${shQuote(branch)} ]`,
    `git -C ${shQuote(path)} remote get-url origin`,
  ].join('\n');
}

export function takeMainScript(repo: WorkstreamRepo): string {
  return [
    'set -eu', `cd -- ${shQuote(repo.path)}`,
    `[ "$(git symbolic-ref --short HEAD)" = ${shQuote(repo.branch)} ]`,
    '[ -z "$(git status --porcelain --untracked-files=all)" ]',
    'git fetch origin main',
    // A squash merge has a different ancestry. Merge main without discarding the workstream's commits.
    'git -c core.editor=true merge --no-edit origin/main',
    `git push origin HEAD:${shQuote(repo.branch)}`,
    `git update-ref ${shQuote(`refs/firstmate/shipped/${repo.branch}`)} HEAD`,
  ].join('\n');
}

export function devUnit(w: Workstream): string { return `fm-workstream-${w.id}.service`; }
export function devActivityPath(w: Workstream): string { return `/run/${devUnit(w).slice(0, -8)}/activity`; }
export function devAppCommand(repo: WorkstreamRepo, command: string, port: number): string {
  return command.replaceAll('{port}', String(port)).replaceAll('{source}', shQuote(repo.sourcePath));
}
export function devStartScript(w: Workstream, repo: WorkstreamRepo, command: string, allowedHost?: string): string {
  const unit = devUnit(w), port = w.devLink.port, upstream = port + 20000;
  if (upstream > 65535) throw new Error('No internal dev port available.');
  const source = readFileSync(new URL('./workstream-dev-proxy.cjs', import.meta.url), 'utf8');
  const supervisor = [
    `(${devAppCommand(repo, command, upstream)}) & app=$!`,
    `FM_DEV_PROXY_RUN=1 node --input-type=commonjs -e ${shQuote(source)} ${port} ${upstream} ${shQuote(devActivityPath(w))} & proxy=$!`,
    `trap 'kill "$app" "$proxy" 2>/dev/null || true' EXIT`,
    `wait -n "$app" "$proxy"`,
  ].join('\n');
  return [
    'set -eu',
    `if ! systemctl is-active --quiet ${shQuote(unit)}; then`,
    `  for port in ${port} ${upstream}; do if ss -H -ltn "sport = :$port" | grep -q .; then echo "Workstream dev port is already in use" >&2; exit 1; fi; done`,
    `  systemctl reset-failed ${shQuote(unit)} 2>/dev/null || true`,
    `  systemd-run --unit=${shQuote(unit)} --collect --property=Restart=on-failure --property=${shQuote(`RuntimeDirectory=${unit.slice(0, -8)}`)} --property=RuntimeDirectoryMode=0700 --working-directory=${shQuote(repo.path)} --setenv=${shQuote(`VITE_LOCAL_AUTH_BYPASS=${!w.devLink.realLogin}`)} --setenv=VITE_USE_PROD_CLERK=false ${allowedHost ? `--setenv=${shQuote(`__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=${allowedHost}`)}` : ''} --setenv=${shQuote(`PORT=${upstream}`)} /bin/bash -lc ${shQuote(supervisor)}`,
    'fi',
    `curl --retry 45 --retry-connrefused --retry-max-time 90 --retry-delay 1 --max-time 2 --silent --fail --output /dev/null http://127.0.0.1:${port}/`,
    `bb connect expose ${port} --json`,
  ].join('\n');
}

// Fold scripts print one marker and exit 0 for every expected outcome (lib/workstream-fold.ts parseFoldOutput):
// FOLD_OK (with FOLD_HEAD and the changed files), FOLD_CONFLICT for the crew to fix, and FOLD_WAIT <reason>
// when the workstream worktree cannot take the fold safely now. A dev server writes into that worktree, so
// a fold never cleans, stashes or hard-resets it: the merge result is built without touching files, and the
// worktree then only fast-forwards, which Git refuses when a local change is in the way.
const onBranch = (branch: string) =>
  `[ "$(git symbolic-ref --quiet --short HEAD || true)" = ${shQuote(branch)} ] || { echo ${shQuote(`FOLD_WAIT the workstream worktree is not on ${branch}`)}; exit 0; }`;

/** Read-only: the workstream head and the task checkout head a fold would merge. */
export function foldPlanScript(workstreamPath: string, workstreamBranch: string, checkoutPath: string): string {
  return [
    "set -eu",
    `cd -- ${shQuote(workstreamPath)}`,
    onBranch(workstreamBranch),
    'echo "FOLD_BEFORE $(git rev-parse HEAD)"',
    `target=$(git -C ${shQuote(checkoutPath)} rev-parse HEAD 2>/dev/null) || { echo 'FOLD_WAIT the task checkout is unreadable'; exit 0; }`,
    'echo "FOLD_TARGET $target"',
  ].join("\n");
}

export function foldScript(workstreamPath: string, crewPath: string, workstreamBranch: string, target?: string, expectedBefore?: string): string {
  return [
    "set -eu",
    `cd -- ${shQuote(workstreamPath)}`,
    onBranch(workstreamBranch),
    "git diff --cached --quiet || { echo 'FOLD_WAIT the workstream worktree has staged changes'; exit 0; }",
    "before=$(git rev-parse HEAD)",
    ...(expectedBefore ? [`[ "$before" = ${shQuote(expectedBefore)} ] || { echo 'FOLD_WAIT the workstream branch moved since this fold began'; exit 0; }`] : []),
    target ? `target=${shQuote(target)}` : `target=$(git -C ${shQuote(crewPath)} rev-parse HEAD)`,
    // Worktrees of one repository share objects; fetch only when the task checkout is a separate clone.
    `git cat-file -e "$target^{commit}" 2>/dev/null || git fetch -q -- ${shQuote(crewPath)} HEAD 2>/dev/null || true`,
    "git cat-file -e \"$target^{commit}\" 2>/dev/null || { echo 'FOLD_WAIT the task commit is not available'; exit 0; }",
    'if git merge-base --is-ancestor "$target" HEAD; then commit=$before',
    'elif git merge-base --is-ancestor HEAD "$target"; then commit=$target',
    "else",
    '  set +e; tree=$(git merge-tree --write-tree --no-messages HEAD "$target" 2>/dev/null); rc=$?; set -e',
    '  if [ "$rc" -eq 1 ]; then echo FOLD_CONFLICT; exit 0; fi',
    '  [ "$rc" -eq 0 ]',
    `  commit=$(git commit-tree "$tree" -p HEAD -p "$target" -m ${shQuote(`Fold task into ${workstreamBranch}`)})`,
    "fi",
    'if [ "$commit" != "$before" ]; then',
    "  git merge --ff-only -q \"$commit\" >/dev/null 2>&1 || { echo 'FOLD_WAIT the workstream worktree has local changes in files this fold changes'; exit 0; }",
    "fi",
    "after=$(git rev-parse HEAD)",
    "gitdir=$(git rev-parse --git-dir)",
    'printf %s "$before" > "$gitdir/FOLD_BEFORE"',
    'printf %s "$after" > "$gitdir/FOLD_AFTER"',
    'echo "FOLD_HEAD $after"',
    "echo FOLD_OK",
    'git diff --name-only "$before" "$after"',
  ].join("\n");
}

/**
 * Undo one fold: move the workstream branch from `after` back to `before` with `reset --keep`, which keeps
 * every local change and refuses when one is in a file the fold changed. Prints FOLD_ROLLED_BACK, or
 * FOLD_ROLLBACK_BLOCKED <reason> so the undo is retried later. Without heads it undoes the last fold.
 */
export function rollbackFoldScript(workstreamPath: string, before?: string, after?: string): string {
  return [
    "set -eu",
    `cd -- ${shQuote(workstreamPath)}`,
    "gitdir=$(git rev-parse --git-dir)",
    before ? `before=${shQuote(before)}` : 'before=$(cat "$gitdir/FOLD_BEFORE")',
    after ? `after=${shQuote(after)}` : 'after=$(cat "$gitdir/FOLD_AFTER")',
    "head=$(git rev-parse HEAD)",
    'if [ "$head" = "$before" ]; then echo FOLD_ROLLED_BACK; exit 0; fi',
    "[ \"$head\" = \"$after\" ] || { echo 'FOLD_ROLLBACK_BLOCKED the workstream branch moved after this fold'; exit 0; }",
    "if git reset -q --keep \"$before\" >/dev/null 2>&1; then echo FOLD_ROLLED_BACK; else echo 'FOLD_ROLLBACK_BLOCKED the workstream worktree has local changes in files this fold changed'; fi",
  ].join("\n");
}

/**
 * After a restart: the workstream head, whether it already holds the task commit, and, given the head
 * saved before the fold, the files changed since then (lib/workstream-fold.ts parseFoldInspect).
 */
export function foldInspectScript(workstreamPath: string, target: string, before?: string): string {
  return [
    "set -eu",
    `cd -- ${shQuote(workstreamPath)}`,
    'echo "FOLD_HEAD $(git rev-parse HEAD)"',
    `if git merge-base --is-ancestor ${shQuote(target)} HEAD 2>/dev/null; then echo 'FOLD_HAS_TARGET yes'; else echo 'FOLD_HAS_TARGET no'; fi`,
    ...(before ? ["echo FOLD_FILES", `git diff --name-only ${shQuote(before)} HEAD`] : []),
  ].join("\n");
}

export function deleteTaskBranchScript(sourcePath: string, branch: string): string {
  return [
    "set -eu",
    `cd -- ${shQuote(sourcePath)}`,
    `git push origin --delete ${shQuote(branch)} || true`,
    `git branch -D ${shQuote(branch)} || true`,
  ].join("\n");
}

export function unshippedScript(repo: WorkstreamRepo): string {
  const shipped = `refs/firstmate/shipped/${repo.branch}`;
  return [
    'set -eu', `cd -- ${shQuote(repo.path)}`,
    'if git diff --quiet origin/main HEAD; then exit 0; else result=$?; [ "$result" -eq 1 ] || exit "$result"; fi',
    'base=origin/main',
    `if git show-ref --verify --quiet ${shQuote(shipped)}; then base=${shQuote(shipped)}; fi`,
    'git log --reverse --format=%ct "$base"..HEAD | head -n 1',
  ].join('\n');
}
