#!/usr/bin/env python3
"""BB-ONLY endpoint replacement: preserve native contract and all work.
Called under native task/meta locks by fm-worker-rebind.sh. No worker/git writes.
"""
import importlib.util
import json
from pathlib import Path
import re
import shlex
import sys
sys.dont_write_bytecode=True
spec=importlib.util.spec_from_file_location('adoption',Path(__file__).with_name('fm-launch-adopt.py'))
a=importlib.util.module_from_spec(spec)
spec.loader.exec_module(a)
try:
    plan=json.loads(a.regular(Path(sys.argv[1])))
    home=Path(plan['home']);task=plan['taskId']
    a.require(home.is_absolute() and home.resolve()==home,'noncanonical native home')
    a.require(re.fullmatch(r'[A-Za-z0-9._-]{1,100}',task) and task not in ('.','..'),'invalid task id')
    for p in (home/'state',home/'data',home/'data'/task):
        a.require(p.is_dir() and not p.is_symlink() and p.resolve()==p,'invalid task namespace')
    a.require(a.git(home,'rev-parse','HEAD') in a.PINS,'unaudited native source')
    source=a.regular(home/'bin/fm-spawn.sh')
    function=re.search(r'^spawn_worktree_isolated\(\) \{[^\n]*\n.*?^\}',source,re.M|re.S)
    a.require(function and a.digest(function[0])==a.ISOLATION_SHA,'native isolation predicate changed')
    marker=home/'config/bb-captain'
    if marker.exists() or marker.is_symlink():
        a.require(a.regular(marker).strip()==plan['owner'],'home owner conflict')
    a.require(not (home/'state'/f'{task}.backlog-close').exists(),'task retirement pending')
    text=a.regular(home/'state'/f'{task}.meta');fields={}
    for line in text.splitlines():
        if '=' not in line: continue
        key,value=line.split('=',1)
        a.require(key not in fields,'ambiguous native metadata field '+key)
        fields[key]=value
    a.require(fields.get('backend')=='bb' and fields.get('harness')=='bb','source is not a BB endpoint')
    a.require(fields.get('endpoint_task_id',task)==task,'task binding conflict')
    a.require(fields.get('bb_thread_id') in (plan['sourceThreadId'],plan['threadId']),'source worker conflict')
    a.require(fields.get('window') in ('bb:'+plan['sourceThreadId'],'bb:'+plan['threadId']),'source window conflict')
    a.require(fields.get('worktree')==plan['worktree'] and fields.get('kind')==plan['shape'],'source worktree/kind conflict')
    a.require(fields.get('project')==plan['project'],'source project conflict')
    brief=home/'data'/task/'brief.md';body=a.regular(brief)
    a.require(not plan.get('briefSha') or a.digest(body)==plan['briefSha'],'immutable native brief changed')
    if plan['shape']=='ship':
        branches=re.findall(r'^Ship branch: (.+)$',body,re.M)
        a.require(len(branches)==1 and fields.get('branch',branches[0])==branches[0],'immutable source branch conflict')
        a.git(plan['worktree'],'rev-parse','--verify','refs/heads/'+branches[0])
        if 'branch' not in fields: fields['bb_missing_branch']=branches[0]
        fields['branch']=branches[0]
        a.require(fields.get('mode')==plan['mode'],'delivery mode conflict')
    # Idempotent publication accepts only this generation on an already rebound endpoint.
    generation='bb-r'+str(plan['generation'])
    if fields['bb_thread_id']==plan['threadId'] and plan['sourceThreadId']!=plan['threadId']:
        a.require(fields.get('spawn_gen')==generation,'replacement generation conflict')
    changes={'bb_thread_id':plan['threadId'],'window':'bb:'+plan['threadId'],'endpoint_task_id':task,'spawn_gen':generation,
             'model':plan['model'] or 'default','provider':plan['providerId'] or '', 'effort':plan['reasoningLevel'] or 'default'}
    for value in changes.values(): a.require(isinstance(value,str) and not any(c in value for c in '\r\n\0'),'invalid endpoint/execution value')
    lines=[]
    for line in text.splitlines():
        key=line.split('=',1)[0]
        if key in changes: lines.append(key+'='+changes.pop(key))
        else: lines.append(line)
    if 'bb_missing_branch' in fields and plan['shape']=='ship':changes['branch']=fields['branch']
    lines.extend(key+'='+value for key,value in changes.items())
    Path(sys.argv[2]).write_text('\n'.join(lines)+'\n')
    for name,value in dict(ID=task,WT=plan['worktree'],PROJ_ABS=plan['project'],BRIEF=str(brief),SOURCE_SHA=a.digest(body)).items():print(name+'='+shlex.quote(value))
    print(function[0])
except (OSError,ValueError,KeyError,a.subprocess.SubprocessError) as error:
    print('REFUSED: BB worker rebind: '+str(error),file=sys.stderr);sys.exit(2)
