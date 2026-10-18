import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

// A test process killed before it exits (a timeout, the OOM killer) cannot clean up.
test('a test whose process is killed after it made a temp folder', () => {
  mkdirSync(join(tmpdir(), 'fm-fixture-leak'));
  process.kill(process.pid, 'SIGKILL');
});
