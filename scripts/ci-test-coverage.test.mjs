import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { coverage, load } from './ci-test-coverage.mjs';

const REASON = 'needs a signed-in BB desktop session, which no hosted runner has';

test('every listed test file runs when nothing is skipped', () => {
  const result = coverage({ tracked: ['a.test.ts', 'lib/b.test.mjs', 'lib/b.ts'], listed: ['a.test.ts', 'lib/b.test.mjs'], skipped: {} });
  assert.deepEqual(result, { run: ['a.test.ts', 'lib/b.test.mjs'], skipped: [], errors: [] });
});

test('a tracked test file outside the package.json list is an error', () => {
  const result = coverage({ tracked: ['a.test.ts', 'lib/new.test.ts'], listed: ['a.test.ts'], skipped: {} });
  assert.deepEqual(result.errors, ['lib/new.test.ts: tracked test file is not in the package.json test list, so nothing runs it']);
});

test('a skip needs a reason and a listed file, and leaves the run list', () => {
  const ok = coverage({ tracked: ['a.test.ts', 'b.test.ts'], listed: ['a.test.ts', 'b.test.ts'], skipped: { 'b.test.ts': REASON } });
  assert.deepEqual(ok, { run: ['a.test.ts'], skipped: ['b.test.ts'], errors: [] });
  const bad = coverage({ tracked: ['a.test.ts'], listed: ['a.test.ts'], skipped: { 'a.test.ts': 'flaky', 'gone.test.ts': REASON } });
  assert.deepEqual(bad.errors, [
    'a.test.ts: a CI skip needs a reason of at least 20 characters',
    'gone.test.ts: on the CI skip list but not in the package.json test list',
  ]);
});

test('vendored upstream trees are not this repository\'s tests; a listed file must exist', () => {
  const result = coverage({ tracked: ['native-snapshot/1f3e7696/tests/x.test.ts', 'third-party/y.test.mjs', 'a.test.ts'], listed: ['a.test.ts', 'typo.test.ts'], skipped: {} });
  assert.deepEqual(result.errors, ['typo.test.ts: in the package.json test list but not a tracked test file']);
});

test('this repository: every tracked test file is run by CI or skipped with a reason, and CI uses this list', () => {
  const result = coverage(load());
  assert.deepEqual(result.errors, []);
  assert.ok(result.run.includes('server.test.ts') && result.run.includes('scripts/ci-test-coverage.test.mjs'), 'the large files run');
  const workflow = readFileSync('.github/workflows/checks.yml', 'utf8');
  assert.match(workflow, /node scripts\/ci-test-coverage\.mjs\n/, 'the coverage job runs the check');
  assert.match(workflow, /files=\$\(node scripts\/ci-test-coverage\.mjs --run-list\)/, 'the test step takes its files from the same list');
  assert.doesNotMatch(workflow, /host_only|self-hosted/, 'no second skip list and no self-hosted runner on a public repository');
});
