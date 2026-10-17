// The weekly sync automation against a fake upstream (a local git repo) and fake bb and gh
// on PATH. It proves what the automation runs, that a repeated run starts nothing twice, and
// that a run killed right after a spawn or a message does not repeat it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, 'native-sync.ts');

const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const world = JSON.parse(fs.readFileSync(process.env.FAKE_WORLD, 'utf8'));
const a = process.argv.slice(2);
if (a[0] === 'api') { process.stdout.write('export const UPSTREAM_FIRSTMATE_SHA = "' + world.pin + '";\\n'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') { const closed = a.includes('closed'); process.stdout.write(JSON.stringify(closed ? world.closed : world.prs)); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'view') { process.stdout.write(JSON.stringify({ files: (world.files[a[2]] ?? []).map((path) => ({ path })) })); process.exit(0); }
process.stderr.write('fake gh: unknown ' + a.join(' ')); process.exit(1);
`;

// Spawned threads and sent messages live in the log, so a fake crash cannot lose them.
const FAKE_BB = `#!/usr/bin/env node
const fs = require('node:fs');
const world = JSON.parse(fs.readFileSync(process.env.FAKE_WORLD, 'utf8'));
const a = process.argv.slice(2);
const flag = (name) => a[a.indexOf(name) + 1];
const entries = () => fs.readFileSync(process.env.FAKE_LOG, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const log = (entry) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\\n');
const crash = (what) => { if (world.crashAfter === what) { process.kill(process.ppid, 'SIGKILL'); setTimeout(() => process.exit(0), 50); return true; } return false; };
if (a[0] === 'thread' && a[1] === 'spawn') {
  const id = 'thr_fake' + (entries().filter((e) => e.cmd === 'spawn').length + 1);
  log({ cmd: 'spawn', id, at: Date.now(), title: flag('--title'), args: a, prompt: fs.readFileSync(flag('--prompt-file'), 'utf8') });
  if (crash('spawn')) return;
  process.stdout.write(JSON.stringify({ id, status: 'active' })); process.exit(0);
}
if (a[0] === 'thread' && a[1] === 'list') { const spawned = entries().filter((e) => e.cmd === 'spawn').map((e) => ({ id: e.id, title: world.titles?.[e.id] ?? e.title, createdAt: e.at, visibility: 'visible', archivedAt: null })); const rows = a.includes('--archived') ? [] : [...spawned, ...(world.otherChildren ?? [])]; process.stdout.write(JSON.stringify(rows)); process.exit(0); }
if (a[0] === 'thread' && a[1] === 'show') { const t = world.threads[a[2]]; if (!t) { process.stdout.write(JSON.stringify({ ok: false, error: { code: 'not_found' } })); process.exit(1); } process.stdout.write(JSON.stringify({ thread: { id: a[2], status: t.status, archivedAt: null } })); process.exit(0); }
if (a[0] === 'thread' && a[1] === 'output') { process.stdout.write(JSON.stringify({ output: world.threads[a[2]]?.output ?? '' })); process.exit(0); }
if (a[0] === 'thread' && a[1] === 'log') {
  if (world.logHangs) { setTimeout(() => {}, 60000); return; }
  const events = [];
  for (const e of entries()) {
    if (e.cmd === 'tell' && e.to === a[2]) events.push({ type: 'client/turn/requested', createdAt: e.at, data: { input: [{ type: 'text', text: e.message }] } });
    if (e.cmd === 'chatter' && e.to === a[2]) for (let i = 0; i < e.n; i++) events.push({ type: 'client/turn/requested', createdAt: e.at, data: { input: [{ type: 'text', text: 'unrelated message ' + i + (e.quote ? '\\n> ' + e.quote : '') }] } });
  }
  events.forEach((ev, i) => { ev.seq = i + 1; });
  const after = Number(flag('--after-seq') ?? 0), limit = Number(flag('--limit') ?? 100);
  process.stdout.write(JSON.stringify(events.filter((ev) => ev.seq > after).slice(0, limit))); process.exit(0);
}
if (a[0] === 'thread' && a[1] === 'tell') { log({ cmd: 'tell', at: Date.now(), to: a[2], message: fs.readFileSync(flag('--message-file'), 'utf8') }); if (crash('tell')) return; process.stdout.write(JSON.stringify({ threadId: a[2], delivery: 'queued', messageId: 'msg_' + entries().length })); process.exit(0); }
process.stderr.write('fake bb: unknown ' + a.join(' ')); process.exit(1);
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'native-sync-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, body] of [['gh', FAKE_GH], ['bb', FAKE_BB]]) { writeFileSync(join(bin, name), body); chmodSync(join(bin, name), 0o755); }
  const upstream = join(dir, 'upstream');
  const git = (...args) => execFileSync('git', ['-C', upstream, ...args], { encoding: 'utf8' }).trim();
  mkdirSync(upstream);
  git('init', '-q', '-b', 'main');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'pinned');
  const pin = git('rev-parse', 'HEAD');
  const world = { pin, prs: [], closed: [], files: {}, threads: {}, crashAfter: null };
  const paths = { world: join(dir, 'world.json'), log: join(dir, 'log.jsonl'), state: join(dir, 'state.json') };
  writeFileSync(paths.log, '');
  const env = () => ({ ...process.env, FM_SYNC_SEARCH_BUDGET_MS: world.searchBudgetMs ?? '', FM_BB_CALL_TIMEOUT_MS: '3000', PATH: `${bin}:${process.env.PATH}`, FAKE_WORLD: paths.world, FAKE_LOG: paths.log, FM_SYNC_STATE: paths.state, FM_SYNC_UPSTREAM: upstream, FM_SYNC_MANAGER: 'thr_repair', FM_SYNC_PROJECT: 'proj_fm' });
  const raw = (...args) => { writeFileSync(paths.world, JSON.stringify(world)); return spawnSync(process.execPath, [SCRIPT, 'tick', ...args], { encoding: 'utf8', env: env() }); };
  const run = (...args) => { const r = raw(...args); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const log = () => readFileSync(paths.log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const spawns = () => log().filter((e) => e.cmd === 'spawn');
  const tells = () => log().filter((e) => e.cmd === 'tell');
  const advance = () => { git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'upstream fix'); return git('rev-parse', 'HEAD'); };
  const state = () => JSON.parse(readFileSync(paths.state, 'utf8'));
  const chatter = (n, quote) => writeFileSync(paths.log, readFileSync(paths.log, 'utf8') + JSON.stringify({ cmd: 'chatter', to: 'thr_repair', at: Date.now(), n, quote }) + '\n');
  return { world, run, raw, log, spawns, tells, advance, state, env, paths, chatter };
}

test('a pin already at upstream HEAD does nothing', () => {
  const t = setup();
  assert.match(t.run('--start'), /^native-sync: none: pin [0-9a-f]{8} is upstream HEAD$/);
  assert.deepEqual(t.log(), []);
});

test('upstream ahead by one commit: one sync crew, one checker, one message to the repair thread', () => {
  const t = setup();
  const head = t.advance();
  assert.match(t.run('--start', '--dry-run').split('\n')[0], new RegExp(`^native-sync: spawn-sync: Native sync to ${head.slice(0, 8)} \\[op:[0-9a-f]+\\] \\(dry run, nothing started\\)$`));
  assert.deepEqual(t.log(), []);

  assert.match(t.run('--start'), /spawn-sync: Native sync to .* as thr_fake1/);
  const [spawned] = t.spawns();
  const flag = (name) => spawned.args[spawned.args.indexOf(name) + 1];
  assert.equal(flag('--parent-thread'), 'thr_repair');
  assert.equal(flag('--project'), 'proj_fm');
  assert.equal(flag('--new-environment'), 'worktree');
  assert.equal(flag('--model'), 'claude-opus-5-5');
  assert.match(spawned.prompt, new RegExp(`from ${t.world.pin} to ${head}`));

  t.world.threads.thr_fake1 = { status: 'active', output: '' };
  assert.match(t.run('--start'), /none: sync crew thr_fake1 is still working/);

  t.world.threads.thr_fake1 = { status: 'idle', output: 'Opened the sync PR. Canary passed: one dispatch, one merge, a mid-turn switch.' };
  t.world.prs = [{ number: 140, url: 'https://github.com/o/r/pull/140', headRefName: `native-sync/${head.slice(0, 8)}`, headRefOid: 'c'.repeat(40) }, { number: 9, url: 'u', headRefName: 'feature/x', headRefOid: 'd'.repeat(40) }];
  t.world.files['140'] = ['lib/upstream-surface.ts'];
  assert.match(t.run(), /spawn-check: Check native sync PR #140 .* as thr_fake2/);
  const checker = t.spawns()[1];
  const cflag = (name) => checker.args[checker.args.indexOf(name) + 1];
  assert.equal(cflag('--model'), 'gpt-6-astra');
  assert.equal(cflag('--base-branch'), `origin/native-sync/${head.slice(0, 8)}`);

  t.world.threads.thr_fake2 = { status: 'active', output: '' };
  assert.match(t.run(), /none: checker thr_fake2 is still working/);
  t.world.threads.thr_fake2 = { status: 'idle', output: 'Ran the suite and the guard.\nVERDICT: pass' };
  assert.match(t.run(), /tell: report:c{40} sent to thr_repair/);
  assert.equal(t.tells().length, 1);
  assert.match(t.tells()[0].message, /Checker verdict: pass/);
  assert.match(t.run(), /none: report:c{40} is already reported/);
  assert.equal(t.tells().length, 1);
});

test('a run killed right after the spawn adopts that thread instead of spawning again', () => {
  const t = setup();
  t.advance();
  t.world.crashAfter = 'spawn';
  const killed = t.raw('--start');
  assert.notEqual(killed.status, 0, 'the run died');
  assert.equal(t.spawns().length, 1);
  assert.equal(t.state().sync.threadId, undefined, 'the intent was saved before the spawn');
  t.world.crashAfter = null;
  assert.match(t.run('--start'), /adopt: sync thr_fake1/);
  assert.equal(t.state().sync.threadId, 'thr_fake1');
  t.world.threads.thr_fake1 = { status: 'active', output: '' };
  assert.match(t.run('--start'), /still working/);
  assert.equal(t.spawns().length, 1, 'one sync thread for one target');
});

test('a lost spawn is adopted only from one marked child created inside the operation window', () => {
  const t = setup();
  t.advance();
  t.world.crashAfter = 'spawn';
  t.raw('--start');
  t.world.crashAfter = null;
  const op = t.state().sync.op;
  t.world.otherChildren = [{ id: 'thr_old', title: `copied [op:${op}]`, createdAt: Date.now() - 3_600_000 }];
  assert.match(t.run('--start'), /adopt: sync thr_fake1/, 'a marked child from before the operation is ignored');
  t.world.otherChildren = [];
  const second = setup();
  second.advance();
  second.world.crashAfter = 'spawn';
  second.raw('--start');
  second.world.crashAfter = null;
  const op2 = second.state().sync.op;
  second.world.otherChildren = [{ id: 'thr_twin', title: `twin [op:${op2}]`, createdAt: Date.now() }];
  assert.match(second.run('--start'), /none: 2 threads carry operation/);
  assert.equal(second.spawns().length, 1);
});

test('a run killed right after a message confirms it from the repair thread log instead of sending it again', () => {
  const t = setup();
  const head = t.advance();
  t.run('--start');
  t.world.threads.thr_fake1 = { status: 'idle', output: 'done' };
  t.world.prs = [{ number: 140, url: 'https://github.com/o/r/pull/140', headRefName: `native-sync/${head.slice(0, 8)}`, headRefOid: 'c'.repeat(40) }];
  t.run();
  t.world.threads.thr_fake2 = { status: 'idle', output: 'VERDICT: pass' };
  t.world.crashAfter = 'tell';
  assert.notEqual(t.raw().status, 0, 'the run died');
  t.world.crashAfter = null;
  t.chatter(150, '[native-sync deadbeef] quoted by someone else');
  assert.match(t.run(), /delivered: report:c{40}/, 'found behind 150 newer messages');
  assert.match(t.run(), /already reported/);
  assert.equal(t.tells().length, 1);
});

test('an earlier message is sent again only when the whole log since its intent was searched', () => {
  const t = setup();
  const head = t.advance();
  t.run('--start');
  t.world.threads.thr_fake1 = { status: 'idle', output: 'done' };
  t.world.prs = [{ number: 140, url: 'https://github.com/o/r/pull/140', headRefName: `native-sync/${head.slice(0, 8)}`, headRefOid: 'c'.repeat(40) }];
  t.run();
  t.world.threads.thr_fake2 = { status: 'idle', output: 'VERDICT: pass' };
  const state = t.state();
  state.outbox = { key: 'report:' + 'c'.repeat(40), op: 'feedface', at: new Date(Date.now() - 1000).toISOString(), text: '[native-sync feedface]\nreport' };
  writeFileSync(t.paths.state, JSON.stringify(state));
  t.world.logHangs = true;
  assert.match(t.run(), /none: cannot confirm whether report:c{40} was delivered/);
  assert.equal(t.tells().length, 0, 'an unfinished search never resends');
  t.world.logHangs = false;
  assert.match(t.run(), /tell: report:c{40} sent to thr_repair/, 'a complete search that finds nothing resends');
  assert.equal(t.tells().length, 1);
  assert.match(t.state().receipts['report:' + 'c'.repeat(40)].messageId, /^msg_/, 'the receipt is saved when the call returns');
});

test('a sync crew that ends without a PR is retried once, then reported once', () => {
  const t = setup();
  t.advance();
  t.run('--start');
  t.world.threads.thr_fake1 = { status: 'error', output: '' };
  assert.match(t.run(), /spawn-sync: .* as thr_fake2/);
  t.world.threads.thr_fake2 = { status: 'idle', output: 'BLOCKED: the guard refused the pin' };
  assert.match(t.run('--start'), /tell: failed:/);
  assert.match(t.tells()[0].message, /ended 2 times without a PR/);
  assert.match(t.run('--start'), /none: failed:.* is already reported/);
  assert.equal(t.spawns().length, 2);
  assert.match(t.run('--start', '--retry'), /spawn-sync: .* as thr_fake3/);
});

test('two runs at once: one holds the lock for its whole life, the other does nothing', async () => {
  const t = setup();
  t.advance();
  writeFileSync(t.paths.world, JSON.stringify(t.world));
  const slow = spawn('flock', [`${t.paths.state}.lock`, 'sleep', '2'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.match(t.run('--start'), /none: another run holds the lock/);
  await new Promise((resolve) => slow.on('exit', resolve));
  assert.match(t.run('--start'), /spawn-sync/);
});

test('the run refuses to start without the repair thread and the project', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'tick'], { encoding: 'utf8', env: { ...process.env, FM_SYNC_MANAGER: '', FM_SYNC_PROJECT: '' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /FM_SYNC_MANAGER and FM_SYNC_PROJECT/);
});
