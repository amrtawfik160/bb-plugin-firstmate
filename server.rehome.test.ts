// Fake-host drive of the three real re-home cases (REHOME-DECISIONS.md, 20 Oct): real Git in temporary
// repositories behind a fake `gh`. Reels: three diverged lines, worktrees partly gone, tasks recorded under
// the Cyndra SaaS repository. Cyndra SaaS UI: main + #2579, which holds #2574; both close once the
// workstream PR holds every commit. RunAnts: staging base, #1899 left out.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createOwnerTasks } from './lib/owner-tasks.ts';
import { stubProviderCatalog } from './test/provider-catalog.mjs';
import { manifestSkillIds } from './scripts/plugin-skill-fixture.mjs';
import { FIRSTMATE_ROUTINE_MARKER } from './lib/timeline-noise.ts';

type Row = Record<string, unknown>;
const skills = manifestSkillIds(new URL('.', import.meta.url).pathname);

// A fake gh: PR rows live in a JSON file; commits of a PR are read from its bare repository at call time.
const FAKE_GH = String.raw`#!/usr/bin/env node
const fs = require('node:fs'); const { execFileSync } = require('node:child_process');
const state = process.env.FM_FAKE_GH_STATE; const log = process.env.FM_FAKE_GH_LOG;
const args = process.argv.slice(2); fs.appendFileSync(log, JSON.stringify({ args, cwd: process.cwd() }) + '\n');
const db = JSON.parse(fs.readFileSync(state, 'utf8'));
const save = () => fs.writeFileSync(state, JSON.stringify(db));
const flag = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const find = (ref) => db.prs.find((pr) => pr.url === ref || String(pr.number) === String(ref));
const commitsOf = (pr) => execFileSync('git', ['--git-dir', pr.bare, 'rev-list', '--reverse', 'refs/heads/' + pr.head, '--not', pr.forkedFrom], { encoding: 'utf8' }).split('\n').filter(Boolean);
if (args[0] === 'pr' && args[1] === 'view') {
  const pr = find(args[2]); if (!pr) { console.error('no such PR'); process.exit(1); }
  const out = { url: pr.url, number: pr.number, state: pr.state, headRefName: pr.head, baseRefName: pr.base, commits: commitsOf(pr).map((oid) => ({ oid })) };
  console.log(JSON.stringify(out)); process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'list') {
  const head = flag('--head');
  console.log(JSON.stringify(db.prs.filter((pr) => pr.head === head && pr.created).map((pr) => ({ url: pr.url, state: pr.state, headRefOid: pr.headOid ?? '' })))); process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'create') {
  const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  const repo = origin.replace(/\.git$/, '').replace(/^.*github\.com[/:]/, '');
  const number = 9000 + db.prs.length;
  const url = 'https://github.com/' + repo + '/pull/' + number;
  db.prs.push({ url, number, state: 'OPEN', head: flag('--head'), base: flag('--base'), created: true, title: flag('--title') }); save();
  console.log(url); process.exit(0);
}
if (args[0] === 'pr' && args[1] === 'comment') { const pr = find(args[2]); pr.comments = [...(pr.comments ?? []), flag('--body')]; save(); process.exit(0); }
if (args[0] === 'pr' && args[1] === 'close') { const pr = find(args[2]); pr.state = 'CLOSED'; save(); process.exit(0); }
console.error('fake gh: unexpected ' + args.join(' ')); process.exit(1);
`;

function git(dir: string, ...args: string[]) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: gitEnv }).trim();
}
let gitEnv: NodeJS.ProcessEnv = process.env;
function commitAll(dir: string, message: string) { git(dir, 'add', '-A'); git(dir, 'commit', '-qm', message); return git(dir, 'rev-parse', 'HEAD'); }

async function world() {
  const dir = mkdtempSync(join(tmpdir(), 'fm-rehome-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH); chmodSync(join(bin, 'gh'), 0o755);
  const gitconfig = join(dir, 'gitconfig');
  writeFileSync(gitconfig, `[user]\n\tname = fixture\n\temail = fixture@test\n[url "${dir}/github.com/"]\n\tinsteadOf = https://github.com/\n[init]\n\tdefaultBranch = main\n[advice]\n\tdetachedHead = false\n`);
  const ghState = join(dir, 'gh.json'), ghLog = join(dir, 'gh.log');
  writeFileSync(ghState, JSON.stringify({ prs: [] })); writeFileSync(ghLog, '');
  gitEnv = { ...process.env, PATH: `${bin}:${process.env['PATH']}`, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1', HOME: dir, GIT_TERMINAL_PROMPT: '0', FM_FAKE_GH_STATE: ghState, FM_FAKE_GH_LOG: ghLog };
  delete gitEnv['BB_CLI'];
  const remote = (repo: string, base = 'main') => {
    const bare = join(dir, 'github.com', `${repo}.git`);
    mkdirSync(join(bare, '..'), { recursive: true });
    execFileSync('git', ['init', '--bare', '-q', '-b', base, bare], { env: gitEnv });
    return bare;
  };
  const clone = (repo: string, path: string) => { execFileSync('git', ['clone', '-q', `https://github.com/${repo}.git`, path], { env: gitEnv, stdio: 'pipe' }); return path; };
  const gh = {
    add: (pr: Row) => { const db = JSON.parse(readFileSync(ghState, 'utf8')); db.prs.push(pr); writeFileSync(ghState, JSON.stringify(db)); },
    prs: () => (JSON.parse(readFileSync(ghState, 'utf8')) as { prs: Row[] }).prs,
    calls: () => readFileSync(ghLog, 'utf8').split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { args: string[] }).args),
  };
  return { dir, remote, clone, gh };
}

type Spec = { status: string; envId?: string; archived?: boolean };

async function rehomeHost(w: Awaited<ReturnType<typeof world>>, projects: Array<{ id: string; name: string; source?: string }>) {
  const host = createFakePluginHost({ pluginId: 'firstmate', agentSkillIds: skills });
  await host.bb.storage.kv.set('captain-project:cap', projects[0]!.id);
  await plugin(host.bb); stubProviderCatalog(host);
  await host.harness.behavior.setSettings({ signInCheck: false, fmHome: '', maxActiveCrews: 0, fmReliability: JSON.stringify({ telegramThreading: 'on' }) });
  const threads = new Map<string, Spec>([['cap', { status: 'idle' }]]);
  const envs = new Map<string, { path: string; branch: string }>();
  const commands: string[] = [];
  const rpcs: Array<{ method: string; input: Row }> = [];
  const spawned: Row[] = [];
  const sent: string[] = [];
  host.harness.sdk.stub('threads.getPluginMetadata', async ({ threadId }: { threadId: string }) => (threadId === 'cap' ? { captain: 'true' } : {}));
  host.harness.sdk.stub('threads.get', async ({ threadId }: { threadId: string }) => {
    const spec = threads.get(threadId);
    if (!spec) throw new Error(`thread ${threadId} not found`);
    return { ...makeThreadResponse({ id: threadId, projectId: projects[0]!.id, status: spec.status as 'idle', ...(spec.envId ? { environmentId: spec.envId } : {}) }), archivedAt: spec.archived ? 1 : null, parentThreadId: threadId === 'cap' ? null : 'cap' };
  });
  host.harness.sdk.stub('threads.list', async () => []);
  host.harness.sdk.stub('threads.send', async ({ threadId, input }: { threadId: string; input: Array<{ text: string }> }) => { if (threadId === 'cap') sent.push(input.map((i) => i.text).join('\n')); return {}; });
  host.harness.sdk.stub('threadSections.list', async () => []);
  host.harness.sdk.stub('threadSections.create', async () => ({ id: 'sec' }));
  host.harness.sdk.stub('threads.defaultExecutionOptions', async () => ({ model: 'gpt-6.1-sol', reasoningLevel: 'high' }));
  host.harness.sdk.stub('threads.spawn', async (args: Row) => {
    spawned.push(args);
    const id = `thr_spawn${spawned.length}`;
    const env = args['environment'] as Row;
    const envId = env['type'] === 'reuse' ? String(env['environmentId']) : `env_spawn${spawned.length}`;
    if (env['type'] !== 'reuse') envs.set(envId, { path: String((env['workspace'] as Row)['path'] ?? ''), branch: '' });
    threads.set(id, { status: 'active', envId });
    return { id };
  });
  host.harness.sdk.stub('projects.list', async () => projects.map(({ id, name }) => ({ id, name })));
  host.harness.sdk.stub('projects.get', async ({ projectId }: { projectId: string }) => {
    const p = projects.find((row) => row.id === projectId)!;
    return { id: p.id, name: p.name, kind: 'repo', sources: p.source ? [{ hostId: 'h1', path: p.source, isDefault: true }] : [] };
  });
  host.harness.sdk.stub('environments.list', async ({ projectId }: { projectId?: string }) => {
    const p = projects.find((row) => row.id === projectId) ?? projects[0]!;
    return p.source ? [{ id: `env_src_${p.id}`, hostId: 'h1', path: p.source, status: 'ready', isWorktree: false }] : [];
  });
  host.harness.sdk.stub('environments.get', async ({ environmentId }: { environmentId: string }) => {
    const env = envs.get(environmentId);
    if (!env) throw new Error(`environment ${environmentId} not found`);
    return { id: environmentId, hostId: 'h1', path: env.path, status: 'ready', isWorktree: true, branchName: env.branch };
  });
  host.harness.sdk.stub('plugins.callRpc', async (args: { method: string; input: Row }) => { rpcs.push({ method: args.method, input: args.input }); return { ok: true, queued: 1, duplicate: false }; });
  host.harness.sdk.stub('hosts.exec', async ({ command }: { command: string }) => {
    commands.push(command);
    const run = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: gitEnv, cwd: w.dir, timeout: 60_000 });
    return { exitCode: run.status ?? 1, output: run.status === 0 ? run.stdout : `${run.stdout}${run.stderr}` };
  });
  const tasks = createOwnerTasks(host.bb.storage.database());
  const crews: Row[] = [];
  const crew = async (id: string, projectId: string, thread: string, spec: Spec, extra: Row = {}) => {
    threads.set(thread, spec);
    crews.push({ id, task: `work ${id}`, title: id, projectId, threadId: thread, parentThreadId: 'cap', nativeHome: '', worktree: true, shape: 'ship', posture: 'direct-PR', createdAt: '2026-10-19T00:00:00.000Z', providerId: 'codex', model: 'gpt-6.1-sol', reasoningLevel: null, ...extra });
    await host.bb.storage.kv.set('crews', crews);
  };
  const open = (title: string, project: { id: string; name: string }, crewId?: string) =>
    tasks.open({ captain: 'cap', project: project.name, projectId: project.id, title, sourceRefs: [`tg:42:${title}`], crewId, at: Date.now() });
  const tool = host.harness.inspection.registrations.agentTools.find((t) => t.name === 'firstmate_workstream')!;
  const call = (method: string, input: Row) => host.harness.behavior.callRpc(method as never, input as never) as Promise<Row>;
  return { host, threads, envs, commands, rpcs, spawned, sent, tasks, crew, open, tool, call };
}

/** Adopt through the owner card: the first call shows the card and touches nothing; the owner's Approve adopts. */
async function adoptByCard(h: Awaited<ReturnType<typeof rehomeHost>>, input: Row) {
  const before = h.commands.length;
  const first = await h.call('workstreams.adopt', { threadId: 'cap', ...input }) as { workstream?: Row; card?: { askId: string; state: string; text: string } };
  assert.equal(first.workstream, undefined, 'nothing is adopted before the owner approves');
  assert.ok(first.card, 'adopt shows the owner card first');
  assert.equal(first.card.state, 'open');
  assert.equal(h.commands.slice(before).some((c) => /worktree add|merge|commit|push/.test(c)), false, 'the card step changes nothing on the host');
  const asked = h.rpcs.filter((r) => r.method === 'ask' && r.input['askId'] === first.card!.askId);
  assert.equal(asked.length, 1, 'one owner card per workstream');
  // A repeat before the answer shows the same card again, without a second card.
  const repeat = await h.call('workstreams.adopt', { threadId: 'cap', ...input }) as { card?: { askId: string } };
  assert.equal(repeat.card?.askId, first.card.askId);
  assert.equal(h.rpcs.filter((r) => r.method === 'ask').length, h.rpcs.filter((r) => r.method === 'ask').length);
  const resolved = await h.call('resolveAsk', { threadId: 'cap', id: first.card.askId, resolution: 'Approve' }) as { ok: boolean };
  assert.equal(resolved.ok, true);
  const listed = await h.call('workstreams.list', { threadId: 'cap' }) as { workstreams: Array<Row & { id: string; name: string }> };
  const adopted = listed.workstreams.find((row) => row.name === input['name']);
  assert.ok(adopted, `the approved card adopts ${String(input['name'])}: ${h.sent.join(' | ')}`);
  return { card: first.card, workstream: adopted as any };
}

test('Reels app: three diverged pushed lines fold into a workstream of the re-pointed repository; a conflict goes to a new crew', async () => {
  const w = await world();
  const reelsRepo = 'amrtawfik160/reels-app';
  const cyndra = { id: 'cyndra', name: 'Cyndra SaaS', source: join(w.dir, 'src', 'agent-orchestrator') };
  try {
    // Cyndra SaaS, where the Reels tasks were recorded, and its crew worktrees.
    w.remote('Cyndra-AI/cyndra-saas');
    mkdirSync(join(w.dir, 'src'));
    const seedC = w.clone('Cyndra-AI/cyndra-saas', join(w.dir, 'seed-c'));
    writeFileSync(join(seedC, 'app.ts'), 'cyndra'); commitAll(seedC, 'cyndra base'); git(seedC, 'push', '-q', 'origin', 'HEAD:main');
    w.clone('Cyndra-AI/cyndra-saas', cyndra.source);
    // reels-app: one shared start, three diverged lines pushed by the repair thread.
    w.remote(reelsRepo);
    const seed = w.clone(reelsRepo, join(w.dir, 'seed-r'));
    writeFileSync(join(seed, 'scene.txt'), 'scene: base\n'); writeFileSync(join(seed, 'README.md'), 'reels\n'); commitAll(seed, 'shared start 11b7a9b'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
    const line = (branch: string, edit: () => void, count: number) => {
      git(seed, 'checkout', '-q', '-b', branch, 'origin/main');
      for (let i = 0; i < count; i++) { edit(); commitAll(seed, `${branch} ${i}`); }
      git(seed, 'push', '-q', 'origin', branch);
      return git(seed, 'rev-parse', 'HEAD');
    };
    const anim = line('fm/535abb3b', () => writeFileSync(join(seed, 'scene.txt'), 'scene: animated\n'), 1);
    let n = 0;
    const theme = line('fm/reels-theme-clr', () => { mkdirSync(join(seed, 'themes'), { recursive: true }); writeFileSync(join(seed, 'themes', `t${n++}.txt`), 'theme'); }, 3);
    let lit = 0;
    const lamp = line('fm/e9fe2c66', () => writeFileSync(join(seed, 'scene.txt'), `scene: lamp ${lit++}\n`), 2);
    const h = await rehomeHost(w, [cyndra]);
    try {
      // Crews ran in Cyndra worktrees: one archived, one idle and clean, one idle with unsaved Cyndra files.
      const lampTree = join(w.dir, 'wt-lamp');
      git(cyndra.source, 'worktree', 'add', '-q', '-b', 'fm/e9fe2c66', lampTree, 'origin/main');
      mkdirSync(join(lampTree, 'images')); writeFileSync(join(lampTree, 'images', 'a.png'), 'png');
      h.envs.set('env_lamp', { path: lampTree, branch: 'fm/e9fe2c66' });
      const clrTree = join(w.dir, 'wt-clr');
      git(cyndra.source, 'worktree', 'add', '-q', '-b', 'fm/reels-clr-c', clrTree, 'origin/main');
      h.envs.set('env_clr', { path: clrTree, branch: 'fm/reels-clr-c' });
      await h.crew('anim', 'cyndra', 'thr_anim', { status: 'idle', archived: true }, { branch: 'fm/535abb3b' });
      await h.crew('clr', 'cyndra', 'thr_clr', { status: 'idle', envId: 'env_clr' }, { environmentId: 'env_clr', branch: 'fm/reels-clr-c' });
      await h.crew('lamp', 'cyndra', 'thr_lamp', { status: 'idle', envId: 'env_lamp' }, { environmentId: 'env_lamp', branch: 'fm/e9fe2c66' });
      const tAnim = h.open('Reels animation line', cyndra, 'anim');
      const tTheme = h.open('Counter listicle theme', cyndra, 'clr');
      const tLamp = h.open('Fold lamp', cyndra, 'lamp');
      const { card, workstream } = await adoptByCard(h, {
        projectId: 'cyndra', name: 'Reels app', requestId: 'reels-app',
        taskIds: [tAnim.id, tTheme.id, tLamp.id],
        tasks: [
          { taskId: tAnim.id, repository: reelsRepo, branches: ['fm/535abb3b'] },
          { taskId: tTheme.id, repository: reelsRepo, branches: ['fm/reels-theme-clr'] },
          { taskId: tLamp.id, repository: reelsRepo, branches: ['fm/e9fe2c66'] },
        ],
      });
      assert.match(card.text, /moves from cyndra-ai\/cyndra-saas to amrtawfik160\/reels-app/i);
      for (const t of [tAnim, tTheme, tLamp]) assert.match(card.text, new RegExp(`${t.id} `));
      assert.deepEqual(workstream.repos.map((r: Row) => r['repository']), [reelsRepo]);
      const repo = workstream.repos[0];
      assert.equal(repo.base ?? 'main', 'main', 'a main base is not recorded');
      assert.equal(existsSync(join(repo.path, 'README.md')), true, 'the workstream worktree is a checkout of reels-app');
      const jobs = () => (h.call('workstreams.list', { threadId: 'cap' }) as Promise<any>).then((r) => r.workstreams.find((x: Row) => x['id'] === workstream.id).jobs as Array<Row & { id: string }>);
      const byTask = async (taskId: string) => (await jobs()).find((j) => j['taskId'] === taskId && !j['resolves'])!;
      assert.equal((await byTask(tAnim.id))['state'], 'folded');
      assert.equal((await byTask(tTheme.id))['state'], 'folded');
      assert.equal((await byTask(tAnim.id))['repointedFrom'], 'cyndra-ai/cyndra-saas');
      // The lamp line conflicts with the animation line: a new crew resolves it in the workstream worktree.
      const lampJob = await byTask(tLamp.id);
      assert.equal(lampJob['state'], 'finished');
      const resolver = (await jobs()).find((j) => j['resolves'] === lampJob.id)!;
      assert.ok(resolver, 'a conflict crew is queued');
      const resolverSpawn = h.spawned.find((s) => ((s['pluginMetadata'] as Row)['crewId']) === resolver.id)!;
      assert.ok(resolverSpawn, 'the conflict crew was spawned');
      assert.deepEqual((resolverSpawn['environment'] as Row)['workspace'], { type: 'unmanaged', path: repo.path });
      const brief = String(resolverSpawn['prompt']);
      assert.match(brief, new RegExp(lamp.slice(0, 12)));
      assert.match(brief, /Commit the merge here and do not push/);
      assert.doesNotMatch(brief, /Firstmate folds this branch/, 'the conflict crew is not briefed as a task crew');
      // The crew merges the lamp line by hand and finishes.
      git(repo.path, 'merge', '-q', '--no-edit', lamp, '--no-ff', '-X', 'theirs');
      for (const [id, spec] of h.threads) if (id.startsWith('thr_spawn')) h.threads.set(id, { ...spec, status: 'idle' });
      await h.host.harness.behavior.runSchedule('workstreams');
      assert.equal((await byTask(tLamp.id))['state'], 'folded');
      // All three lines are in the workstream branch; the Cyndra worktree with unsaved files was not touched.
      for (const sha of [anim, theme, lamp]) git(repo.path, 'merge-base', '--is-ancestor', sha, 'HEAD');
      assert.equal(readFileSync(join(lampTree, 'images', 'a.png'), 'utf8'), 'png');
      assert.match(git(lampTree, 'status', '--porcelain'), /images/);
      assert.equal(h.commands.some((c) => c.includes(lampTree) && /commit|push/.test(c)), false, 'another repository is never committed or pushed');
    } finally { await h.host.harness.lifecycle.dispose(); }
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('Cyndra SaaS UI: main + #2579 (which holds #2574); both close only when the workstream PR holds all their commits', async () => {
  const w = await world();
  const repoName = 'Cyndra-AI/cyndra-saas';
  const cyndra = { id: 'cyndra', name: 'Cyndra SaaS', source: join(w.dir, 'src', 'agent-orchestrator') };
  try {
    const bare = w.remote(repoName);
    mkdirSync(join(w.dir, 'src'));
    const seed = w.clone(repoName, join(w.dir, 'seed'));
    writeFileSync(join(seed, 'app.ts'), 'v1'); const forked = commitAll(seed, 'main'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
    // #2574 (worktree gone, branch pushed), then #2579 on top of it.
    git(seed, 'checkout', '-q', '-b', 'fm/f3a726e7');
    writeFileSync(join(seed, 'sky.ts'), 'sky'); commitAll(seed, 'sky backgrounds');
    writeFileSync(join(seed, 'viewer.ts'), 'glass'); commitAll(seed, 'glass viewer');
    git(seed, 'push', '-q', 'origin', 'fm/f3a726e7');
    w.clone(repoName, cyndra.source);
    const tree2579 = join(w.dir, 'wt-2579');
    git(cyndra.source, 'worktree', 'add', '-q', '-b', 'fm/0f2d6bce', tree2579, 'origin/fm/f3a726e7');
    writeFileSync(join(tree2579, 'chrome.ts'), 'chrome'); commitAll(tree2579, 'hide Ready to chat');
    git(tree2579, 'push', '-q', 'origin', 'fm/0f2d6bce');
    // Unsaved work on #2579's crew: saved as a backup commit before the fold.
    writeFileSync(join(tree2579, 'choices.ts'), 'restyled');
    w.gh.add({ url: `https://github.com/${repoName}/pull/2574`, number: 2574, state: 'OPEN', head: 'fm/f3a726e7', base: 'main', bare, forkedFrom: forked });
    w.gh.add({ url: `https://github.com/${repoName}/pull/2579`, number: 2579, state: 'OPEN', head: 'fm/0f2d6bce', base: 'main', bare, forkedFrom: forked });
    w.gh.add({ url: `https://github.com/${repoName}/pull/2572`, number: 2572, state: 'MERGED', head: 'fm/a7245f97', base: 'main', bare, forkedFrom: forked });
    const h = await rehomeHost(w, [cyndra]);
    try {
      h.envs.set('env_2579', { path: tree2579, branch: 'fm/0f2d6bce' });
      await h.crew('c2574', 'cyndra', 'thr_2574', { status: 'idle', archived: true }, { branch: 'fm/f3a726e7', prUrl: `https://github.com/${repoName}/pull/2574` });
      await h.crew('c2579', 'cyndra', 'thr_2579', { status: 'idle', envId: 'env_2579' }, { environmentId: 'env_2579', branch: 'fm/0f2d6bce', prUrl: `https://github.com/${repoName}/pull/2579` });
      const t2574 = h.open('Sky backgrounds and glass viewer', cyndra, 'c2574');
      const t2579 = h.open('Chat chrome', cyndra, 'c2579');
      h.tasks.linkPr(t2574.id, 'cap', `https://github.com/${repoName}/pull/2574`, Date.now());
      h.tasks.linkPr(t2579.id, 'cap', `https://github.com/${repoName}/pull/2579`, Date.now());
      const replaces = [`https://github.com/${repoName}/pull/2574`, `https://github.com/${repoName}/pull/2579`];
      const { card, workstream } = await adoptByCard(h, { projectId: 'cyndra', name: 'Cyndra SaaS UI', requestId: 'cyndra-ui', taskIds: [t2574.id, t2579.id], replacesPrs: replaces });
      assert.match(card.text, /#2574/); assert.match(card.text, /#2579/);
      const repo = workstream.repos[0];
      const states = Object.fromEntries((workstream.jobs as Row[]).map((j) => [j['taskId'], j['state']]));
      assert.deepEqual(states, { [t2574.id]: 'folded', [t2579.id]: 'folded' });
      assert.equal(git(tree2579, 'log', '-1', '--format=%s').startsWith('Backup of unsaved work'), true);
      assert.equal(git(tree2579, 'status', '--porcelain'), '');
      assert.equal(readFileSync(join(repo.path, 'choices.ts'), 'utf8'), 'restyled', 'the backup commit is in the workstream branch');
      assert.equal(git(tree2579, 'rev-list', '--count', 'HEAD', '--not', '--remotes'), '0', 'the backup commit is pushed, so the old worktree can be retired');
      // Someone adds a commit to #2579 after the fold: Ship closes #2574, keeps #2579 open.
      const extra = join(w.dir, 'extra');
      w.clone(repoName, extra);
      git(extra, 'checkout', '-q', 'fm/0f2d6bce'); writeFileSync(join(extra, 'late.ts'), 'late'); commitAll(extra, 'late fix'); git(extra, 'push', '-q', 'origin', 'fm/0f2d6bce');
      await h.call('workstreams.ship', { threadId: 'cap', workstreamId: workstream.id, requestId: 'ship-1' }).catch(() => {});
      const pr = (n: number) => w.gh.prs().find((row) => row['number'] === n)!;
      const wsPr = w.gh.prs().find((row) => row['created'])!;
      assert.ok(wsPr, 'Ship opened the workstream PR');
      assert.equal(wsPr['base'], 'main');
      assert.equal(pr(2574)['state'], 'CLOSED');
      assert.match(String((pr(2574)['comments'] as string[])[0]), new RegExp(String(wsPr['url'])));
      assert.equal(pr(2579)['state'], 'OPEN', 'a PR with a commit outside the workstream PR is never closed');
      assert.equal(pr(2572)['state'], 'MERGED');
      // The late commit is removed again: the next Ship closes #2579 too.
      git(extra, 'push', '-q', '--force', 'origin', `${git(extra, 'rev-parse', 'HEAD~1')}:refs/heads/fm/0f2d6bce`);
      await h.call('workstreams.ship', { threadId: 'cap', workstreamId: workstream.id, requestId: 'ship-1' }).catch(() => {});
      assert.equal(pr(2579)['state'], 'CLOSED');
      assert.equal(w.gh.calls().filter((args) => args[1] === 'close').length, 2, 'each replaced PR is closed once');
    } finally { await h.host.harness.lifecycle.dispose(); }
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('RunAnts UI: the workstream starts from staging, Ship targets staging, and #1899 stays out', async () => {
  const w = await world();
  const repoName = 'HazW80801/runants';
  const runants = { id: 'runants', name: 'Runants', source: join(w.dir, 'src', 'runants') };
  try {
    w.remote(repoName, 'staging');
    mkdirSync(join(w.dir, 'src'));
    const seed = w.clone(repoName, join(w.dir, 'seed'));
    git(seed, 'checkout', '-q', '-b', 'staging');
    writeFileSync(join(seed, 'app.tsx'), 'app'); commitAll(seed, 'base'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
    writeFileSync(join(seed, 'staging.tsx'), 'staging only'); commitAll(seed, 'staging work'); git(seed, 'push', '-q', 'origin', 'HEAD:staging');
    w.clone(repoName, runants.source);
    const t361Tree = join(w.dir, 'wt-361'), t1899Tree = join(w.dir, 'wt-1899');
    git(runants.source, 'worktree', 'add', '-q', '-b', 'fm/361', t361Tree, 'origin/staging');
    writeFileSync(join(t361Tree, 'planes.tsx'), 'planes'); commitAll(t361Tree, 'T361 planes');
    git(runants.source, 'worktree', 'add', '-q', '-b', 'fm/86b937f4', t1899Tree, 'origin/staging');
    writeFileSync(join(t1899Tree, 'sidebar.tsx'), 'uncommitted sidebar');
    const h = await rehomeHost(w, [runants]);
    try {
      h.envs.set('env_361', { path: t361Tree, branch: 'fm/361' });
      h.envs.set('env_1899', { path: t1899Tree, branch: 'fm/86b937f4' });
      await h.crew('r361', 'runants', 'thr_361', { status: 'idle', envId: 'env_361' }, { environmentId: 'env_361', branch: 'fm/361' });
      await h.crew('r1899', 'runants', 'thr_1899', { status: 'active', envId: 'env_1899' }, { environmentId: 'env_1899', branch: 'fm/86b937f4', prUrl: `https://github.com/${repoName}/pull/1899` });
      const t361 = h.open('T361 Planes gutters', runants, 'r361');
      const t1899 = h.open('Labeled sidebar (#1899)', runants, 'r1899');
      const { workstream } = await adoptByCard(h, { projectId: 'runants', name: 'RunAnts UI', requestId: 'runants-ui', taskIds: [t361.id] });
      const repo = workstream.repos[0];
      assert.equal(repo.base, 'staging');
      assert.equal(existsSync(join(repo.path, 'staging.tsx')), true, 'the workstream branch starts from staging');
      assert.equal(existsSync(join(repo.path, 'planes.tsx')), true);
      assert.deepEqual(workstream.taskIds, [t361.id]);
      assert.equal(h.commands.some((c) => c.includes(t1899Tree)), false, '#1899 is left alone');
      assert.equal(readFileSync(join(t1899Tree, 'sidebar.tsx'), 'utf8'), 'uncommitted sidebar');
      assert.equal(h.tasks.get(t1899.id)!.state, 'working');
      await h.call('workstreams.ship', { threadId: 'cap', workstreamId: workstream.id, requestId: 'ship' }).catch(() => {});
      const create = w.gh.calls().find((args) => args[1] === 'create')!;
      assert.equal(create[create.indexOf('--base') + 1], 'staging');
      assert.equal(w.gh.calls().some((args) => args[1] === 'list' && args.includes('main')), false, 'Ship never looks at main for RunAnts');
    } finally { await h.host.harness.lifecycle.dispose(); }
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('the captain proposes groups per project, workstreams work in every project, and a gone topic is replaced', async () => {
  const w = await world();
  try {
    const h = await rehomeHost(w, [{ id: 'cyndra', name: 'Cyndra SaaS' }, { id: 'safi', name: 'Safi' }]);
    try {
      await h.crew('s1', 'safi', 'thr_s1', { status: 'idle' });
      const safiTask = h.open('Safi onboarding', { id: 'safi', name: 'Safi' }, 's1');
      const raw = String(await h.tool.execute({ action: 'propose' }, { threadId: 'cap', projectId: 'cyndra' } as never));
      const proposed = JSON.parse(raw.endsWith(FIRSTMATE_ROUTINE_MARKER) ? raw.slice(0, -FIRSTMATE_ROUTINE_MARKER.length) : raw) as { groups: Array<{ projectId: string; taskIds: string[] }>; text: string };
      assert.deepEqual(proposed.groups.map((g) => [g.projectId, g.taskIds]), [['safi', [safiTask.id]]]);
      assert.match(proposed.text, /adopt/);
      const listed = await h.call('workstreams.list', { threadId: 'cap' }) as { trialProjectIds: string[] };
      assert.deepEqual(listed.trialProjectIds.sort(), ['cyndra', 'safi'], 'workstreams are allowed in every project');
      // A workstream whose topic is gone takes a new one; a live topic still refuses.
      const db = h.host.bb.storage.database();
      db.exec('CREATE TABLE IF NOT EXISTS firstmate_workstream (id TEXT PRIMARY KEY, record TEXT NOT NULL)');
      const record = { id: 'ws-topic', name: 'Topic', projectId: 'safi', threadId: 'cap', requestId: 'topic', state: 'open', supportsDevLink: false, provisioned: true, topic: { chatId: '42', topicId: 5 }, repos: [], taskIds: [], jobs: [], devLink: { state: 'stopped', port: 5300, realLogin: false }, closeTopicRequested: false, ship: { state: 'idle' }, createdAt: 1, updatedAt: 1 };
      db.prepare('INSERT INTO firstmate_workstream (id,record) VALUES (?,?)').run(record.id, JSON.stringify(record));
      await assert.rejects(h.call('workstreams.bindTopic', { threadId: 'cap', workstreamId: 'ws-topic', chatId: '42', topicId: 6 }), /already has a topic/);
      const replaced = await h.call('workstreams.bindTopic', { threadId: 'cap', workstreamId: 'ws-topic', chatId: '42', topicId: 6, goneTopicId: 5 }) as { workstream: Row };
      assert.deepEqual(replaced.workstream['topic'], { chatId: '42', topicId: 6 });
    } finally { await h.host.harness.lifecycle.dispose(); }
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

// Check round 1 of PR #182 (VERDICT-REHOME-FM-1.md): the checker's probes, each defect assertion stating the safe outcome.
async function probeWorld() {
  const w = await world();
  const repository = 'Cyndra-AI/cyndra-saas';
  const project = { id: 'cyndra', name: 'Cyndra SaaS', source: join(w.dir, 'src', 'cyndra') };
  w.remote(repository); mkdirSync(join(w.dir, 'src'));
  const seed = w.clone(repository, join(w.dir, 'seed'));
  writeFileSync(join(seed, 'base.txt'), 'base\n'); commitAll(seed, 'base'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
  w.clone(repository, project.source);
  const h = await rehomeHost(w, [project]);
  const add = async (id: string, status = 'idle', conflict?: string) => {
    const tree = join(w.dir, id);
    const branch = `fm/${id}`;
    git(project.source, 'worktree', 'add', '-q', '-b', branch, tree, 'origin/main');
    writeFileSync(join(tree, conflict ? 'base.txt' : `${id}.txt`), conflict ?? id);
    commitAll(tree, id); git(tree, 'push', '-q', 'origin', branch);
    h.envs.set(`env_${id}`, { path: tree, branch });
    await h.crew(id, project.id, `thr_${id}`, { status, envId: `env_${id}` }, { branch, environmentId: `env_${id}` });
    const task = h.open(id, project, id);
    return { tree, branch, task, head: git(tree, 'rev-parse', 'HEAD') };
  };
  const done = async () => { await h.host.harness.lifecycle.dispose(); rmSync(w.dir, { recursive: true, force: true }); };
  return { w, h, add, done, repository, project };
}

test('check round 1: a named pushed branch keeps its crew worktree as the source and folds its unsaved files', async () => {
  const p = await probeWorld();
  try {
    const a = await p.add('a');
    writeFileSync(join(a.tree, 'unsaved.txt'), 'owner work');
    const { workstream } = await adoptByCard(p.h, { projectId: p.project.id, name: 'Explicit branch', requestId: 'explicit', taskIds: [a.task.id], tasks: [{ taskId: a.task.id, branches: [a.branch] }] });
    assert.equal(existsSync(join(workstream.repos[0].path, 'unsaved.txt')), true, 'all unsaved crew work must be backed up and folded');
  } finally { await p.done(); }
});

test('check round 1: a retry cannot fold an extra branch that the owner never approved', async () => {
  const p = await probeWorld();
  try {
    const a = await p.add('a');
    const input = { projectId: p.project.id, name: 'Retry', requestId: 'retry', taskIds: [a.task.id], tasks: [{ taskId: a.task.id, branches: [a.branch] }] };
    const { workstream } = await adoptByCard(p.h, input);
    const extra = join(p.w.dir, 'extra');
    git(p.project.source, 'worktree', 'add', '-q', '-b', 'fm/unapproved', extra, 'origin/main');
    writeFileSync(join(extra, 'unapproved.txt'), 'extra work'); commitAll(extra, 'unapproved'); git(extra, 'push', '-q', 'origin', 'fm/unapproved');
    await p.h.call('workstreams.adopt', { threadId: 'cap', ...input, tasks: [{ taskId: a.task.id, branches: [a.branch, 'fm/unapproved'] }] }).catch(() => ({}));
    assert.equal(existsSync(join(workstream.repos[0].path, 'unapproved.txt')), false, 'changed branch list must require new approval or be refused');
  } finally { await p.done(); }
});

test('check round 1: a crew that resumes during provisioning gets no backup commit while it runs', async () => {
  const p = await probeWorld();
  try {
    const a = await p.add('a');
    writeFileSync(join(a.tree, 'in-progress.txt'), 'still editing');
    let resumed = false;
    p.h.host.harness.sdk.stub('hosts.exec', async ({ command }: { command: string }) => {
      p.h.commands.push(command);
      if (command.includes('git worktree add')) { resumed = true; p.h.threads.set('thr_a', { status: 'active', envId: 'env_a' }); }
      const run = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: gitEnv, cwd: p.w.dir, timeout: 60_000 });
      return { exitCode: run.status ?? 1, output: run.status === 0 ? run.stdout : `${run.stdout}${run.stderr}` };
    });
    await adoptByCard(p.h, { projectId: p.project.id, name: 'Resume', requestId: 'resume', taskIds: [a.task.id] });
    assert.ok(resumed);
    assert.equal(git(a.tree, 'rev-parse', 'HEAD'), a.head, 'must hold lifecycle lock and re-read crew status before committing in its worktree');
  } finally { await p.done(); }
});

test('check round 1: a later finished crew does not fold into the worktree of a running conflict crew', async () => {
  const p = await probeWorld();
  try {
    const a = await p.add('a', 'idle', 'change a\n');
    const b = await p.add('b', 'idle', 'change b\n');
    const c = await p.add('c', 'active');
    const { workstream } = await adoptByCard(p.h, { projectId: p.project.id, name: 'Resolver active', requestId: 'resolver', taskIds: [a.task.id, b.task.id, c.task.id] });
    const repo = workstream.repos[0];
    const resolver = workstream.jobs.find((j: Row) => j['resolves']);
    assert.ok(resolver); assert.equal(resolver.state, 'running');
    const before = git(repo.path, 'rev-parse', 'HEAD');
    p.h.threads.set('thr_c', { status: 'idle', envId: 'env_c' });
    await p.h.host.harness.behavior.runSchedule('workstreams');
    const after = git(repo.path, 'rev-parse', 'HEAD');
    assert.equal(after, before, 'running resolver exclusively owns its workstream worktree');
  } finally { await p.done(); }
});

// Changed in check round 2 (allowed assertion change): an erroring adopted crew no longer folds while in error.
// It folds once idle, and that fold holds the work it committed while recovering.
test('check round 1: a running adopted crew whose thread ends in error folds its saved work only once idle, recovery work included', async () => {
  const p = await probeWorld();
  try {
    const a = await p.add('a', 'active');
    const { workstream } = await adoptByCard(p.h, { projectId: p.project.id, name: 'Error end', requestId: 'error', taskIds: [a.task.id] });
    p.h.threads.set('thr_a', { status: 'error', envId: 'env_a' });
    await p.h.host.harness.behavior.runSchedule('workstreams');
    const job = async () => ((await p.h.call('workstreams.list', { threadId: 'cap' }) as any).workstreams.find((w: Row) => w['id'] === workstream.id).jobs[0]);
    assert.notEqual((await job()).state, 'folded', 'an erroring adopted source must wait until idle');
    writeFileSync(join(a.tree, 'recovered.txt'), 'recovered'); commitAll(a.tree, 'recovered turn');
    p.h.threads.set('thr_a', { status: 'idle', envId: 'env_a' });
    await p.h.host.harness.behavior.runSchedule('workstreams');
    assert.equal((await job()).state, 'folded', 'an ended adopted crew saved work must not be stranded');
    assert.equal(existsSync(join(workstream.repos[0].path, 'recovered.txt')), true, 'work committed during recovery is in the fold');
  } finally { await p.done(); }
});

test('check round 1: an adopted crew that recovers from an error and finishes still folds its saved work', async () => {
  const p = await probeWorld();
  try {
    const a = await p.add('a', 'active');
    const { workstream } = await adoptByCard(p.h, { projectId: p.project.id, name: 'Error end', requestId: 'error', taskIds: [a.task.id] });
    p.h.threads.set('thr_a', { status: 'error', envId: 'env_a' });
    await p.h.host.harness.behavior.runSchedule('workstreams');
    p.h.threads.set('thr_a', { status: 'idle', envId: 'env_a' });
    await p.h.host.harness.behavior.runSchedule('workstreams');
    const rows = await p.h.call('workstreams.list', { threadId: 'cap' }) as any;
    const actual = rows.workstreams.find((w: Row) => w['id'] === workstream.id);
    assert.equal(actual.jobs[0].state, 'folded', 'an ended adopted crew saved work must not be stranded');
  } finally { await p.done(); }
});

// Check round 2 of PR #182 (VERDICT-REHOME-FM-2.md): the checker's probes, each stating the safe outcome.
test('check round 2: a recoverable error waits for idle and the fold includes the recovery work', async () => {
  const p = await probeWorld();
  try {
    const a = await p.add('a', 'active');
    const { workstream } = await adoptByCard(p.h, { projectId: p.project.id, name: 'Recover', requestId: 'recover', taskIds: [a.task.id] });
    writeFileSync(join(a.tree, 'partial.txt'), 'partial');
    p.h.threads.set('thr_a', { status: 'error', envId: 'env_a' }); await p.h.host.harness.behavior.runSchedule('workstreams');
    const rows1 = await p.h.call('workstreams.list', { threadId: 'cap' }) as any;
    const foldedAtError = rows1.workstreams[0].jobs[0].state === 'folded';
    p.h.threads.set('thr_a', { status: 'active', envId: 'env_a' }); writeFileSync(join(a.tree, 'recovered.txt'), 'recovered'); commitAll(a.tree, 'recovered turn');
    await p.h.host.harness.behavior.runSchedule('workstreams');
    p.h.threads.set('thr_a', { status: 'idle', envId: 'env_a' }); await p.h.host.harness.behavior.runSchedule('workstreams');
    assert.equal(existsSync(join(workstream.repos[0].path, 'recovered.txt')), true, 'recovered source work must enter the fold after idle');
    assert.equal(foldedAtError, false, 'an erroring adopted source must wait until idle');
  } finally { await p.done(); }
});

test('check round 2: a conflict crew whose turn ended but whose background command runs keeps the workstream worktree', async () => {
  const p = await probeWorld();
  try {
    const a = await p.add('a', 'idle', 'change a\n'); const b = await p.add('b', 'idle', 'change b\n'); const c = await p.add('c', 'active');
    const { workstream } = await adoptByCard(p.h, { projectId: p.project.id, name: 'Background resolver', requestId: 'bg-resolver', taskIds: [a.task.id, b.task.id, c.task.id] });
    const repo = workstream.repos[0], resolver = workstream.jobs.find((j: Row) => j['resolves']); assert.equal(resolver.state, 'running');
    p.h.threads.set('thr_c', { status: 'idle', envId: 'env_c' }); p.h.threads.set(resolver.threadId, { status: 'idle', envId: p.h.threads.get(resolver.threadId)?.envId });
    p.h.host.harness.sdk.stub('threads.get', async ({ threadId }: { threadId: string }) => {
      const spec = p.h.threads.get(threadId); if (!spec) throw new Error('fixture missing');
      return { ...makeThreadResponse({ id: threadId, projectId: p.project.id, status: spec.status as 'idle', ...(spec.envId ? { environmentId: spec.envId } : {}) }), archivedAt: spec.archived ? 1 : null, parentThreadId: threadId === 'cap' ? null : 'cap', activity: threadId === resolver.threadId ? { activeBackgroundCommandCount: 1 } : undefined };
    });
    const before = git(repo.path, 'rev-parse', 'HEAD'); await p.h.host.harness.behavior.runSchedule('workstreams'); const after = git(repo.path, 'rev-parse', 'HEAD');
    assert.equal(after, before, 'running background command still owns resolver worktree');
  } finally { await p.done(); }
});

// Gaps found on first live use (BUILD-ADOPT-GAPS.md, 20 Oct): T361 and T366 had no recorded project and were
// refused; RunAnts (default branch staging) must start from staging and every adopt text must say so.
async function runantsWorld() {
  const w = await world();
  const repoName = 'HazW80801/runants';
  const runants = { id: 'runants', name: 'RunAnts', source: join(w.dir, 'src', 'runants') };
  const cyndra = { id: 'cyndra', name: 'Cyndra SaaS' };
  w.remote(repoName, 'staging');
  mkdirSync(join(w.dir, 'src'));
  const seed = w.clone(repoName, join(w.dir, 'seed'));
  git(seed, 'checkout', '-q', '-b', 'staging');
  writeFileSync(join(seed, 'app.tsx'), 'app'); commitAll(seed, 'base'); git(seed, 'push', '-q', 'origin', 'HEAD:main');
  writeFileSync(join(seed, 'staging.tsx'), 'staging only'); commitAll(seed, 'staging work'); git(seed, 'push', '-q', 'origin', 'HEAD:staging');
  w.clone(repoName, runants.source);
  const tree = join(w.dir, 'wt-361');
  git(runants.source, 'worktree', 'add', '-q', '-b', 'fm/361', tree, 'origin/staging');
  writeFileSync(join(tree, 'planes.tsx'), 'planes'); commitAll(tree, 'T361 planes');
  const h = await rehomeHost(w, [runants, cyndra]);
  h.envs.set('env_361', { path: tree, branch: 'fm/361' });
  await h.crew('r361', 'runants', 'thr_361', { status: 'idle', envId: 'env_361' }, { environmentId: 'env_361', branch: 'fm/361' });
  // As the live T361: no project and no project id recorded.
  const t361 = h.tasks.open({ captain: 'cap', project: null, projectId: null, title: 'Planes gutters', sourceRefs: ['tg:42:361'], crewId: 'r361', at: Date.now() });
  const done = async () => { await h.host.harness.lifecycle.dispose(); rmSync(w.dir, { recursive: true, force: true }); };
  return { w, h, runants, cyndra, tree, t361, done };
}

test('adopt gaps: a task with no recorded project joins the requested project; the card names it and Approve records it', async () => {
  const r = await runantsWorld();
  try {
    const other = r.h.open('Cyndra banner', r.cyndra);
    await assert.rejects(
      r.h.call('workstreams.adopt', { threadId: 'cap', projectId: 'runants', name: 'RunAnts UI', requestId: 'mixed', taskIds: [r.t361.id, other.id] }),
      new RegExp(`Task ${other.id} belongs to another project\\.`),
    );
    assert.equal(r.h.rpcs.some((x) => x.method === 'ask'), false, 'a refusal comes before any card');
    const { card, workstream } = await adoptByCard(r.h, { projectId: 'runants', name: 'RunAnts UI', requestId: 'runants-ui', taskIds: [r.t361.id] });
    assert.match(card.text, new RegExp(`${r.t361.id} Planes gutters: .*no project recorded, joins project RunAnts`));
    assert.deepEqual(workstream.taskIds, [r.t361.id]);
    const task = r.h.tasks.get(r.t361.id)!;
    assert.equal(task.projectId, 'runants', 'Approve records the project on the task');
    assert.equal(task.project, 'RunAnts');
    assert.equal(r.h.tasks.get(other.id)!.projectId, 'cyndra');
    assert.equal(existsSync(join(workstream.repos[0].path, 'planes.tsx')), true, 'its saved work folds');
  } finally { await r.done(); }
});

test('adopt gaps: in a staging repository the card, the adopt result and a task crew brief name staging; the base is read once, at the card', async () => {
  const r = await runantsWorld();
  try {
    const reads = () => r.h.commands.filter((c) => c.includes('ls-remote')).length;
    const first = await r.h.call('workstreams.adopt', { threadId: 'cap', projectId: 'runants', name: 'RunAnts UI', requestId: 'runants-ui', taskIds: [r.t361.id] }) as { card: { askId: string; text: string } };
    assert.match(first.card.text, /a new branch from staging and one dev link/);
    assert.doesNotMatch(first.card.text, /from main/);
    assert.equal(reads(), 1, 'the card reads the base once');
    await r.h.call('resolveAsk', { threadId: 'cap', id: first.card.askId, resolution: 'Approve' });
    assert.equal(reads(), 1, 'Approve uses the base the card showed');
    const listed = await r.h.call('workstreams.list', { threadId: 'cap' }) as { workstreams: Array<Row & { id: string; repos: Array<{ base?: string; path: string }> }> };
    const ws = listed.workstreams[0]!;
    assert.equal(ws.repos[0]!.base, 'staging');
    assert.equal(existsSync(join(ws.repos[0]!.path, 'staging.tsx')), true, 'the workstream branch starts from staging');
    const result = r.h.sent.find((text) => text.startsWith('WORKSTREAM ADOPTED'));
    assert.ok(result, r.h.sent.join(' | '));
    assert.match(result, /from staging/);
    assert.doesNotMatch(result, /from main/);
    // A new task crew in the workstream is told that Ship merges the workstream branch into staging.
    const dispatch = r.h.host.harness.inspection.registrations.agentTools.find((t) => t.name === 'firstmate_dispatch')!;
    await dispatch.execute({ task: 'Tighten the planes gutters', taskId: 'gutters-2', workstreamId: ws.id, origin: { kind: 'captain', reason: 'owner follow-up' }, providerId: 'codex', model: 'gpt-6.1-sol' }, { threadId: 'cap', projectId: 'runants' } as never);
    await r.h.host.harness.behavior.runSchedule('workstreams');
    const brief = r.h.spawned.map((s) => JSON.stringify(s)).find((s) => s.includes('Tighten the planes gutters'));
    assert.ok(brief, 'the task crew started');
    assert.match(brief, /merge the workstream branch to staging/);
    assert.doesNotMatch(brief, /workstream branch to main/);
  } finally { await r.done(); }
});

test('adopt gaps: a default branch that cannot be read refuses the adopt before any card; it never falls back to main', async () => {
  const r = await runantsWorld();
  try {
    r.h.host.harness.sdk.stub('hosts.exec', async ({ command }: { command: string }) => {
      r.h.commands.push(command);
      if (command.includes('ls-remote')) return { exitCode: 128, output: 'fatal: Could not read from remote repository.' };
      const run = spawnSync('bash', ['-c', command], { encoding: 'utf8', env: gitEnv, cwd: r.w.dir, timeout: 60_000 });
      return { exitCode: run.status ?? 1, output: run.status === 0 ? run.stdout : `${run.stdout}${run.stderr}` };
    });
    await assert.rejects(
      r.h.call('workstreams.adopt', { threadId: 'cap', projectId: 'runants', name: 'RunAnts UI', requestId: 'runants-ui', taskIds: [r.t361.id] }),
      /Cannot read the default branch of hazw80801\/runants/i,
    );
    assert.equal(r.h.rpcs.some((x) => x.method === 'ask'), false, 'no card is shown');
    assert.equal(r.h.tasks.get(r.t361.id)!.projectId, null);
  } finally { await r.done(); }
});

test('adopt gaps: create saves the real base on the repository record; a main repository records main', async () => {
  const r = await runantsWorld();
  try {
    const created = await r.h.call('workstreams.create', { threadId: 'cap', projectId: 'runants', name: 'RunAnts next', requestId: 'runants-next' }) as { workstream: { repos: Array<{ base?: string; path: string }> } };
    assert.equal(created.workstream.repos[0]!.base, 'staging');
    assert.equal(existsSync(join(created.workstream.repos[0]!.path, 'staging.tsx')), true);
  } finally { await r.done(); }
  const p = await probeWorld();
  try {
    const created = await p.h.call('workstreams.create', { threadId: 'cap', projectId: p.project.id, name: 'Cyndra next', requestId: 'cyndra-next' }) as { workstream: { repos: Array<{ base?: string }> } };
    assert.equal(created.workstream.repos[0]!.base, 'main', 'the base is saved even when it is main');
  } finally { await p.done(); }
});

test('adopt gaps: a bind refusal carries a stable reason in the result when the caller asks for it; the error text is unchanged', async () => {
  const w = await world();
  try {
    const h = await rehomeHost(w, [{ id: 'safi', name: 'Safi' }]);
    try {
      const db = h.host.bb.storage.database();
      db.exec('CREATE TABLE IF NOT EXISTS firstmate_workstream (id TEXT PRIMARY KEY, record TEXT NOT NULL)');
      const record = (id: string, topic?: { chatId: string; topicId: number }) => ({ id, name: id, projectId: 'safi', threadId: 'cap', requestId: id, state: 'open', supportsDevLink: false, provisioned: true, ...(topic ? { topic } : {}), repos: [], taskIds: [], jobs: [], devLink: { state: 'stopped', port: id === 'ws-a' ? 5300 : 5301, realLogin: false }, closeTopicRequested: false, ship: { state: 'idle' }, createdAt: 1, updatedAt: 1 });
      for (const row of [record('ws-a', { chatId: '42', topicId: 5 }), record('ws-b')]) db.prepare('INSERT INTO firstmate_workstream (id,record) VALUES (?,?)').run(row.id, JSON.stringify(row));
      // A caller that does not ask still gets the same errors.
      await assert.rejects(h.call('workstreams.bindTopic', { threadId: 'cap', workstreamId: 'ws-a', chatId: '42', topicId: 6 }), /Workstream already has a topic\./);
      await assert.rejects(h.call('workstreams.bindTopic', { threadId: 'cap', workstreamId: 'ws-b', chatId: '42', topicId: 5 }), /Topic already belongs to a workstream\./);
      const has = await h.call('workstreams.bindTopic', { threadId: 'cap', workstreamId: 'ws-a', chatId: '42', topicId: 6, structuredRefusal: true }) as { workstream: Row; refused?: Row };
      assert.deepEqual(has.refused, { reason: 'workstream_has_topic', message: 'Workstream already has a topic.' });
      assert.deepEqual(has.workstream['topic'], { chatId: '42', topicId: 5 }, 'the recorded topic is kept');
      const used = await h.call('workstreams.bindTopic', { threadId: 'cap', workstreamId: 'ws-b', chatId: '42', topicId: 5, structuredRefusal: true }) as { workstream: Row; refused?: Row };
      assert.deepEqual(used.refused, { reason: 'topic_in_use', message: 'Topic already belongs to a workstream.' });
      assert.equal(used.workstream['topic'], undefined);
      const bound = await h.call('workstreams.bindTopic', { threadId: 'cap', workstreamId: 'ws-b', chatId: '42', topicId: 7, structuredRefusal: true }) as { workstream: Row; refused?: Row };
      assert.equal(bound.refused, undefined);
      assert.deepEqual(bound.workstream['topic'], { chatId: '42', topicId: 7 });
    } finally { await h.host.harness.lifecycle.dispose(); }
  } finally { rmSync(w.dir, { recursive: true, force: true }); }
});

test('adopt gaps: a captain with no host reads the base on the host of a task crew checkout; the card names staging', async () => {
  const r = await runantsWorld();
  try {
    // Neither the captain thread nor the project has a ready environment; the crew's checkout is on h1.
    r.h.host.harness.sdk.stub('environments.list', async () => []);
    const first = await r.h.call('workstreams.adopt', { threadId: 'cap', projectId: 'runants', name: 'RunAnts UI', requestId: 'runants-ui', taskIds: [r.t361.id] }) as { card: { text: string } };
    assert.match(first.card.text, /a new branch from staging/);
  } finally { await r.done(); }
});
