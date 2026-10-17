import test from 'node:test';
import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {overlay,pins,fixture,run,ok} from './prompt-fixture.mjs';

// Drives the installed bin-bb/fm-watch.sh with native's own watcher test harness:
// 12 windows whose capture takes 1 s each make one pass outlast a 6 s stale grace.
const driver=readFileSync(new URL('./watcher-beat.driver.sh',import.meta.url),'utf8');

test('the installed BB watcher keeps its beacon fresh through a pane scan longer than the stale grace',()=>{
 const home=fixture(pins.at(-1));try {
  ok(run('python3',[join(overlay,'install-bb-backend.py'),'--home',home,'--overlay',overlay]));
  const script=join(home,'tests','bb-watcher-beat.test.sh');writeFileSync(script,driver,{mode:0o755});
  ok(spawnSync('bash',[script],{encoding:'utf8',env:{...process.env,FM_HOME:home},timeout:120000}));
 }finally{rmSync(home,{recursive:true,force:true});}
});

// The beacon now beats mid-scan for liveness, so a pass is marked separately, at the top of each pass.
test('the installed BB watcher marks a finished pass separately from its mid-scan beat',()=>{
 const home=fixture(pins.at(-1));try {
  ok(run('python3',[join(overlay,'install-bb-backend.py'),'--home',home,'--overlay',overlay]));
  const script=join(home,'tests','bb-watcher-pass.test.sh');writeFileSync(script,readFileSync(new URL('./watcher-pass.driver.sh',import.meta.url),'utf8'),{mode:0o755});
  ok(spawnSync('bash',[script],{encoding:'utf8',env:{...process.env,FM_HOME:home},timeout:120000}));
 }finally{rmSync(home,{recursive:true,force:true});}
});
