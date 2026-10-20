// Adopt with fold: the owner card, saved work, pushed branches, conflict crews, replaced PRs and topic replace.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  adoptCardText, prBaseFromLsRemote, proposeWorkstreams, replacedPrVerdict, resolverBrief, RESOLVE_UNSAFE,
  parseSavedWork, parseContained, type AdoptSource,
} from './workstream-adopt.ts';
import { provisionScript, takeMainScript, unshippedScript, saveWorkScript, foldBranchPlanScript, prContainsScript, prBaseScript, foldScript } from './workstream-runtime.ts';
import { foldValue, parseFoldOutput, isAdoptedWorkstream } from './workstream-fold.ts';
import { createWorkstreams, type WorkstreamDeps, type FoldOps } from './workstreams.ts';

const git = (dir: string, ...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const commit = (dir: string, message = 'work') => { git(dir, 'add', '-A'); git(dir, '-c', 'user.name=fixture', '-c', 'user.email=fixture@test', 'commit', '-qm', message); };
const bash = (script: string) => execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const source = (over: Partial<AdoptSource> & Pick<AdoptSource, 'taskId' | 'crewId' | 'branch'>): AdoptSource => ({
  threadId: `thr_${over.crewId}`, repository: 'cyndra-ai/app', from: 'worktree', running: false,
  path: `/wt/${over.crewId}`, environmentId: `env_${over.crewId}`, hostId: 'h1', ...over,
});

test('the owner card lists every task once, its repository move, and when it folds', () => {
  const text = adoptCardText({
    name: 'Reels app',
    base: 'main',
    sources: [
      source({ taskId: 'T12', crewId: 'a1', branch: 'fm/535abb3b', repository: 'amrtawfik160/reels-app', repointedFrom: 'Cyndra-AI/cyndra-saas', from: 'branch' }),
      source({ taskId: 'T13', crewId: 'b1', branch: 'fm/reels-theme-clr', repository: 'amrtawfik160/reels-app' }),
      source({ taskId: 'T14', crewId: 'c1', branch: 'fm/e9fe2c66', repository: 'amrtawfik160/reels-app', running: true }),
    ],
    tasks: [{ id: 'T12', title: 'Animation line' }, { id: 'T13', title: 'Counter listicle theme' }, { id: 'T14', title: 'Fold lamp' }, { id: 'T15', title: 'No work yet' }],
    replaces: ['https://github.com/Cyndra-AI/cyndra-saas/pull/2574'],
  });
  assert.match(text, /Reels app/);
  assert.match(text, /T12 Animation line/);
  assert.match(text, /moves from Cyndra-AI\/cyndra-saas to amrtawfik160\/reels-app/);
  assert.match(text, /T13 Counter listicle theme.*folds now/);
  assert.match(text, /T14 Fold lamp.*folds when its crew finishes/);
  assert.match(text, /T15 No work yet.*no saved work/);
  assert.match(text, /#2574/);
  assert.match(text, /from main/);
  assert.equal(text.split('\n').filter((line) => line.includes('T13')).length, 1);
  assert.ok(text.length <= 1500);
});

test('the PR base comes from the remote default branch; a PR closes only when all its commits are in', () => {
  assert.equal(prBaseFromLsRemote('ref: refs/heads/staging\tHEAD\n0123abc\tHEAD\n'), 'staging');
  assert.equal(prBaseFromLsRemote('0123abc\tHEAD\n'), null);
  assert.deepEqual(replacedPrVerdict({ state: 'OPEN', commits: ['a', 'b'] }, new Set(['a', 'b'])), { action: 'close' });
  assert.deepEqual(replacedPrVerdict({ state: 'OPEN', commits: ['a', 'b'] }, new Set(['a'])), { action: 'wait', reason: '1 of 2 commits are not in the workstream PR yet' });
  assert.deepEqual(replacedPrVerdict({ state: 'OPEN', commits: [] }, new Set()), { action: 'wait', reason: 'its commits could not be read' });
  assert.equal(replacedPrVerdict({ state: 'MERGED', commits: ['a'] }, new Set(['a'])).action, 'skip');
  assert.equal(replacedPrVerdict({ state: 'CLOSED', commits: ['a'] }, new Set(['a'])).action, 'skip');
  assert.deepEqual(parseContained('FM_IN aaa\nFM_OUT bbb\nnoise\n'), new Set(['aaa']));
  assert.deepEqual(parseSavedWork('FM_SAVE none\n'), { committed: false });
  assert.deepEqual(parseSavedWork('FM_SAVE commit abc123\n'), { committed: true, head: 'abc123' });
  assert.deepEqual(parseSavedWork('FM_SAVE missing\n'), { committed: false, missing: true });
});

test('proposal groups open tasks per project and leaves out tasks already in a workstream', () => {
  const groups = proposeWorkstreams({
    tasks: [
      { id: 'T1', title: 'Composer', projectId: 'cyndra', project: 'Cyndra SaaS', state: 'working', crews: 1, prs: ['https://github.com/Cyndra-AI/cyndra-saas/pull/2579'] },
      { id: 'T2', title: 'Sidebar', projectId: 'runants', project: 'Runants', state: 'needs_you', crews: 2, prs: [] },
      { id: 'T3', title: 'Held', projectId: 'cyndra', project: 'Cyndra SaaS', state: 'working', crews: 1, prs: [] },
      { id: 'T4', title: 'Done', projectId: 'cyndra', project: 'Cyndra SaaS', state: 'live', crews: 1, prs: [] },
    ],
    held: new Set(['T3']),
  });
  assert.deepEqual(groups.map((g) => [g.projectId, g.taskIds]), [['cyndra', ['T1']], ['runants', ['T2']]]);
  assert.match(groups[0]!.lines.join('\n'), /T1 Composer .*#2579/);
});

test('the conflict crew brief names the commit, the branch and the unsafe way out', () => {
  const brief = resolverBrief({ taskId: 'T7', repository: 'cyndra-ai/app', workstreamBranch: 'workstream/ws-1', target: 'abc1234def', label: 'fm/a7245f97' });
  assert.match(brief, /abc1234def/);
  assert.match(brief, /workstream\/ws-1/);
  assert.match(brief, /merge --abort/);
  assert.match(brief, new RegExp(RESOLVE_UNSAFE));
});

test('real Git: a staging base, a backup commit of unsaved work, a pushed branch fold and PR containment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fm-adopt-'));
  try {
    const remote = join(dir, 'origin.git'), src = join(dir, 'source'), ws = join(dir, 'ws'), crew = join(dir, 'crew');
    execFileSync('git', ['init', '--bare', '-q', '-b', 'staging', remote]);
    execFileSync('git', ['init', '-qb', 'staging', src]);
    writeFileSync(join(src, 'base.txt'), 'base'); commit(src);
    git(src, 'remote', 'add', 'origin', remote); git(src, 'push', '-q', '-u', 'origin', 'staging');
    git(src, 'branch', 'main'); git(src, 'push', '-q', 'origin', 'main');
    assert.equal(prBaseFromLsRemote(bash(prBaseScript(src))), 'staging');
    // The workstream branch starts from the repo's PR base, not main.
    writeFileSync(join(src, 'staging-only.txt'), 'staging'); commit(src); git(src, 'push', '-q', 'origin', 'staging');
    bash(provisionScript(src, ws, 'workstream/ws-1', 'staging'));
    assert.equal(existsSync(join(ws, 'staging-only.txt')), true);
    // A crew with uncommitted work: the backup commit takes it, never scratch files.
    git(src, 'worktree', 'add', '-q', '-b', 'fm/crew1', crew, 'origin/staging');
    writeFileSync(join(crew, 'feature.txt'), 'feature');
    mkdirSync(join(crew, '.lavish')); writeFileSync(join(crew, '.lavish', 'review.html'), 'scratch');
    const saved = parseSavedWork(bash(saveWorkScript(crew, 'Backup of unsaved work before folding into workstream/ws-1')));
    assert.equal(saved.committed, true);
    assert.equal(git(crew, 'log', '-1', '--format=%s'), 'Backup of unsaved work before folding into workstream/ws-1');
    assert.match(git(crew, 'status', '--porcelain', '--untracked-files=all'), /\.lavish/);
    assert.deepEqual(parseSavedWork(bash(saveWorkScript(crew, 'again'))), { committed: false });
    assert.deepEqual(parseSavedWork(bash(saveWorkScript(join(dir, 'gone'), 'gone'))), { committed: false, missing: true });
    // A pushed branch folds when the crew worktree is gone.
    git(crew, 'push', '-q', 'origin', 'fm/crew1');
    git(src, 'worktree', 'remove', '--force', crew);
    const plan = bash(foldBranchPlanScript(ws, 'workstream/ws-1', 'fm/crew1'));
    const before = foldValue(plan, 'BEFORE')!, target = foldValue(plan, 'TARGET')!;
    assert.ok(before && target);
    const folded = parseFoldOutput(bash(foldScript(ws, ws, 'workstream/ws-1', target, before)));
    assert.equal(folded.ok, true);
    assert.deepEqual(folded.files, ['feature.txt']);
    assert.equal(parseFoldOutput(bash(foldBranchPlanScript(ws, 'workstream/ws-1', 'fm/missing'))).wait, 'the branch fm/missing is not on origin');
    // Containment reads each PR commit against the workstream head; an unknown commit is not contained.
    const head = git(ws, 'rev-parse', 'HEAD');
    const contained = parseContained(bash(prContainsScript(ws, head, [target, '0'.repeat(40)])));
    assert.deepEqual(contained, new Set([target]));
    // Ship of this repository takes its PR base, not main.
    const repo = { repository: 'x/y', projectId: 'p', hostId: 'h', path: ws, sourcePath: src, branch: 'workstream/ws-1', environmentId: null, base: 'staging' };
    assert.match(takeMainScript(repo), /origin\/staging/);
    assert.doesNotMatch(takeMainScript(repo), /origin\/main/);
    assert.match(unshippedScript(repo), /origin\/staging/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function fixture() {
  const db = new DatabaseSync(':memory:');
  const statuses = new Map<string, string>();
  const started: Array<{ id: string; isolated?: boolean; payload: string }> = [];
  const provisioned: string[][] = [];
  const saved: string[] = [];
  const merged: string[] = [];
  const told: string[] = [];
  const archived: string[] = [];
  const deleted: string[] = [];
  const separate: string[] = [];
  const conflicts = new Set<string>();
  const landed = new Set<string>();
  const ops: FoldOps = {
    plan: async (_w, job) => ({ steps: [{ repository: job.repository ?? 'cyndra-ai/app', hostId: 'h1', workstreamPath: '/ws', checkoutPath: job.path ?? '/ws', before: 'b0', target: `t-${job.id}`, state: 'pending' }] }),
    merge: async (_w, step) => {
      merged.push(step.target);
      if (conflicts.has(step.target)) return { kind: 'conflict' };
      landed.add(step.target);
      return { kind: 'merged', after: `a-${step.target}`, files: [`${step.target}.txt`] };
    },
    inspect: async (_w, step) => ({ head: 'h', hasTarget: landed.has(step.target), files: landed.has(step.target) ? ['resolved.txt'] : [] }),
    rollback: async () => true,
  };
  const deps: WorkstreamDeps = {
    now: () => 100,
    provision: async (w) => { provisioned.push(w.adoption?.repositories ?? []); return (w.adoption?.repositories ?? ['cyndra-ai/app']).map((repository) => ({ repository, projectId: w.projectId, hostId: 'h1', path: `/ws/${repository}`, sourcePath: '/src', branch: `workstream/${w.id}`, environmentId: null, base: 'main' })); },
    start: async (_w, job) => { started.push({ id: job.id, isolated: job.isolated, payload: job.payload }); statuses.set(job.id, 'active'); return `thr_${job.id}`; },
    status: async (id) => statuses.get(id.replace(/^thr_/, '')) ?? 'idle',
    startDev: async () => 'https://dev', stopDev: async () => {}, unsaved: async () => [], remove: async () => {}, ship: async () => {},
    taskState: () => 'working',
    report: async () => '',
    foldOps: ops,
    saveWork: async (_w, job) => { saved.push(job.id); },
    tell: async (_w, job, message) => { told.push(`${job.id}:${message}`); },
    archive: async (_w, job) => { archived.push(job.id); },
    deleteBranch: async (_w, job) => { deleted.push(job.id); },
    separate: async (_w, job, reason) => { separate.push(`${job.taskId}:${reason}`); },
  };
  const store = createWorkstreams(db, deps);
  return { db, deps, store, statuses, started, provisioned, saved, merged, told, archived, deleted, separate, conflicts, landed };
}

const adoptInput = (sources: AdoptSource[], extra: Record<string, unknown> = {}) => ({
  threadId: 'cap', projectId: 'cyndra', name: 'Reels app', requestId: 'reels',
  taskIds: [...new Set(sources.map((s) => s.taskId))], repositories: [...new Set(sources.map((s) => s.repository))], sources, replaces: [], ...extra,
});

test('adopt folds idle crews at once after saving their work and lets a running crew fold when it finishes', async () => {
  const f = fixture();
  try {
    const sources = [
      source({ taskId: 'T1', crewId: 'idle1', branch: 'fm/idle1' }),
      source({ taskId: 'T2', crewId: 'gone1', branch: 'fm/gone1', from: 'branch', path: undefined, environmentId: null, threadId: 'thr_gone1' }),
      source({ taskId: 'T3', crewId: 'run1', branch: 'fm/run1', running: true }),
    ];
    f.statuses.set('run1', 'active');
    const w = await f.store.adoptFold(adoptInput(sources));
    assert.equal(isAdoptedWorkstream(w), false, 'an adopt-with-fold workstream works like a created one');
    assert.equal(w.provisioned, true);
    assert.deepEqual(f.provisioned, [['cyndra-ai/app']]);
    assert.deepEqual(w.taskIds, ['T1', 'T2', 'T3']);
    const job = (id: string) => f.store.get(w.id, 'cap').jobs.find((j) => j.id === id)!;
    assert.equal(job('idle1').state, 'folded');
    assert.equal(job('gone1').state, 'folded');
    assert.equal(job('gone1').sourceBranch, 'fm/gone1');
    assert.equal(job('run1').state, 'running');
    assert.deepEqual(f.saved.sort(), ['gone1', 'idle1']);
    // An adopted crew's old worktree is retired by the task-worktree cleanup, never by the workstream archive.
    assert.equal(job('idle1').cleanup, undefined);
    assert.deepEqual(f.archived, []);
    assert.deepEqual(f.deleted, [], 'an adopted crew branch (often a PR branch) is never deleted');
    // The running crew finishes; it needs no workstream test report to fold.
    f.statuses.set('run1', 'idle');
    await f.store.reconcile();
    assert.equal(job('run1').state, 'folded');
    assert.deepEqual(f.saved.sort(), ['gone1', 'idle1', 'run1']);
    assert.deepEqual(f.started, [], 'no crew is spawned for clean folds');
    // A retry of the same request changes nothing.
    const again = await f.store.adoptFold(adoptInput(sources));
    assert.equal(again.id, w.id);
    assert.equal(again.jobs.length, 3);
    assert.deepEqual(f.provisioned, [['cyndra-ai/app']]);
    await assert.rejects(f.store.adoptFold(adoptInput(sources, { name: 'Other' })), /changed its original/);
    await assert.rejects(f.store.adoptFold(adoptInput(sources.slice(0, 2))), /changed its original/);
  } finally { f.db.close(); }
});

test('a conflicting adopted fold goes to a new crew in the workstream worktree; success folds the task', async () => {
  const f = fixture();
  try {
    f.conflicts.add('t-idle1');
    const w = await f.store.adoptFold(adoptInput([source({ taskId: 'T1', crewId: 'idle1', branch: 'fm/idle1' })]));
    const jobs = () => f.store.get(w.id, 'cap').jobs;
    const original = () => jobs().find((j) => j.id === 'idle1')!;
    assert.deepEqual(f.told, [], 'the adopted crew is not told to fix the conflict');
    assert.equal(f.started.length, 1);
    const resolver = jobs().find((j) => j.resolves === 'idle1')!;
    assert.equal(f.started[0]!.id, resolver.id);
    assert.notEqual(resolver.isolated, true, 'the conflict crew works in the workstream worktree');
    assert.equal(resolver.editing, true);
    assert.equal(resolver.taskId, 'T1');
    assert.match(JSON.parse(resolver.payload).task, /t-idle1/);
    assert.equal(original().state, 'finished');
    assert.equal(original().resolver, resolver.id);
    assert.match(original().note ?? '', /resolves the fold conflict/);
    // Nothing folds again while the conflict crew works.
    await f.store.reconcile();
    assert.equal(f.merged.filter((t) => t === 't-idle1').length, 1);
    // The conflict crew merged it: the workstream branch now holds the task commit.
    f.landed.add('t-idle1');
    f.statuses.set(resolver.id, 'idle');
    await f.store.reconcile();
    assert.equal(original().state, 'folded');
    assert.deepEqual(original().files, ['resolved.txt']);
    assert.equal(jobs().find((j) => j.id === resolver.id)!.state, 'folded');
    assert.deepEqual(f.separate, []);
  } finally { f.db.close(); }
});

test('a conflict the new crew cannot resolve safely leaves the task separate and asks the owner once', async () => {
  const f = fixture();
  try {
    f.conflicts.add('t-idle1');
    const w = await f.store.adoptFold(adoptInput([
      source({ taskId: 'T1', crewId: 'idle1', branch: 'fm/idle1' }),
      source({ taskId: 'T2', crewId: 'idle2', branch: 'fm/idle2' }),
    ]));
    const resolver = f.store.get(w.id, 'cap').jobs.find((j) => j.resolves === 'idle1')!;
    f.statuses.set(resolver.id, 'idle');
    await f.store.reconcile();
    await f.store.reconcile();
    const now = f.store.get(w.id, 'cap');
    const original = now.jobs.find((j) => j.id === 'idle1')!;
    assert.equal(original.state, 'dropped');
    assert.match(original.note ?? '', /stays separate/);
    assert.deepEqual(now.taskIds, ['T2'], 'the task leaves the workstream and keeps its own worktree and PR');
    assert.equal(f.separate.length, 1);
    assert.match(f.separate[0]!, /^T1:/);
    assert.equal(now.jobs.find((j) => j.id === 'idle2')!.state, 'folded');
    assert.deepEqual(f.archived, []);
  } finally { f.db.close(); }
});

test('adopt refuses a task already in another workstream and creates nothing', async () => {
  const f = fixture();
  try {
    await f.store.adoptFold(adoptInput([source({ taskId: 'T1', crewId: 'idle1', branch: 'fm/idle1' })]));
    await assert.rejects(f.store.adoptFold({ ...adoptInput([source({ taskId: 'T1', crewId: 'idle1', branch: 'fm/idle1' })]), requestId: 'other', name: 'Other' }), /already belongs to a workstream/);
    assert.equal(f.store.list('cap').length, 1);
  } finally { f.db.close(); }
});

test('a new topic replaces a recorded topic only when the caller names the recorded topic as gone', async () => {
  const f = fixture();
  try {
    const w = await f.store.create({ threadId: 'cap', projectId: 'cyndra', name: 'Design', requestId: 'd', topic: { chatId: '200', topicId: 7 } });
    await assert.rejects(f.store.bindTopic(w.id, 'cap', { chatId: '200', topicId: 9 }), /already has a topic/);
    await assert.rejects(f.store.bindTopic(w.id, 'cap', { chatId: '200', topicId: 9 }, 8), /already has a topic/);
    const replaced = await f.store.bindTopic(w.id, 'cap', { chatId: '200', topicId: 9 }, 7);
    assert.deepEqual(replaced.topic, { chatId: '200', topicId: 9 });
    // A repeat after the replace is a no-op; the old topic id is gone from the record.
    const repeat = await f.store.bindTopic(w.id, 'cap', { chatId: '200', topicId: 9 }, 7);
    assert.deepEqual(repeat.topic, { chatId: '200', topicId: 9 });
    assert.equal(JSON.stringify(f.store.get(w.id, 'cap')).includes('"topicId":7'), false);
    // A workstream without a topic binds its first one as before.
    const other = await f.store.create({ threadId: 'cap', projectId: 'cyndra', name: 'Other', requestId: 'o' });
    assert.deepEqual((await f.store.bindTopic(other.id, 'cap', { chatId: '200', topicId: 11 })).topic, { chatId: '200', topicId: 11 });
  } finally { f.db.close(); }
});

test('Ship and later folds wait while a conflict crew works in the workstream worktree, then go on', async () => {
  const f = fixture();
  let ships = 0;
  f.deps.ship = async () => { ships++; };
  try {
    f.conflicts.add('t-idle1');
    f.statuses.set('run2', 'active');
    const w = await f.store.adoptFold(adoptInput([
      source({ taskId: 'T1', crewId: 'idle1', branch: 'fm/idle1' }),
      source({ taskId: 'T2', crewId: 'run2', branch: 'fm/run2', running: true }),
    ]));
    const resolver = f.store.get(w.id, 'cap').jobs.find((j) => j.resolves === 'idle1')!;
    assert.equal(resolver.state, 'running');
    // The other crew finishes while the conflict crew works: its fold waits.
    f.statuses.set('run2', 'idle');
    await f.store.reconcile();
    assert.equal(f.store.get(w.id, 'cap').jobs.find((j) => j.id === 'run2')!.state, 'finished');
    assert.equal(f.merged.includes('t-run2'), false);
    const queued = await f.store.ship(w.id, 'cap', 'ship-1');
    assert.equal(queued.ship.state, 'queued');
    assert.match(queued.ship.error ?? '', /crew working in the workstream worktree/);
    assert.equal(ships, 0);
    // The conflict crew merged and finished: the waiting fold lands, then the queued Ship runs.
    f.landed.add('t-idle1');
    f.statuses.set(resolver.id, 'idle');
    await f.store.reconcile();
    const after = f.store.get(w.id, 'cap');
    assert.equal(after.jobs.find((j) => j.id === 'run2')!.state, 'folded');
    assert.equal(ships, 1);
  } finally { f.db.close(); }
});
