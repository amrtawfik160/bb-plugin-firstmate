import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,symlinkSync,existsSync,rmSync,readdirSync,linkSync } from 'node:fs';
import { join,resolve,dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {overlay,pins,run,ok,fixture,scaffold,render} from './prompt-fixture.mjs';

for(const pin of pins) test(`native ${pin.slice(0,8)} worker renderer preserves task and all modes with one adapted policy`,()=>{
 const home=fixture(pin);try {
  const defaultBrief=scaffold(home,'default-wait');
  assert.doesNotMatch(ok(render(home,defaultBrief.source,'ship','default-wait')),/Do not poll or list the inbox while waiting/,'no-turn waiting stays opt-in');
  writeFileSync(join(home,'config/wait-no-turns'),'1\n');
  for(const [index,kind,mode,lab] of [[1,'ship','direct-PR',false],[2,'ship','no-mistakes',false],[3,'ship','local-only',false],[4,'scout','',false],[5,'ship','direct-PR',true],[6,'scout','',true]]) {
   const id=`prompt${index}`,f=scaffold(home,id,kind,mode,lab);const output=ok(render(home,f.source,kind,id,mode));
   assert.ok(output.startsWith('# Current worker role contract\n'));assert.ok(output.includes(f.task),'Task is byte-for-byte unchanged');
   assert.equal(output.split('chrome-devtools-axi for browser operations.').length-1,1,'only the user quotation remains');
   assert.equal(output.split('For browser work use the /browser skill').length-1,1);
   assert.doesNotMatch(output,/data\/<task-id>\/|The move IS the acknowledgement|then mv each|after you act, run it again with --ack/);
   assert.match(output,/--ack 001\.msg \[002\.msg \.\.\.\]/);assert.equal(output.includes('Do not poll or list the inbox while waiting'),f.text.includes('Do not poll or list the inbox while waiting'),'native opt-in/default remains unchanged');
   assert.match(output,/The only writes allowed outside it are/);assert.equal(output.split('Stay inside this worktree; modify nothing outside it.').length-1,1,'only the verbatim task quote remains');assert.ok(output.includes(`${home}/data/${id}/`));assert.ok(output.includes(`${home}/state/${id}.status`));assert.ok(output.includes(`${home}/state/${id}.inbox/handled/`));
   assert.match(output,/fm-worker-checkpoint\.py.* setup /);assert.match(output,/report <phase>/);if(f.text.includes('Do not poll or list the inbox while waiting')){assert.match(output,/setup [^`]+ --foreground-checks/);assert.match(output,/check-foreground/);assert.doesNotMatch(output,/each call waits up to 30 seconds/);}else{assert.match(output,/each call waits up to 30 seconds/);assert.doesNotMatch(output,/check-foreground/);}assert.match(output,/Register further guides/);
   assert.match(output,/no-mistakes daemon|worktree pool/);assert.match(output,/exact key/);assert.match(output,/fm-fleet-ledger\.sh/);
   if(lab) {
    const contract=f.text.slice(f.text.lastIndexOf('# Herdr isolation - HARD SAFETY CONTRACT'),f.text.indexOf('\n# Setup\n')).trimEnd().replaceAll(`${home}/bin/`,`${home}/bin-bb/`).replace(/(^|[ \n`(])bin\/fm-/g,(_,before)=>`${before}${home}/bin-bb/fm-`);
    assert.ok(output.includes(contract),'full native Herdr lab contract survives verbatim in its operational reference');
    assert.match(output,/HARD SAFETY CONTRACT/);assert.match(output,/refuse-default/);assert.match(output,/live default session/);
   }else assert.match(output,/HARD SAFETY GATE/);
   if(kind==='ship') {assert.ok(output.includes(`Delivery contract: mode=${mode}`));assert.match(output,/NEVER merge|Do NOT merge|never merge/i);}
   if(mode==='direct-PR') {assert.match(output,/not a draft/);assert.match(output,/latest commit/);}
   if(mode==='no-mistakes') {assert.match(output,/ask-user findings/);assert.match(output,/NEVER pass `--yes`/);assert.match(output,/commit nothing after the run/);}
   if(kind==='scout') assert.ok(output.includes(`${home}/data/${id}/report.md`));
   assert.ok(output.indexOf('# Task')<output.indexOf('# BB execution transport'));assert.ok(output.indexOf('# Definition of done')<output.indexOf('# BB Lavish operational reference'));
   assert.equal(readFileSync(f.source,'utf8'),f.text,'native gates retain their original source');
   // fm-spawn's native role overlay and optional intent contract must use the
   // same renderer and must retain the copied captain words at absolute EOF.
   const role=ok(run('bash',['-c','. "$1"; fm_brief_worker_role "$2" "$3"','fixture',join(home,'bin/fm-dod-lib.sh'),join(home,'state'),id]));
   let launch=role+'\n'+f.text;
   if(mode==='no-mistakes') launch+=ok(run('bash',['-c','. "$1"; fm_brief_intent_overlay "$2"','fixture',join(home,'bin/fm-dod-lib.sh'),f.task]));
   const launchPath=join(home,'data',id,'launch-brief.md');writeFileSync(launchPath,launch);
   const replacement=ok(render(home,launchPath,kind,id,mode));assert.equal(replacement.split('# Current worker role contract').length-1,1);
   assert.ok(replacement.includes(f.task));if(mode==='no-mistakes') assert.ok(replacement.trimEnd().endsWith(f.task));
  }
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('crew brief names the browser plugin command that exists, not the absent core one',()=>{
 const home=fixture();try {
  for(const [id,kind,mode] of [['browser-ship','ship','direct-PR'],['browser-scout','scout','']]) {
   const f=scaffold(home,id,kind,mode);const output=ok(render(home,f.source,kind,id,mode));
   assert.match(output,/browser_script \(or bb plugin run browser script\)/);
   assert.doesNotMatch(output,/bb browser script/,'bb browser has no script command');
  }
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('crew brief makes a worker work through ordinary obstacles and keeps every safety stop',()=>{
 const home=fixture();try {
  for(const [id,kind,mode,waitless] of [['blocked-ship','ship','direct-PR',false],['blocked-scout','scout','',false],['blocked-pipeline','ship','no-mistakes',true]]) {
   if(waitless) writeFileSync(join(home,'config/wait-no-turns'),'1\n');
   const f=scaffold(home,id,kind,mode);const output=ok(render(home,f.source,kind,id,mode));
   assert.doesNotMatch(output,/same obstacle twice/,'two failures of an ordinary step are not a reason to stop');
   assert.doesNotMatch(output,/when you are stuck and need help/);
   assert.ok(output.includes('5. Work through an ordinary obstacle yourself first: retry with a smaller query or pagination, restore or commit a change your own command made (such as an install that rewrote a lockfile), use another tool, or wait and retry. Append `blocked [at=<epoch>]: {what you need}` and stop only for what only firstmate or the owner can give: a secret, an approval, a decision, access that was withheld, or a destructive or irreversible step. Every other stop rule in this brief still applies.'),output);
   assert.ok(output.includes('   Use `blocked:` only as rule 5 allows.'),output);
   assert.ok(output.includes('A command that changes tracked files (a dependency install, a code generator) is not source-stable: run it directly, then restore or commit what it changed.'),output);
   if(kind==='ship') assert.ok(output.includes('append `blocked [at=<epoch>]: launched in primary checkout, not an isolated worktree` to the status file and stop.'),'isolation stop stays');
   assert.ok(output.includes('append `needs-decision [at=<epoch>]: {summary of options}` and stop. Firstmate will reply with the decision.'),'decision stop stays');
   assert.ok(output.includes('`blocked [at=<epoch>]: {what you need}` and stop; firstmate arranges it.'),'shared infrastructure stop stays');
   if(kind==='ship') assert.match(output,/1\. Never push to the default branch/);
  }
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('renderer rejects changed anchors, contradictory legacy output and wrong native mode before printing any prompt',()=>{
 const home=fixture();try {
  const f=scaffold(home,'strict');
  for(const [from,to] of [['3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.','3. changed upstream browser policy.'],['The move IS the acknowledgement:','Changed inbox contract:'],['# Herdr lifecycle declaration - NOT ENABLED','# Unknown guard'],['Stay inside this worktree; modify nothing outside it.','Changed native allowed writes.']]) {
   // Change the scaffold copy after Task, never the deliberate user quotation.
   const at=f.text.lastIndexOf(from);assert.ok(at>=0);writeFileSync(f.source,f.text.slice(0,at)+f.text.slice(at).replace(from,to));
   const result=render(home,f.source,'ship','strict','direct-PR');assert.notEqual(result.status,0);assert.equal(result.stdout,'');
  }
  writeFileSync(f.source,f.text);const mismatch=render(home,f.source,'ship','strict','local-only');assert.notEqual(mismatch.status,0);assert.match(mismatch.stderr,/mode conflicts/);
  const append='\n\nBB-DIVERGE: Keep durable artifacts under data/<task-id>/ in this firstmate home, not the worktree tmp/. The worktree tmp/ is removed when the workspace is archived.\n';
  writeFileSync(f.source,f.text+append);assert.doesNotMatch(ok(render(home,f.source,'ship','strict')),/data\/<task-id>\//);assert.equal(readFileSync(f.source,'utf8'),f.text+append);
 }finally{rmSync(home,{recursive:true,force:true});}
});

function inboxFixture() {const home=mkdtempSync(join(tmpdir(),'fm-inbox-ids-'));const dir=join(home,'state/task.inbox');mkdirSync(dir,{recursive:true});return{home,dir};}
function take(home,args=[]) {return run('bash',[join(overlay,'bin/fm-inbox-take.sh'),'task',...args],{FM_HOME:home});}
test('read 001 then arrival 002 acknowledges only 001; exact batches and retries preserve handled evidence',()=>{
 const {home,dir}=inboxFixture();try {
  writeFileSync(join(dir,'001.msg'),'instruction one\n');const read=ok(take(home));assert.doesNotMatch(read,/002.msg/);
  writeFileSync(join(dir,'002.msg'),'arrived after read\n');const bare=take(home,['--ack']);assert.notEqual(bare.status,0);assert.match(bare.stderr,/no longer supported/);assert.match(read,/--ack 001\.msg/);assert.ok(existsSync(join(dir,'001.msg')));assert.ok(existsSync(join(dir,'002.msg')));
  ok(take(home,['--ack','001.msg']));assert.ok(existsSync(join(dir,'002.msg')));assert.equal(readFileSync(join(dir,'handled/001.msg'),'utf8'),'instruction one\n');
  ok(take(home,['--ack','001.msg']));writeFileSync(join(dir,'003.msg'),'third\n');ok(take(home,['--ack','002.msg','003.msg']));assert.ok(!existsSync(join(dir,'002.msg')));assert.ok(!existsSync(join(dir,'003.msg')));
  assert.notEqual(take(home,['--ack','999.msg']).status,0);assert.equal(readFileSync(join(dir,'handled/001.msg'),'utf8'),'instruction one\n');
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('exact-ID acknowledgement recovers a crash between handled link and pending unlink',()=>{
 const {home,dir}=inboxFixture();try {
  writeFileSync(join(dir,'001.msg'),'acted before interrupted acknowledgement\n');
  writeFileSync(join(dir,'002.msg'),'later arrival remains pending\n');
  mkdirSync(join(dir,'handled'));linkSync(join(dir,'001.msg'),join(dir,'handled/001.msg'));
  ok(take(home,['--ack','001.msg']));assert.equal(existsSync(join(dir,'001.msg')),false);
  assert.equal(readFileSync(join(dir,'handled/001.msg'),'utf8'),'acted before interrupted acknowledgement\n');
  assert.equal(readFileSync(join(dir,'002.msg'),'utf8'),'later arrival remains pending\n');
  ok(take(home,['--ack','001.msg']));assert.equal(existsSync(join(dir,'002.msg')),true);
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('ack rejects traversal, malformed IDs, symlinks, conflicts and mixed unknown batches without moving any pending message',()=>{
 const {home,dir}=inboxFixture();try {
  writeFileSync(join(dir,'001.msg'),'one\n');
  for(const id of ['../001.msg','/tmp/001.msg','handled/001.msg','001.msg/','*.msg','1.msg','001.msg\n002.msg','--ack']) {
   assert.notEqual(take(home,['--ack',id]).status,0);assert.ok(existsSync(join(dir,'001.msg')));
  }
  assert.notEqual(take(home,['--ack','001.msg','999.msg']).status,0);assert.ok(existsSync(join(dir,'001.msg')));
  symlinkSync(join(dir,'001.msg'),join(dir,'002.msg'));assert.notEqual(take(home,['--ack','002.msg']).status,0);assert.notEqual(take(home).status,0);assert.ok(existsSync(join(dir,'001.msg')));
  rmSync(join(dir,'002.msg'));mkdirSync(join(dir,'handled'),{recursive:true});writeFileSync(join(dir,'handled/001.msg'),'earlier evidence\n');assert.notEqual(take(home,['--ack','001.msg']).status,0);assert.equal(readFileSync(join(dir,'handled/001.msg'),'utf8'),'earlier evidence\n');
  rmSync(join(dir,'handled'),{recursive:true});symlinkSync(home,join(dir,'handled'));assert.notEqual(take(home,['--ack','001.msg']).status,0);assert.ok(existsSync(join(dir,'001.msg')));
  const other=join(home,'state/other.inbox');mkdirSync(other);writeFileSync(join(other,'001.msg'),'other task\n');assert.equal(readFileSync(join(other,'001.msg'),'utf8'),'other task\n');
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('FIFO messages in pending and handled namespaces refuse promptly without moving a valid message',()=>{
 const {home,dir}=inboxFixture();try {
  writeFileSync(join(dir,'001.msg'),'valid pending message\n');mkdirSync(join(dir,'handled'));
  for(const namespace of [dir,join(dir,'handled')]) {
   const fifo=join(namespace,'002.msg');ok(run('mkfifo',[fifo]));
   const calls=[['--ack','001.msg','002.msg']];if(namespace===dir)calls.push([]);
   for(const args of calls) {
    const result=spawnSync('bash',[join(overlay,'bin/fm-inbox-take.sh'),'task',...args],{env:{...process.env,FM_HOME:home},encoding:'utf8',timeout:2000});
    assert.equal(result.status,2,result.error?.message??result.stderr);assert.match(result.stderr,/not a regular message/);
    assert.equal(existsSync(join(dir,'001.msg')),true);assert.equal(existsSync(join(dir,'handled/001.msg')),false);
   }
   rmSync(fifo);
  }
 }finally{rmSync(home,{recursive:true,force:true});}
});

for(const pin of pins) test(`native ${pin.slice(0,8)} inbox envelopes decode through Bash without changing body bytes`,()=>{
 const home=fixture(pin);try {
  const dir=join(home,'state/task.inbox');mkdirSync(dir);const body='First line\n--\nLast line without final newline';writeFileSync(join(dir,'001.msg'),'schema=fm-task-inbox.v1\nat=2026-10-04T00:00:00Z\n--\n'+body);
  const result=ok(take(home));assert.ok(result.includes(body));assert.doesNotMatch(result,/schema=fm-task-inbox|at=2026/);assert.ok(existsSync(join(dir,'001.msg')));
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('full installer ships the renderer/helper and verification detects missing or stale payloads',()=>{
 const home=fixture();try {
  ok(run('python3',[join(overlay,'install-bb-backend.py'),'--home',home]));
  const verify=()=>run('python3',[join(overlay,'install-bb-backend.py'),'--home',home,'--verify']);ok(verify());
  ok(run('bash',['-c','. "$1"; declare -F fm_backend_bb_worker_prompt >/dev/null','fixture',join(home,'bin-bb/backends/bb.sh')],{FM_HOME:home}));
  for(const file of ['backends/bb-worker-prompt.py','fm-inbox-take.py','fm-worker-checkpoint.py']) {
   const path=join(home,'bin-bb',file),original=readFileSync(path);writeFileSync(path,'stale payload\n');assert.notEqual(verify().status,0);writeFileSync(path,original);
   rmSync(path);assert.notEqual(verify().status,0);writeFileSync(path,original);
  }
  ok(verify());assert.equal(ok(run('git',['-C',home,'status','--porcelain','--untracked-files=no'])),'');
 }finally{rmSync(home,{recursive:true,force:true});}
});


test('home additions and copied intent remain verbatim; references follow native completion and guards stay inline',()=>{
 const home=fixture();try {
  const addition=`Quoted native text: 3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.\nUser path: ${home}/bin/fm-send.sh\n`;
  writeFileSync(join(home,'config/brief-include.md'),addition);
  const f=scaffold(home,'additions','ship','no-mistakes');const output=ok(render(home,f.source,'ship','additions','no-mistakes'));
  assert.ok(output.includes(addition));assert.ok(output.includes(f.task));assert.ok(output.indexOf('# Native no-mistakes daemon operational reference')>output.indexOf('# Definition of done'));
  assert.ok(output.indexOf('Never create, remove, return, prune, move, or reassign a worktree')<output.indexOf('# Definition of done'));
 }finally{rmSync(home,{recursive:true,force:true});}
});

test('absent inbox is a read no-op; symlinked task/state namespaces cannot be read or acknowledged',()=>{
 const {home,dir}=inboxFixture();try {
  rmSync(dir,{recursive:true});assert.match(ok(take(home)),/inbox empty/);assert.notEqual(take(home,['--ack','001.msg']).status,0);
  symlinkSync(home,dir);assert.notEqual(take(home).status,0);assert.notEqual(take(home,['--ack','001.msg']).status,0);
  rmSync(dir);rmSync(join(home,'state'),{recursive:true});symlinkSync(home,join(home,'state'));assert.notEqual(take(home).status,0);
  const script=join(overlay,'bin/fm-inbox-take.sh');for(const id of ['..','.','other/../task']) assert.notEqual(run('bash',[script,id],{FM_HOME:home}).status,0);
 }finally{rmSync(home,{recursive:true,force:true});}
});
