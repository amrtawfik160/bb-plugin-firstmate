// The weekly sync automation against a fake upstream (a local git repo) and fake bb and gh
// on PATH. It proves what the automation runs, and that a repeated run starts nothing twice.
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, 'native-sync.ts');

const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const world = JSON.parse(fs.readFileSync(process.env.FAKE_WORLD, 'utf8'));
const a = process.argv.slice(2);
if (a[0] === 'api') { process.stdout.write('export const UPSTREAM_FIRSTMATE_SHA = "' + world.pin + '";\\n'); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'list') { process.stdout.write(JSON.stringify(world.prs)); process.exit(0); }
if (a[0] === 'pr' && a[1] === 'view') { process.stdout.write(JSON.stringify({ files: (world.files[a[2]] ?? []).map((path) => ({ path })) })); process.exit(0); }
process.stderr.write('fake gh: unknown ' + a.join(' ')); process.exit(1);
`;

const FAKE_BB = `#!/usr/bin/env node
const fs = require('node:fs');
const world = JSON.parse(fs.readFileSync(process.env.FAKE_WORLD, 'utf8'));
const a = process.argv.slice(2);
const flag = (name) => a[a.indexOf(name) + 1];
const log = (entry) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\\n');
if (a[0] === 'thread' && a[1] === 'spawn') {
  const id = 'thr_fake' + (fs.readFileSync(process.env.FAKE_LOG, 'utf8').split('\\n').filter(Boolean).length + 1);
  log({ cmd: 'spawn', id, args: a, prompt: fs.readFileSync(flag('--prompt-file'), 'utf8') });
  process.stdout.write(JSON.stringify({ id, status: 'active' })); process.exit(0);
}
if (a[0] === 'thread' && a[1] === 'show') { const t = world.threads[a[2]]; if (!t) { process.stdout.write(JSON.stringify({ ok: false, error: { code: 'not_found' } })); process.exit(1); } process.stdout.write(JSON.stringify({ thread: { id: a[2], status: t.status, archivedAt: null } })); process.exit(0); }
if (a[0] === 'thread' && a[1] === 'output') { process.stdout.write(JSON.stringify({ output: world.threads[a[2]]?.output ?? '' })); process.exit(0); }
if (a[0] === 'thread' && a[1] === 'tell') { log({ cmd: 'tell', to: a[2], message: fs.readFileSync(flag('--message-file'), 'utf8') }); process.stdout.write('{}'); process.exit(0); }
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
  const world = { pin, prs: [], files: {}, threads: {} };
  const paths = { world: join(dir, 'world.json'), log: join(dir, 'log.jsonl'), state: join(dir, 'state.json') };
  writeFileSync(paths.log, '');
  const save = () => writeFileSync(paths.world, JSON.stringify(world));
  save();
  const run = (...args) => {
    save();
    const r = spawnSync(process.execPath, [SCRIPT, 'tick', ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_WORLD: paths.world, FAKE_LOG: paths.log, FM_SYNC_STATE: paths.state, FM_SYNC_UPSTREAM: upstream, FM_SYNC_MANAGER: 'thr_repair', FM_SYNC_PROJECT: 'proj_fm' } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  const log = () => readFileSync(paths.log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const advance = () => { git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'upstream fix'); return git('rev-parse', 'HEAD'); };
  return { world, run, log, advance, state: () => JSON.parse(readFileSync(paths.state, 'utf8')) };
}

test('a pin already at upstream HEAD does nothing', () => {
  const t = setup();
  assert.match(t.run('--start'), /^native-sync: none: pin [0-9a-f]{8} is upstream HEAD$/);
  assert.deepEqual(t.log(), []);
});

test('upstream ahead by one commit: one sync crew, one checker, one message to the repair thread', () => {
  const t = setup();
  const head = t.advance();
  assert.equal(t.run('--start', '--dry-run').split('\n')[0], `native-sync: start-sync: Native sync to ${head.slice(0, 8)} (dry run, nothing started)`);
  assert.deepEqual(t.log(), []);

  assert.match(t.run('--start'), /start-sync: Native sync to .* as thr_fake1/);
  const [spawn] = t.log();
  const flag = (name) => spawn.args[spawn.args.indexOf(name) + 1];
  assert.equal(flag('--parent-thread'), 'thr_repair');
  assert.equal(flag('--project'), 'proj_fm');
  assert.equal(flag('--new-environment'), 'worktree');
  assert.equal(flag('--provider'), 'claude-code');
  assert.equal(flag('--model'), 'claude-opus-5-5');
  assert.match(spawn.prompt, new RegExp(`from ${t.world.pin} to ${head}`));
  assert.match(spawn.prompt, /docs\/native-sync\.md/);

  t.world.threads.thr_fake1 = { status: 'active', output: '' };
  assert.match(t.run('--start'), /none: sync crew thr_fake1 is still working/);
  assert.match(t.run(), /none: sync crew thr_fake1 is still working/);

  t.world.threads.thr_fake1 = { status: 'idle', output: 'Opened the sync PR. Canary passed: one dispatch, one merge, a mid-turn switch.' };
  t.world.prs = [{ number: 140, url: 'https://github.com/o/r/pull/140', headRefName: `native-sync/${head.slice(0, 8)}`, headRefOid: 'c'.repeat(40) }, { number: 9, url: 'u', headRefName: 'feature/x', headRefOid: 'd'.repeat(40) }];
  t.world.files['140'] = ['lib/upstream-surface.ts'];
  assert.match(t.run(), /start-checker: Check native sync PR #140 as thr_fake2/);
  const checker = t.log()[1];
  const cflag = (name) => checker.args[checker.args.indexOf(name) + 1];
  assert.equal(cflag('--provider'), 'codex');
  assert.equal(cflag('--model'), 'gpt-6-astra');
  assert.equal(cflag('--base-branch'), `origin/native-sync/${head.slice(0, 8)}`);
  assert.match(checker.prompt, /pull\/140/);

  t.world.threads.thr_fake2 = { status: 'active', output: '' };
  assert.match(t.run(), /none: checker thr_fake2 is still working/);
  t.world.threads.thr_fake2 = { status: 'idle', output: 'Ran the suite and the guard.\nVERDICT: pass' };
  assert.match(t.run(), /report: PR #140 sent to thr_repair/);
  const tell = t.log()[2];
  assert.equal(tell.to, 'thr_repair');
  assert.match(tell.message, /Checker verdict: pass/);
  assert.match(tell.message, /Canary passed/);
  assert.match(tell.message, /Owner card: not needed/);

  assert.match(t.run(), /none: PR #140 at cccccccc is already reported/);
  assert.match(t.run('--start'), /none: PR #140 at cccccccc is already reported/);
  assert.equal(t.log().length, 3);
  assert.equal(t.state().reported, 'c'.repeat(40));
});

test('the run refuses to start without the repair thread and the project', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'tick'], { encoding: 'utf8', env: { ...process.env, FM_SYNC_MANAGER: '', FM_SYNC_PROJECT: '' } });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /FM_SYNC_MANAGER and FM_SYNC_PROJECT/);
});
