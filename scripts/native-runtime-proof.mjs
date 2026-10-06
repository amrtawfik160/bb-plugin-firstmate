// Real pinned scripts under the invoking harness, owned disposable home only.
// BB transport records reads; model launches and forge mutations are forbidden.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,readdirSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {runtimeFixture,distribution} from './native-runtime-fixture.mjs';
import {captainStartupCommand} from '../server.ts';
const evidence=resolve(process.argv[2]??'/tmp/fm-self-contained-runtime-proof');mkdirSync(evidence,{recursive:true});
const f=runtimeFixture();let root;
try {
 const begin=Date.now();root=f.ready();const installBindMs=Date.now()-begin;
 mkdirSync(join(f.directory,'bin'));const log=join(f.directory,'bb-commands');writeFileSync(join(f.directory,'bin/bb'),'#!/bin/sh\nprintf "%s\\n" "$*" >> "$BB_FIXTURE_LOG"\nprintf "{}\\n"\n',{mode:0o755});writeFileSync(join(f.home,'config/crew-harness'),'cursor\n');writeFileSync(join(f.home,'state/sentinel.status'),'retained unhandled report\n');
 const command=captainStartupCommand(f.home,'session-start');const started=Date.now();const result=spawnSync('bash',['-c',command],{encoding:'utf8',timeout:125000,maxBuffer:8*1024*1024,env:{...process.env,HOME:f.directory,PATH:`${f.directory}/bin:${process.env.PATH}`,BB_FIXTURE_LOG:log,FM_STATE_OVERRIDE:join(f.home,'state'),FM_CONFIG_OVERRIDE:join(f.home,'config'),FM_BOOTSTRAP_NETWORK:'skip'}});const startupMs=Date.now()-started,output=result.stdout+result.stderr;
 writeFileSync(join(evidence,'startup.output'),output);const calls=(()=>{try{return readFileSync(log,'utf8');}catch{return '';}})();writeFileSync(join(evidence,'bb-commands'),calls);
 assert.equal(result.status,0,output);assert.match(output,/lock acquired: harness pid [0-9]+/);assert.match(output,/BOOTSTRAP/);assert.match(output,/WAKE QUEUE/);assert.match(output,/NEXT STEP/);assert.doesNotMatch(output,/^●  STARTUP TRUNCATED|^error: cannot locate harness|MISSING:|MISSING_MANUAL:|BACKEND_INVALID:|BB_STARTUP_PROBE_FAILED:/m);assert.doesNotMatch(calls,/(?:^|\s)(?:spawn|send|retry|dispatch|create|delete)(?:\s|$)/m);assert.equal(readFileSync(join(f.home,'state/sentinel.status'),'utf8'),'retained unhandled report\n');assert.ok(!command.includes('/root/firstmate'));
 const proof={release:distribution.release,upstreamCommit:distribution.upstreamCommit,snapshotCommit:distribution.snapshotCommit,archiveBytes:distribution.archiveBytes,installBindMs,startupMs,home:f.home,runtime:root,exit:result.status,realNative:true,realBBHostTransport:false,realModelWorker:false,externalNativeRepositoryUsed:false};writeFileSync(join(evidence,'result.json'),JSON.stringify(proof,null,2)+'\n');console.log(JSON.stringify(proof));
} finally {
 for(const pid of readdirSync('/proc').filter(p=>/^\d+$/.test(p)))try{const args=readFileSync(`/proc/${pid}/cmdline`,'utf8').replaceAll('\0',' ');if(root&&args.includes(`${root}/bin-bb/fm-`))process.kill(Number(pid),'SIGTERM');}catch{}
 await new Promise(r=>setTimeout(r,100));f.clean();
}
