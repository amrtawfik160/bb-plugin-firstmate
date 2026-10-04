// Isolated checkout only. The real factory/configure callback is exercised.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const original = readFileSync('server.ts', 'utf8');
const mutations = [
  ['remove worker route', 'skills: ["worker-methods"],', 'skills: [],'],
  ['leak captain helper to workers', 'skills: ["worker-methods"],', 'skills: ["worker-methods", "captain-methods"],'],
  ['remove captain route', '"catch-up", "captain-methods", ...UPSTREAM_SKILL_NAMES', '"catch-up", ...UPSTREAM_SKILL_NAMES'],
  ['remove completion/report pointer', 'Read captain-methods at assignment, completion, and required-report triggers; load only its matching reference.', 'No method pointer.'],
];
try {
  for (const [label, before, after] of mutations) {
    assert.equal(original.split(before).length, 2, `unique mutation anchor: ${label}`);
    writeFileSync('server.ts', original.replace(before, after));
    const result = spawnSync(process.execPath, ['--test', '--experimental-strip-types',
      '--test-name-pattern=role methods route|saturated captain instruction budget', 'server.methods.test.mjs'],
    { encoding: 'utf8', timeout: 30_000 });
    assert.equal(result.error, undefined, label);
    assert.notEqual(result.status, 0, `mutation survived: ${label}`);
    assert.match(result.stdout + result.stderr, /ERR_ASSERTION/, `test must fail on an assertion: ${label}`);
    console.log(`KILLED: ${label}; actual role configuration/budget assertions failed.`);
    writeFileSync('server.ts', original);
  }
} finally { writeFileSync('server.ts', original); }
