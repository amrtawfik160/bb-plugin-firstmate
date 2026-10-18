import assert from 'node:assert/strict';
import test from 'node:test';
import { createFakePluginHost,makeThreadResponse } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import { createDeliveries } from './lib/pr-delivery.ts';
import { createOwnerTasks } from './lib/owner-tasks.ts';

process.env.FM_MERGEABLE_POLL_MS='0';

// Owner decisions Q5 and Q6 (17 Oct). The 15-17 Oct audit: four Dr Woo crews recorded proof
// from web runs while the owner found three iPhone failures; #2523 and dr.woo#124 were
// "verified" by the captain himself; Safi builds 17-21 skipped the "Beta Testers" group.
const ctx={threadId:'thr_cap',projectId:'proj_1'};
const WOO='amrtawfik160/dr.woo';
const CYN='Cyndra-AI/cyndra-saas';
const SAFI='amrtawfik160/Safi';
const url=(repo,n)=>`https://github.com/${repo}/pull/${n}`;
const key=(repo,n)=>`${repo.toLowerCase()}#${n}`;
const head=n=>String(n).repeat(10).slice(0,40);
const crewRow=(id,threadId,extra)=>({id,task:'x',projectId:'proj_1',threadId,parentThreadId:'thr_cap',nativeHome:'/native',worktree:true,shape:'ship',posture:'direct-PR',createdAt:'2026-10-17T00:00:00.000Z',reasoningLevel:null,playbook:'babysit',...extra});
const CREWS=[
 crewRow('woo1','thr_woo',{title:'Fix the photo upload',providerId:'claude-code',model:'claude-opus-5-5'}),
 crewRow('cyn1','thr_cyn',{title:'Fix the Gmail trigger',providerId:'claude-code',model:'claude-opus-5-5'}),
 crewRow('safi1','thr_safi',{title:'Ship build 21',providerId:'claude-code',model:'claude-opus-5-5'}),
 crewRow('chk1','thr_chk',{title:'Check the PR',providerId:'codex',model:'gpt-6-astra',role:'checker'}),
];
const PRS=[[WOO,130,'woo1','thr_woo'],[CYN,2523,'cyn1','thr_cyn'],[SAFI,77,'safi1','thr_safi']];
const repoOfNumber=n=>PRS.find(p=>p[1]===n)[0];

function hostCommands(host) {
 const commands=[];const byId=new Map();let n=0;
 host.harness.sdk.stub('terminals.create',async args=>{const tid=`term${++n}`;byId.set(tid,args.start.command);commands.push(args.start.command);return{id:tid};});
 host.harness.sdk.stub('terminals.get',async()=>({status:'running'}));
 host.harness.sdk.stub('terminals.close',async()=>({}));
 host.harness.sdk.stub('terminals.output',async({terminalId})=>{const command=byId.get(terminalId);const out=forge(command);const captured=command.includes('FM_HOST_CAPTURE_V1');const payload=captured?JSON.stringify({protocol:'FM_HOST_CAPTURE_V1',exitCode:out.code??0,stdout:out.payload??'',stderr:''}):out.payload??'';return{nextSeq:1,chunks:[{dataBase64:Buffer.from(`${payload}\n__FM_HOST_RC:${captured?0:out.code ?? 0}\n`).toString('base64')}]};});
 return commands;
}
function forge(command) {
 const n=Number(/\/pull\/(\d+)/.exec(command)?.[1]);
 if(command.includes('fm-pr-merge.sh'))return{payload:`verified: ${url(repoOfNumber(n),n)} is merged (state=MERGED, merged=true, isInMergeQueue=false)`};
 if(command.includes('gh pr checks'))return{code:0,payload:JSON.stringify([{name:'build',bucket:'pass'}])};
 if(command.includes('gh pr view')){const crew=PRS.find(p=>p[1]===n)[2];return{payload:JSON.stringify({number:n,url:url(repoOfNumber(n),n),title:`Change ${n}`,headRefName:`fm/${crew}-change-${n}`,headRefOid:head(n),state:'OPEN',mergeable:'MERGEABLE',files:[{path:'app/screens/upload.tsx'}]})};}
 return{code:0};
}
async function deck() {
 const host=createFakePluginHost({pluginId:'firstmate',agentSkillIds:['firstmate','captain'],settings:{fmHome:'/native',fmHostId:'host_1'}});
 await host.bb.storage.kv.set('captain-project:thr_cap','proj_1');
 await plugin(host.bb);
 await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: 'on', telegramThreading: 'on' }) });
 host.harness.sdk.stub('threads.list',async()=>[]);
 host.harness.sdk.stub('threads.getPluginMetadata',async({threadId})=>threadId==='thr_cap'?{captain:'true'}:{});
 host.harness.sdk.stub('threads.get',async({threadId})=>makeThreadResponse({id:threadId,projectId:'proj_1',status:'idle',environmentId:`env_${threadId}`}));
 host.harness.sdk.stub('environments.list',async()=>[{id:'env_source',hostId:'host_1',status:'ready',isWorktree:false,path:'/repo'}]);
 host.harness.sdk.stub('environments.get',async({environmentId})=>{const crew=CREWS.find(c=>`env_${c.threadId}`===environmentId);const pr=PRS.find(p=>p[2]===crew?.id);return{id:environmentId,hostId:'host_1',status:'ready',isWorktree:true,path:'/wt',branchName:`fm/${crew?.id}-change-${pr?.[1]}`};});
 host.harness.sdk.stub('environments.pullRequest',async()=>({outcome:'unavailable'}));
 host.harness.sdk.stub('threads.output',async()=>({output:'DONE: PR open'}));
 host.harness.sdk.stub('threads.events.list',async()=>[]);
 host.harness.sdk.stub('threads.send',async()=>({delivery:'queued'}));
 host.harness.sdk.stub('projects.get',async()=>({id:'proj_1',name:'woo-app',kind:'repo'}));
 const rpc=[];
 // The connector records the owner's own taps; ownerAnswer reads them back.
 const ownerTaps=new Map();
 host.harness.sdk.stub('plugins.callRpc',async(call)=>{rpc.push(call);if(call.method==='ownerAnswer')return{answer:ownerTaps.get(call.input.askId)??null};return{ok:true,queued:1,duplicate:false};});
 host.harness.sdk.stub('files.read',async()=>{throw new Error('ENOENT');});
 await host.bb.storage.kv.set('crews',CREWS);
 const store=createDeliveries(host.bb.storage.database());
 for(const [repo,n,crew,thread] of PRS){
  const r=store.register({url:url(repo,n),taskId:crew,projectId:'proj_1',owner:'thr_cap',home:'/native',worker:thread,requirement:'merged',title:`Change ${n}`});
  store.observe(r.id,{headSha:head(n),state:'open',draft:false,checks:'passing',review:'approved',reviewHeadSha:head(n),mergeCommitSha:null,mergeable:'mergeable'},true);
 }
 const tap=async(id,answer)=>{ownerTaps.set(id,answer);return host.harness.behavior.callRpc('resolveAsk',{threadId:'thr_cap',id,resolution:answer});};
 return {host,store,rpc,tap,commands:hostCommands(host)};
}
const tool=(host,name)=>host.harness.inspection.registrations.agentTools.find(t=>t.name===name);
const text=out=>typeof out==='string'?out:out?.content?.[0]?.text ?? JSON.stringify(out);
const merges=commands=>commands.filter(c=>c.includes('fm-pr-merge.sh'));
const deliveries=(host,input,as)=>tool(host,'firstmate_deliveries').execute(input,{threadId:as,projectId:'proj_1'});
const verify=(host,repo,n,as,surface)=>deliveries(host,{action:'verify',id:key(repo,n),commitSha:head(n).slice(0,7),driven:'opened the upload screen and sent a photo',seen:'the photo arrived',...(surface?{surface}:{})},as);
const check=(host,repo,n)=>deliveries(host,{action:'check',id:key(repo,n),commitSha:head(n).slice(0,7),verdict:'pass',notes:'read the diff; ran the upload flow'},'thr_chk');
const merge=(host,crewId,pr,extra={})=>tool(host,'firstmate_merge').execute({crewId,yes:true,pr,...extra},ctx);

test('the captain cannot record verification for a PR; only a crew can',async()=>{
 const {host,store}=await deck();try {
  assert.match(text(await verify(host,CYN,2523,'thr_cap','web')),/^(?:Error: )?Refusing: only a crew records verification\. The captain cannot verify cyndra-ai\/cyndra-saas#2523 for itself/);
  assert.equal(store.get(key(CYN,2523)).verifiedCommitSha,null);
  text(await verify(host,CYN,2523,'thr_cyn','web'));
  const recorded=store.get(key(CYN,2523)).verification;
  assert.deepEqual([recorded.crewId,recorded.surface,recorded.commitSha],['cyn1','web',head(2523)]);
 }finally{await host.harness.lifecycle.dispose();}
});

test('Dr Woo proof from a web run is refused; an iPhone proof the host cannot drive sends the crew to the owner card',async()=>{
 const {host,store}=await deck();try {
  assert.match(text(await verify(host,WOO,130,'thr_woo','web')),/Refusing: Dr Woo proof must come from the app on an iPhone or the iOS Simulator \(surface iphone\), not web\. Proof from another surface does not count\./);
  assert.match(text(await verify(host,WOO,130,'thr_woo')),/Refusing: Dr Woo proof must come from the app on an iPhone or the iOS Simulator \(surface iphone\); name the surface you drove\./);
  const iphone=text(await verify(host,WOO,130,'thr_woo','iphone'));
  assert.match(iphone,/Refusing: this host cannot drive the app on an iPhone or the iOS Simulator\./);
  assert.match(iphone,/firstmate_deliveries action=device-proof id=amrtawfik160\/dr\.woo#130 commitSha=1301301 build="<build id>" link="<TestFlight or OTA link>" check="<what the owner checks>"/);
  assert.equal(store.get(key(WOO,130)).verifiedCommitSha,null);
 }finally{await host.harness.lifecycle.dispose();}
});

test("the owner's Works tap on the crew's device card is the proof record, with the build id; then the merge passes",async()=>{
 const {host,store,rpc,tap,commands}=await deck();try {
  const asked=text(await deliveries(host,{action:'device-proof',id:key(WOO,130),commitSha:head(130).slice(0,7),build:'8',link:'https://testflight.apple.com/join/abc',check:'Open a chat, send a photo, and see it arrive'},'thr_woo'));
  const askId=/card (a[0-9a-z]{6})/.exec(asked)?.[1];
  assert.ok(askId,asked);
  const card=rpc.find(call=>call.method==='ask');
  assert.equal(card.input.project,'Dr Woo');
  assert.deepEqual(card.input.options.map(o=>o.label),['Works','Does not work']);
  assert.match(card.input.text,/build 8/);assert.match(card.input.text,/https:\/\/testflight\.apple\.com\/join\/abc/);assert.match(card.input.text,/Open a chat, send a photo, and see it arrive/);
  // The captain cannot answer it for the owner.
  assert.match(text(await tool(host,'firstmate_resolve_ask').execute({id:askId,resolution:'Works'},ctx)),/only the owner's tap answers a device proof card/);
  assert.equal(store.get(key(WOO,130)).verifiedCommitSha,null);
  assert.match(text(await merge(host,'woo1',130)),/^Refusing: #130 reaches production .* has no proof a crew or the owner recorded for its current head 1301301/);
  assert.deepEqual(await tap(askId,'Works'),{ok:true});
  const recorded=store.get(key(WOO,130)).verification;
  assert.deepEqual([recorded.actor,recorded.crewId,recorded.surface,recorded.build,recorded.commitSha],['owner',null,'iphone','8',head(130)]);
  text(await check(host,WOO,130));
  const merged=text(await merge(host,'woo1',130));
  assert.match(merged,/^Merged #130 Change 130\n/);
  assert.equal(merges(commands).length,1);
 }finally{await host.harness.lifecycle.dispose();}
});

test('a Does not work tap records no proof and the crew hears it',async()=>{
 const {host,store,tap}=await deck();try {
  const asked=text(await deliveries(host,{action:'device-proof',id:key(WOO,130),commitSha:head(130).slice(0,7),build:'8',link:'https://testflight.apple.com/join/abc',check:'Send a photo'},'thr_woo'));
  const askId=/card (a[0-9a-z]{6})/.exec(asked)[1];
  await tap(askId,'Does not work');
  assert.equal(store.get(key(WOO,130)).verifiedCommitSha,null);
  const told=host.harness.sdk.callsTo('threads.send').map(call=>call[0]).filter(m=>m.threadId==='thr_woo').map(m=>JSON.stringify(m));
  assert.ok(told.some(m=>/build 8 does not work on the owner's iPhone/.test(m)),told.join('\n'));
 }finally{await host.harness.lifecycle.dispose();}
});

test('a production merge refuses a record the captain made, an owner waiver, and proof from another surface',async()=>{
 const {host,store,commands}=await deck();try {
  // #2523: "verified" by the captain himself.
  store.verify(key(CYN,2523),'thr_cap',head(2523).slice(0,7),{driven:'read the code',seen:'looks right'});
  text(await check(host,CYN,2523));
  assert.match(text(await merge(host,'cyn1',2523)),/^Refusing: #2523's verification record was made by the captain, not by a crew; nothing was merged\./);
  // #2485: merged unverified on the owner's words.
  assert.match(text(await merge(host,'cyn1',2523,{allowUnverified:'just merge it now'})),/^Refusing: #2523 reaches production .*; the owner's words cannot waive proof for a production PR/);
  // Dr Woo: a crew's web record does not stand for the iPhone.
  store.verify(key(WOO,130),'thr_woo',head(130).slice(0,7),{driven:'web preview',seen:'works'},'woo1');
  text(await check(host,WOO,130));
  assert.match(text(await merge(host,'woo1',130)),/^Refusing: Dr Woo proof must come from the app on an iPhone or the iOS Simulator \(surface iphone\); name the surface you drove\./);
  assert.deepEqual(merges(commands),[]);
 }finally{await host.harness.lifecycle.dispose();}
});

test('a release read-back must name the required TestFlight group, and a Safi task with a merged PR closes only with one',async()=>{
 const {host,store}=await deck();try {
  const tasks=createOwnerTasks(host.bb.storage.database());
  const task=tasks.open({captain:'thr_cap',project:'Safi',title:'Ship build 21',sourceRefs:['tg:1:5'],crewId:'safi1',prs:[key(SAFI,77)],at:Date.now()});
  store.observe(key(SAFI,77),{headSha:head(77),state:'merged',draft:false,checks:'passing',review:'approved',reviewHeadSha:head(77),mergeCommitSha:'f'.repeat(40),mergeable:'mergeable'},true);
  const release=(as,group)=>deliveries(host,{action:'release',task:task.id,build:'21',group,source:'app-store-connect',seen:`build 21 is in ${group}, state Approved`},as);
  assert.match(text(await release('thr_cap','Beta Testers')),/^(?:Error: )?Refusing: only a crew records a release read-back/);
  assert.match(text(await release('thr_safi','Team (Expo)')),/^(?:Error: )?Refusing: Safi builds must be in the "Beta Testers" public-link group, not "Team \(Expo\)"\. Add build 21 to "Beta Testers", read it back from App Store Connect or EAS, then record it again\./);
  assert.match(text(await tool(host,'firstmate_task').execute({action:'close',id:task.id,state:'done',reason:'Build 21 is live on TestFlight'},ctx)),/Task T1 is a Safi release with a merged PR: it closes only with a crew's read-back of the build in "Beta Testers"/);
  assert.match(text(await release('thr_safi','Beta Testers')),/Release read-back recorded for T1: build 21 in "Beta Testers"/);
  assert.match(text(await tool(host,'firstmate_task').execute({action:'close',id:task.id,state:'done',reason:'Build 21 is in Beta Testers'},ctx)),/Task T1 is done/);
 }finally{await host.harness.lifecycle.dispose();}
});

test("an owner tap hours later reads the PR fresh from GitHub before it records the proof",async()=>{
 const {host,store,tap}=await deck();try {
  const asked=text(await deliveries(host,{action:'device-proof',id:key(WOO,130),commitSha:head(130).slice(0,7),build:'8',link:'https://testflight.apple.com/join/abc',check:'Send a photo'},'thr_woo'));
  const askId=/card (a[0-9a-z]{6})/.exec(asked)[1];
  store.stale(key(WOO,130),'GitHub did not answer');
  assert.equal(store.get(key(WOO,130)).freshness,'stale');
  await tap(askId,'Works');
  const row=store.get(key(WOO,130));
  assert.equal(row.verifiedCommitSha,head(130));
  assert.equal(row.verification.actor,'owner');
 }finally{await host.harness.lifecycle.dispose();}
});

// Checker FF2-verdict-1, #144 finding 1: only the owner's exact Works tap, confirmed by Telegram, is proof.
test('an answer that is not the exact Works choice, or that Telegram did not record from the owner, records no proof',async()=>{
 const {host,store,tap}=await deck();try {
  const open=async(build)=>/card (a[0-9a-z]{6})/.exec(text(await deliveries(host,{action:'device-proof',id:key(WOO,130),commitSha:head(130).slice(0,7),build,link:'https://testflight.apple.com/join/abc',check:'Send a photo'},'thr_woo')))[1];
  const first=await open('8');
  await tap(first,'Works for build 7, build 8 not tested');
  assert.equal(store.get(key(WOO,130)).verifiedCommitSha,null,'not the exact Works choice');
  const second=await open('8');
  assert.deepEqual(await host.harness.behavior.callRpc('resolveAsk',{threadId:'thr_cap',id:second,resolution:'Works'}),{ok:true});
  assert.equal(store.get(key(WOO,130)).verifiedCommitSha,null,'a plain RPC call with no owner tap recorded by Telegram');
 }finally{await host.harness.lifecycle.dispose();}
});

// #144 finding 2: a new build at the same head gets its own card; the older card is replaced.
test('a second build at the same head opens its own card and replaces the first; the same build twice keeps one card',async()=>{
 const {host,store,tap}=await deck();try {
  const open=async(build)=>text(await deliveries(host,{action:'device-proof',id:key(WOO,130),commitSha:head(130).slice(0,7),build,link:'https://testflight.apple.com/join/abc',check:'Send a photo'},'thr_woo'));
  const eight=/card (a[0-9a-z]{6})/.exec(await open('8'))[1];
  const again=await open('8');
  assert.match(again,new RegExp(`card ${eight} is already open`));
  const nine=/card (a[0-9a-z]{6})/.exec(await open('9'))[1];
  assert.notEqual(nine,eight);
  await tap(eight,'Works');
  assert.equal(store.get(key(WOO,130)).verifiedCommitSha,null,'the replaced build 8 card no longer proves anything');
  await tap(nine,'Works');
  assert.equal(store.get(key(WOO,130)).verification.build,'9');
 }finally{await host.harness.lifecycle.dispose();}
});
