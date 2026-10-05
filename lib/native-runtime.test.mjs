import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {pluginAssetRoot} from './plugin-assets.ts';
import {createNativeRuntime,loadRuntimeAssets,runtimeRootAssign} from './native-runtime.ts';
const assets=resolve('runtime-assets'),sha=b=>createHash('sha256').update(b).digest('hex');
function fake(write) {
 const controller=new AbortController(),calls=[],writes=[],removed=[];
 const run=async(host,command)=>{calls.push({host,command});return{exitCode:0,output:command.startsWith('printf')?"/home/user's remote":command.includes(' && python3 ')?'{}':''};};
 const files={remove:async data=>{removed.push(data);return{};},write:async data=>{writes.push(data);return write?write(data):{outcome:'written',sha256:sha(Buffer.from(data.content,'base64'))};}};
 return{runtime:createNativeRuntime({assets,files:()=>files,disposal:controller.signal,run}),controller,calls,writes,removed};
}
test('runtime host transfer uses public host files with checked bytes, explicit host and bounded quoted commands',async()=>{
 const f=fake();await f.runtime.operation('host_remote','install');assert.equal(f.writes.length,2);assert.ok(f.writes.every(w=>w.hostId==='host_remote'&&w.mode===0o600&&w.expectedSha256===null&&w.rootPath.startsWith('/tmp/.fm-runtime-')));assert.equal(f.writes[1].contentEncoding,'base64');assert.ok(Buffer.from(f.writes[1].content,'base64').equals(readFileSync(join(assets,'runtime.tar.gz'))));assert.ok(f.calls.every(c=>c.host==='host_remote'&&Buffer.byteLength(c.command)<8000));assert.equal(f.calls.filter(c=>c.command.includes(' && python3 ')).length,1);assert.equal(f.removed.length,1);assert.match(f.removed[0].path,/^\/tmp\/.fm-runtime-/);
});
test('failed/conflicting file staging never invokes publication or selection',async()=>{
 for(const mode of ['throw','conflict','mismatched']){
 const f=fake(async()=>{if(mode==='throw')throw new Error('staging fault');return mode==='conflict'?{outcome:'conflict'}:{outcome:'written',sha256:'0'.repeat(64)};});await assert.rejects(f.runtime.operation('host_remote','install'),/staging/);assert.equal(f.calls.some(c=>c.command.includes(' && python3 ')),false);assert.equal(f.removed.length,1);
 }
});
test('interruption during SDK write settles promptly; late bytes get cleanup and never execute',async()=>{
 let release,entered;const start=new Promise(r=>entered=r);const f=fake(data=>{entered();return new Promise(r=>release=()=>r({outcome:'written',sha256:sha(Buffer.from(data.content,'base64'))}));});const request=f.runtime.operation('host_remote','install');await start;f.controller.abort(new Error('disposed'));await assert.rejects(Promise.race([request,new Promise((_,reject)=>setTimeout(()=>reject(new Error('hung')),1000))]),/disposed/);release();await new Promise(r=>setTimeout(r,10));assert.equal(f.calls.some(c=>c.command.includes(' && python3 ')),false);assert.equal(f.removed.length,2);
});
test('missing or changed asset bytes refuse before any host operation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'fm-corrupt-assets-'));try{cpSync(assets,dir,{recursive:true});writeFileSync(join(dir,'runtime-host.py'),'corrupted');assert.throws(()=>loadRuntimeAssets(dir),/mismatched/);rmSync(join(dir,'runtime.tar.gz'));assert.throws(()=>loadRuntimeAssets(dir));}finally{rmSync(dir,{recursive:true,force:true});}
});
test('runtime shell resolves exact selected release; selection descriptor never supplies executable code or guessed global root',()=>{
 const command=runtimeRootAssign("/home/a quoted ' captain");assert.match(command,/helperSha256/);assert.match(command,/"resolve"/);assert.match(command,/FM_BUNDLED_VERIFIED=1/);assert.doesNotMatch(command,/\/root\/firstmate|github_projects/);
});

test("built and source entrypoints resolve only their own shipped package assets",()=>{assert.equal(pluginAssetRoot("file:///owned/plugin/server.ts"),"/owned/plugin");assert.equal(pluginAssetRoot("file:///owned/plugin/dist/server.js"),"/owned/plugin");assert.equal(pluginAssetRoot("file:///owned/runtime/server.js"),"/owned/runtime");});
