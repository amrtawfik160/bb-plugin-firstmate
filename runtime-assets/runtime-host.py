#!/usr/bin/env python3
"""BB-only release transport. Native code/policy is never rewritten here.

All operations are host-local, offline, serialized and publication is atomic.
Selection never edits task state, configuration policy, hooks or worker paths.
"""
import argparse, contextlib, fcntl, stat, hashlib, importlib.util, json, os, re, shutil, subprocess, tarfile, tempfile, time, uuid, sys, selectors
from pathlib import Path
sys.dont_write_bytecode=True

def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def regular(path):
    if path.is_symlink() or not path.is_file(): raise ValueError(f'expected regular file: {path}')
    return path

def json_read(path): return json.loads(regular(path).read_text())
def identifier(value):
    if not re.fullmatch(r'[0-9a-f]{64}',value): raise ValueError('invalid release identity')
    return value

def owner(value):
    if not re.fullmatch(r'thr_[A-Za-z0-9_-]+',value): raise ValueError('invalid captain identity')
    return value

def git(path,*args):
    env={**os.environ,'GIT_CONFIG_GLOBAL':os.devnull,'GIT_CONFIG_SYSTEM':os.devnull}
    for name in ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES']:
        env.pop(name,None)
    return subprocess.check_output(['git','-c','core.hooksPath=/dev/null','-C',str(path),*args],env=env,stderr=subprocess.STDOUT).decode().strip()

@contextlib.contextmanager
def lock(path):
    path.parent.mkdir(parents=True,exist_ok=True)
    descriptor=os.open(path,os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW|os.O_NONBLOCK,0o600)
    started=time.monotonic()
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode): raise ValueError(f'non-regular runtime lock: {path}')
        while True:
            try: fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB);break
            except BlockingIOError:
                if time.monotonic()-started>15: raise ValueError(f'runtime publication busy: {path}')
                time.sleep(.05)
        yield
    finally: os.close(descriptor)

def atomic_json(path,value):
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_name(path.name+'.tmp-'+uuid.uuid4().hex)
    try:
        with open(temporary,'x') as out:
            json.dump(value,out,sort_keys=True,indent=2);out.write('\n');out.flush();os.fsync(out.fileno())
        os.replace(temporary,path)
        descriptor=os.open(path.parent,os.O_DIRECTORY);os.fsync(descriptor);os.close(descriptor)
    finally: temporary.unlink(missing_ok=True)

def module(path):
    spec=importlib.util.spec_from_file_location('bb_native_overlay',path)
    result=importlib.util.module_from_spec(spec);spec.loader.exec_module(result);return result

def verify_version_path(root,release):
    identifier(release)
    if any(parent.is_symlink() for parent in [root,root.parent]) or not root.is_dir(): raise ValueError(f'runtime is not installed: {release}')
    manifest_path=regular(root/'release-manifest.json')
    if sha(manifest_path)!=release: raise ValueError('installed release manifest identity mismatch')
    manifest=json_read(manifest_path)
    if manifest['schema']!=1 or manifest['stateContract']!='native-flat-v1': raise ValueError('unsupported runtime/state compatibility; no selection changed')
    for relative,expected in manifest['payloads'].items():
        if sha(regular(root/relative))!=expected: raise ValueError(f'installed runtime payload corrupted: {relative}')
    source=json_read(root/'native-manifest.json')
    if git(root/'runtime','rev-parse','HEAD')!=source['snapshotCommit']: raise ValueError('installed snapshot Git identity mismatch')
    if sha(root/'runtime/.bb-native-runtime.json')!=source['sourceManifestSha256']: raise ValueError('installed native source inventory corrupted')
    overlay=module(root/'overlay/install-bb-backend.py')
    if overlay.audited_source_identity(root/'runtime')!=source['upstreamCommit']: raise ValueError('installed upstream identity mismatch')
    errors=overlay.verify_mirror(root/'runtime',root/'overlay')
    if errors: raise ValueError('; '.join(errors))
    return root,manifest

def verify_version(store,release):
    return verify_version_path(store/'versions'/identifier(release),release)

def install(args):
    archive=regular(Path(args.archive))
    if sha(archive)!=args.sha256: raise ValueError('runtime archive checksum mismatch; nothing installed or selected')
    started=time.monotonic()
    with tempfile.TemporaryDirectory(prefix='fm-runtime-validate-') as directory:
        contents=Path(directory)
        with tarfile.open(archive,'r:gz') as bundle:
            members=bundle.getmembers()
            if len(members)>100 or sum(member.size for member in members)>25*1024*1024: raise ValueError('runtime archive exceeds distribution bounds')
            names=set()
            for member in members:
                name=Path(member.name)
                if member.name in names or name.as_posix()!=member.name or not member.isfile() or name.is_absolute() or '..' in name.parts:
                    raise ValueError(f'unsafe runtime archive member: {member.name}')
                names.add(member.name)
                target=contents/name;target.parent.mkdir(parents=True,exist_ok=True)
                with bundle.extractfile(member) as source: target.write_bytes(source.read())
            release=sha(regular(contents/'release-manifest.json'))
            manifest=json_read(contents/'release-manifest.json')
            if names!=set(manifest['payloads'])|{'release-manifest.json'}: raise ValueError('runtime archive incomplete or has unexpected files')
            for name,expected in manifest['payloads'].items():
                if sha(regular(contents/name))!=expected: raise ValueError(f'runtime asset hash mismatch: {name}')
        with lock(args.store/'.runtime-publication.lock'):
            final=args.store/'versions'/release
            if final.exists():
                verify_version(args.store,release)
                return {'signature':'FM_BUNDLED_RUNTIME_REUSED','release':release,'installed':str(final),'selected':False,'elapsedMs':round((time.monotonic()-started)*1000)}
            staging=args.store/'versions'/('.staging-'+uuid.uuid4().hex)
            staging.parent.mkdir(parents=True,exist_ok=True)
            try:
                shutil.copytree(contents,staging)
                git(staging,'clone','--quiet','--branch','main','--no-hardlinks',str(staging/'native.bundle'),str(staging/'runtime'))
                git(staging/'runtime','remote','remove','origin')
                native=json_read(staging/'native-manifest.json')
                if sha(staging/'native.bundle')!=native['nativeBundle']['sha256'] or git(staging/'runtime','rev-parse','HEAD')!=native['snapshotCommit']:
                    raise ValueError('native bundle does not match release manifest')
                subprocess.check_output(['python3',str(staging/'overlay/install-bb-backend.py'),'--home',str(staging/'runtime'),'--overlay',str(staging/'overlay')],stderr=subprocess.STDOUT)
                # Validate staging at its final depth: native and mirror symlinks are relative.
                native_overlay=module(staging/'overlay/install-bb-backend.py')
                verify_version_path(staging,release)
                subprocess.check_output(['bash','-c','. "$1"; fm_backend_validate_spawn bb','verify',str(staging/'runtime/bin-bb/fm-backend.sh')],stderr=subprocess.STDOUT)
                if os.environ.get('FM_RUNTIME_TEST_FAIL')=='before-publication': raise ValueError('injected failure before runtime publication')
                os.rename(staging,final)
                descriptor=os.open(final.parent,os.O_DIRECTORY);os.fsync(descriptor);os.close(descriptor)
            finally:
                if staging.exists(): shutil.rmtree(staging)
            verify_version(args.store,release)
            return {'signature':'FM_BUNDLED_RUNTIME_INSTALLED','release':release,'installed':str(final),'selected':False,'elapsedMs':round((time.monotonic()-started)*1000)}

def selection_path(home): return home/'config/bb-runtime-selected.json'
def selected(home):
    path=selection_path(home)
    return json_read(path) if path.exists() else None

def assert_owner(args):
    owner(args.captain)
    if args.home.is_symlink() or any(parent.is_symlink() for parent in args.home.parents): raise ValueError('symlinked captain home refused')
    marker=regular(args.home/'config/bb-captain').read_text().strip()
    if marker!=args.captain: raise ValueError('runtime home belongs to another captain')
    previous=selected(args.home)
    if previous and (previous['captain']!=args.captain or previous['host']!=args.host): raise ValueError('runtime captain/host identity mismatch')
    return previous

def blockers(home):
    # Never move code beneath a task's recorded paths or reinterpret live state.
    reasons=[]
    state=home/'state'
    if list(state.glob('*.meta')): reasons.append('retained native task identities still reference this home')
    if (state/'.lock').exists(): reasons.append('native primary lock remains; native owns its release')
    for pattern in ['.spawn-*.lock','.control-*.lock','.watch.lock','.bb-watch-keeper.pid','.watch-arm.pid']:
        if list(state.glob(pattern)): reasons.append(f'native/BB runtime consumer present: {pattern}')
    return reasons

def bind(args):
    root,manifest=verify_version(args.store,args.release)
    owner(args.captain)
    with lock(args.store/'.runtime-publication.lock'):
        if args.home.exists():
            previous=assert_owner(args)
            if previous:
                inspect(args)
                return {'signature':'FM_BUNDLED_HOME_REUSED','home':str(args.home),'selection':previous,'changed':False}
            raise ValueError('existing home is preserved; use explicit runtime migrate/select --check before selection')
        args.home.parent.mkdir(parents=True,exist_ok=True)
        staging=args.home.with_name('.'+args.home.name+'.staging-'+uuid.uuid4().hex)
        try:
            git(root,'clone','--quiet','--branch','main','--no-hardlinks',str(root/'runtime'),str(staging))
            git(staging,'remote','remove','origin')
            shutil.copytree(root/'runtime/bin-bb',staging/'bin-bb',symlinks=True)
            for name in ['config','state','data','projects']: (staging/name).mkdir(exist_ok=True)
            staging.chmod(0o700)
            for name in ['config','state','data']: (staging/name).chmod(0o700)
            (staging/'config/bb-captain').write_text(args.captain+'\n')
            if args.project_id:
                if not re.fullmatch(r'proj_[A-Za-z0-9_-]+',args.project_id): raise ValueError('invalid captain project identity')
                (staging/'config/bb-project').write_text(args.project_id+'\n')
            (staging/'config/backend').write_text('bb\n');(staging/'config/bb-overlay').write_text('bin-bb\n')
            value={'schema':1,'captain':args.captain,'host':args.host,'release':args.release,'root':str(root/'runtime'),
                   'stateContract':manifest['stateContract'],'helperSha256':manifest['payloads']['runtime-host.py'],'store':str(args.store),'previous':None}
            atomic_json(selection_path(staging),value)
            if os.environ.get('FM_RUNTIME_TEST_FAIL')=='before-home-publication': raise ValueError('injected home publication failure')
            os.rename(staging,args.home)
        finally:
            if staging.exists(): shutil.rmtree(staging)
        return {'signature':'FM_BUNDLED_HOME_BOUND','home':str(args.home),'selection':value,'changed':True}

def bind_seeded(args):
    """Seal a native-seeded child. Never seed, launch, send or allocate anything."""
    root,manifest=verify_version(args.store,args.release)
    owner(args.captain);owner(args.parent_captain)
    if not re.fullmatch(r'[A-Za-z0-9._-]+',args.task_id or ''): raise ValueError('exact native seeded task identity required')
    parent_args=argparse.Namespace(home=args.parent_home,captain=args.parent_captain,host=args.host)
    parent=assert_owner(parent_args)
    if not parent or parent['release']!=args.release or parent['store']!=str(args.store): raise ValueError('seeded parent runtime selection mismatch')
    if args.home==args.parent_home or args.home.is_relative_to(args.parent_home) or args.parent_home.is_relative_to(args.home): raise ValueError('overlapping secondmate homes refused')
    if args.home.is_symlink() or any(p.is_symlink() for p in args.home.parents): raise ValueError('symlinked seeded home refused')
    if regular(args.home/'.fm-secondmate-home').read_text().strip()!=args.task_id: raise ValueError('seeded task identity mismatch')
    regular(args.home/'data/charter.md')
    # The native parser is authoritative, including duplicate/NUL/local-route checks.
    subprocess.check_output(['bash','-c','. "$1"; fm_secondmate_parent_record_parse "$2" && [ "$FM_SECONDMATE_PARENT_ROUTE" = local ] && [ "$(realpath "$FM_SECONDMATE_PARENT_HOME")" = "$(realpath "$3")" ]','validate',str(root/'runtime/bin/fm-secondmate-parent-lib.sh'),str(args.home/'.fm-secondmate-parent'),str(args.parent_home)],stderr=subprocess.STDOUT)
    if git(args.home,'rev-parse','HEAD')!=manifest['snapshotCommit']: raise ValueError('seeded native source identity mismatch')
    overlay=module(root/'overlay/install-bb-backend.py');overlay.select_patch_set(args.home,root/'overlay')
    errors=overlay.verify_mirror(args.home,root/'overlay')
    if errors: raise ValueError('seeded adapter mismatch: '+'; '.join(errors))
    with lock(args.store/'.runtime-publication.lock'):
        marker=args.home/'config/bb-captain'
        if marker.exists() and regular(marker).read_text().strip()!=args.captain: raise ValueError('seeded captain owner collision')
        old=selected(args.home)
        if old:
            assert_owner(args)
            if old['release']!=args.release: raise ValueError('seeded runtime collision')
            return {'signature':'FM_BUNDLED_SEEDED_HOME_REUSED','selection':old,'home':str(args.home),'changed':False}
        if blockers(args.home): raise ValueError('unbound seeded home already has native consumers; explicit recovery required')
        marker.parent.mkdir(parents=True,exist_ok=True)
        marker.write_text(args.captain+'\n')
        value={'schema':1,'captain':args.captain,'host':args.host,'release':args.release,'root':str(root/'runtime'),'stateContract':manifest['stateContract'],'helperSha256':manifest['payloads']['runtime-host.py'],'store':str(args.store),'previous':None,'seededTask':args.task_id,'parentHome':str(args.parent_home)}
        atomic_json(selection_path(args.home),value)
        return {'signature':'FM_BUNDLED_SEEDED_HOME_BOUND','selection':value,'home':str(args.home),'changed':True}

@contextlib.contextmanager
def native_task_set(home,root,check):
    if check:
        yield;return
    # Use native ownership/staleness/release rather than a competing flock on
    # its mkdir lock. Keeping stdin open holds only this exact task-set lease.
    command='''set -eu; . "$1"; key=$(fm_task_set_lock_path "$2"); fm_lock_try_acquire "$key" || exit 2; trap 'fm_lock_release "$key"' EXIT; printf "FM_RUNTIME_NATIVE_TASK_SET_LOCKED\\n"; IFS= read -r finish || true'''
    process=subprocess.Popen(['bash','-c',command,'runtime-selection',str(root/'runtime/bin-bb/fm-wake-lib.sh'),str(home/'state')],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    try:
        ready=selectors.DefaultSelector();ready.register(process.stdout,selectors.EVENT_READ)
        try:
            if not ready.select(10): raise ValueError('native task-set selection lock timed out; no selection attempted')
            line=process.stdout.readline()
        finally: ready.close()
        if line.strip()!='FM_RUNTIME_NATIVE_TASK_SET_LOCKED': raise ValueError('native task set is busy; selection refused; inspect the owning home native lock')
        yield
    finally:
        process.stdin.close()
        try: process.wait(timeout=3)
        except subprocess.TimeoutExpired: process.terminate();process.wait(timeout=3)
        process.stdout.close();process.stderr.close()

def select(args):
    previous=assert_owner(args)
    if args.action=='rollback' and args.release=='external' and previous is None:
        history=json_read(args.home/'config/bb-runtime-last-bundled.json')
        if history.get('captain')!=args.captain or history.get('host')!=args.host or history.get('externalCommit')!=git(args.home,'rev-parse','HEAD'): raise ValueError('external rollback history mismatch')
        return {'home':str(args.home),'selection':None,'changed':False,'check':args.check,'taskStateChanged':False}
    external=args.action=='rollback' and args.release=='external'
    if external:
        if not previous or previous.get('previous')!='external' or previous.get('externalRoot')!=str(args.home): raise ValueError('external rollback is not the recorded previous runtime')
        root,manifest=verify_version(args.store,previous['release'])
        overlay=module(root/'overlay/install-bb-backend.py')
        overlay.select_patch_set(args.home,root/'overlay')
        if git(args.home,'rev-parse','HEAD')!=previous.get('externalCommit'): raise ValueError('external source changed since migration; rollback refused')
        errors=overlay.verify_mirror(args.home,root/'overlay')
        if errors: raise ValueError('external rollback needs the original compatible mirror: '+'; '.join(errors))
    else:
        root,manifest=verify_version(args.store,args.release)
    assert_owner(args)  # Refuse foreign homes before creating any home-local lock.
    guard=contextlib.nullcontext() if args.check else lock(args.home/'config/.bb-runtime-selection.lock')
    with guard, native_task_set(args.home,root,args.check):
        previous=assert_owner(args)
        if previous and previous['release']==args.release: return {'home':str(args.home),'selection':previous,'changed':False,'check':args.check}
        if args.action=='rollback' and (not previous or previous.get('previous')!=args.release): raise ValueError('rollback target is not the recorded previous runtime')
        if not previous and args.action!='migrate': raise ValueError('external home requires explicit migrate; no automatic native upgrade')
        if previous and args.action=='migrate': raise ValueError('home already uses a bundled runtime; use select')
        if not previous:
            # Existing native checkout must independently meet the exact audited registry.
            current=module(root/'overlay/install-bb-backend.py')
            current.select_patch_set(args.home,root/'overlay')
            errors=current.verify_mirror(args.home,root/'overlay')
            if errors: raise ValueError('external migration requires a verified matching adapter: '+'; '.join(errors))
        reasons=blockers(args.home)
        if reasons: raise ValueError('runtime selection refused: '+'; '.join(reasons)+'. Existing runtime/state are unchanged; keep this home external until consumers retire.')
        if previous and previous['stateContract']!=manifest['stateContract']: raise ValueError('state schema rollback/migration unsupported; selection unchanged')
        if external:
            if not args.check:
                atomic_json(args.home/'config/bb-runtime-last-bundled.json',previous)
                selection_path(args.home).unlink()
                descriptor=os.open(selection_path(args.home).parent,os.O_DIRECTORY);os.fsync(descriptor);os.close(descriptor)
            return {'signature':'FM_EXTERNAL_ROLLBACK_CHECKED' if args.check else 'FM_EXTERNAL_ROLLBACK_PUBLISHED','home':str(args.home),'selection':None,'changed':not args.check,'check':args.check,'taskStateChanged':False}
        value={'schema':1,'captain':args.captain,'host':args.host,'release':args.release,'root':str(root/'runtime'),
               'stateContract':manifest['stateContract'],'helperSha256':manifest['payloads']['runtime-host.py'],'store':str(args.store),'previous':previous['release'] if previous else 'external',
               'externalRoot':previous.get('externalRoot') if previous else str(args.home),
               'externalCommit':previous.get('externalCommit') if previous else git(args.home,'rev-parse','HEAD')}
        if not args.check:
            if os.environ.get('FM_RUNTIME_TEST_FAIL')=='before-selection': raise ValueError('injected failure before selection')
            atomic_json(selection_path(args.home),value)
            if os.environ.get('FM_RUNTIME_TEST_FAIL')=='after-selection': raise ValueError('injected lost selection response')
        return {'signature':'FM_BUNDLED_SELECTION_CHECKED' if args.check else 'FM_BUNDLED_SELECTION_PUBLISHED',
                'home':str(args.home),'selection':value,'changed':not args.check,'check':args.check,'taskStateChanged':False}

def inspect(args):
    value=assert_owner(args)
    if value:
        root,manifest=verify_version(args.store,value['release'])
        if value['root']!=str(root/'runtime') or value['store']!=str(args.store): raise ValueError('selected runtime root/store mismatch')
        if value['helperSha256']!=manifest['payloads']['runtime-host.py']: raise ValueError('selected helper identity mismatch')
    return {'selected':value,'compatible':True,'home':str(args.home)}

def status(args):
    installed=[]
    versions=args.store/'versions'
    if versions.exists():
        rows=sorted(path for path in versions.iterdir() if re.fullmatch(r'[0-9a-f]{64}',path.name) and (not args.release or path.name==identifier(args.release)))
        if len(rows)>50: raise ValueError('runtime inventory exceeds bounded status limit; inspect explicit release instead')
        for path in rows:
            try:
                _,manifest=verify_version(args.store,path.name)
                installed.append({'release':path.name,'compatible':True,'upstreamCommit':manifest['upstreamCommit'],'adapterRevision':manifest['adapterRevision'],'pluginVersion':manifest['pluginVersion']})
            except Exception as error: installed.append({'release':path.name,'compatible':False,'error':str(error)})
    value=assert_owner(args) if args.home and args.home.exists() else None
    external=None
    if args.home and not value:
        commit=git(args.home,'rev-parse','HEAD')
        audited=json.loads(args.audited_sources)
        external={'root':str(args.home),'nativeCommit':commit,'compatible':commit in audited,
                  'compatibility':'audited-external-source; adapter checked on deck/migrate' if commit in audited else 'unknown-native-source; selection refused'}
    compatible=True;selection_error=None
    if value:
        try: inspect(args)
        except Exception as error: compatible=False;selection_error=str(error)
    return {'selectionCompatible':compatible,'selectionError':selection_error,'external':external,'installed':installed,'selected':value,'home':str(args.home) if args.home else None,
            'mode':'bundled' if value else 'external' if args.home else 'unbound','migrationRequiredForBundledMode':bool(args.home and not value)}

def main():
    parser=argparse.ArgumentParser();parser.add_argument('action',choices=['install','bind','bind-seeded','select','migrate','rollback','status','inspect','resolve'])
    parser.add_argument('--store',type=Path,required=True);parser.add_argument('--archive');parser.add_argument('--sha256');parser.add_argument('--release');parser.add_argument('--audited-sources',default='[]')
    parser.add_argument('--parent-home',type=Path);parser.add_argument('--parent-captain');parser.add_argument('--task-id');parser.add_argument('--project-id');parser.add_argument('--home',type=Path);parser.add_argument('--captain');parser.add_argument('--host');parser.add_argument('--check',action='store_true')
    args=parser.parse_args()
    if not args.store.is_absolute() or (args.home and not args.home.is_absolute()): raise ValueError('runtime store/home must be absolute host paths')
    if args.store.is_symlink() or any(parent.is_symlink() for parent in args.store.parents): raise ValueError('symlinked runtime store refused')
    if args.check and args.action not in ('select','migrate','rollback'): raise ValueError('--check is only supported for select/migrate/rollback')
    operation=install if args.action=='install' else bind_seeded if args.action=='bind-seeded' else bind if args.action=='bind' else status if args.action=='status' else inspect if args.action in ('inspect','resolve') else select
    result=operation(args)
    if args.action=='resolve':
        if not result['selected']: raise ValueError('home has no bundled runtime selection')
        print(result['selected']['root'])
    else: print(json.dumps(result,sort_keys=True))
if __name__=='__main__':
    try: main()
    except Exception as error:
        print(json.dumps({'error':str(error),'outcome':'unresolved; inspect runtime status before changing targets'}));raise SystemExit(2)
