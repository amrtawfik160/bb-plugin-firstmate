import {manifestSkillIds} from './scripts/plugin-skill-fixture.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync, readdirSync, cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFakePluginHost, makePluginAgentConfigurationContext } from '@get-bb/plugin-sdk/testing';
import plugin from './server.ts';
import {followRuntimeReferences} from './scripts/captain-packaging-check.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const skillRoot = join(root, 'skills');
// Declare skills from the actual manifest directory, not from the routing code.
const skillIds = manifestSkillIds(root);

async function configuredHost(settings = {}) {
  const host = createFakePluginHost({ pluginId: 'firstmate', agentSkillIds: skillIds, settings });
  await plugin(host.bb);
  return host;
}
const configure = (host, pluginMetadata) => host.harness.behavior.resolveAgentConfiguration(
  makePluginAgentConfigurationContext({ pluginMetadata }));

test('native defaults route through actual configuration across resume and reload without side effects', async () => {
  let host = await configuredHost();
  try {
    const cases = [
      [{}, [], ['firstmate']],
      [{ captain: 'true' }, [], ['captain']],
      [{ captain: 'true', nativeHome: '/owned-home' }, [], ['captain']],
      [{ crew: 'true' }, [], []],
      [{ crew: 'true', captain: 'true', nativeHome: '/owned-home' }, [], []],
    ];
    const stateBefore = await host.bb.storage.kv.get('crews');
    for (const reload of [false, true]) {
      if (reload) host = await host.harness.lifecycle.reload(plugin);
      for (const [metadata, methods, otherSkills] of cases) {
        const cfg = await configure(host, metadata);
        assert.deepEqual(cfg.skills.filter(id => id.endsWith('-methods')), methods);
        for (const id of otherSkills) assert.ok(cfg.skills.includes(id));
        assert.ok((cfg.instructions ?? '').length <= 4096);
        if (metadata.crew) {
          assert.deepEqual(cfg.tools, []);
          assert.deepEqual(cfg.skills, []);
          for (const obligation of [/native launch brief/, /exact-ID steering inbox/,
            /Do not delegate/, /selected provider, model, or effort/,
            /not captain merge or deployment completion/]) assert.match(cfg.instructions, obligation);
          assert.doesNotMatch(cfg.instructions, /firstmate_contract|captain-methods|Calm reporting/);
        } else if (metadata.captain) {
          assert.ok(cfg.tools.some(tool => tool.name === 'firstmate_deliveries'));
          assert.ok(cfg.tools.some(tool => tool.name === 'firstmate_merge'));
          assert.doesNotMatch(cfg.instructions, /captain-methods|worker-methods|Calm reporting/);
          assert.match(cfg.instructions, /firstmate_skill/);
        }
      }
    }
    assert.equal(await host.bb.storage.kv.get('crews'), stateBefore);
    assert.equal(host.harness.inspection.sdk.calls.length, 0, 'configure must not invoke SDK writes or reads');
  } finally { await host.harness.lifecycle.dispose(); }
});

test('saturated captain instruction budget preserves every runtime obligation and role pointer', async () => {
  const empty = await configuredHost();
  let base;
  try { base = (await configure(empty, { captain: 'true' })).instructions; }
  finally { await empty.harness.lifecycle.dispose(); }
  const host = await configuredHost({
    captainMemory: 'MEMORY_START\n' + 'bounded remembered fact\n'.repeat(1000),
    fmSkillsManifest: JSON.stringify({ head: 'abc1234567890', skills:
      Array.from({ length: 200 }, (_, n) => ({ name: `method-${n}`, desc: 'conditional native reference' })) }),
  });
  try {
    for (const metadata of [{ captain: 'true' }, { captain: 'true', nativeHome: '/resumed-home' }]) {
      const cfg = await configure(host, metadata);
      assert.ok(cfg.instructions.length <= 4096);
      assert.ok(cfg.instructions.startsWith(base), 'optional caches cannot truncate the complete runtime base');
      for (const obligation of [/read firstmate_contract without a section/, /script=session-start/,
        /firstmate_skill/, /firstmate_watch once per batch/, /End the turn; never retry or poll/,
        /author for fixes/, /independent review when required/, /merge through firstmate_merge/,
        /Inspect unresolved delivery records after compaction or handoff/,
        /profileId unset for the thread-isolated default/,
        /Treat tmux, herdr, zellij, cmux, orca/]) assert.match(cfg.instructions, obligation);
      if (!metadata.nativeHome) assert.match(cfg.instructions, /MEMORY_START/);
      assert.doesNotMatch(cfg.instructions, /method-0: conditional native reference/);
    }
  } finally { await host.harness.lifecycle.dispose(); }
});

test('unregistered method source references resolve within the repository without global skill paths', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.ok(!manifest.bb.skills.includes('skills'));
  for(const name of ['calm','catch-up','captain-methods','worker-methods']) assert.ok(!manifest.bb.skills.includes('skills/'+name), 'optional source remains unregistered');
  const pending = ['captain-methods/SKILL.md', 'worker-methods/SKILL.md', 'calm/SKILL.md', 'catch-up/SKILL.md']
    .map(path => join(skillRoot, path));
  const seen = new Set();
  while (pending.length) {
    const path = pending.pop();
    if (seen.has(path)) continue;
    seen.add(path);
    const text = readFileSync(path, 'utf8');
    assert.doesNotMatch(text, /~\/\.codex|~\/\.cursor|\/root\/|\/Users\//);
    for (const [, target] of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
      if (/^https:\/\//.test(target)) continue;
      const destination = resolve(dirname(path), target.split('#')[0]);
      const local = relative(skillRoot, destination);
      assert.ok(!relative(root,destination).startsWith('..'), `${target} must stay in the repository sources`);
      const sourceSkill = relative(skillRoot, path).split('/')[0];
      if (sourceSkill.endsWith('-methods') && /^(captain-methods|worker-methods)\//.test(local)) {
        assert.equal(local.split('/')[0], sourceSkill, 'each selected method skill carries its own method references');
      }
      readFileSync(destination); // Throws if the package-local reference is absent.
      // Existing native references can use fmHome anchors. Check the new graph only.
      if (/^(captain-methods|worker-methods|calm)\//.test(local)) pending.push(destination);
    }
  }
  assert.equal([...seen].filter(path => path.includes('/captain-methods/') || path.includes('/worker-methods/')).length, 10);
  assert.ok(seen.has(join(skillRoot, 'calm/references/reporting.md')), 'shared reporting ships with its presentation owner');
  const read = (skill, name) => readFileSync(join(skillRoot, skill, 'references', name), 'utf8');
  assert.equal(read('captain-methods', 'decision-trail.md'), read('worker-methods', 'decision-trail.md'));
  const methodSteps = text => text.slice(text.indexOf('1. To explain current behavior'));
  assert.equal(methodSteps(read('captain-methods', 'research-design-review.md')),
    methodSteps(read('worker-methods', 'research-design-review.md')), 'shared procedure stays equal after role-specific boundary');
});

// Materialize only the directories selected by the actual SDK configure driver.
// The full repository cannot satisfy a dangling runtime-package reference here.
function runtimePackage(configuration, additionalSkills = []) {
  const directory = mkdtempSync(join(tmpdir(), 'fm-cold-skills-'));
  for (const id of new Set([...configuration.skills, ...additionalSkills])) {
    cpSync(join(root, 'entry-skills', id), join(directory, id), { recursive: true });
  }
  return directory;
}
for (const [route, entry, explicit] of [
  ['typed Firstmate request', 'firstmate/SKILL.md', []],
  ['direct captain invocation', 'captain/SKILL.md', ['captain']],
]) {
  test(`cold runtime package resolves ${route} before binding or reload`, async () => {
    let host = await configuredHost();
    try {
      for (const reload of [false, true]) {
        if (reload) host = await host.harness.lifecycle.reload(plugin);
        const cfg = await configure(host, {});
        const directory = runtimePackage(cfg, explicit);
        try {
          const visited = followRuntimeReferences(directory, entry);
          for (const required of ['captain/SKILL.md', 'captain/references/supervision.md',
            'captain/references/bb.md']) assert.ok(visited.includes(required), required);
          assert.deepEqual(cfg.tools.map(tool => tool.name).sort(), ['firstmate_contract', 'firstmate_deck']);
          assert.ok(!cfg.skills.some(id => id.endsWith('-methods')));
          const bound = await configure(host, { captain: 'true', nativeHome: '/owned-captain' });
          assert.ok(bound.tools.some(tool => tool.name === 'firstmate_dispatch'));
          assert.ok(!bound.skills.includes('captain-methods'));
          assert.ok(bound.tools.some(t=>t.name==='firstmate_skill'));
          const crew = await configure(host, { crew: 'true', captain: 'true' });
          assert.deepEqual(crew.tools, []);
          assert.deepEqual(crew.skills, []);
        } finally { rmSync(directory, { recursive: true, force: true }); }
      }
      assert.equal(host.harness.inspection.sdk.calls.length, 0);
    } finally { await host.harness.lifecycle.dispose(); }
  });
}

test('public methods selection persists for new captains and exposes only role-owned verified references',async()=>{
 let host=await configuredHost();const ctx={threadId:'thr_cap',projectId:'proj_1'},worker={threadId:'thr_worker',projectId:'proj_1'};
 const stubs=()=>host.harness.sdk.stub('threads.getPluginMetadata',async({threadId})=>threadId==='thr_worker'?{crew:'true',crewId:'task',shape:'ship',posture:'direct-PR'}:{captain:'true'});
 stubs();
 try{
  const status=await host.harness.behavior.runCli(['methods','status','--json'],ctx);assert.equal(status.exitCode,0,status.stderr);assert.equal(JSON.parse(status.stdout).profile,'off');
  const unknown=await host.harness.behavior.runCli(['methods','unknown'],ctx);assert.equal(unknown.exitCode,1);assert.match(unknown.stderr,/Use methods status\|enable\|disable\|read/);
  const absent=await host.harness.behavior.runCli(['methods','read','captain-methods'],ctx);assert.equal(absent.exitCode,1);assert.match(absent.stderr,/not selected/);
  const enabled=await host.harness.behavior.runCli(['methods','enable','selected-v1','--reason','User selected existing Pstack methods and PR composition'],ctx);assert.equal(enabled.exitCode,0,enabled.stderr);
  const cfg=await configure(host,{captain:'true',nativeHome:'/new-home'});assert.ok(cfg.tools.some(t=>t.name==='firstmate_methods'));assert.match(cfg.instructions,/coverage|Assignment/);assert.doesNotMatch(cfg.instructions,/Calm|worker-methods/);
  const tool=host.harness.registrations.agentTools.find(t=>t.name==='firstmate_methods');assert.ok(tool);
  const page=await tool.execute({action:'read',name:'captain-methods',reference:'references/coverage.md'},ctx);assert.equal(typeof page,'string',JSON.stringify(page));assert.match(page,/END OF BB METHODS TRANSPORT/);
  assert.ok(page.includes(readFileSync(join(skillRoot,'captain-methods/references/coverage.md'),'utf8')));
  const crew=await configure(host,{crew:'true',captain:'true',shape:'ship',posture:'direct-PR'});assert.deepEqual(crew.tools.map(t=>t.name),['firstmate_methods']);assert.deepEqual(crew.skills,[]);assert.match(crew.instructions,/worker-methods/);assert.doesNotMatch(crew.instructions,/captain-methods|Calm|Report scope gaps to the captain/);
  const enableTool=await tool.execute({action:'enable',profile:'selected-v1',reason:'Worker request'},worker);assert.equal(enableTool.isError,true);
  const wrong=await tool.execute({action:'read',name:'captain-methods'},worker);assert.equal(wrong.isError,true);assert.match(JSON.stringify(wrong),/role/);
  const own=await tool.execute({action:'read',name:'worker-methods',reference:'references/product-verification.md'},worker);assert.equal(typeof own,'string',JSON.stringify(own));assert.match(own,/does not assign full skill maintenance/);assert.doesNotMatch(own,/ask the\s+captain/);
  const escape=await tool.execute({action:'read',name:'worker-methods',reference:'../../calm/SKILL.md'},worker);assert.equal(escape.isError,true);
  const denied=await host.harness.behavior.runCli(['methods','enable','selected-v1','--reason','Worker request'],worker);assert.equal(denied.exitCode,1);assert.match(denied.stderr,/worker.*supervisor/i);
  host=await host.harness.lifecycle.reload(plugin);stubs();
  const resumed=await configure(host,{captain:'true',nativeHome:'/another-home'});assert.match(resumed.instructions,/firstmate_methods/,'durable installation selection needs no repeated opt-in');
  assert.equal((await host.harness.behavior.runCli(['methods','disable','--reason','Explicit operator change'],ctx)).exitCode,0);
  const off=await configure(host,{crew:'true'});assert.deepEqual(off.tools,[]);assert.doesNotMatch(off.instructions,/worker-methods/);
 }finally{await host.harness.lifecycle.dispose();}
});

test('direct-PR body author reads the actual installed PR skill in bounded owner-pinned pages; pipeline and local-only ownership stay native',async()=>{
 const host=await configuredHost({selectedMethods:'selected-v1'}),worker={threadId:'thr_worker',projectId:'proj_1'};
 let mode='direct-PR',revision='revision-1';const content='---\nname: pr\ndescription: Write reviewer-facing PR bodies.\n---\n# PR body\nRead the repository diff, preserve evidence and risks.\n'+'\n'+'owned PR-reference evidence\n'.repeat(700);
 try{
  host.harness.sdk.stub('threads.getPluginMetadata',async()=>({crew:'true',crewId:'task',shape:'ship',posture:mode,nativeHome:'/task-home'}));
  host.harness.sdk.stub('threads.get',async({threadId})=>({id:threadId,projectId:'proj_1',environmentId:'env_writer'}));
  host.harness.sdk.stub('skills.list',async args=>{assert.equal(args.projectId,'proj_1');assert.equal(args.environmentId,'env_writer');return{skills:[{id:'owned-pr',name:'pr',pluginId:null,scope:'bb-user'}]};});
  host.harness.sdk.stub('skills.getContent',async args=>{assert.equal(args.skillId,'owned-pr');assert.equal(args.path,'SKILL.md');return{content,revision};});
  const tool=host.harness.registrations.agentTools.find(t=>t.name==='firstmate_methods');assert.ok(tool);
  const cfg=await configure(host,{crew:'true',shape:'ship',posture:mode});assert.match(cfg.instructions,/before creating or updating a PR body/i);assert.match(cfg.instructions,/name=pr/);
  let cursor,assembled='',pages=0;
  do{
   const page=await tool.execute(cursor?{action:'read',cursor}:{action:'read',name:'pr'},worker);assert.equal(typeof page,'string',JSON.stringify(page));assert.ok(Buffer.byteLength(page)<19500);
   assembled+=/\nBEGIN_PAGE\n([\s\S]*)\nEND_PAGE\n/.exec(page)[1];
   const next=/"cursor":"([A-Za-z0-9_-]+)"/.exec(page)?.[1];
   if(next && !cursor){revision='revision-2';const changed=await tool.execute({action:'read',cursor:next},worker);assert.equal(changed.isError,true);revision='revision-1';const foreign=await tool.execute({action:'read',cursor:next},{...worker,threadId:'thr_other_worker'});assert.equal(foreign.isError,true);}
   cursor=next;assert.ok(++pages<20);if(!cursor)assert.match(page,/END OF BB METHODS TRANSPORT/);
  }while(cursor);
  assert.equal(assembled,content);assert.ok(pages>1);
  for(const posture of ['no-mistakes','local-only']){
   mode=posture;const config=await configure(host,{crew:'true',shape:'ship',posture});assert.doesNotMatch(config.instructions,/name=pr|before creating or updating a PR body/);
   const read=await tool.execute({action:'read',name:'pr'},worker);assert.equal(read.isError,true);assert.match(JSON.stringify(read),/body author/);
  }
  mode='direct-PR';host.harness.sdk.stub('skills.list',async()=>({skills:[]}));
  const missing=await tool.execute({action:'read',name:'pr'},worker);assert.equal(missing.isError,true);assert.match(JSON.stringify(missing),/Missing.*\/pr/);
  assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);assert.equal(host.harness.sdk.callsTo('threads.send').length,0);
 }finally{await host.harness.lifecycle.dispose();}
});

test('PR skill lookup cancellation settles disposal without writing a body or starting another task',async()=>{
 const host=await configuredHost({selectedMethods:'selected-v1'});let entered;const started=new Promise(r=>{entered=r;});
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({crew:'true',shape:'ship',posture:'direct-PR'}));
 host.harness.sdk.stub('threads.get',async()=>({projectId:'proj_1',environmentId:'env_writer'}));
 host.harness.sdk.stub('skills.list',async({signal})=>{assert.ok(signal instanceof AbortSignal);entered();return new Promise(()=>{});});
 const tool=host.harness.registrations.agentTools.find(t=>t.name==='firstmate_methods');
 const pending=tool.execute({action:'read',name:'pr'},{threadId:'thr_worker',projectId:'proj_1'});await started;
 await host.harness.lifecycle.dispose();let timer;
 try{const response=await Promise.race([pending,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('PR reader did not settle disposal')),1000);})]);assert.equal(response.isError,true);assert.match(JSON.stringify(response),/abort/i);assert.equal(host.harness.sdk.callsTo('skills.getContent').length,0);assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);}finally{clearTimeout(timer);}
});

test('PR author resolves provider-specific skill copies and permits only byte-identical cross-provider copies for ACP',async()=>{
 const host=await configuredHost({selectedMethods:'selected-v1'});let providerId='acp-grok',conflict=false;const reads=[];
 host.harness.sdk.stub('threads.getPluginMetadata',async()=>({crew:'true',shape:'ship',posture:'direct-PR'}));
 host.harness.sdk.stub('threads.get',async()=>({projectId:'proj_1',environmentId:'env_writer',providerId}));
 host.harness.sdk.stub('skills.list',async()=>({skills:['claude-code','codex','pi'].map(provider=>({name:'pr',id:provider+'-pr',provider,scope:'provider-user'}))}));
 host.harness.sdk.stub('skills.getContent',async({skillId})=>{reads.push(skillId);return{content:conflict && skillId==='pi-pr'?'Different body policy':'Exact selected PR body policy',revision:skillId+'-v1'};});
 const tool=host.harness.registrations.agentTools.find(t=>t.name==='firstmate_methods');const context={threadId:'thr_author',projectId:'proj_1'};
 try{
  const compatible=await tool.execute({action:'read',name:'pr'},context);assert.equal(typeof compatible,'string',JSON.stringify(compatible));assert.match(compatible,/Exact selected PR body policy/);assert.deepEqual(reads.sort(),['claude-code-pr','codex-pr','pi-pr']);
  conflict=true;const ambiguous=await tool.execute({action:'read',name:'pr'},context);assert.equal(ambiguous.isError,true);assert.match(JSON.stringify(ambiguous),/Ambiguous.*\/pr/);
  providerId='codex';reads.length=0;const native=await tool.execute({action:'read',name:'pr'},context);assert.equal(typeof native,'string',JSON.stringify(native));assert.deepEqual(reads,['codex-pr'],'use the actual selected provider rather than foreign copies');
 }finally{await host.harness.lifecycle.dispose();}
});

test('explicit installation PR source survives reload and unreadable foreign aliases without bypassing BB content guards',async()=>{
 let host=await configuredHost(),changed=false,unavailable=false,renamed=false;const context={threadId:'thr_cap',projectId:'proj_1'},worker={threadId:'thr_author',projectId:'proj_1'};
 const stubs=()=>{
  host.harness.sdk.stub('threads.getPluginMetadata',async({threadId})=>threadId==='thr_cap'?{captain:'true'}:{crew:'true',shape:'ship',posture:'direct-PR'});
  host.harness.sdk.stub('threads.get',async()=>({projectId:'proj_1',environmentId:'env_writer',providerId:'acp-grok'}));
  host.harness.sdk.stub('skills.list',async()=>({skills:[{name:renamed?'different-skill':'pr',id:'physical-pr',provider:'codex',scope:'provider-user'},{name:'pr',id:'alias-pr',provider:'claude-code',scope:'provider-user'}]}));
  host.harness.sdk.stub('skills.getContent',async({skillId})=>{if(skillId==='alias-pr')throw new Error('BB refuses symlink root');assert.equal(skillId,'physical-pr');if(unavailable)throw new Error('Selected resource unavailable');return{content:changed?'Changed PR skill':'Exact requested PR skill',revision:changed?'physical-v2':'physical-v1'};});
 };
 stubs();try{
  const selected=await host.harness.behavior.runCli(['methods','enable','selected-v1','--pr-skill','physical-pr','--reason','User selected this existing PR skill'],context);assert.equal(selected.exitCode,0,selected.stderr);
  const status=await host.harness.behavior.runCli(['methods','status','--json'],context);assert.equal(JSON.parse(status.stdout).prSkillId,'physical-pr');
  host=await host.harness.lifecycle.reload(plugin);stubs();
  const tool=host.harness.registrations.agentTools.find(t=>t.name==='firstmate_methods');const body=await tool.execute({action:'read',name:'pr'},worker);assert.equal(typeof body,'string',JSON.stringify(body));assert.match(body,/Exact requested PR skill/);assert.deepEqual(host.harness.sdk.callsTo('skills.getContent').map(([args])=>args.skillId),['physical-pr']);
  const bad=await host.harness.behavior.runCli(['methods','enable','selected-v1','--pr-skill','alias-pr','--reason','Explicit source change'],context);assert.equal(bad.exitCode,1);assert.match(bad.stderr,/symlink/);
  const retained=await host.harness.behavior.runCli(['methods','status','--json'],context);assert.equal(JSON.parse(retained.stdout).prSkillId,'physical-pr','invalid selection cannot replace valid prior source');
  changed=true;const changedRead=await tool.execute({action:'read',name:'pr'},worker);assert.equal(changedRead.isError,true);assert.match(JSON.stringify(changedRead),/source changed/);changed=false;
  unavailable=true;const lost=await tool.execute({action:'read',name:'pr'},worker);assert.equal(lost.isError,true);assert.match(JSON.stringify(lost),/unavailable/);unavailable=false;
  renamed=true;const unrelated=await host.harness.behavior.runCli(['methods','enable','selected-v1','--pr-skill','physical-pr','--reason','Cannot select a differently named skill'],context);assert.equal(unrelated.exitCode,1);assert.match(unrelated.stderr,/unavailable|requested pr/);
  assert.equal(host.harness.sdk.callsTo('threads.spawn').length,0);
 }finally{await host.harness.lifecycle.dispose();}
});
