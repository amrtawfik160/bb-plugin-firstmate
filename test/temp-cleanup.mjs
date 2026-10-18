// Loaded into every test process (`node --test --import ./test/temp-cleanup.mjs`). Firstmate tests
// left about 20 GB of temp folders in /tmp in 3 days (18 Oct). Each test file's process gets its
// own temp root, named after the file, and TMPDIR points at it, so the scripts and tools a test
// starts write there too. The root and every folder the process made with mkdtemp are removed
// when the process exits, also after a failed test.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

const made = new Set();
const track = (dir) => { if (typeof dir === 'string') made.add(dir); return dir; };
const { mkdtemp, mkdtempSync } = fs;
const promiseMkdtemp = fs.promises.mkdtemp;
fs.mkdtempSync = (...args) => track(mkdtempSync(...args));
fs.mkdtemp = (prefix, ...rest) => {
  const callback = rest.pop();
  return mkdtemp(prefix, ...rest, (error, dir) => callback(error, error ? dir : track(dir)));
};
fs.promises.mkdtemp = async (...args) => track(await promiseMkdtemp(...args));
syncBuiltinESMExports();

// Only a test file's own process; the runner process keeps the run's root (test/temp-guard.mjs).
if (process.env.NODE_TEST_CONTEXT !== undefined) {
  process.env.TMPDIR = fs.mkdtempSync(join(tmpdir(), `fm-test-${basename(process.argv[1] ?? 'node')}-`));
}

process.once('exit', () => {
  for (const dir of [...made].reverse()) {
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 2 }); } catch { /* the run guard reports what is left */ }
  }
});
