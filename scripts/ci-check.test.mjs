import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync,readdirSync,mkdtempSync,writeFileSync,rmSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
import {coverage,ciEnvironment,assertNoSkippedTests,environmentFiles} from './ci-check.mjs';
test('CI coverage accounts every package test file; environment exclusions are explicit and cannot go stale',()=>{
 const packageJson=JSON.parse(readFileSync('package.json'));const plan=coverage(packageJson.scripts.test);
 assert.ok(plan.files.includes('server.launch-delivery.test.mjs'));assert.ok(plan.files.includes('lib/policy.differential.test.ts'));
 assert.equal(plan.files.length+Object.keys(environmentFiles).length,packageJson.scripts.test.match(/\S+\.test\.(?:ts|mjs)/g).length);
 const registered=packageJson.scripts.test.match(/\S+\.test\.(?:ts|mjs)/g).sort();
 const discovered=['.','lib','scripts'].flatMap(dir=>readdirSync(dir).filter(name=>/\.test\.(ts|mjs)$/.test(name)).map(name=>dir==='.'?name:dir+'/'+name)).sort();
 assert.deepEqual(registered,discovered,'colocated tests must remain wired to the package test command');
 assert.throws(()=>coverage(packageJson.scripts.test.replace('server.test.ts','')),/coverage drift/);
});
test('clean CI resolves the locked native backlog CLI while refusing real BB transport',()=>{
 const bin=mkdtempSync(join(tmpdir(),'fm-ci-prerequisite-'));
 try {
  writeFileSync(join(bin,'bb'),'#!/bin/sh\nexit 97\n',{mode:0o755});
  const env=ciEnvironment('/owned/native',bin);
  const located=spawnSync('bash',['-c','command -v tasks-axi'],{env,encoding:'utf8'});
  assert.equal(located.status,0,located.stderr);
  assert.equal(realpathSync(located.stdout.trim()),resolve('scripts/ci-tools/node_modules/tasks-axi/dist/bin/tasks-axi.js'),'native tests must not depend on a globally installed tasks-axi');
  const version=spawnSync('tasks-axi',['--version'],{env,encoding:'utf8'});
  assert.equal(version.status,0,version.stderr);assert.equal(version.stdout.trim(),'0.2.6');
  assert.equal(JSON.parse(readFileSync('scripts/ci-tools/package.json')).dependencies['tasks-axi'],'0.2.6');
  assert.equal(spawnSync('bb',['thread','spawn'],{env}).status,97,'the fixture BB must still take precedence');
 }finally{rmSync(bin,{recursive:true,force:true});}
});
test('CI has no inherited BB routing, explicit native fixtures and no tolerated skipped assertions',()=>{
 const env=ciEnvironment('/owned/native','/owned/bin');assert.equal(env.BB_CLI,undefined);assert.equal(env.BB_SERVER_URL,undefined);assert.equal(env.FM_TEST_HOME,'/owned/native');assert.equal(env.FM_CLASSIFY_LIB,'/owned/native/bin/fm-classify-lib.sh');assert.ok(env.PATH.startsWith('/owned/bin:'));
 assertNoSkippedTests('# skipped 0\n');assert.throws(()=>assertNoSkippedTests('# skipped 1\n'),/zero skipped/);assert.throws(()=>assertNoSkippedTests(''),/zero skipped/);
 const workflow=readFileSync('.github/workflows/checks.yml','utf8');for(const command of ['npm ci','npm run typecheck','npm run fidelity','npm run runtime:verify','npm run test:ci','bb plugin build .'])assert.ok(workflow.includes(command));
 for(const pin of Object.keys(JSON.parse(readFileSync('overlay/patch-sets.json')).sets))assert.ok(workflow.includes(pin+':refs/heads/audited-'),'both exact sources must remain reachable when tests clone the fixture');
 assert.equal(JSON.parse(readFileSync('scripts/ci-tools/package.json')).dependencies['bb-app'],'0.44.0');
});
