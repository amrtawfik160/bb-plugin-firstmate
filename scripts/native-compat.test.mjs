import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,cpSync,rmSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {overlay,pins,fixture,run,ok} from './prompt-fixture.mjs';
import {OVERLAY_INSTALL_INPUTS,overlayFingerprint} from '../server.ts';
const installer=join(overlay,'install-bb-backend.py');
const registry=JSON.parse(readFileSync(join(overlay,'patch-sets.json'),'utf8'));
const patched=['fm-backend.sh','fm-spawn.sh','fm-teardown.sh','fm-merge-local.sh','fm-bootstrap.sh','fm-tasks-axi-lib.sh','fm-quota-axi-lib.sh','fm-busy-lib.sh','fm-secondmate-liveness-lib.sh','fm-watch.sh'];
const install=(home,bundle=overlay)=>run('python3',[installer,'--home',home,'--overlay',bundle]);
const verify=(home,bundle=overlay)=>run('python3',[installer,'--home',home,'--overlay',bundle,'--verify']);
function treeDigest(root) {return ok(run('python3',['-c',"import hashlib,pathlib,sys;p=pathlib.Path(sys.argv[1]);h=hashlib.sha256();[(h.update(str(f.relative_to(p)).encode()),h.update(('link:'+str(f.readlink())).encode() if f.is_symlink() else f.read_bytes())) for f in sorted(p.rglob('*')) if f.is_file() or f.is_symlink()];print(h.hexdigest())",root])).trim();}

for(const pin of pins) test(`exact native ${pin.slice(0,8)} patches install, load both siblings and preserve all native tracked inputs`,()=>{
 const home=fixture(pin);try {
  const result=install(home);ok(result);assert.doesNotMatch(result.stdout+result.stderr,/offset|fuzz|FAILED/);
  assert.match(result.stdout,new RegExp(`selected audited native patch set ${pin}`));ok(verify(home));
  for(const file of patched) ok(run('bash',['-n',join(home,'bin-bb',file)]));
  const backend=readFileSync(join(home,'bin-bb/fm-backend.sh'),'utf8');
  assert.ok(backend.includes(pin===pins[0]?'siblings="fm-composer-lib.sh fm-transition-lib.sh"':'set -- fm-composer-lib.sh fm-transition-lib.sh'));
  const loaded=ok(run('bash',['-c','set -eu; . "$FM_HOME/bin-bb/fm-backend.sh"; fm_backend_source bb; declare -F fm_backend_bb_create_task fm_composer_strip_ansi fm_transition_record','fixture'],{FM_HOME:home,FM_BACKEND:'bb'}));
  assert.match(loaded,/fm_backend_bb_create_task/);assert.match(loaded,/fm_transition_record/);
  const manifest=readFileSync(join(home,'bin-bb/.mirror-manifest'),'utf8');assert.match(manifest,new RegExp(`^patch-set=${pin}$`,'m'));assert.match(manifest,/^patch-set-sha=[0-9a-f]{64}$/m);
  assert.equal(ok(run('git',['-C',home,'status','--porcelain','--untracked-files=no'])),'');assert.equal(ok(run('git',['-C',home,'rev-parse','HEAD'])).trim(),pin);
 }finally{rmSync(home,{recursive:true,force:true});}
});

for(const pin of pins) test(`exact native ${pin.slice(0,8)} secondmate seed/spawn and guarded teardown run through installed policy without model launches`,()=>{
 const home=fixture(pin),childRoot=mkdtempSync(join(tmpdir(),'fm-compat-child-'));try {
  ok(install(home));const child=join(childRoot,'home');const fake=join(home,'fakebin');mkdirSync(fake);const log=join(home,'bb-events.jsonl');
  writeFileSync(join(fake,'bb'),`#!/usr/bin/env python3\nimport json,sys\na=sys.argv[1:]\nwith open(${JSON.stringify(log)},'a') as f:f.write(json.dumps(a)+'\\n')\nif a[:2] in [['firstmate','create-worker'],['thread','show']]:print(json.dumps({'id':'thr_domain','status':'idle','path':${JSON.stringify(child)}}))\n`,{mode:0o755});
  const env={FM_HOME:home,FM_BACKEND:'bb',FM_BB_PROJECT_ID:'proj_fixture',FM_BB_MACHINE:'host_fixture',FM_STATE_OVERRIDE:join(home,'state'),PATH:`${fake}:${process.env.PATH}`,FM_SECONDMATE_CHARTER:'Audit the isolated fixture.',FM_SECONDMATE_SCOPE:'Fixture audit',FM_SKIP_SECONDMATE_SYNC:'1'};
  ok(run('bash',[join(home,'bin-bb/fm-home-seed.sh'),'domain',child,'--no-projects'],env));
  ok(run('bash',[join(home,'bin-bb/fm-spawn.sh'),'domain',child,'--secondmate','--backend','bb','--harness','bb'],env));
  const meta=readFileSync(join(home,'state/domain.meta'),'utf8');assert.match(meta,/^kind=secondmate$/m);assert.match(meta,/^backend=bb$/m);assert.ok(meta.includes(`home=${child}`));
  const calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);const create=calls.find(a=>a[0]==='firstmate'&&a[1]==='create-worker');assert.ok(create);assert.ok(create.includes('--path')&&create.includes(child));assert.ok(create.includes('--shape')&&create.includes('secondmate'));assert.ok(!calls.some(a=>a[1]==='mark-captain'));
  // Native --force here is disposable fixture cleanup, never a real task.
  const teardown=run('bash',[join(home,'bin-bb/fm-teardown.sh'),'domain','--force'],env);ok(teardown);
  assert.equal(existsSync(join(home,'state/domain.meta')),false);assert.ok(readFileSync(log,'utf8').includes('thread'));
 }finally{rmSync(home,{recursive:true,force:true});rmSync(childRoot,{recursive:true,force:true});}
});

test('unknown source SHA and mismatched old/new patch inputs refuse without replacing the working mirror',()=>{
 const home=fixture(pins[0]),bundle=mkdtempSync(join(tmpdir(),'fm-compat-mismatch-'));try {
  ok(install(home));const before=treeDigest(join(home,'bin-bb'));cpSync(overlay,bundle,{recursive:true});
  const changed=structuredClone(registry);changed.sets[pins[0]]=changed.sets[pins[1]];writeFileSync(join(bundle,'patch-sets.json'),JSON.stringify(changed));
  const mismatch=install(home,bundle);assert.notEqual(mismatch.status,0);assert.match(mismatch.stderr,/did not apply/);assert.equal(treeDigest(join(home,'bin-bb')),before);
  ok(run('git',['-C',home,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','unknown source fixture']));
  const unknown=install(home);assert.notEqual(unknown.status,0);assert.match(unknown.stderr,/unsupported native source SHA/);assert.equal(treeDigest(join(home,'bin-bb')),before);
  const stale=verify(home);assert.notEqual(stale.status,0);assert.match(stale.stderr,/unsupported native source SHA/);assert.equal(existsSync(join(home,'bin-bb.staging')),false);
 }finally{rmSync(home,{recursive:true,force:true});rmSync(bundle,{recursive:true,force:true});}
});

test('remote overlay manifest ships every selected patch; fingerprints and recorded patch identity detect changes',()=>{
 const bundle=mkdtempSync(join(tmpdir(),'fm-remote-bundle-'));try {
  // Materialize exactly the same declared remote payload as server installBbOverlay.
  for(const rel of OVERLAY_INSTALL_INPUTS) {const target=join(bundle,rel);mkdirSync(join(target,'..'),{recursive:true});writeFileSync(target,readFileSync(join(overlay,rel)));}
  for(const pin of pins) for(const rel of registry.sets[pin]) assert.ok(OVERLAY_INSTALL_INPUTS.includes(rel));assert.ok(OVERLAY_INSTALL_INPUTS.includes('patch-sets.json'));
  assert.equal(overlayFingerprint(bundle),overlayFingerprint(overlay));
  for(const pin of pins) {
   const home=fixture(pin);try {
    ok(install(home,bundle));ok(verify(home,bundle));
    const path=join(bundle,registry.sets[pin][0]),original=readFileSync(path);writeFileSync(path,Buffer.concat([original,Buffer.from('\n# bundle drift\n')]));
    assert.notEqual(overlayFingerprint(bundle),overlayFingerprint(overlay));const stale=verify(home,bundle);assert.notEqual(stale.status,0);assert.match(stale.stderr,/patch-set identity\/digest|overlay changed/);writeFileSync(path,original);
    const manifestPath=join(home,'bin-bb/.mirror-manifest'),manifest=readFileSync(manifestPath,'utf8');writeFileSync(manifestPath,manifest.replace(`patch-set=${pin}`,`patch-set=${pins.find(x=>x!==pin)}`));assert.notEqual(verify(home,bundle).status,0);writeFileSync(manifestPath,manifest);ok(verify(home,bundle));
   }finally{rmSync(home,{recursive:true,force:true});}
  }
 }finally{rmSync(bundle,{recursive:true,force:true});}
});
