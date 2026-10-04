// Test the missing-package defect without changing the implementation checkout.
import assert from 'node:assert/strict';
import {cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const root = resolve('.'), copy = mkdtempSync(join(tmpdir(), 'fm-cold-package-mutation-'));
try {
  for (const file of ['package.json', 'rpc.ts', 'server.ts', 'server.methods.test.mjs', 'lib', 'overlay', 'skills', 'scripts']) {
    cpSync(join(root, file), join(copy, file), {recursive: true});
  }
  symlinkSync(join(root, 'node_modules'), join(copy, 'node_modules'), 'dir');
  function killed(name, file, from, to, diagnostic) {
    const path = join(copy, file), original = readFileSync(path, 'utf8');
    assert.ok(original.includes(from), `missing mutation anchor: ${name}`);
    try {
      writeFileSync(path, original.replace(from, to));
      const result = spawnSync(process.execPath, ['--test', '--experimental-strip-types',
        '--test-name-pattern=cold runtime package', 'server.methods.test.mjs'],
      {cwd: copy, encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024});
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, diagnostic);
      console.log(`KILLED ${name}`);
    } finally { writeFileSync(path, original); }
  }
  killed('ordinary runtime packages only firstmate', 'server.ts',
    '[...CAPTAIN_BOOTSTRAP_SKILLS]', '["firstmate"]', /ENOENT.*captain\/SKILL\.md/);
  killed('captain is shipped but calm is absent', 'server.ts',
    '"captain", "calm", "catch-up", "harness-adapters"] as const',
    '"captain", "catch-up", "harness-adapters"] as const', /ENOENT.*calm\/SKILL\.md/);
  killed('calm still points outside its cold reporting package', 'skills/calm/SKILL.md',
    '(references/reporting.md)', '(../captain-methods/references/reporting.md)', /ENOENT.*captain-methods\/references\/reporting\.md/);
  killed('cold startup exposes orchestration tools', 'server.ts',
    'tools: marked ? [...CAPTAIN_TOOLS] : [...CAPTAIN_BOOTSTRAP_TOOLS]',
    'tools: [...CAPTAIN_TOOLS]', /AssertionError/);
  console.log('Source checkout untouched; all isolated mutations restored.');
} finally { rmSync(copy, {recursive: true, force: true}); }
