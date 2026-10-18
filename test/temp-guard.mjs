// `node --test --test-global-setup=./test/temp-guard.mjs`: each test run gets its own temp root.
// Anything a test leaves there fails the run, by name, and is removed.
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let root = '';

export async function globalSetup() {
  root = mkdtempSync(join(tmpdir(), 'fm-test-run-'));
  process.env.TMPDIR = root;
}

export async function globalTeardown() {
  const left = readdirSync(root);
  rmSync(root, { recursive: true, force: true, maxRetries: 2 });
  if (left.length > 0) {
    process.exitCode = 1;
    console.error(`temp-guard: tests left ${left.length} temp folder(s) behind (now removed): ${left.sort().join(', ')}`);
  }
}
