import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {fixture,pins,run,ok} from './prompt-fixture.mjs';
function probes(home,tool){
 const bin=join(home,'probe-bin');mkdirSync(bin);const actual=ok(run('bash',['-c',`command -v ${tool}`])).trim();
 writeFileSync(join(bin,tool),`#!/bin/sh\nif [ "$1" = --version ]; then exec sleep 9; fi\nexec '${actual.replaceAll("'","'\\''")}' "$@"\n`,{mode:0o755});
 return{...process.env,PATH:`${bin}:${process.env.PATH}`,FM_HOME:home,FM_ROOT_OVERRIDE:home,FM_BACKEND:'bb',FM_BOOTSTRAP_DETECT_ONLY:'1',FM_BOOTSTRAP_NETWORK:'skip'};
}
for(const pin of pins)for(const tool of ['no-mistakes','tasks-axi','quota-axi'])test(`native ${pin.slice(0,8)} names bounded ${tool} prerequisite refusal without losing other diagnostics`,()=>{
 const home=fixture(pin);try{
 ok(run('python3',['overlay/install-bb-backend.py','--home',home]));const env=probes(home,tool);const r=spawnSync('bash',[join(home,'bin-bb/fm-bootstrap.sh')],{env,encoding:'utf8',timeout:60000});assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout+r.stderr,new RegExp(`BB_STARTUP_PROBE_FAILED: ${tool} --version \\(exit=124`));assert.match(r.stdout,new RegExp(`MISSING: ${tool}`));assert.equal(ok(run('git',['-C',home,'diff','--','bin'])), '');
 }finally{rmSync(home,{recursive:true,force:true});}
});
for(const pin of pins)test(`native ${pin.slice(0,8)} BB does not require inactive Cursor CLI; non-BB harness detection stays native`,()=>{
 const home=fixture(pin),runtime=mkdtempSync(join(tmpdir(),'fm-captain-provider-'));try{
 ok(run('python3',['overlay/install-bb-backend.py','--home',home]));writeFileSync(join(home,'config/crew-harness'),'cursor\n');const bin=join(runtime,'bin');mkdirSync(bin);
 for(const command of ['bb','node','no-mistakes','gh-axi','lavish-axi','quota-axi','tasks-axi']){
  const actual=ok(run('bash',['-c',`command -v ${command}`])).trim();symlinkSync(actual,join(bin,command));
 }
 const env={...process.env,HOME:runtime,PATH:`${bin}:/usr/bin:/bin`,FM_HOME:home,FM_ROOT_OVERRIDE:home,FM_BOOTSTRAP_DETECT_ONLY:'1',FM_BOOTSTRAP_NETWORK:'skip'};
 const bb=run('bash',[join(home,'bin-bb/fm-bootstrap.sh')],{...env,FM_BACKEND:'bb'});ok(bb);assert.doesNotMatch(bb.stdout,/MISSING_MANUAL: cursor-agent|MISSING: chrome-devtools/);
 const native=run('bash',[join(home,'bin/fm-bootstrap.sh')],{...env,FM_BACKEND:'tmux'});ok(native);assert.match(native.stdout,/MISSING_MANUAL: cursor-agent/);assert.equal(readFileSync(join(home,'config/crew-harness'),'utf8'),'cursor\n');
 }finally{rmSync(home,{recursive:true,force:true});rmSync(runtime,{recursive:true,force:true});}
});
for(const pin of pins)test(`native ${pin.slice(0,8)} feature probes preserve native help printed on stderr`,()=>{
 const home=fixture(pin);try {
  ok(run('python3',['overlay/install-bb-backend.py','--home',home]));
  const bin=join(home,'probe-bin');mkdirSync(bin);const actual=ok(run('bash',['-c','command -v tasks-axi'])).trim();
  writeFileSync(join(bin,'tasks-axi'),`#!/bin/sh\ncase "$1 $2" in\n 'update --help') printf '%s\\n' --archive-body >&2; exit 0 ;;\n 'mv --help') printf '%s\\n' '[<id>...]' >&2; exit 0 ;;\nesac\nexec '${actual.replaceAll("'","'\\''")}' "$@"\n`,{mode:0o755});
  const env={...process.env,PATH:`${bin}:${process.env.PATH}`,FM_HOME:home,FM_ROOT_OVERRIDE:home,FM_TASKS_AXI_COMPATIBLE:''};
  for(const backend of ['bb','tmux'])ok(run('bash',['-c','. "$1"; fm_tasks_axi_compatible','fixture',join(home,backend==='bb'?'bin-bb':'bin','fm-tasks-axi-lib.sh')],{...env,FM_BACKEND:backend}));
 }finally{rmSync(home,{recursive:true,force:true});}
});
