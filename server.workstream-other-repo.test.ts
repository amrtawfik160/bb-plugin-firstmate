// A workstream whose repository is not the BB project's checkout (Reels in Cyndra, 20 Oct): BB cut every
// task worktree from the project checkout, where the workstream branch does not exist, so three Reels
// builders failed workspace setup. Real Git in temporary repositories behind a fake BB: repo A
// (agent-orchestrator) is the project checkout, repo B (reels-app) the workstream repository. The fake
// BB worktree provider runs `git worktree add` in repo A, as BB's does.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createWorkstreams } from './lib/workstreams.ts';
import { provisionScript } from './lib/workstream-runtime.ts';
import { stubProviderCatalog } from './test/provider-catalog.mjs';
import { manifestSkillIds } from './scripts/plugin-skill-fixture.mjs';

type Row = Record<string, unknown>;
const skills = manifestSkillIds(new URL('.', import.meta.url).pathname);

function world() {
  const dir = mkdtempSync(join(tmpdir(), 'fm-ws-other-repo-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  // gh on the host: no task branch has an open PR.
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\n[ "$1 $2" = "pr list" ] && { echo "[]"; exit 0; }\necho "fake gh: unexpected $*" >&2; exit 1\n', { mode: 0o755 });
  const gitconfig = join(dir, 'gitconfig');
  writeFileSync(gitconfig, `[user]\n\tname = fixture\n\temail = fixture@test\n[url "${dir}/github.com/"]\n\tinsteadOf = https://github.com/\n[init]\n\tdefaultBranch = main\n`);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}:${process.env['PATH']}`, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', HOME: dir, GIT_TERMINAL_PROMPT: '0' };
  delete env['BB_CLI'];
  const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const bash = (command: string) => spawnSync('bash', ['-c', command], { encoding: 'utf8', env, cwd: dir, timeout: 60_000 });
  const repo = (name: string, checkout: string) => {
    const bare = join(dir, 'github.com', `${name}.git`);
    mkdirSync(dirname(bare), { recursive: true });
    execFileSync('git', ['init', '--bare', '-q', '-b', 'main', bare], { env });
    mkdirSync(dirname(checkout), { recursive: true });
    execFileSync('git', ['clone', '-q', `https://github.com/${name}.git`, checkout], { env, stdio: 'pipe' });
    writeFileSync(join(checkout, 'README.md'), `${name}\n`);
    git(checkout, 'add', '-A'); git(checkout, 'commit', '-qm', 'first'); git(checkout, 'push', '-q', 'origin', 'main');
    return checkout;
  };
  const a = repo('cyndra-ai/cyndra-saas', join(dir, 'github_projects', 'agent-orchestrator'));
  const b = repo('amrtawfik160/reels-app', join(dir, 'github_projects', '.firstmate-sources', 'amrtawfik160', 'reels-app'));
  return { dir, a, b, git, bash, done: () => rmSync(dir, { recursive: true, force: true }) };
}

async function otherRepoHost(settings: Row = {}) {
  const w = world();
  const host = createFakePluginHost({ pluginId: 'firstmate', agentSkillIds: skills });
  // The workstream of repo B, provisioned the way Firstmate provisions it: a worktree of B on its branch.
  const seeded = createWorkstreams(host.bb.storage.database(), {
    now: () => 0,
    provision: async (ws) => {
      const path = join(w.dir, 'github_projects', '.firstmate-workstreams', ws.id, 'reels-app');
      const branch = `workstream/${ws.id}`;
      const made = w.bash(provisionScript(w.b, path, branch, 'main'));
      assert.equal(made.status, 0, made.stderr);
      return [{ repository: 'amrtawfik160/reels-app', projectId: 'cyndra', hostId: 'h1', path, sourcePath: w.b, branch, environmentId: 'env_ws_reels', base: 'main' }];
    },
    start: async () => 'unused', status: async () => 'unknown', startDev: async () => '', stopDev: async () => {}, unsaved: async () => [], remove: async () => {}, ship: async () => {}, taskState: () => 'working',
  });
  const stream = await seeded.create({ threadId: 'cap', projectId: 'cyndra', name: 'Reels app', requestId: 'reels' });
  const repoB = stream.repos[0]!;
  await plugin(host.bb); stubProviderCatalog(host);
  await host.harness.behavior.setSettings({ signInCheck: false, fmHome: '', maxActiveCrews: 0, ...settings });
  await host.bb.storage.kv.set('captain-project:cap', 'cyndra');
  const threads = new Map<string, { status: string; envId?: string; archived?: boolean }>([['cap', { status: 'idle', envId: 'env_main' }]]);
  const envs = new Map<string, { path: string; branch: string }>([['env_main', { path: w.a, branch: 'main' }], ['env_ws_reels', { path: repoB.path, branch: repoB.branch }]]);
  const spawned: Row[] = [];
  const setupErrors: string[] = [];
  const commands: string[] = [];
  const deletedEnvs: string[] = [];
  host.harness.sdk.stub('threads.getPluginMetadata', async ({ threadId }: { threadId: string }) => (threadId === 'cap' ? { captain: 'true' } : {}));
  host.harness.sdk.stub('threads.get', async ({ threadId }: { threadId: string }) => {
    const spec = threads.get(threadId);
    if (!spec) throw new Error(`thread ${threadId} not found`);
    return { ...makeThreadResponse({ id: threadId, projectId: 'cyndra', status: spec.status as 'idle' }), environmentId: spec.envId ?? null, archivedAt: spec.archived ? 1 : null, parentThreadId: threadId === 'cap' ? null : 'cap' };
  });
  host.harness.sdk.stub('threads.list', async (args: { environmentId?: string }) => {
    if (!args.environmentId) return [];
    return [...threads].filter(([, spec]) => spec.envId === args.environmentId && !spec.archived).map(([id, spec]) => ({ id, status: spec.status, archivedAt: null }));
  });
  host.harness.sdk.stub('threads.spawn', async (args: Row) => {
    spawned.push(args);
    const id = `thr_crew${spawned.length}`;
    const environment = args['environment'] as { type: string; environmentId?: string; workspace?: { type: string; path?: string; baseBranch?: { name: string } } };
    let envId: string;
    if (environment.type === 'reuse') envId = environment.environmentId!;
    else if (environment.workspace?.type === 'managed-worktree') {
      // BB's worktree provider: `git worktree add` in the project checkout, from the named base branch.
      const path = join(w.dir, 'bb-worktrees', id, 'agent-orchestrator');
      const made = spawnSync('git', ['-C', w.a, 'worktree', 'add', '-q', '-b', `bb/${id}`, path, environment.workspace.baseBranch!.name], { encoding: 'utf8' });
      if (made.status !== 0) { setupErrors.push(made.stderr); threads.set(id, { status: 'error' }); return { id }; }
      envId = `env_${id}`; envs.set(envId, { path, branch: `bb/${id}` });
    } else {
      // BB's project-checkout provider attaches the path as it is and records its branch.
      const path = environment.workspace!.path!;
      envId = `env_${id}`; envs.set(envId, { path, branch: w.git(path, 'symbolic-ref', '--short', 'HEAD') });
    }
    threads.set(id, { status: 'active', envId });
    return { id };
  });
  host.harness.sdk.stub('threads.archive', async ({ threadId }: { threadId: string }) => { threads.get(threadId)!.archived = true; return { ok: true, archivedThreadIds: [threadId] }; });
  host.harness.sdk.stub('threads.unarchive', async ({ threadId }: { threadId: string }) => { threads.get(threadId)!.archived = false; return { ok: true }; });
  host.harness.sdk.stub('threads.stop', async () => ({ ok: true }));
  host.harness.sdk.stub('threads.send', async () => ({}));
  host.harness.sdk.stub('threadSections.list', async () => []);
  host.harness.sdk.stub('threadSections.create', async () => ({ id: 'sec' }));
  host.harness.sdk.stub('threads.defaultExecutionOptions', async () => ({ model: 'claude-opus-5-5', reasoningLevel: 'high' }));
  host.harness.sdk.stub('projects.list', async () => [{ id: 'cyndra', name: 'Cyndra SaaS' }]);
  host.harness.sdk.stub('projects.get', async () => ({ id: 'cyndra', name: 'Cyndra SaaS', kind: 'repo', sources: [{ hostId: 'h1', path: w.a, isDefault: true }] }));
  host.harness.sdk.stub('environments.list', async () => [{ id: 'env_main', hostId: 'h1', path: w.a, status: 'ready', isWorktree: false }]);
  host.harness.sdk.stub('environments.get', async ({ environmentId }: { environmentId: string }) => {
    const env = envs.get(environmentId);
    if (!env) throw new Error(`environment ${environmentId} not found`);
    return { id: environmentId, hostId: 'h1', path: env.path, status: 'ready', isWorktree: environmentId !== 'env_main', branchName: env.branch };
  });
  host.harness.sdk.stub('environments.delete', async ({ environmentId }: { environmentId: string }) => { deletedEnvs.push(environmentId); envs.delete(environmentId); return { ok: true }; });
  host.harness.sdk.stub('files.read', async ({ path }: { path: string }) => {
    if (!existsSync(path)) throw new Error(`no file ${path}`);
    const content = readFileSync(path, 'utf8');
    return { content, contentEncoding: 'utf8', sizeBytes: content.length };
  });
  host.harness.sdk.stub('plugins.callRpc', async () => ({ ok: true, queued: 1, duplicate: false }));
  host.harness.sdk.stub('hosts.exec', async ({ command }: { command: string }) => {
    commands.push(command);
    const run = w.bash(command);
    return { exitCode: run.status ?? 1, output: run.status === 0 ? run.stdout : `${run.stdout}${run.stderr}` };
  });
  const dispatch = host.harness.inspection.registrations.agentTools.find((t) => t.name === 'firstmate_dispatch')!;
  const ctx = { threadId: 'cap', projectId: 'cyndra' } as never;
  const text = (result: unknown) => (typeof result === 'string' ? result : JSON.stringify(result));
  return {
    w, host, seeded, stream, repoB, threads, envs, spawned, setupErrors, commands, deletedEnvs,
    job: (id: string) => seeded.get(stream.id, 'cap').jobs.find((j) => j.id === id),
    dispatch: async (input: Row) => text(await dispatch.execute({ workstreamId: stream.id, workstreamRepo: 'amrtawfik160/reels-app', origin: { kind: 'captain', reason: 'workstream task' }, providerId: 'claude-code', model: 'claude-opus-5-5', ...input }, ctx)),
    pass: () => host.harness.behavior.runSchedule('workstreams'),
    done: async () => { await host.harness.lifecycle.dispose(); w.done(); },
  };
}

test('fake BB: a task crew for a repository that is not the project checkout starts in its own worktree of that repository, folds and is cleaned up', async () => {
  const f = await otherRepoHost();
  try {
    const sent = await f.dispatch({ task: 'Fix the reel sound effects', taskId: 'reels-builder', title: 'Reels builder' });
    assert.match(sent, /Dispatched ship crew reels-builder/, sent);
    assert.deepEqual(f.setupErrors, [], 'BB never runs git worktree add in the project checkout for this repository');
    const taskPath = join(dirname(f.repoB.path), '.tasks', 'reels-builder', 'reels-app');
    assert.deepEqual(f.spawned[0]!.environment, { type: 'host', hostId: 'h1', workspace: { type: 'unmanaged', path: taskPath } });
    // The worktree is of repo B, on the crew's own branch, cut from the workstream branch.
    assert.equal(f.w.git(taskPath, 'config', '--get', 'remote.origin.url'), 'https://github.com/amrtawfik160/reels-app.git');
    assert.equal(f.w.git(taskPath, 'symbolic-ref', '--short', 'HEAD'), 'fm/reels-builder');
    assert.equal(f.w.git(taskPath, 'rev-parse', 'HEAD'), f.w.git(f.repoB.path, 'rev-parse', 'HEAD'));
    assert.equal(f.w.git(f.w.a, 'worktree', 'list', '--porcelain').split('\n').filter((line) => line.startsWith('worktree ')).length, 1, 'repo A gets no worktree');
    assert.ok(String(f.spawned[0]!.prompt).includes(`Repository amrtawfik160/reels-app: this worktree, cut from ${f.repoB.branch}, is this task's only checkout`));
    const recorded = f.job('reels-builder')!;
    assert.deepEqual(recorded.repos, [{ repository: 'amrtawfik160/reels-app', path: taskPath, branch: 'fm/reels-builder', environmentId: 'env_thr_crew1', hostId: 'h1' }]);

    // The crew commits and pushes its work, reports its tests passed, and ends its turn.
    writeFileSync(join(taskPath, 'sfx.ts'), 'export const sfx = "on beats only";\n');
    f.w.git(taskPath, 'add', '-A'); f.w.git(taskPath, 'commit', '-qm', 'Play sound effects on beats only');
    const work = f.w.git(taskPath, 'rev-parse', 'HEAD');
    f.w.git(taskPath, 'push', '-q', 'origin', 'HEAD');
    const reportDir = (f.spawned[0]!.pluginMetadata as Row)['reportDir'] as string;
    mkdirSync(reportDir, { recursive: true });
    writeFileSync(join(reportDir, 'report.md'), 'DONE: sound effects play on beats.\nTests passed: 12 pass, 0 fail.\n');
    f.threads.get('thr_crew1')!.status = 'idle';
    for (let i = 0; i < 3 && f.job('reels-builder')!.cleanup !== 'done'; i++) await f.pass();

    const folded = f.job('reels-builder')!;
    assert.equal(folded.state, 'folded', folded.note ?? folded.error);
    f.w.git(f.repoB.path, 'merge-base', '--is-ancestor', work, 'HEAD');
    assert.ok(existsSync(join(f.repoB.path, 'sfx.ts')), 'the fold lands the task in the workstream worktree');
    assert.equal(folded.cleanup, 'done', folded.note);
    assert.equal(f.threads.get('thr_crew1')!.archived, true);
    assert.equal(existsSync(taskPath), false, 'the task worktree is removed after the archive');
    assert.equal(f.w.git(f.w.b, 'branch', '--list', 'fm/reels-builder'), '', 'the folded task branch is deleted');
    assert.equal(f.w.git(f.w.b, 'ls-remote', '--heads', 'origin', 'fm/reels-builder'), '', 'and its pushed copy');
    assert.deepEqual(f.deletedEnvs, ['env_thr_crew1']);
  } finally { await f.done(); }
});

test('fake BB: a scout in that workstream reuses the workstream environment, never the project checkout', async () => {
  const f = await otherRepoHost();
  try {
    const sent = await f.dispatch({ task: 'Review the reels', taskId: 'reels-reviewer', shape: 'scout', role: 'lookup' });
    assert.match(sent, /Dispatched scout crew reels-reviewer/, sent);
    assert.deepEqual(f.spawned[0]!.environment, { type: 'reuse', environmentId: 'env_ws_reels' });
    assert.equal(existsSync(join(dirname(f.repoB.path), '.tasks')), false, 'a scout gets no task worktree');
  } finally { await f.done(); }
});

for (const async of [false, true]) {
  test(`fake BB: a repository that cannot be set up is refused before anything is reserved, naming why${async ? ' (background dispatch)' : ''}`, async () => {
    const f = await otherRepoHost(async ? { fmReliability: JSON.stringify({ asyncDispatch: 'on' }) } : {});
    try {
      // The workstream branch is gone from repo B, so no task worktree can be cut from it.
      f.w.git(f.repoB.path, 'checkout', '-q', '--detach');
      f.w.git(f.w.b, 'branch', '-D', f.repoB.branch);
      const sent = await f.dispatch({ task: 'Fix the reel sound effects', taskId: 'reels-builder' });
      assert.match(sent, new RegExp(`cannot set up a worktree of amrtawfik160/reels-app for crew reels-builder: branch ${f.repoB.branch} is not in ${f.w.b}`), sent);
      assert.doesNotMatch(sent, /Reserved crew|Dispatched/);
      assert.equal(f.spawned.length, 0, 'no crew thread');
      assert.equal(f.job('reels-builder'), undefined, 'no workstream job');
      const db = f.host.bb.storage.database();
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM launches').get()!['n'], 0, 'no crew slot');
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM dispatch_jobs').get()!['n'], 0, 'no background job');
    } finally { await f.done(); }
  });
}
