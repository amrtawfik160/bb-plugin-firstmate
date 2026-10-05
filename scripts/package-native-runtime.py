#!/usr/bin/env python3
"""Combine the audited native snapshot and exact adapter inputs reproducibly."""
import argparse, gzip, hashlib, importlib.util, io, json, tarfile
from pathlib import Path

def sha(data): return hashlib.sha256(data).hexdigest()
def package(root, check=False):
    assets=root/'runtime-assets'
    native=json.loads((assets/'native-manifest.json').read_text())
    spec=importlib.util.spec_from_file_location('overlay_install',root/'overlay/install-bb-backend.py')
    overlay=importlib.util.module_from_spec(spec);spec.loader.exec_module(overlay)
    payloads={name:(assets/name).read_bytes() for name in ['native-manifest.json','LICENSE.firstmate','NOTICE']}
    # native.bundle is a generation intermediate; only the compressed release ships.
    if (assets/'native.bundle').exists(): payloads['native.bundle']=(assets/'native.bundle').read_bytes()
    else:
        with tarfile.open(assets/'runtime.tar.gz','r:gz') as archive: payloads['native.bundle']=archive.extractfile('native.bundle').read()
    if sha(payloads['native.bundle'])!=native['nativeBundle']['sha256']: raise ValueError('native bundle differs from audited generation manifest')
    payloads['runtime-host.py']=(root/'scripts/runtime-host.py').read_bytes()
    for name in overlay.OVERLAY_INSTALL_INPUTS: payloads['overlay/'+name]=(root/'overlay'/name).read_bytes()
    manifest={'schema':1,'pluginVersion':json.loads((root/'package.json').read_text())['version'],
              'upstreamCommit':native['upstreamCommit'],'snapshotCommit':native['snapshotCommit'],
              'adapterRevision':overlay.overlay_fingerprint(root/'overlay'),'stateContract':native['stateContract'],
              'payloads':{name:sha(data) for name,data in sorted(payloads.items())}}
    raw=(json.dumps(manifest,sort_keys=True,separators=(',',':'))+'\n').encode()
    payloads['release-manifest.json']=raw
    archive=io.BytesIO()
    with tarfile.open(fileobj=archive,mode='w',format=tarfile.USTAR_FORMAT) as out:
        for name,data in sorted(payloads.items()):
            member=tarfile.TarInfo(name);member.size=len(data);member.mode=0o644;member.mtime=0;member.uid=member.gid=0
            out.addfile(member,io.BytesIO(data))
    compressed=gzip.compress(archive.getvalue(),compresslevel=9,mtime=0)
    # Normalize gzip OS byte so Python/platform differences cannot change this artifact.
    compressed=compressed[:9]+b'\xff'+compressed[10:]
    if not check: (assets/'runtime.tar.gz').write_bytes(compressed)
    helper=(root/'scripts/runtime-host.py').read_bytes()
    if not check: (assets/'runtime-host.py').write_bytes(helper)
    distribution={'schema':1,'release':sha(raw),'archiveSha256':sha(compressed),'archiveBytes':len(compressed),
                  'helperSha256':sha(helper),'pluginVersion':manifest['pluginVersion'],'upstreamCommit':native['upstreamCommit'],
                  'snapshotCommit':native['snapshotCommit'],'adapterRevision':manifest['adapterRevision'],'stateContract':manifest['stateContract'],'auditedSources':sorted(json.loads((root/'overlay/patch-sets.json').read_text())['sets'])}
    distribution_raw=json.dumps(distribution,sort_keys=True,indent=2)+'\n'
    if check:
        if (assets/'distribution.json').read_text()!=distribution_raw or (assets/'runtime.tar.gz').read_bytes()!=compressed or (assets/'runtime-host.py').read_bytes()!=helper:
            raise ValueError('bundled runtime is stale or incomplete; run runtime:package and review the release manifest')
    else: (assets/'distribution.json').write_text(distribution_raw)
    print(json.dumps(distribution,sort_keys=True))
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--root',type=Path,default=Path('.'));parser.add_argument('--check',action='store_true');args=parser.parse_args();package(args.root.resolve(),args.check)
