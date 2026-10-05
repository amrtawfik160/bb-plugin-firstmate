import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {ok,run} from './prompt-fixture.mjs';
export const assets=resolve('runtime-assets');
export const distribution=JSON.parse(readFileSync(join(assets,'distribution.json'),'utf8'));
export const helper=join(assets,'runtime-host.py');
export function runtimeFixture() {
 const directory=mkdtempSync(join(tmpdir(),'fm-bundled-owned-')),store=join(directory,'store'),home=join(directory,'homes/thr_fixture');
 const env={...process.env,HOME:directory,FM_BOOTSTRAP_NETWORK:'skip',FM_BOOTSTRAP_DETECT_ONLY:'1'};
 const call=(action,extra=[],overrides={})=>spawnSync('python3',[helper,action,'--store',store,...extra],{encoding:'utf8',env:{...env,...overrides},timeout:45000,maxBuffer:8*1024*1024});
 const owned=['--home',home,'--captain','thr_fixture','--host','host_fixture'];
 const install=()=>call('install',['--archive',join(assets,'runtime.tar.gz'),'--sha256',distribution.archiveSha256]);
 const bind=()=>call('bind',[...owned,'--release',distribution.release,'--project-id','proj_fixture']);
 const json=result=>{assert.equal(result.status,0,result.stdout+result.stderr);return JSON.parse(result.stdout);};
 const ready=()=>{json(install());json(bind());return join(store,'versions',distribution.release,'runtime');};
 return{directory,store,home,env,call,owned,json,install,bind,ready,clean:()=>rmSync(directory,{recursive:true,force:true})};
}

export function secondRelease(f) {
 const result=ok(run('python3',['-c',`import hashlib,io,json,tarfile,gzip,sys
from pathlib import Path
original=Path(sys.argv[1]);out=Path(sys.argv[2]);files={}
with tarfile.open(original,'r:gz') as bundle:
 for entry in bundle.getmembers():files[entry.name]=bundle.extractfile(entry).read()
manifest=json.loads(files['release-manifest.json']);manifest['pluginVersion']='0.4.1-fixture'
files['release-manifest.json']=(json.dumps(manifest,sort_keys=True,separators=(',',':'))+'\\n').encode()
release=hashlib.sha256(files['release-manifest.json']).hexdigest();raw=io.BytesIO()
with tarfile.open(fileobj=raw,mode='w',format=tarfile.USTAR_FORMAT) as bundle:
 for name,data in sorted(files.items()):
  item=tarfile.TarInfo(name);item.size=len(data);item.mode=420;item.mtime=0;bundle.addfile(item,io.BytesIO(data))
compressed=gzip.compress(raw.getvalue(),mtime=0);out.write_bytes(compressed)
print(json.dumps({'release':release,'sha256':hashlib.sha256(compressed).hexdigest()}))`,join(assets,'runtime.tar.gz'),join(f.directory,'next.tar.gz')]));return JSON.parse(result);
}
