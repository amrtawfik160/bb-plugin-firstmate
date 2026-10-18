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
