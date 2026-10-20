import {cpSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync, readFileSync,chmodSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import assert from 'node:assert/strict';
import {nativeWatchSourceScript,parseNativeWatchSource} from '../lib/captain-watch-need.ts';
import {runtimeFixture} from './native-runtime-fixture.mjs';
const fixture=runtimeFixture(),fixtureBin=join(fixture.ready(),'bin');
const base=mkdtempSync(join(tmpdir(),'verify-180-probes-'));mkdirSync(base,{recursive:true});
const releases=join(fixture.store,'versions');
const env={...process.env,HOME:join(base,'home')};delete env.BB_THREAD_ID;
for(const release of readdirSync(releases)) {
 const bin=join(base,release,'bin');cpSync(join(releases,release,'runtime/bin'),bin,{recursive:true,dereference:true});
 const results={release};
 for(const scenario of ['empty','away','check','queue','paused','signal','seen','secondmate','inbox']) {
  const home=join(base,release,scenario),state=join(home,'state');mkdirSync(state,{recursive:true});
  const file=(name,text)=>writeFileSync(join(state,name),text);
  if(scenario==='away')file('.afk','');
  if(scenario==='check')file('c.check.sh','#!/bin/sh\n');
  if(scenario==='queue')file('.wake-queue','1\t1\tsignal\tc.status\tnew report\n');
  if(['paused','signal','seen','secondmate','inbox'].includes(scenario))file('c.meta',`kind=${scenario==='secondmate'?'secondmate':'ship'}\n`);
  if(scenario==='paused')file('c.status',`paused: waiting on owner [at=${Math.floor(Date.now()/1000)}]\n`);
  if(['signal','seen'].includes(scenario))file('c.status',`done: shipped [at=${Math.floor(Date.now()/1000)}]\n`);
  const prefix=`export FM_HOME='${home}' FM_STATE_OVERRIDE='${state}'; . '${bin}/fm-wake-lib.sh'; . '${bin}/fm-classify-lib.sh'; `;
  if(scenario==='seen')assert.equal(spawnSync('bash',['-c',prefix+`fm_wake_status_mark_current '${state}' '${state}/c.status'`],{env,encoding:'utf8'}).status,0);
  if(scenario==='inbox'){mkdirSync(join(state,'c.inbox'));file('c.inbox/000001.msg','instruction');}
  const script=nativeWatchSourceScript({binDirAssign:`FM_BINDIR='${bin}'; FM_BUNDLED_VERIFIED=1`,fmHome:home,stateDir:state});
  const result=spawnSync('bash',['-c',script],{env,encoding:'utf8'});
  const source=parseNativeWatchSource(result.stdout);assert.equal(result.status,0,result.stderr);
  const expected={empty:'none',away:'none',check:'check',queue:'wake-queue',paused:'declared-wait',signal:'unsurfaced-signal',seen:'none',secondmate:'secondmate',inbox:'steering-inbox'}[scenario];
  results[scenario]=source;assert.ok(source===expected||source==='unreadable',JSON.stringify({release,scenario,source,expected,stderr:result.stderr}));
 }
 console.log(JSON.stringify(results));
}
console.log('PASS: copied pinned runtimes preserve sources or fail safe');
const durabilityHome=join(base,'durability'),durabilityState=join(durabilityHome,'state');mkdirSync(durabilityState,{recursive:true});
const packaged=fixtureBin;
const durabilityEnv={...env,FM_HOME:durabilityHome,FM_STATE_OVERRIDE:durabilityState,FM_ROOT_OVERRIDE:durabilityHome};
const stop=spawnSync('bash',[join(packaged,'fm-watch-arm.sh'),'--stop'],{env:durabilityEnv,encoding:'utf8'});assert.equal(stop.status,0,stop.stderr);assert.match(stop.stdout,/none running/);
const append=spawnSync('bash',['-c',`. '${packaged}/fm-wake-lib.sh'; fm_wake_append check verify180 'check: wake written while stopped'`],{env:durabilityEnv,encoding:'utf8'});assert.equal(append.status,0,append.stderr);
const receive=(action='receive',id='')=>{const r=spawnSync('python3',['overlay/bin/bb-wake-receipt.py',durabilityState,action,id,join(packaged,'fm-wake-drain.sh')],{env:durabilityEnv,encoding:'utf8',timeout:15000});assert.equal(r.status,0,r.stderr);return JSON.parse(r.stdout.trim().slice('FM_BB_RECEIPT='.length));};
const first=receive();assert.ok(first.id);assert.match(first.report,/wake written while stopped/);assert.equal(receive().id,first.id);
assert.equal(receive('complete',first.id).id,null);assert.equal(receive().id,null);assert.equal(readFileSync(join(durabilityState,'.wake-queue'),'utf8'),'');
console.log('PASS: real packaged stop (empty temporary home), append while stopped, receive/replay, complete once, no redelivery');
const unreadable=join(base,'unreadable'),state=join(unreadable,'state');
mkdirSync(state,{recursive:true});writeFileSync(join(state,'critical.check.sh'),'#!/bin/sh\n');chmodSync(state,0o000);
const script=nativeWatchSourceScript({binDirAssign:'FM_BINDIR=/nonexistent; FM_BUNDLED_VERIFIED=1',fmHome:unreadable,stateDir:state});
const result=spawnSync('setpriv',['--reuid=65534','--regid=65534','--clear-groups','bash','-c',script],{env,encoding:'utf8'});
chmodSync(state,0o755);
console.log(JSON.stringify({scenario:'unreadable-state-containing-check',expected:'unreadable',actual:parseNativeWatchSource(result.stdout),exit:result.status,stderr:result.stderr}));
