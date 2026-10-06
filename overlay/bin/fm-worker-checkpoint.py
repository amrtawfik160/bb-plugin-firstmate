#!/usr/bin/env python3
"""Task-owned BB reporting and validation transport. Native status remains authoritative."""
import argparse
from contextlib import contextmanager
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shlex
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid


def git(*args):
    result = subprocess.run(['git', *args], capture_output=True, check=True)
    return result.stdout


def revision():
    head = git('rev-parse', 'HEAD').decode().strip()
    digest = hashlib.sha256(git('diff', '--binary', 'HEAD'))
    for name in sorted(git('ls-files', '--others', '--exclude-standard', '-z').split(b'\0')):
        if not name:
            continue
        path = Path(os.fsdecode(name))
        payload = os.fsencode(os.readlink(path)) if path.is_symlink() else path.read_bytes()
        digest.update(name + b'\0' + hashlib.sha256(payload).digest())
    return {'head': head, 'diff': digest.hexdigest()}


def atomic(path, text):
    if path.is_symlink() or path.exists() and not path.is_file():
        raise ValueError(f'expected regular task file: {path}')
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent, delete=False) as stream:
            temporary = Path(stream.name)
            stream.write(text)
        os.replace(temporary, path)
    finally:
        if temporary and temporary.exists():
            temporary.unlink()


def save(path, record):
    atomic(path, json.dumps(record, indent=2) + '\n')


def load(path):
    if path.is_symlink() or path.exists() and not path.is_file():
        raise ValueError(f'expected regular task file: {path}')
    return json.loads(path.read_text())


def directories(task):
    home = Path(os.environ['FM_HOME'])
    if not home.is_absolute() or not re.fullmatch(r'[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}', task):
        raise ValueError('absolute FM_HOME and exact task ID required')
    if Path(git('rev-parse', '--show-toplevel').decode().strip()).resolve() != Path.cwd().resolve():
        raise ValueError('run from the task worktree root')
    state, data = home / 'state', home / 'data' / task
    metadata = state / f'{task}.meta'
    if metadata.is_symlink() or not metadata.is_file():
        raise ValueError('task must have native metadata in this home')
    fields = dict(line.split('=', 1) for line in metadata.read_text().splitlines() if '=' in line)
    if Path(fields.get('worktree', '')).resolve() != Path.cwd().resolve():
        raise ValueError('task metadata does not own this worktree')
    if fields.get('endpoint_task_id', task) != task:
        raise ValueError('task metadata has another endpoint identity')
    if os.environ.get('BB_THREAD_ID') and fields.get('bb_thread_id') != os.environ['BB_THREAD_ID']:
        raise ValueError('task belongs to another BB thread')
    for directory in (home, state, home / 'data', data, data / 'checks'):
        if directory.is_symlink():
            raise ValueError(f'refusing symlinked task namespace {directory}')
        directory.mkdir(exist_ok=True)
    return home, state, data


@contextmanager
def locked(data):
    path = data / '.checkpoint.lock'
    descriptor = os.open(path, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('task checkpoint lock must be a regular file')
        deadline = time.monotonic() + 15
        while True:
            try:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError:
                if time.monotonic() >= deadline:
                    raise ValueError('another checkpoint is busy; retry after it finishes')
                time.sleep(.05)
        yield


def instruction_text(path):
    with Path(path).open(encoding='utf-8', newline='') as stream:
        return stream.read()


def status(home, state, task, phase, summary, key=None):
    if '\n' in summary or '\r' in summary or not summary.strip():
        raise ValueError('status requires one nonempty line')
    path = state / f'{task}.status'
    if path.is_symlink():
        raise ValueError('refusing symlinked task status')
    stamp = f'{phase} [at={int(time.time())}]' + (f' [key={key}]' if key else '')
    descriptor = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(descriptor, 'a') as stream:
        if not stat.S_ISREG(os.fstat(stream.fileno()).st_mode):
            raise ValueError('native task status must be a regular file')
        stream.write(f'{stamp}: {summary}\n')
    root = Path(os.environ.get('FM_ROOT_OVERRIDE', str(home)))
    ledger = root / 'bin-bb/fm-fleet-ledger.sh'
    if (home / 'config/fleet-ledger').exists() and ledger.exists():
        subprocess.run([str(ledger), 'appended', str(home / 'config'), str(path)], stdout=subprocess.DEVNULL)


def report(data, phase, summary):
    current = revision()
    previous = data / 'progress.md'
    marker = data / 'checkpoint-progress.json'
    if previous.exists() and not marker.exists():
        if previous.is_symlink() or not previous.is_file():
            raise ValueError('existing progress must be a regular task file')
        atomic(data / 'progress-before-checkpoint.md', instruction_text(previous))
    lines = [f'# Worker progress', '', f'Updated: {time.strftime("%Y-%m-%d %H:%M:%S UTC", time.gmtime())}',
             f'Phase: {phase}', f'Status: {summary}', f'Commit: {current["head"]}', '', '## Worktree changes', '',
             '```', git('status', '--short').decode().rstrip() or 'No uncommitted changes.', '```', '',
             '## Recorded checks', '']
    for path in sorted((data / 'checks').glob('*.json')):
        row = load(path)
        match = row['revision'] == current and row.get('finishedRevision', current) == current
        result = f'exit {row["exitCode"]}' if 'exitCode' in row else 'running'
        lines.append(f'- {row["label"]}: {result}; {"current revision" if match else "earlier revision"}. Evidence: checks/{path.name}')
    notes = data / 'progress-notes.md'
    if notes.is_symlink() or notes.exists() and not notes.is_file():
        raise ValueError('worker notes must be a regular task file')
    if notes.exists():
        lines += ['', '## Worker notes', '', instruction_text(notes)]
    lines += ['', 'Check results describe only the recorded commands and revision. Application or production behavior requires its own evidence.', '']
    if (data / 'progress-before-checkpoint.md').exists():
        lines += ['Previous authored report retained at progress-before-checkpoint.md; its claims have not been revalidated.', '']
    atomic(data / 'progress.md', '\n'.join(lines))
    save(marker, {'schema': 1, 'revision': current, 'phase': phase})


def required_reads():
    paths = []
    for name in ['AGENTS.md', 'CLAUDE.md']:
        path = Path(name)
        if path.is_file():
            paths.append(path.resolve())
    if git('ls-files', '--', '*.ts', '*.tsx').strip():
        for root in [Path.home() / '.agents/skills', Path.home() / '.codex/skills']:
            path = root / 'typescript-best-practices/SKILL.md'
            if path.is_file():
                paths.append(path.resolve())
                break
        else:
            print('warning: no typescript-best-practices skill under ~/.agents/skills or ~/.codex/skills; setup continues without it', file=sys.stderr)
    return list(dict.fromkeys(paths))


def ready(data):
    path = data / 'setup.json'
    if not path.exists():
        raise ValueError('run setup and finish its required reads before validation or handoff')
    setup = load(path)
    for record in setup['reads']:
        text = instruction_text(record['path'])
        if hashlib.sha256(text.encode()).hexdigest() != record['sha256'] or record['readThrough'] < len(text):
            raise ValueError(f'required read incomplete or changed: {record["path"]}')
    return setup


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('task')
    parser.add_argument('action', choices=['setup', 'read', 'report', 'check', 'check-foreground', 'wait', '_execute', 'require-read'])
    parser.add_argument('arguments', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    home, state, data = directories(args.task)
    values = args.arguments
    if args.action in ('setup', 'read', 'require-read', 'report'):
        with locked(data):
            return update(args, home, state, data, values)
    return check(args, home, state, data, values)


def update(args, home, state, data, values):
    if args.action == 'setup':
        mode = values[0] if values else 'direct-PR'
        if values[1:] not in ([], ['--foreground-checks']):
            raise ValueError('setup accepts a mode and the native brief foreground-checks option only')
        if mode not in ('scout', 'direct-PR', 'local-only', 'no-mistakes'):
            raise ValueError('unsupported task mode')
        fields = dict(line.split('=', 1) for line in (state / f'{args.task}.meta').read_text().splitlines() if '=' in line)
        expected = 'scout' if fields.get('kind') == 'scout' else fields.get('mode')
        if expected and mode != expected:
            raise ValueError(f'setup mode must match native task metadata: {expected}')
        if mode == 'no-mistakes':
            result = subprocess.run(['no-mistakes', 'doctor'], capture_output=True, text=True)
            print(result.stdout, end='')
            print(result.stderr, end='', file=sys.stderr)
            if 'not initialized' in (result.stdout + result.stderr).lower():
                subprocess.run(['no-mistakes', 'init'], check=True)
                subprocess.run(['no-mistakes', 'doctor'], check=True)
            elif result.returncode:
                raise ValueError('no-mistakes doctor failed; resolve the reported setup problem')
        setup = {'mode': mode, 'foregroundChecks': '--foreground-checks' in values[1:], 'reads': [{'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
                                        'readThrough': 0} for path in required_reads()]}
        save(data / 'setup.json', setup)
        print('Read these instructions. Register further required project guides with require-read before reading them:')
        for record in setup['reads']:
            print(shlex.join(['python3', str(Path(__file__).resolve()), args.task, 'read', record['path']]))
        status(home, state, args.task, 'working', 'setup checked; required project reads remain')
        report(data, 'working', 'setup checked; required project reads remain')
    elif args.action == 'require-read':
        if not values:
            raise ValueError('require-read needs the project guide paths')
        setup = load(data / 'setup.json')
        for value in values:
            path = Path(value).resolve()
            if not path.is_relative_to(Path.cwd().resolve()) or not path.is_file():
                raise ValueError('additional guides must be files in this worktree')
            if not any(row['path'] == str(path) for row in setup['reads']):
                setup['reads'].append({'path': str(path), 'sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'readThrough': 0})
        save(data / 'setup.json', setup)
        for value in values:
            print(shlex.join(['python3', str(Path(__file__).resolve()), args.task, 'read', str(Path(value).resolve())]))
    elif args.action == 'read':
        if not values or len(values) > 2:
            raise ValueError('read requires a path and optional byte-independent character offset')
        setup = load(data / 'setup.json')
        path = str(Path(values[0]).resolve())
        row = next((row for row in setup['reads'] if row['path'] == path), None)
        if row is None:
            raise ValueError('path is not in this task setup manifest')
        text = instruction_text(path)
        if hashlib.sha256(text.encode()).hexdigest() != row['sha256']:
            raise ValueError('instructions changed; rerun setup')
        start = int(values[1]) if len(values) == 2 else 0
        if start != row['readThrough'] or start < 0:
            raise ValueError(f'read sequentially from offset {row["readThrough"]}')
        end = min(len(text), start + 8000)
        print(text[start:end], end='')
        row['readThrough'] = end
        save(data / 'setup.json', setup)
        if end < len(text):
            print('\nContinue:', shlex.join(['python3', str(Path(__file__).resolve()), args.task, 'read', path, str(end)]))
    elif args.action == 'report':
        if len(values) != 2 or values[0] not in ('working', 'paused', 'blocked', 'needs-decision', 'done', 'failed'):
            raise ValueError('report requires native phase and one-line summary')
        if values[0] not in ('blocked', 'needs-decision', 'failed'):
            ready(data)
        if not sys.stdin.isatty():
            notes = sys.stdin.read()
            if notes.strip():
                atomic(data / 'progress-notes.md', notes)
        report(data, *values)
        status(home, state, args.task, *values)


def launch_unit(home, task, identifier):
    if not shutil.which('systemd-run') or not Path('/run/systemd/system').is_dir() or not hasattr(os, 'geteuid') or os.geteuid() != 0:
        return False
    # A system unit starts with a bare environment; carry the caller's, including HOME.
    environment = {**os.environ, 'FM_HOME': str(home), 'FM_ROOT_OVERRIDE': os.environ.get('FM_ROOT_OVERRIDE', str(home))}
    environment.setdefault('PATH', os.defpath)
    settings = [f'--setenv={key}={value}' for key, value in environment.items()
                if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_]*', key) and '\n' not in value]
    try:
        subprocess.run(['systemd-run', '--quiet', '--collect', '--property=Type=exec',
                        f'--unit=fm-check-{identifier}', f'--working-directory={Path.cwd()}', *settings,
                        sys.executable, str(Path(__file__).resolve()), task, '_execute', identifier], check=True)
    except (OSError, subprocess.CalledProcessError):
        return False
    return True


def unit_stopped(identifier):
    result = subprocess.run(['systemctl', 'show', f'fm-check-{identifier}.service', '--property=LoadState',
                             '--property=ActiveState', '--property=Result'], capture_output=True, text=True)
    if result.returncode:
        raise ValueError('cannot inspect the exact validation unit; check systemd before waiting again')
    fields = dict(line.split('=', 1) for line in result.stdout.splitlines() if '=' in line)
    state = fields.get('ActiveState')
    if state not in ('active', 'activating', 'reloading', 'deactivating', 'inactive', 'failed'):
        raise ValueError('validation unit state is unreadable; no success result recorded')
    return fields.get('LoadState') == 'not-found' or state in ('inactive', 'failed')


def check(args, home, state, data, values):
    if args.action in ('check', 'check-foreground'):
        setup = ready(data)
        foreground = args.action == 'check-foreground'
        if setup.get('foregroundChecks') and not foreground:
            raise ValueError('native zero-turn waiting requires check-foreground with the harness maximum foreground timeout')
        if len(values) < 3 or values[1] != '--':
            raise ValueError('check requires a label, --, and the validation command')
        if any('\n' in value or '\r' in value for value in values[:1]):
            raise ValueError('check label must be one line')
        identifier = uuid.uuid4().hex
        row = {'id': identifier, 'label': values[0], 'command': values[2:], 'revision': revision(), 'transport': 'foreground' if foreground else 'background'}
        with locked(data):
            save(data / 'checks' / f'{identifier}.json', row)
            status(home, state, args.task, 'paused', f'{row["label"]}; resume when check {identifier} finishes', f'bb-check-{identifier}')
            report(data, 'paused', f'{row["label"]}; check {identifier} is running')
        if not foreground and not launch_unit(home, args.task, identifier):
            # Without a usable system manager (macOS, containers, non-root) the check runs here.
            print('systemd cannot start a validation unit here; running the check in the foreground', file=sys.stderr)
            row['transport'] = 'foreground'
            with locked(data):
                save(data / 'checks' / f'{identifier}.json', row)
            foreground = True
        if foreground:
            check(argparse.Namespace(task=args.task, action='_execute'), home, state, data, [identifier])
            return check(argparse.Namespace(task=args.task, action='wait'), home, state, data, [identifier])
        print(shlex.join(['python3', str(Path(__file__).resolve()), args.task, 'wait', identifier]))
    elif args.action in ('wait', '_execute'):
        if len(values) != 1 or not re.fullmatch(r'[a-f0-9]{32}', values[0]):
            raise ValueError('exact check ID required')
        path = data / 'checks' / f'{values[0]}.json'
        row = load(path)
        if args.action == '_execute':
            # Exclusive evidence creation makes duplicate execution refuse.
            with path.with_suffix('.log').open('x') as output:
                try:
                    result = subprocess.run(row['command'], stdout=output, stderr=subprocess.STDOUT)
                    row['exitCode'] = result.returncode
                except OSError as error:
                    output.write(str(error) + '\n')
                    row['exitCode'] = 127
            row['finishedRevision'] = revision()
            with locked(data):
                save(path, row)
                status(home, state, args.task, 'resolved', f'{row["label"]} finished with exit {row["exitCode"]}', f'bb-check-{row["id"]}')
                pending = any('exitCode' not in load(record) for record in (data / 'checks').glob('*.json'))
                phase = 'paused' if pending else 'working'
                if not pending:
                    status(home, state, args.task, phase, f'{row["label"]} finished; continue the task')
                report(data, phase, f'{row["label"]} finished with exit {row["exitCode"]}')
        else:
            deadline = time.monotonic() + 30
            while 'exitCode' not in row and time.monotonic() < deadline:
                if load(data / 'setup.json').get('foregroundChecks') or row.get('transport') == 'foreground':
                    raise ValueError('use the native foreground-command wait; background polling is not permitted for this check')
                if unit_stopped(row['id']):
                    with locked(data):
                        row = load(path)
                        if 'exitCode' not in row:
                            row['exitCode'] = 125
                            row['finishedRevision'] = revision()
                            row['error'] = 'Validation unit ended without a completion receipt; inspect the unit journal and rerun the check.'
                            save(path, row)
                            status(home, state, args.task, 'resolved', row['error'], f'bb-check-{row["id"]}')
                            pending = any('exitCode' not in load(record) for record in (data / 'checks').glob('*.json'))
                            phase = 'paused' if pending else 'working'
                            if not pending:
                                status(home, state, args.task, phase, row['error'])
                            report(data, phase, row['error'])
                    break
                time.sleep(1)
                row = load(path)
            if 'exitCode' not in row:
                print('Still running. Repeat this wait command; do not poll the background task status.')
                return
            log = path.with_suffix('.log')
            if log.exists():
                print(log.read_text()[-8000:], end='')
            if row.get('finishedRevision') != row['revision'] or row['revision'] != revision():
                raise ValueError('worktree changed during or after validation; rerun on the final revision')
            if row.get('error'):
                print(row['error'], file=sys.stderr)
            print(f'Check finished with exit {row["exitCode"]}. Full receipt: {path}; command output: {log if log.exists() else "unavailable"}')
            sys.exit(row['exitCode'])


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f'error: {error}', file=sys.stderr)
        sys.exit(2)
