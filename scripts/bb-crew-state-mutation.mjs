// Causal reversions in a private candidate. No source or deployed home edits.
import assert from 'node:assert/strict';import {cpSync,mkdtempSync,readFileSync,writeFileSync,symlinkSync,rmSync} from 'node:fs';import {join,resolve,basename} from 'node:path';import {tmpdir} from 'node:os';import {spawnSync} from 'node:child_process';
const root=resolve('.'),candidate=mkdtempSync(join(tmpdir(),'fm-crew-state-mutation-'));
const baseline='c7ca7b9';
function old(path){const r=spawnSync('git',['show',baseline+':'+path],{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout;}
function section(s){const a=s.indexOf('diff --git a/bin/fm-busy-lib.sh'),b=s.indexOf('diff --git a/bin/',a+10);assert.ok(a>=0&&b>a);return[a,b];}
function check(args,expected){const r=spawnSync(process.execPath,['--test','--test-reporter=tap','--experimental-strip-types',...args],{cwd:candidate,env:process.env,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});const output=r.stdout+r.stderr;assert.equal(r.status,1,output);assert.doesNotMatch(output,/SyntaxError|ERR_MODULE_NOT_FOUND|installer failed/);for(const match of expected)assert.match(output,match);}
try{
 cpSync(root,candidate,{recursive:true,filter:p=>!['.git','node_modules','dist','__pycache__'].includes(basename(p))});symlinkSync(join(root,'node_modules'),join(candidate,'node_modules'),'dir');
 const patches=['overlay/firstmate-bb-backend.patch','overlay/compat/2d833ff147cd26a5c461e914e06854e0eb2707ce/firstmate-bb-backend.patch'];
 for(const path of patches){const current=readFileSync(join(candidate,path),'utf8'),prior=old(path),[a,b]=section(current),[c,d]=section(prior);writeFileSync(join(candidate,path),current.slice(0,a)+prior.slice(c,d)+current.slice(b));}
 check(['server.native-crew-state.test.mjs'],[/not ok .*native BB crew-state.*2d833ff1/,/not ok .*native BB crew-state.*1f3e7696/,/must reach native DoD, not unknown missing/]);
 console.log('KILLED busy-only BB classification at both audited pins: actual registered native crew-state cannot reconcile settled ship/scout.');
 for(const path of patches)writeFileSync(join(candidate,path),readFileSync(join(root,path)));
 const path='overlay/bin/backends/bb.sh',current=readFileSync(join(candidate,path),'utf8'),prior=old(path),a=current.indexOf('fm_backend_bb_busy_state()'),b=current.indexOf('fm_backend_bb_agent_state()',a),c=prior.indexOf('fm_backend_bb_busy_state()'),d=prior.indexOf('fm_backend_bb_agent_state()',c);
 assert.ok(a>=0&&b>a&&c>=0&&d>c);writeFileSync(join(candidate,path),current.slice(0,a)+prior.slice(c,d)+current.slice(b));
 check(['--test-name-pattern=BB idle transport evidence','lib/bb-activity.test.ts'],[/not ok .*BB idle transport evidence/,/true/,/idle/]);
 console.log('KILLED permissive BB activity parsing: malformed/incomplete activity cannot license native completion reconciliation.');
}finally{rmSync(candidate,{recursive:true,force:true});}
