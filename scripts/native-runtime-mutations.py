#!/usr/bin/env python3
"""Causal proofs in private source copies. Never modifies the working checkout."""
import argparse,json,os,shutil,subprocess,tempfile
from pathlib import Path

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--evidence',type=Path,required=True);args=parser.parse_args();args.evidence.mkdir(parents=True,exist_ok=True)
    source=Path(__file__).resolve().parents[1]
    cases=[
      ('archive-checksum','scripts/runtime-host.py',"    if sha(archive)!=args.sha256: raise ValueError('runtime archive checksum mismatch; nothing installed or selected')","    # MUTATION: omit archive hash guard",'corrupted release/native source','scripts/native-runtime.test.mjs'),
      ('native-consumers','scripts/runtime-host.py',"    if list(state.glob('*.meta')): reasons.append('retained native task identities still reference this home')","    # MUTATION: omit retained native identities",'selection refuses foreign','scripts/native-runtime.test.mjs'),
      ('native-task-set','scripts/runtime-host.py','with guard, native_task_set(args.home,root,args.check):','with guard:','native task-set lock','scripts/native-runtime.test.mjs'),
      ('snapshot-attestation','overlay/install-bb-backend.py','if (home / ".bb-native-runtime.json").exists():\n            attestation','if False:\n            attestation','synthetic source cannot self-declare','scripts/native-runtime.test.mjs'),
      ('renderer-home-only','overlay/bin/backends/bb-worker-prompt.py',"    if bindir != home + '/bin-bb':","    require(bindir == home + '/bin-bb','MUTATION: reject selected immutable runtime')\n    if bindir != home + '/bin-bb':",'bundled ship/direct-PR','scripts/native-runtime.test.mjs'),
      ('worker-code-root','overlay/bin/backends/bb.sh','local home=${FM_ROOT_OVERRIDE:-${FM_HOME:-}}','local home=${FM_HOME:-}','bundled ship/direct-PR','scripts/native-runtime.test.mjs'),
      ('worker-home-environment','overlay/bin/backends/bb-worker-transport.txt','Native command environment: `{FM_COMMAND_ENV}`.','Native command environment: `FM_BACKEND=bb`.','bundled ship/direct-PR','scripts/native-runtime.test.mjs'),
      ('replacement-source','overlay/bin/fm-worker-rebind.py',"    source=a.regular(a.native_root(home)/'bin/fm-spawn.sh')","    a.require(a.git(home,'rev-parse','HEAD') in a.PINS,'MUTATION: unaudited synthetic source')\n    source=a.regular(home/'bin/fm-spawn.sh')",'bundled ship/direct-PR','scripts/native-runtime.test.mjs'),
      ('external-rollback','scripts/runtime-host.py','                selection_path(args.home).unlink()','                pass # MUTATION: leave the bundled selection','explicit external 2d833ff1','scripts/native-runtime.test.mjs'),
      ('built-assets','lib/plugin-assets.ts',"return basename(directory)==='dist'?dirname(directory):directory;","return directory;",'actual registered cli clean captain','server.native-runtime.test.mjs'),
    ]
    results=[]
    for name,path,before,after,pattern,testfile in cases:
      with tempfile.TemporaryDirectory(prefix='fm-runtime-mutation-') as directory:
        root=Path(directory)/'plugin'
        shutil.copytree(source,root,ignore=shutil.ignore_patterns('.git','node_modules','dist','__pycache__'))
        (root/'node_modules').symlink_to((source/'node_modules').resolve())
        target=root/path;text=target.read_text()
        if text.count(before)!=1: raise RuntimeError(f'mutation anchor mismatch: {name}')
        target.write_text(text.replace(before,after))
        package=subprocess.run(['python3','scripts/package-native-runtime.py'],cwd=root,capture_output=True,text=True,timeout=30)
        if package.returncode: raise RuntimeError(package.stdout+package.stderr)
        env={**os.environ}
        if name=='built-assets':
          build=subprocess.run(['bb','plugin','build','.'],cwd=root,capture_output=True,text=True,timeout=30)
          if build.returncode: raise RuntimeError(build.stdout+build.stderr)
          env['FM_RUNTIME_BUILT']='1'
        run=subprocess.run(['node','--test','--experimental-strip-types','--test-name-pattern='+pattern,testfile],cwd=root,env=env,capture_output=True,text=True,timeout=90)
        output=run.stdout+run.stderr;(args.evidence/(name+'.log')).write_text(output)
        # A loader error or missing test is not a causal kill. Require one actual
        # test failure with its assertion/guard evidence; healthy proof is separate.
        killed=run.returncode!=0 and ('✖ '+pattern in output or 'not ok ' in output or 'ℹ fail 1' in output)
        results.append({'mutation':name,'testPattern':pattern,'testFile':testfile,'exit':run.returncode,'killed':killed})
        print(json.dumps(results[-1]),flush=True)
        if not killed: raise RuntimeError('mutation survived or no behavioural test executed: '+name)
    (args.evidence/'results.json').write_text(json.dumps(results,indent=2)+'\n')
if __name__=='__main__':main()
