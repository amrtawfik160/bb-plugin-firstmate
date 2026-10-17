// The weekly scorecard automation with a fake clock and fake bb on PATH: it renders from
// fixture data, sends the captain one message per week, and reads Telegram counts as a weekly change.
import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SCRIPT = join(import.meta.dirname, 'weekly-scorecard.ts');
const FAKE_BB = `#!/usr/bin/env node
const fs = require('node:fs');
const world = JSON.parse(fs.readFileSync(process.env.FAKE_WORLD, 'utf8'));
const a = process.argv.slice(2);
const flag = (name) => a[a.indexOf(name) + 1];
const log = (entry) => fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify(entry) + '\\n');
if (a[0] === 'firstmate' && a[1] === 'scorecard') { log({ cmd: 'scorecard', args: a }); process.stdout.write(JSON.stringify({ ...world.card, since: flag('--since'), until: flag('--until') })); process.exit(0); }
if (a[0] === 'telegram' && a[1] === 'status') { if (!world.telegram) { process.stderr.write('connector down'); process.exit(1); } process.stdout.write(JSON.stringify(world.telegram)); process.exit(0); }
if (a[0] === 'thread' && a[1] === 'tell') { log({ cmd: 'tell', to: a[2], message: fs.readFileSync(flag('--message-file'), 'utf8') }); process.exit(0); }
process.stderr.write('fake bb: unknown ' + a.join(' ')); process.exit(1);
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'scorecard-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'bb'), FAKE_BB);
  chmodSync(join(dir, 'bin', 'bb'), 0o755);
  const world = {
    card: { captain: 'thr_cap', home: '/homes/cap', corrections: [{ id: 'C4', ref: 'tg:1:1', at: '2026-10-13T08:00:00.000Z', fixed: true }], redone: [{ task: 'T12', title: 'Login fix', extraCrews: 1 }], checkerFails: [], unproven: [{ pr: 'o/r#5', crew: 'c1', at: '2026-10-14T08:00:00.000Z' }] },
    telegram: { inbox: { delivered: 850, failed: 2 }, outbox: { sent: 2594, uncertain: 13 } },
  };
  const paths = { world: join(dir, 'world.json'), log: join(dir, 'log.jsonl'), state: join(dir, 'state.json') };
  writeFileSync(paths.log, '');
  const run = (...args) => {
    writeFileSync(paths.world, JSON.stringify(world));
    const r = spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { ...process.env, PATH: `${join(dir, 'bin')}:${process.env.PATH}`, FAKE_WORLD: paths.world, FAKE_LOG: paths.log, FM_SCORECARD_STATE: paths.state, FM_CAPTAIN_THREAD: 'thr_cap', FM_REFLECT_PROJECT: 'proj_example01' } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout;
  };
  const log = () => readFileSync(paths.log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { world, run, log };
}

const SUNDAY = '2026-10-18T18:00:00.000Z';
const NEXT_SUNDAY = '2026-10-25T18:00:00.000Z';

test('a dry run prints the scorecard and the captain message and sends nothing', () => {
  const t = setup();
  const out = t.run('--until', SUNDAY);
  assert.match(out, /^🛠 Hanoon & tools · Weekly scorecard, 11 Oct to 18 Oct\n/);
  assert.match(out, /Owner corrections: 1 correction\. 1 is fixed\. Source: corrections ledger\./);
  assert.match(out, /Noise: no earlier count, so no weekly number yet\. Totals so far: 2594 sent, 15 failed or not confirmed\./);
  assert.match(out, /dry run: nothing sent/);
  const scorecard = t.log().find((e) => e.cmd === 'scorecard');
  assert.deepEqual(scorecard.args.slice(2), ['--captain', 'thr_cap', '--since', '2026-10-11T18:00:00.000Z', '--until', SUNDAY, '--json']);
  assert.equal(t.log().filter((e) => e.cmd === 'tell').length, 0);
});

test('the captain gets one message a week, and noise is the change since last week', () => {
  const t = setup();
  assert.match(t.run('--send', '--until', SUNDAY), /sent the week ending 2026-10-18 to thr_cap/);
  assert.match(t.run('--send', '--until', SUNDAY), /already sent the week ending 2026-10-18/);
  const tells = t.log().filter((e) => e.cmd === 'tell');
  assert.equal(tells.length, 1);
  assert.equal(tells[0].to, 'thr_cap');
  assert.match(tells[0].message, /1\. Post the scorecard below to the owner unchanged, as its own message, in the Hanoon & tools project topic\./);
  assert.match(tells[0].message, /firstmate_dispatch projectId=proj_example01 role=builder playbook=none title="Weekly reflect 18 Oct"/);
  assert.match(tells[0].message, /pstack `reflect`/);

  t.world.telegram = { inbox: { delivered: 900, failed: 3 }, outbox: { sent: 3000, uncertain: 13 } };
  assert.match(t.run('--send', '--until', NEXT_SUNDAY), /sent the week ending 2026-10-25/);
  const second = t.log().filter((e) => e.cmd === 'tell')[1];
  assert.match(second.message, /Noise: 406 Telegram messages sent\. 1 failed or not confirmed\. Source: Telegram connector status\./);
});

test('an unreadable connector is named, not counted as zero', () => {
  const t = setup();
  t.world.telegram = null;
  assert.match(t.run('--until', SUNDAY), /Noise: not read\. bb telegram status failed\./);
});
