// Checker round 1 for PR #174 (finding 6): the actual shipWorkstream function, run with isolated fakes.
// Ship takes only folded work: the folded builder, and a PR link for the folded task alone.
import assert from 'node:assert/strict';import test from 'node:test';import{readFileSync}from'node:fs';import{stripTypeScriptTypes}from'node:module';
import { shipSnapshotOf } from './lib/workstreams.ts';
test('Ship selects the folded builder and links only the folded task before approval', async () => {
const source=readFileSync('server.ts','utf8');const a=source.indexOf('  async function shipWorkstream('),b=source.indexOf('\n  async function sanitizeDiagnosticSettings',a);
const fn=stripTypeScriptTypes(source.slice(a,b));
const pr='https://github.com/cyndra-ai/cyndra-saas/pull/123';const linked=[],selected=[];
const tasks=new Map(['T1','T2'].map(id=>[id,{id,state:'working',crewIds:[id==='T1'?'folded':'running']} ]));
const deps={isAdoptedWorkstream:()=>false,shipSnapshotOf,shQuote:x=>`'${x}'`,ghReadCommand:x=>x,workstreamCommand:async(repo,cmd)=>cmd.includes('gh pr list')?JSON.stringify([{url:pr,state:'OPEN',headRefOid:'abc'}]):cmd.includes('git rev-parse HEAD')?'abc':'',z:{array:()=>({parse:x=>x}),object:()=>{},string:()=>{}},ownerTasks:{get:id=>tasks.get(id),linkPr:(id,cap,url)=>linked.push(id)},readCrews:async()=>[{id:'running',projectId:'p',threadId:'active-thread',shape:'ship',role:'builder',workstreamId:'ws'},{id:'folded',projectId:'p',threadId:'archived-thread',shape:'ship',role:'builder',workstreamId:'ws'}],rememberPrUrl:async crew=>selected.push(crew.id),discoverCrewDelivery:async()=>{},mergeTarget:async()=>({url:pr}),requireProductionApproval:async()=>{throw Error('fixture stops before approval')} };
const run=Function(...Object.keys(deps),fn+'\nreturn shipWorkstream;')(...Object.values(deps));
await assert.rejects(run({id:'ws',repos:[{projectId:'p',repository:'cyndra-ai/cyndra-saas',path:'/fixture/ws',branch:'workstream/ws'}],taskIds:['T1','T2'],jobs:[{id:'folded',editing:true,state:'folded',taskId:'T1'},{id:'running',editing:true,state:'running',taskId:'T2'}]}),/fixture stops before approval/);
assert.deepEqual(selected,['folded']);assert.deepEqual(linked,['T1']);
});
