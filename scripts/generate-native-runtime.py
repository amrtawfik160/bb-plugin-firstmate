#!/usr/bin/env python3
"""Build a reproducible filtered native Git snapshot. Reads only committed source."""
import argparse, hashlib, json, os, subprocess, tempfile, sys
from pathlib import Path
PIN = '1f3e769616fdf9f31f85f4c3e6a9f71606634238'
PREFIXES = ('bin/', '.agents/', '.claude/', '.codex/', '.cursor/', '.grok/', '.omp/', '.opencode/', '.pi/', 'skills/', 'docs/')
ROOT_FILES = ('AGENTS.md', 'CLAUDE.md', 'GROK_BOT.md', 'README.md', 'LICENSE', 'CONTRIBUTING.md', '.tasks.toml', '.gitignore', '.gitattributes')
def digest(data): return hashlib.sha256(data).hexdigest()
def run(args, **kw): return subprocess.check_output(args, **kw)
def generate(source, destination):
    destination.mkdir(parents=True, exist_ok=True)
    source_env={key:value for key,value in os.environ.items() if not key.startswith('GIT_')}
    source_env.update(GIT_CONFIG_GLOBAL=os.devnull,GIT_CONFIG_SYSTEM=os.devnull,GIT_NO_REPLACE_OBJECTS='1',GIT_TEMPLATE_DIR='')
    entries = run(['git','-C',str(source),'ls-tree','-rz',PIN],env=source_env).split(b'\0')
    files = {}
    with tempfile.TemporaryDirectory(prefix='fm-native-package-') as temporary:
        tree = Path(temporary)
        # No user/system Git configuration, credentials, hooks or inherited author identity.
        env = {**source_env, 'GIT_CONFIG_GLOBAL':os.devnull, 'GIT_CONFIG_SYSTEM':os.devnull,
               'GIT_AUTHOR_NAME':'Firstmate runtime packaging', 'GIT_AUTHOR_EMAIL':'runtime@invalid',
               'GIT_COMMITTER_NAME':'Firstmate runtime packaging', 'GIT_COMMITTER_EMAIL':'runtime@invalid',
               'GIT_AUTHOR_DATE':'2026-10-04T00:00:00Z', 'GIT_COMMITTER_DATE':'2026-10-04T00:00:00Z'}
        for key in ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES']:
            env.pop(key, None)
        for entry in entries:
            if not entry: continue
            header, name = entry.split(b'\t',1)
            mode, kind, oid = header.decode().split()
            name = name.decode()
            if not (name in ROOT_FILES or name.startswith(PREFIXES)): continue
            if any(component in ('tests','__pycache__') for component in Path(name).parts): continue
            if mode not in ('100644','100755','120000'): raise ValueError(f'unsupported native entry {name}')
            data = run(['git','-C',str(source),'cat-file','blob',oid],env=source_env)
            path = tree/name; path.parent.mkdir(parents=True,exist_ok=True)
            if mode == '120000':
                target = data.decode()
                resolved = (path.parent/target).resolve()
                if not resolved.is_relative_to(tree): raise ValueError(f'escaping native symlink {name}')
                path.symlink_to(target)
            else:
                path.write_bytes(data); path.chmod(0o755 if mode=='100755' else 0o644)
            files[name] = {'sha256':digest(data), 'mode':mode, 'bytes':len(data)}
        for name in files:
            path = tree/name
            if path.is_symlink() and not path.exists(): raise ValueError(f'missing transitive symlink target {name}')
        descriptor = {'schema':1, 'format':'filtered-git-snapshot-v1', 'upstreamCommit':PIN,
                      'upstreamSource':'https://github.com/kunchenguid/firstmate', 'stateContract':'native-flat-v1', 'files':files}
        (tree/'.bb-native-runtime.json').write_text(json.dumps(descriptor,sort_keys=True,separators=(',',':'))+'\n')
        run(['git','init','--quiet','--initial-branch=main',str(tree)],env=env)
        run(['git','-C',str(tree),'add','--force','.'],env=env)
        oid = run(['git','-C',str(tree),'write-tree'],env=env).decode().strip()
        commit = run(['git','-C',str(tree),'commit-tree',oid],env=env,input=f'Filtered Firstmate runtime {PIN}\n'.encode()).decode().strip()
        run(['git','-C',str(tree),'update-ref','refs/heads/main',commit],env=env)
        bundle = destination/'native.bundle'
        run(['git','-C',str(tree),'bundle','create',str(bundle.resolve()),'refs/heads/main'],env=env)
        manifest = {'schema':1,'generator':{'git':run(['git','--version'],env=source_env).decode().strip(),'python':sys.version.split()[0]},'upstreamCommit':PIN,'upstreamSource':descriptor['upstreamSource'],
                    'snapshotCommit':commit,'stateContract':descriptor['stateContract'],
                    'nativeBundle':{'sha256':digest(bundle.read_bytes()),'bytes':bundle.stat().st_size},
                    'sourceManifestSha256':digest((tree/'.bb-native-runtime.json').read_bytes()),'nativeFiles':len(files)}
        (destination/'native-manifest.json').write_text(json.dumps(manifest,sort_keys=True,indent=2)+'\n')
        registry_path=Path(__file__).resolve().parents[1]/'overlay/patch-sets.json'
        registry=json.loads(registry_path.read_text())
        if PIN not in registry['sets']: raise ValueError('native generator pin has no audited adapter patch set')
        registry['bundledSnapshots']={commit:{'upstreamCommit':PIN,'sourceManifestSha256':manifest['sourceManifestSha256']}}
        registry_path.write_text(json.dumps(registry,sort_keys=True,indent=2)+'\n')
        (destination/'LICENSE.firstmate').write_bytes((tree/'LICENSE').read_bytes())
        (destination/'NOTICE').write_text(f'Firstmate by Kun Chen, MIT License.\nSource: {descriptor["upstreamSource"]}\nUpstream commit: {PIN}\nNative files are unchanged; the BB adapter is separately marked and versioned.\nThe snapshot Git commit is a packaging identity, not the upstream commit.\n')
        print(json.dumps(manifest,sort_keys=True))
if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('--source',type=Path,required=True);parser.add_argument('--output',type=Path,default=Path('runtime-assets'))
    args=parser.parse_args();generate(args.source,args.output)
