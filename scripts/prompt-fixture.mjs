import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,cpSync,symlinkSync,readdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
export const overlay=resolve('overlay');
const repository=process.env.FIRSTMATE_TEST_NATIVE??'/root/github_projects/firstmate';
export const pins=['2d833ff147cd26a5c461e914e06854e0eb2707ce','1f3e769616fdf9f31f85f4c3e6a9f71606634238'];
export function run(command,args,env={}) { return spawnSync(command,args,{encoding:'utf8',env:{...process.env,...env},timeout:30000,maxBuffer:8*1024*1024}); }
export function ok(result) {assert.equal(result.status,0,result.stdout+result.stderr);return result.stdout;}
export function fixture(pin=pins[1]) {
 const home=mkdtempSync(join(tmpdir(),'fm-prompt-fixture-'));
 ok(run('git',['clone','--quiet','--shared',repository,home]));ok(run('git',['-C',home,'checkout','--quiet','--detach',pin]));
 mkdirSync(join(home,'config'),{recursive:true});mkdirSync(join(home,'state'),{recursive:true});mkdirSync(join(home,'bin-bb/backends'),{recursive:true});
 for(const entry of readdirSync(join(home,'bin'))) if(entry!=='backends') symlinkSync(join(home,'bin',entry),join(home,'bin-bb',entry));
 for(const entry of ['bb.sh','bb-worker-prompt.py','bb-worker-transport.txt']) cpSync(join(overlay,'bin/backends',entry),join(home,'bin-bb/backends',entry));
 for(const entry of ['fm-inbox-take.sh','fm-inbox-take.py','fm-launch-adopt.sh','fm-launch-adopt.py','fm-worker-rebind.sh','fm-worker-rebind.py']) cpSync(join(overlay,'bin',entry),join(home,'bin-bb',entry));
 writeFileSync(join(home,'config/bb-overlay'),'bb\n');
 return home;
}
export function scaffold(home,id,kind='ship',mode='direct-PR',lab=false) {
 const args=[join(home,'bin/fm-brief.sh'),id,'/example/project',...(kind==='scout'?['--scout']:['--mode',mode]),...(lab?['--herdr-lab']:[])];
 ok(run('bash',args,{FM_HOME:home,FM_ROOT_OVERRIDE:home,FM_STATE_OVERRIDE:join(home,'state')}));
 const source=join(home,'data',id,'brief.md');
 // Native-looking phrases in user Task are deliberate regression bait. They
 // remain user text, including script paths, through the rendering boundary.
 const task=`Smooth canvas zoom and align the workflow status with its action button.\nPreserve this quoted policy text verbatim: Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.\nStay inside this worktree; modify nothing outside it.\nUser evidence path: ${home}/bin/fm-send.sh\n## User acceptance\nPreserve cursor anchoring, reduced motion and responsive wrapping. Do not merge or deploy.`;
 const spec='Reproduce behavior, make bounded changes, run focused checks and the native delivery contract.';
 const text=readFileSync(source,'utf8').replace('{TASK}',task).replace('{FIRSTMATE_SPEC}',spec);
 writeFileSync(source,text);return{source,text,task,spec};
}
export function render(home,source,kind,id,mode='') {
 return run('bash',['-c','. "$1"; fm_backend_bb_worker_prompt "$2" "$3" "$4" "$5"','fixture',join(home,'bin-bb/backends/bb.sh'),source,kind,id,mode],{FM_HOME:home,FM_ROOT:home});
}

