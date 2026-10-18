import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('a failing test that made temp folders', async () => {
  writeFileSync(join(mkdtempSync(join(tmpdir(), 'fm-fixture-sync-')), 'f'), 'x');
  await mkdtemp(join(tmpdir(), 'fm-fixture-async-'));
  // A script the test starts writes into the same root.
  execFileSync('sh', ['-c', 'mkdir "${TMPDIR:?}/fm-fixture-child"']);
  assert.fail('fails on purpose');
});
