#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'fm-supervisor-mutations-'));
const cases = [
  ['disable routine batching', 'batchMs > 0', 'batchMs < 0', 'routine durable plugin wakes batch'],
  ['remove scope requirement', '.filter(({ score }) => score > 0)', '.filter(({ score }) => score >= 0)', 'scope word overlap'],
  ['ignore typed urgency', '&& !urgent && batchMs', '&& batchMs', 'interaction urgency'],
  ['make lock waiting uninterruptible', 'return raceAbort(run, signal, STUCK_HOST_CALL_MS);', 'return run;', 'batch timer send'],
  ['lock every callback behind its caller', 'return ["queue", "decide", "firstmate_queue", "firstmate_decide"].includes(name)', 'return true', 'self-deadlock'],
  ['leave receipt ready during external effects', 'if (id) await journal("begin-action");', 'if (id) await journal("inspect");', 'IT receipts replay'],
];
try {
  cpSync(root, scratch, { recursive: true, filter: path => !['.git', 'node_modules', '.bb', 'dist'].includes(path.split('/').at(-1)) });
  symlinkSync(join(root, 'node_modules'), join(scratch, 'node_modules'));
  const source = readFileSync(join(scratch, 'server.ts'), 'utf8');
  const pattern = cases.map(c => c[3]).join('|');
  const run = name => spawnSync(process.execPath, ['--experimental-strip-types', '--test', '--test-name-pattern', name, 'server.test.ts'], { cwd: scratch, encoding: 'utf8', timeout: 60000 });
  const baseline = run(pattern);
  assert.equal(baseline.status, 0, baseline.stdout + baseline.stderr);
  assert.doesNotMatch(baseline.stdout, /# SKIP/);
  for (const [name, before, after, test] of cases) {
    assert.ok(source.includes(before), `mutation anchor missing: ${name}`);
    writeFileSync(join(scratch, 'server.ts'), source.replace(before, after));
    const result = run(test);
    assert.notEqual(result.status, 0, `SURVIVED: ${name}\n${result.stdout}`);
    assert.match(result.stdout + result.stderr, /AssertionError|ERR_ASSERTION|release service blocked behind unsignalled timer lock|native callback deadlocked/, `mutation must fail an assertion, not loading: ${name}\n${result.stdout}${result.stderr}`);
    console.log(`KILLED: ${name} → ${test}`);
  }
} finally { rmSync(scratch, { recursive: true, force: true }); }
