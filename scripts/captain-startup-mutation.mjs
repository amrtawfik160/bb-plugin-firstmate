// Causal regressions run in an isolated copy; the implementation checkout stays intact.
import assert from 'node:assert/strict';
import {cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

const root = resolve('.');
const copy = mkdtempSync(join(tmpdir(), 'fm-captain-mutation-'));
try {
  for (const file of ['package.json','rpc.ts','server.ts','server.captain-startup.test.mjs','lib','overlay','scripts']) {
    cpSync(join(root,file),join(copy,file),{recursive:true});
  }
  symlinkSync(join(root,'node_modules'),join(copy,'node_modules'),'dir');
  function check(name,file,from,to,test,pattern,diagnostic) {
    const path=join(copy,file), saved=readFileSync(path,'utf8');
    assert.ok(saved.includes(from),`mutation anchor missing: ${name}`);
    try {
      writeFileSync(path,saved.replace(from,to));
      const result=spawnSync(process.execPath,['--test','--experimental-strip-types',`--test-name-pattern=${pattern}`,test],{cwd:copy,encoding:'utf8',timeout:35000,maxBuffer:2*1024*1024});
      assert.equal(result.status,1,result.stdout+result.stderr);
      assert.match(result.stdout+result.stderr,diagnostic);
      console.log(`KILLED ${name}`);
    } finally {writeFileSync(path,saved);}
  }
  check('bare deck scans fleet before returning','server.ts',
    '(!current.fullParityOnDeck||all||digest)?','true?',
    'server.captain-startup.test.mjs','captain cli first binding.*1f3e7696',/AssertionError/);
  check('watcher registration precedes home binding','server.ts',
    "stage('native home binding');const setup=", "await rememberWatchCaptain(ctx,threadId);stage('native home binding');const setup=",
    'server.captain-startup.test.mjs','failed clone',/AssertionError/);
  check('bound startup falls back to shared source home','server.ts',
    'if (startup!==null && current.fullParityOnDeck && !homeScope.getStore()?.home)',
    'if (false && startup!==null && current.fullParityOnDeck && !homeScope.getStore()?.home)',
    'server.captain-startup.test.mjs','unbound ACP',/AssertionError/);
  check('native read-only dependency probe is unbounded','overlay/bin/fm-bb-probe-lib.sh',
    'fm_run_timed 5 "$@"','"$@"',
    'scripts/captain-startup-native.test.mjs','native 2d833ff1 names bounded no-mistakes',/AssertionError/);
  check('native feature help loses stderr','overlay/bin/fm-bb-probe-lib.sh',
    'fm_run_timed 5 "$@" </dev/null 2>&1','fm_run_timed 5 "$@" </dev/null 2>/dev/null',
    'scripts/captain-startup-native.test.mjs','native 2d833ff1 feature probes preserve',/AssertionError/);
  check('bound adapter reinstalled on every deck','server.ts',
    'if (verifyFirst) {','if (false && verifyFirst) {',
    'server.captain-startup.test.mjs','captain cli first binding.*1f3e7696',/AssertionError/);
  check('mandatory contract read awaits a hung SDK without cancellation','server.ts',
    'await raceAbort(bb.sdk.files.read({ hostId, path }), signal, STUCK_HOST_CALL_MS)',
    'await bb.sdk.files.read({ hostId, path })',
    'server.captain-startup.test.mjs','captain cli contract cancellation',/contract read hung/);
  console.log('Source checkout untouched; all mutation copies restored.');
} finally {rmSync(copy,{recursive:true,force:true});}
