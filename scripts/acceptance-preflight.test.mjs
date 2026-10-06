import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {validateAcceptance,acceptancePreflight} from './acceptance-preflight.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
test('preflight refuses disabled/stale/wrong-server/wrong-host candidates while keeping runtime selection explicitly unverified',()=>{
 const home=mkdtempSync(join(tmpdir(),'fm-preflight-'));try{
  const pluginRoot=join(home,'plugin'),data=join(home,'data');mkdirSync(data);mkdirSync(join(pluginRoot,'dist'),{recursive:true});mkdirSync(join(pluginRoot,'runtime-assets'));writeFileSync(join(pluginRoot,'dist/server.js'),'reviewed build');writeFileSync(join(pluginRoot,'runtime-assets/runtime.tar.gz'),'reviewed archive');writeFileSync(join(pluginRoot,'runtime-assets/distribution.json'),JSON.stringify({release:'release',upstreamCommit:'audited',archiveSha256:sha('reviewed archive')}));
  const sentinel=join(data,'reports');writeFileSync(sentinel,'unhandled reports');
  const expected={serverUrl:'http://127.0.0.1:1234',launchId:'owned',dataDir:data,pluginRoot,hostId:'host_owned',buildSha256:sha('reviewed build'),release:'release'};
  const snapshot={health:{launchId:'owned'},version:'0.44.0',status:{dataDir:data},plugins:{plugins:[{id:'firstmate',enabled:true,status:'running',rootDir:pluginRoot}]},hosts:[{id:'host_owned',status:'connected'}]};
  const accepted=validateAcceptance(snapshot,expected);assert.equal(accepted.plugin.enabled,true);assert.equal(accepted.selectedRuntime.checked,false);assert.equal(accepted.modelLaunchObserved,false);
  for(const [change,pattern] of [[{enabled:false},/not enabled\/running/],[{status:'error'},/not enabled\/running/]])assert.throws(()=>validateAcceptance({...snapshot,plugins:{plugins:[{...snapshot.plugins.plugins[0],...change}]}},expected),pattern);
  for(const [change,pattern] of [[{launchId:'other'},/launch identity/],[{dataDir:pluginRoot},/data directory/],[{hostId:'foreign'},/absent\/disconnected/],[{buildSha256:'0'.repeat(64)},/artifact hash/],[{release:'other'},/runtime/],[{projectId:'proj_foreign'},/project\/host/]])assert.throws(()=>validateAcceptance(snapshot,{...expected,...change}),pattern);
  assert.throws(()=>validateAcceptance({...snapshot,version:'999'},expected),/Unsupported BB/);
  assert.equal(readFileSync(sentinel,'utf8'),'unhandled reports');
 }finally{rmSync(home,{recursive:true,force:true});}
});
test('wrong health identity refuses before any CLI invocation and remote/implicit origins refuse',async()=>{
 const expected={serverUrl:'http://127.0.0.1:1234',launchId:'owned',dataDir:'/owned',pluginRoot:'/owned/plugin',hostId:'host_owned',buildSha256:'a'.repeat(64),release:'release'};
 await assert.rejects(acceptancePreflight(expected,{binary:'/missing-never-invoked',fetcher:async()=>({ok:true,json:async()=>({launchId:'other'})})}),/Wrong server launch identity/);
 await assert.rejects(acceptancePreflight({...expected,serverUrl:'https://production.example'}),/loopback/);
 await assert.rejects(acceptancePreflight({...expected,hostId:''}),/Missing exact/);
});
