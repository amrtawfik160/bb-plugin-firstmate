import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fixture,scaffold,run,ok,overlay,pins} from '../scripts/prompt-fixture.mjs';
export function replacementFixture(pin=pins[1],shape='ship',mode='direct-PR',id='c1') {
 const home=fixture(pin);ok(run('python3',[join(overlay,'install-bb-backend.py'),'--home',home]));
 const root=mkdtempSync(join(tmpdir(),'fm-replacement-work-')),repo=join(root,'repo'),wt=join(root,'wt');mkdirSync(repo);
 ok(run('git',['-C',repo,'init','--quiet','--initial-branch=main']));ok(run('git',['-C',repo,'config','user.email','test@example.com']));ok(run('git',['-C',repo,'config','user.name','Fixture']));
 writeFileSync(join(repo,'file'),'original\n');ok(run('git',['-C',repo,'add','file']));ok(run('git',['-C',repo,'commit','--quiet','-m','fixture']));ok(run('git',['-C',repo,'remote','add','origin','https://github.com/acme/repo.git']));ok(run('git',['-C',repo,'worktree','add','--quiet','-b',`fm/${id}`,wt]));ok(run('git',['-C',wt,'checkout','--quiet','-b',`fm/${id}-disclosures`]));writeFileSync(join(wt,'dirty'),'preserve saved uncommitted skill\n');
 const f=scaffold(home,id,shape,mode);const brief=f.text.replace('worktree of /example/project,',`worktree of ${repo},`);writeFileSync(f.source,brief);writeFileSync(join(home,'state',`${id}.status`),'2026-10-04T01:00:00Z done: original output\n');
 const meta=`window=bb:thr_old\nendpoint_task_id=${id}\nworktree=${wt}\nproject=${repo}\nharness=bb\nkind=${shape}\nbackend=bb\nbb_thread_id=thr_old\nspawn_gen=original\nmodel=old-model\nprovider=codex\neffort=high\n${shape==='ship'?`mode=${mode}\nbranch=fm/${id}\nyolo=off\n`:''}native_extra=keep\n`;
 writeFileSync(join(home,'state',`${id}.meta`),meta);
 const invariant=()=>({head:ok(run('git',['-C',wt,'rev-parse','HEAD'])),branch:ok(run('git',['-C',wt,'symbolic-ref','HEAD'])),refs:ok(run('git',['-C',repo,'show-ref'])),dirty:readFileSync(join(wt,'dirty'),'utf8'),brief:readFileSync(f.source,'utf8'),status:readFileSync(join(home,'state',`${id}.status`),'utf8')});
 return{home,root,repo,wt,id,brief,task:f.task,meta,invariant,clean:()=>{rmSync(home,{recursive:true,force:true});rmSync(root,{recursive:true,force:true});}};
}
