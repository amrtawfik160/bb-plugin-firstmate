// Tests must never reach the real BB CLI (test/no-live-bb.mjs, test/no-live-bb/bb). On 20 Oct a
// full run started at SHLVL=0; each test's bash read the host's ~/.bashrc, which put the real bb
// ahead of the test's fake, and the dev-link test ran a real `bb connect expose`.
// These checks use only disposable stand-ins: a decoy bb in a throwaway HOME's .bashrc.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const root = new URL('..', import.meta.url).pathname;

function lab() {
  const dir = mkdtempSync(join(tmpdir(), 'fm-no-live-bb-'));
  const fake = join(dir, 'fake'), decoy = join(dir, 'decoy'), home = join(dir, 'home');
  for (const path of [fake, decoy, home]) mkdirSync(path);
  writeFileSync(join(fake, 'bb'), '#!/bin/sh\necho FAKE\n', { mode: 0o755 });
  writeFileSync(join(decoy, 'bb'), '#!/bin/sh\necho DECOY\nexit 97\n', { mode: 0o755 });
  // Like this host's ~/.bashrc: a toolchain PATH line that runs before any non-interactive return.
  writeFileSync(join(home, '.bashrc'), `export PATH="${decoy}:$PATH"\n[ -z "$PS1" ] && return\n`);
  return { dir, fake, home };
}

// A test process, started at the given shell level, runs `bash -c` with the fake first on PATH and
// Node's default (socket) stdin, as the dev-link test does.
function testProcess(l, shlvl, preload) {
  const child = `const {spawnSync}=require('node:child_process');process.stdout.write(spawnSync('bash',['-c','bb'],{encoding:'utf8',env:{...process.env,PATH:${JSON.stringify(l.fake)}+':'+process.env.PATH}}).stdout)`;
  const env = { ...process.env, HOME: l.home, SHLVL: shlvl, BB_CLI: '/nonexistent/bb' };
  const args = [...(preload ? ['--import', join(root, 'test/no-live-bb.mjs')] : []), '-e', child];
  return spawnSync(process.execPath, args, { encoding: 'utf8', env });
}

test('a test started at shell level 0 reaches the decoy without the preload, and its own fake with it', () => {
  const l = lab();
  try {
    const bare = testProcess(l, '0', false);
    assert.equal(bare.stdout.trim(), 'DECOY', `the hazard did not reproduce: ${bare.stderr}`);
    for (const shlvl of ['0', '', 'x']) {
      const guarded = testProcess(l, shlvl, true);
      assert.equal(guarded.status, 0, guarded.stderr);
      assert.equal(guarded.stdout.trim(), 'FAKE', `SHLVL=${JSON.stringify(shlvl)}`);
    }
  } finally { rmSync(l.dir, { recursive: true, force: true }); }
});

test('the preload drops BB_CLI and keeps a shell level a test sets itself', () => {
  const read = (env) => spawnSync(process.execPath, ['--import', join(root, 'test/no-live-bb.mjs'), '-e', 'process.stdout.write(JSON.stringify([process.env.SHLVL,process.env.BB_CLI??null]))'],
    { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.deepEqual(JSON.parse(read({ SHLVL: '3', BB_CLI: '/real/bb' }).stdout), ['3', null]);
  assert.deepEqual(JSON.parse(read({ SHLVL: '0' }).stdout), ['1', null]);
});

test('npm test puts a blocking bb first on PATH, which refuses and logs every call', () => {
  const script = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).scripts.test;
  assert.match(script, /PATH="\$PWD\/test\/no-live-github:\$PWD\/test\/no-live-bb:\$PATH"/);
  assert.match(script, /--import \.\/test\/no-live-bb\.mjs/);
  assert.match(script, /-u BB_CLI /);
  const workflow = readFileSync(join(root, '.github/workflows/checks.yml'), 'utf8');
  assert.match(workflow, /--import \.\/test\/no-live-bb\.mjs/);
  const dir = mkdtempSync(join(tmpdir(), 'fm-no-live-bb-log-'));
  try {
    const log = join(dir, 'calls');
    const run = spawnSync(join(root, 'test/no-live-bb/bb'), ['connect', 'expose', '5200', '--json'], { encoding: 'utf8', env: { ...process.env, FM_LIVE_BB_LOG: log } });
    assert.equal(run.status, 97);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /live bb call blocked in tests: bb connect expose 5200 --json/);
    assert.equal(readFileSync(log, 'utf8'), 'bb connect expose 5200 --json\n');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
