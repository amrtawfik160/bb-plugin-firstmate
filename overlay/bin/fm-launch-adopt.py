#!/usr/bin/env python3
"""BB-ONLY: exact legacy registration repair, called only by the owning plugin.

No spawn/send/retry/forge/worktree mutations. The shell companion owns native
locks, native isolation, filled-brief, endpoint and backlog publication gates.
This validates the public BB evidence and refuses all ambiguous local records.
"""
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import stat
import subprocess
import sys

PINS = ('2d833ff147cd26a5c461e914e06854e0eb2707ce', '1f3e769616fdf9f31f85f4c3e6a9f71606634238')
ISOLATION_SHA = 'fe0f7d8b5bdce903a7ffee99e7f73c19c09d184937896da1c5fca0494f76a625'


def require(ok, why):
    if not ok:
        raise ValueError(why)


def regular(path):
    # Nonblocking opens reject special files without hanging, including FIFOs.
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, 'rb') as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), f'not a regular file: {path}')
        content = stream.read(2_000_001)
    require(len(content) <= 2_000_000, 'repair input exceeds bound')
    return content.decode('utf8')


def git(path, *args):
    return subprocess.check_output(['git', '-C', str(path), *args], env={**os.environ, 'GIT_OPTIONAL_LOCKS':'0'}, text=True, timeout=5).strip()


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def repository(path):
    url = git(path, 'remote', 'get-url', 'origin')
    # Accept the common SSH/HTTPS spelling of the same origin, not a basename.
    match = re.fullmatch(r'(?:https?://|ssh://(?:[^/@]+@)?)([^/]+)/(.+?)(?:\.git)?/?', url) or re.fullmatch(r'[^@]+@([^:]+):(.+?)(?:\.git)?', url)
    require(match is not None, 'origin repository identity cannot be proven')
    return (match[1].lower(), match[2].removesuffix('.git').rstrip('/'))


def inspect(plan):
    r = plan['record']
    home, task = Path(r['home']), r['taskId']
    require(re.fullmatch(r'[A-Za-z0-9._-]{1,100}', task) and task not in ('.','..'), 'invalid task id')
    require(home.is_absolute() and home.resolve() == home, 'home must be an exact canonical path')
    for path in (home/'state', home/'data', home/'data'/task):
        require(path.is_dir() and not path.is_symlink() and path.resolve() == path, 'task namespace is not a real directory')
    require(git(home, 'rev-parse', 'HEAD') in PINS, 'unsupported native source pin')
    source = regular(home/'bin/fm-spawn.sh')
    function = re.search(r'^spawn_worktree_isolated\(\) \{[^\n]*\n.*?^\}', source, re.M|re.S)
    require(function and digest(function[0]) == ISOLATION_SHA, 'native isolation predicate changed')
    marker = home/'config/bb-captain'
    if marker.exists() or marker.is_symlink():
        require(regular(marker).strip() == r['owner'], 'home captain identity conflicts')
    status = regular(home/'state'/f'{task}.status')
    require(not (home/'state'/f'{task}.backlog-close').exists() and not (home/'state'/f'{task}.backlog-close').is_symlink(), 'task has a pending retirement')
    brief_path = home/'data'/task/'brief.md'
    brief = regular(brief_path)
    # Compare only the immutable native task region, not user words against
    # rewritten transport policy. Known scaffold boundaries must be unique.
    identity = 'You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.\n\n# Task\n'
    require(brief.startswith(identity), 'native source brief identity is unsupported')
    boundary = '\n# Herdr lifecycle declaration - NOT ENABLED\n'
    require(brief.count(boundary) == 1, 'only ordinary native worker scaffolds are repairable; Herdr lab needs its own lifecycle validation')
    task_body = brief[len(identity)-len('# Task\n'):brief.index(boundary)]
    prompt = plan['prompt']
    require(prompt.count(task_body) == 1 and f'{home}/state/{task}.status' in prompt and f'{home}/state/{task}.inbox' in prompt, 'initial prompt does not correspond to native task/home evidence')
    require(f'{home}/state/{task}.status' in brief, 'source status identity conflicts')
    require(f'\n# Setup\nYou are in a disposable git worktree of {r["path"]}, at a detached HEAD on a clean default branch.\n' in brief, 'source project provenance differs from original checkout')
    mode = re.findall(r'^Delivery contract: mode=(\S+)', brief, re.M)
    require(r['shape'] in ('ship','scout'), 'only ordinary workers may be adopted')
    if r['shape'] == 'ship':
        require(mode == [r['deliveryMode']], 'source delivery contract differs from reservation')
        branch = re.findall(r'^Ship branch: (.+)$', brief, re.M)
        require(len(branch) == 1, 'original ship branch provenance missing')
        git(plan['worktree'], 'rev-parse', '--verify', 'refs/heads/'+branch[0])
    else:
        require(not mode and f'{home}/data/{task}/report.md' in brief, 'scout source contract differs')
    require(repository(r['path']) == repository(plan['worktree']), 'worker origin differs from original project repository')
    # Do not change, reset or require a clean worktree; it contains existing work.
    current_branch = git(plan['worktree'], 'symbolic-ref', '--quiet', '--short', 'HEAD')
    current_head = git(plan['worktree'], 'rev-parse', 'HEAD')
    execution = plan['execution']
    require(all(isinstance(execution[key], str) and execution[key] for key in ('model','reasoningLevel','permissionMode')), 'initial execution evidence missing')
    evidence = {key:plan[key] for key in ('threadId','environmentId','eventId','createdAt','worktree','execution')}
    evidence.update(key=r['key'], briefSha=digest(brief), promptSha=digest(prompt))
    proof = digest(json.dumps(evidence, sort_keys=True, separators=(',', ':')))
    require(not plan.get('proof') or plan['proof'] == proof, 'immutable repair evidence changed')
    fields = dict(window='bb:'+plan['threadId'], endpoint_task_id=task, worktree=plan['worktree'], project=r['path'], harness='bb', kind=r['shape'], backend='bb', bb_thread_id=plan['threadId'],
                  spawn_gen=str(r['generation']), tasktmp='/tmp/fm-'+task, model=execution['model'], effort=execution['reasoningLevel'],
                  bb_adopt_key=digest(r['key']), bb_adopt_proof=proof, bb_admission='explicit-repair', bb_original_admission='unconfirmed', bb_created_at=str(plan['createdAt']), bb_delivery_requirement=r['deliveryRequirement'])
    if r['shape'] == 'ship':
        fields.update(mode=r['deliveryMode'], yolo='off', branch=current_branch)
    meta = home/'state'/f'{task}.meta'
    existing = meta.exists() or meta.is_symlink()
    if existing:
        values = {}
        for line in regular(meta).splitlines():
            name, sep, value = line.partition('=')
            require(sep and name not in values, 'native metadata is malformed or ambiguous')
            values[name] = value
        for key,value in fields.items():
            if key != 'branch':
                require(values.get(key) == value, 'native metadata collision: '+key)
    # Reject an endpoint already registered under any other native task.
    entries = list((home/'state').glob('*.meta'))
    require(len(entries) <= 500, 'native task inventory exceeds repair bound')
    for other in entries:
        if other == meta:
            continue
        text = regular(other)
        require(all(line not in text+'\n' for line in (f'bb_thread_id={plan["threadId"]}\n', f'window=bb:{plan["threadId"]}\n', f'window={plan["threadId"]}\n')), 'worker already belongs to another native task')
    staged = '\n'.join(f'{key}={value}' for key,value in fields.items())+'\n'
    require(all('\n' not in str(value) and '\r' not in str(value) and '\t' not in str(value) for value in fields.values()), 'invalid metadata atom')
    return dict(proof=proof, briefSha=evidence['briefSha'], promptSha=evidence['promptSha'], task=task_body, outcome=status, branch=current_branch, head=current_head, existing=existing), staged, function[0]


if __name__ == '__main__':
    try:
        action, path, *extra = sys.argv[1:]
        plan = json.loads(regular(path))
        result, staged, function = inspect(plan)
        if action == 'prepare':
            target = Path(extra[0])
            target.write_text(staged)
            for name,value in dict(ID=plan['record']['taskId'], PROJ_ABS=plan['record']['path'], WT=plan['worktree'], KIND=plan['record']['shape'], BRIEF=str(Path(plan['record']['home'])/'data'/plan['record']['taskId']/'brief.md'), EXISTING='1' if result['existing'] else '0').items():
                print(f'{name}={shlex.quote(value)}')
            print(function)
        elif action == 'inspect':
            print(json.dumps(result))
        else:
            raise ValueError('unsupported repair helper operation')
    except (OSError, ValueError, KeyError, subprocess.SubprocessError) as error:
        print(f'REFUSED: legacy launch adoption: {error}', file=sys.stderr)
        sys.exit(2)
