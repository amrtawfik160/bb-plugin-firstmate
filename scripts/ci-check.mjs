// Offline assertions with explicit environment-only coverage. No model transport.
import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

export const environmentFiles={
 'server.test.ts':'Full native integration and installed tool CLIs; run npm test on the acceptance host.',
 'scripts/plugin-package-discovery.test.mjs':'Installed official BB server/host package; owned actual loader acceptance.',
 'scripts/captain-startup-native.test.mjs':'Installed no-mistakes/tasks-axi/quota-axi and browser/Lavish CLIs.',
 'scripts/native-runtime.test.mjs':'Native worker/secondmate startup prerequisite CLIs.',
 'scripts/native-compat.test.mjs':'Native secondmate startup prerequisite CLIs.',
 'server.native-policy.test.mjs':'Real native registry/backlog intake uses tasks-axi.',
 'server.native-crew-state.test.mjs':'Native completion gates use installed external CLIs.',
 'server.queue-storage.test.mjs':'Real tasks-axi backlog integration.',
 'server.captain-startup.test.mjs':'Actual native bootstrap prerequisites include no-mistakes.',
 'server.native-runtime.test.mjs':'Actual deck/native bootstrap requires installed no-mistakes.',
};
export function coverage(command) {
 const tokens=command.split(/\s+/);const files=tokens.filter(t=>/\.test\.(?:ts|mjs)$/.test(t));
 if (!files.length || new Set(files).size!==files.length) throw new Error('Test command has no unique explicit file inventory.');
 for(const file of Object.keys(environmentFiles))if(!files.includes(file))throw new Error('Environment coverage drift: '+file);
 return {files:files.filter(f=>!(f in environmentFiles)),environmentOnly:environmentFiles};
}
export function ciEnvironment(native,bin) {
 const env={...process.env};
 for(const key of Object.keys(env))if(key.startsWith('BB_') || key.startsWith('FM_') || key.startsWith('FIRSTMATE_'))delete env[key];
 // No external Firstmate fallback or inherited model/host routing in this profile.
 // Native adoption uses the real backlog CLI from the CI lockfile, never a
 // separately managed global install. The owned BB refusal stays first.
 return {...env,PATH:`${bin}:${resolve('scripts/ci-tools/node_modules/.bin')}:${dirname(process.execPath)}:/usr/bin:/bin`,
  FIRSTMATE_TEST_NATIVE:native,FM_TEST_HOME:native,FM_SCOUT_NATIVE_BIN:join(native,'bin-bb'),FM_CLASSIFY_LIB:join(native,'bin/fm-classify-lib.sh')};
}
export function assertNoSkippedTests(output) {
 const matches=[...output.matchAll(/^# skipped (\d+)$/gm)];
 if(matches.length!==1 || Number(matches[0][1])!==0)throw new Error('CI profile must finish with zero skipped tests. Inspect explicit environment coverage instead of masking omissions.');
}
export function runCi(native) {
 if(!native)throw new Error('Set FIRSTMATE_TEST_NATIVE to an owned fixture containing both audited commits; CI workflow prepares exact pins.');
 const pins=Object.keys(JSON.parse(readFileSync('overlay/patch-sets.json')).sets);
 for(const pin of pins){const r=spawnSync('git',['-C',native,'cat-file','-e',pin],{encoding:'utf8'});if(r.status!==0)throw new Error('Owned native fixture lacks audited commit '+pin);}
 const plan=coverage(JSON.parse(readFileSync('package.json')).scripts.test);
 console.log(JSON.stringify({profile:'clean-ci',testFiles:plan.files,environmentOnly:plan.environmentOnly,liveModelAcceptance:'required separately, never replaced by this profile'}));
 const owned=mkdtempSync(join(tmpdir(),'fm-ci-')),bin=join(owned,'bin');mkdirSync(bin);
 writeFileSync(join(bin,'bb'),'#!/bin/sh\nprintf "%s\\n" "CI refuses real BB operations: $*" >&2\nexit 97\n',{mode:0o755});
 try {
  const r=spawnSync(process.execPath,['--test','--experimental-strip-types','--test-reporter=tap',...plan.files],{encoding:'utf8',env:ciEnvironment(resolve(native),bin),timeout:300_000,maxBuffer:16*1024*1024});
  process.stdout.write(r.stdout??'');process.stderr.write(r.stderr??'');
  if(r.status!==0)throw new Error('CI test profile failed: '+(r.error?.message??r.status));
  assertNoSkippedTests(r.stdout);
 } finally {rmSync(owned,{recursive:true,force:true});}
}
if(process.argv[1] && import.meta.url===pathToFileURL(resolve(process.argv[1])).href)runCi(process.env.FIRSTMATE_TEST_NATIVE);
