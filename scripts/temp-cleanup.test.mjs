// 18 Oct: Firstmate tests left about 20 GB of temp folders in /tmp in 3 days. Every test process
// removes the folders it made with mkdtemp, also after a failure (test/temp-cleanup.mjs), and a
// run fails when anything is left in its temp root (test/temp-guard.mjs).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function run(fixture) {
  // A nested run must not report into this run's test context.
  const { NODE_TEST_CONTEXT: _context, ...env } = process.env;
  const outer = mkdtempSync(join(tmpdir(), 'fm-guard-outer-'));
  try {
    const result = spawnSync(process.execPath, ['--test', '--import', './test/temp-cleanup.mjs', '--test-global-setup=./test/temp-guard.mjs', fixture],
      { encoding: 'utf8', env: { ...env, TMPDIR: outer }, timeout: 60_000 });
    return { code: result.status, output: `${result.stdout}${result.stderr}`, left: readdirSync(outer) };
  } finally { rmSync(outer, { recursive: true, force: true }); }
}

test('a failing test removes the temp folders it and the scripts it started made', () => {
  const result = run('test/fixtures/temp-fails.fixture.mjs');
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /fails on purpose/);
  assert.doesNotMatch(result.output, /temp-guard/, result.output);
  assert.deepEqual(result.left, []);
});

test('the run fails and names the test file whose killed process left temp folders, then removes them', () => {
  const result = run('test/fixtures/temp-leaks.fixture.mjs');
  assert.equal(result.code, 1, result.output);
  assert.match(result.output, /temp-guard: tests left 1 temp folder\(s\) behind \(now removed\): fm-test-temp-leaks\.fixture\.mjs-\w+/);
  assert.deepEqual(result.left, []);
});

test('the package test script and CI load the cleanup and the guard', async () => {
  const { readFileSync } = await import('node:fs');
  const script = JSON.parse(readFileSync('package.json', 'utf8')).scripts.test;
  const ci = readFileSync('.github/workflows/checks.yml', 'utf8');
  // Both run tests through the one shared test environment (scripts/run-tests.sh).
  assert.match(script, /^sh scripts\/run-tests\.sh /);
  assert.match(ci, /\n\s+sh scripts\/run-tests\.sh \$files\n/);
  const runner = readFileSync('scripts/run-tests.sh', 'utf8');
  assert.match(runner, /--import \.\/test\/temp-cleanup\.mjs/);
  assert.match(runner, /--test-global-setup=\.\/test\/temp-guard\.mjs/);
});
