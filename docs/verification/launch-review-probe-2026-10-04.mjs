// Review probe: reproduces current launch defects with a fake BB host. No real threads start.
import { createFakePluginHost, makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from '../../server.ts';
import { UPSTREAM_SKILL_NAMES } from '../../lib/upstream-surface.ts';
const row=(n,shape='ship')=>({id:`c${n}`,task:'fix login',projectId:'proj_1',threadId:`thr_c${n}`,parentThreadId:'thr_cap',providerId:null,model:null,reasoningLevel:null,worktree:true,shape,posture:shape==='scout'?'scout':'direct-PR',createdAt:'2026-09-18T00:00:00.000Z'});
for (const scenario of ['parallel-cap','promote-active-scout-at-cap']) {
 const h=createFakePluginHost({pluginId:'firstmate',agentSkillIds:['captain','firstmate','calm','catch-up',...UPSTREAM_SKILL_NAMES]});
 await plugin(h.bb);
 try {
  await h.bb.storage.kv.set('crews',scenario==='parallel-cap'?[1,2,3,4].map(n=>row(n)):[1,2,3,4,5].map(n=>row(n,n===5?'scout':'ship')));
  h.harness.sdk.stub('threads.list',async()=>[]);
  h.harness.sdk.stub('threads.getPluginMetadata',async()=>({}));
  h.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,status:'active'}));
  h.harness.sdk.stub('environments.list',async()=>[{hostId:'host_1',status:'ready',isWorktree:false,path:'/repo'}]);
  let spawned=0;
  h.harness.sdk.stub('threads.spawn',async()=>{const id=`thr_new${++spawned}`; await new Promise(r=>setTimeout(r,30));return {id};});
  const ctx={projectId:'proj_1',threadId:'thr_cap'};
  const results=scenario==='parallel-cap'?await Promise.all(['a','b'].map(x=>h.harness.behavior.runCli(['dispatch','--project','proj_1','--',`fix ${x}`],ctx))):[await h.harness.behavior.runCli(['promote','c5'],ctx)];
  console.log(JSON.stringify({scenario,spawned,results}));
 } finally {await h.harness.lifecycle.dispose();}
}
