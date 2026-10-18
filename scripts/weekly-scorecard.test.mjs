// The weekly scorecard automation with a fake clock and fake bb on PATH: it renders from
// fixture data, sends the captain one message per scheduled week even across retries,
// overlapping runs and a crash after the send, and reads Telegram counts from the
// connector's timestamped records.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, 'weekly-scorecard.ts');
const FAKE_BB = `#!/usr/bin/env node
const fs = require('node:fs');
const world = JSON.parse(fs.readFileSync(process.env.FAKE_WORLD, 'utf8'));
const a = process.argv.slice(2);
const flag = (name) => a[a.indexOf(name) + 1];
const entries = () => fs.readFileSync(process.env.FAKE_LOG, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const log = (entry) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\\n');
if (a[0] === 'firstmate' && a[1] === 'scorecard') { log({ cmd: 'scorecard', args: a }); process.stdout.write(JSON.stringify({ ...world.card, since: flag('--since'), until: flag('--until') })); process.exit(0); }
if (a[0] === 'telegram' && a[1] === 'export') {
  if (world.exportHangs) { log({ cmd: 'export-hang' }); setTimeout(() => {}, 60000); return; }
  if (!world.outbox) { process.stderr.write('connector down'); process.exit(1); }
  if (Number(flag('--limit') ?? 20) > (world.maxPage ?? 20)) { process.stderr.write('That page is too large. Use a smaller --limit.'); process.exit(1); }
  const offset = Number(flag('--offset') ?? 0), limit = Number(flag('--limit') ?? 20);
  log({ cmd: 'export', offset });
  process.stdout.write(JSON.stringify({ inbox: [], outbox: world.outbox.slice(offset, offset + limit), decisions: [], offset, limit })); process.exit(0);
}
if (a[0] === 'thread' && a[1] === 'log') {
  const events = [];
  for (const e of entries()) {
    if (e.cmd === 'tell' && e.to === a[2]) events.push({ type: 'client/turn/requested', createdAt: e.at, data: { input: [{ type: 'text', text: e.message }] } });
    if (e.cmd === 'chatter') for (let i = 0; i < e.n; i++) events.push({ type: 'client/turn/requested', createdAt: e.at, data: { input: [{ type: 'text', text: 'unrelated ' + i }] } });
  }
  events.forEach((ev, i) => { ev.seq = i + 1; });
  const after = Number(flag('--after-seq') ?? 0), limit = Number(flag('--limit') ?? 100);
  process.stdout.write(JSON.stringify(events.filter((ev) => ev.seq > after).slice(0, limit))); process.exit(0);
}
if (a[0] === 'thread' && a[1] === 'tell') { log({ cmd: 'tell', at: Date.now(), to: a[2], message: fs.readFileSync(flag('--message-file'), 'utf8') }); if (world.crashAfterTell) { process.kill(process.ppid, 'SIGKILL'); setTimeout(() => process.exit(0), 50); return; } process.stdout.write(JSON.stringify({ threadId: a[2], delivery: 'queued' })); process.exit(0); }
process.stderr.write('fake bb: unknown ' + a.join(' ')); process.exit(1);
`;

const at = (iso) => Date.parse(iso);
// 30 Telegram messages over three weeks: 10 per week, two of each week's not delivered.
const OUTBOX = Array.from({ length: 30 }, (_, i) => ({ created_at: at('2026-10-04T19:00:00Z') + i * 16 * 3_600_000 + 1, state: i % 10 === 3 ? 'failed' : i % 10 === 7 ? 'uncertain' : 'sent' }));

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'scorecard-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'bb'), FAKE_BB);
  chmodSync(join(dir, 'bin', 'bb'), 0o755);
  // GitHub is rate limited for every test: the scorecard must not depend on it.
  writeFileSync(join(dir, 'bin', 'gh'), `#!/bin/sh\necho '{"cmd":"gh"}' >> "$FAKE_LOG"\necho 'GraphQL: API rate limit already exceeded for user ID 1.' >&2\nexit 1\n`);
  chmodSync(join(dir, 'bin', 'gh'), 0o755);
  const world = {
    card: { captain: 'thr_cap', home: '/homes/cap', corrections: [{ id: 'C4', ref: 'tg:1:1', at: '2026-10-13T08:00:00.000Z', fixed: true }], redone: [], checks: [], unproven: [] },
    outbox: OUTBOX, crashAfterTell: false,
  };
  const paths = { world: join(dir, 'world.json'), log: join(dir, 'log.jsonl'), state: join(dir, 'state.json') };
  writeFileSync(paths.log, '');
  const raw = (...args) => { writeFileSync(paths.world, JSON.stringify(world)); return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, FAKE_WORLD: paths.world, FAKE_LOG: paths.log, FM_SCORECARD_STATE: paths.state, FM_CAPTAIN_THREAD: 'thr_cap', FM_REFLECT_PROJECT: 'proj_example01', FM_BB_CALL_TIMEOUT_MS: '1500', FM_SCORECARD_EXPORT_BUDGET_MS: '4000' } }); };
  const run = (...args) => { const r = raw(...args); assert.equal(r.status, 0, r.stderr); return r.stdout; };
  const log = () => readFileSync(paths.log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const tells = () => log().filter((e) => e.cmd === 'tell');
  const chatter = (n) => writeFileSync(paths.log, readFileSync(paths.log, 'utf8') + JSON.stringify({ cmd: 'chatter', at: Date.now(), n }) + '\n');
  return { world, run, raw, log, tells, paths, chatter };
}

const SUNDAY = '2026-10-18T18:00:00.000Z';
const MONDAY = '2026-10-19T08:00:00.000Z';
const NEXT_SUNDAY = '2026-10-25T18:30:00.000Z';

test('a dry run prints the scorecard for the scheduled week and sends nothing', () => {
  const t = setup();
  const out = t.run('--now', MONDAY);
  assert.match(out, /^🛠 Hanoon & tools · Weekly scorecard, 11 Oct to 18 Oct\n/);
  assert.match(out, /Owner corrections: 1 correction\. 1 is fixed\./);
  assert.match(out, /Noise: 8 Telegram messages sent\. 2 not delivered\. 0 still queued\./);
  assert.match(out, /dry run: nothing sent/);
  const card = t.log().find((e) => e.cmd === 'scorecard');
  assert.deepEqual(card.args.slice(2), ['--captain', 'thr_cap', '--since', '2026-10-11T18:00:00.000Z', '--until', SUNDAY, '--json']);
  assert.equal(t.tells().length, 0);
});

test('one message per scheduled week: a repeat and a Monday retry send nothing', () => {
  const t = setup();
  assert.match(t.run('--send', '--now', SUNDAY), /sent the week ending 2026-10-18 to thr_cap/);
  assert.match(t.run('--send', '--now', SUNDAY), /already sent the week ending 2026-10-18/);
  assert.match(t.run('--send', '--now', MONDAY), /already sent the week ending 2026-10-18/);
  assert.equal(t.tells().length, 1);
  assert.match(t.tells()[0].message, /^\[weekly-scorecard 2026-10-18 [0-9a-f]+\]\n/);
  assert.match(t.tells()[0].message, /firstmate_dispatch projectId=proj_example01 role=builder playbook=none title="Weekly reflect 18 Oct"/);
  assert.match(t.run('--send', '--now', NEXT_SUNDAY), /sent the week ending 2026-10-25/);
  assert.equal(t.tells().length, 2);
});

test('a run killed right after the send confirms it from the captain log and does not send again', () => {
  const t = setup();
  t.world.crashAfterTell = true;
  assert.notEqual(t.raw('--send', '--now', SUNDAY).status, 0);
  t.world.crashAfterTell = false;
  t.chatter(150);
  assert.match(t.run('--send', '--now', MONDAY), /confirmed the week ending 2026-10-18/);
  assert.match(t.run('--send', '--now', MONDAY), /already sent/);
  assert.equal(t.tells().length, 1);
});

test('two runs at once send one message', async () => {
  const t = setup();
  writeFileSync(t.paths.world, JSON.stringify(t.world));
  const slow = spawn('flock', [`${t.paths.state}.lock`, 'sleep', '2'], { stdio: 'ignore' });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.match(t.run('--send', '--now', SUNDAY), /another run holds the lock/);
  await new Promise((resolve) => slow.on('exit', resolve));
  t.run('--send', '--now', SUNDAY);
  assert.equal(t.tells().length, 1);
});

test('Telegram counts that the connector no longer keeps, or cannot read, are named, not invented', () => {
  const t = setup();
  t.world.outbox = OUTBOX.filter((r) => r.created_at > at('2026-10-13T00:00:00Z'));
  assert.match(t.run('--now', MONDAY), /Noise: not available \(the connector keeps records only from 13 Oct, after the week began\)\./);
  t.world.outbox = null;
  assert.match(t.run('--now', MONDAY), /Noise: not available \(bb telegram export failed\)\./);
});

test('a hanging export ends in its budget: the noise line says so and the captain still gets the scorecard', () => {
  const t = setup();
  t.world.exportHangs = true;
  const started = Date.now();
  const out = t.run('--send', '--now', SUNDAY);
  assert.ok(Date.now() - started < 15_000, `${Date.now() - started} ms`);
  assert.match(out, /sent the week ending 2026-10-18/);
  assert.match(t.tells()[0].message, /Noise: not available \(export timed out\)\./);
});

test('the first export row alone proves an incomplete week, so no other page is read', () => {
  const t = setup();
  t.world.outbox = OUTBOX.filter((r) => r.created_at > at('2026-10-13T00:00:00Z'));
  t.run('--now', MONDAY);
  assert.equal(t.log().filter((e) => e.cmd === 'export').length, 1);
});

test('a page the connector finds too large is read again in smaller pages', () => {
  const t = setup();
  t.world.maxPage = 5;
  assert.match(t.run('--now', MONDAY), /Noise: 8 Telegram messages sent\. 2 not delivered\./);
});

test('a row created exactly at the start of the week is counted, also when it is row 0', () => {
  const t = setup();
  t.world.outbox = [{ created_at: at('2026-10-11T18:00:00.000Z'), state: 'sent' }, { created_at: at('2026-10-12T09:00:00.000Z'), state: 'sent' }];
  assert.match(t.run('--now', MONDAY), /Noise: 2 Telegram messages sent\./);
  t.world.outbox = [{ created_at: at('2026-10-11T18:00:00.000Z'), state: 'sent' }];
  assert.match(t.run('--now', MONDAY), /Noise: 1 Telegram message sent\./);
  t.world.outbox = [{ created_at: at('2026-10-10T00:00:00.000Z'), state: 'sent' }, { created_at: at('2026-10-11T18:00:00.000Z'), state: 'sent' }, { created_at: at('2026-10-12T09:00:00.000Z'), state: 'failed' }];
  assert.match(t.run('--now', MONDAY), /Noise: 1 Telegram message sent\. 1 not delivered\./);
});

test('a GitHub rate limit cannot fail the scorecard: the run makes no GitHub call', () => {
  const t = setup();
  assert.match(t.run('--send', '--now', SUNDAY), /sent the week ending 2026-10-18 to thr_cap/);
  assert.equal(t.log().filter((e) => e.cmd === 'gh').length, 0);
});
