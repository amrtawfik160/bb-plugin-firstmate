#!/usr/bin/env python3
"""BB rendering boundary for known native ship/scout scaffolds.

Native source briefs remain byte-for-byte inputs to native gates. Only their
known scaffold sections are adapted here; task/intent payloads never pass
through substitutions. Unknown or ambiguous structure refuses before launch.
"""
from pathlib import Path
import re
import importlib.util
import shlex
import sys
sys.dont_write_bytecode=True

IDENTITY = 'You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.\n\n'
BROWSER = '3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.'
WRITES = {
    'ship': '2. Stay inside this worktree; modify nothing outside it.',
    'scout': '2. Stay inside this worktree; the only files you may write outside it are the report and the status file below.',
}
SAME_OBSTACLE = '5. If you hit the same obstacle twice, append `blocked [at=<epoch>]: {why}` and stop; firstmate will help.'
STUCK = '   Use `blocked:` when you are stuck and need help.'
# Mirrored from lib/crew-contract.ts: the opening of the Obstacles section that
# Firstmate adds to a dispatched brief.
OBSTACLES_SECTION = '\n### Obstacles\nClear an ordinary obstacle yourself: '
UNSTABLE_CHECK = ' A command that changes tracked files (a dependency install, a code generator) is not source-stable: run it directly, then restore or commit what it changed.'
OLD_ARTIFACT = '\n\nBB-DIVERGE: Keep durable artifacts under data/<task-id>/ in this firstmate home, not the worktree tmp/. The worktree tmp/ is removed when the workspace is archived.\n'


def require(condition, reason):
    if not condition:
        raise ValueError(f'unsupported native worker brief: {reason}; preserve the native source and regenerate a supported scaffold')


def paths(scaffold, home, bindir):
    # This receives native scaffolding ONLY, never Task or copied captain intent.
    scaffold = scaffold.replace(f'{home}/bin/', f'{bindir}/')
    for before in [' bin/fm-', '`bin/fm-', '(bin/fm-', '\nbin/fm-']:
        scaffold = scaffold.replace(before, before[:-len('bin/fm-')] + bindir + '/fm-')
    return scaffold


def command_env_placeholder(home, bindir):
    return f'FM_HOME={shlex.quote(home)} FM_ROOT_OVERRIDE={shlex.quote(str(Path(bindir).parent))} FM_BACKEND=bb'


def render(brief, kind, task_id, home, bindir, role, transport, mode=''):
    require(kind in WRITES, 'only ship/scout worker roles are supported')
    require(re.fullmatch(r'[A-Za-z0-9._-]{1,100}', task_id) and task_id not in ('.', '..'), 'invalid task identity')
    require(home.startswith('/') and bindir.startswith('/'), 'absolute supervising home and BB mirror required')
    if bindir != home + '/bin-bb':
        # Shared immutable runtime is selected by the home, never inferred from
        # task text or a global install path. Reuse the transport verifier.
        spec=importlib.util.spec_from_file_location('bb_runtime_source',Path(__file__).parent.parent/'fm-launch-adopt.py')
        source=importlib.util.module_from_spec(spec);spec.loader.exec_module(source)
        require(str(source.native_root(Path(home))/'bin-bb')==bindir,'BB mirror is not this home selected runtime')
    artifact = f'{home}/data/{task_id}/'
    status = f'{home}/state/{task_id}.status'
    inbox = f'{home}/state/{task_id}.inbox'
    require(role.startswith('# Current worker role contract\n') and f'`{inbox}`' in role, 'native current worker role is missing')
    # Native fm-spawn already prepends this role. Replacements of a source brief
    # receive the same freshly generated role without inventing another owner.
    if brief.startswith(role.rstrip() + '\n\n'):
        brief = brief[len(role.rstrip() + '\n\n'):]
    require(brief.startswith(IDENTITY + '# Task\n'), 'native identity/task boundary changed')
    brief = brief[len(IDENTITY):]
    # Match native Setup's full introduction instead of any heading/task phrase.
    setups = list(re.finditer(r'\n# Setup\nYou are in a disposable git worktree of [^\n]+, at a detached HEAD on a clean default branch\.\n', brief))
    require(len(setups) == 1, 'ambiguous/missing native Setup anchor')
    setup_start = setups[0].start()
    prefix = brief[:setup_start]
    herdr_headers = ['\n# Herdr lifecycle declaration - NOT ENABLED\n', '\n# Herdr isolation - HARD SAFETY CONTRACT\n']
    candidates = [(prefix.rfind(header), header) for header in herdr_headers]
    herdr_start, _ = max(candidates)
    require(herdr_start > 0, 'native Herdr lifecycle guard is missing')
    task = prefix[:herdr_start]  # Verbatim task incl. nested rule-like text.
    herdr = prefix[herdr_start:]
    require('**HARD SAFETY GATE:**' in herdr or '--herdr-lab' in herdr and 'refuse-default' in herdr, 'Herdr guard changed')
    references = []
    if '# Herdr isolation - HARD SAFETY CONTRACT' in herdr:
        references.append(herdr.lstrip())
        herdr = '\n# Herdr lifecycle guard\nThis task was explicitly scaffolded with `--herdr-lab`. Before provisioning or ANY Herdr lifecycle call, read and follow the complete Herdr isolation - HARD SAFETY CONTRACT in the operational reference after completion below. Its private named session, refuse-default checks and single combined EXIT cleanup are mandatory.\n'
    scaffold = brief[setup_start:]
    # The intent overlay at EOF repeats captain words. Keep it last and verbatim:
    # native explicitly defines --intent as everything through the end of brief.
    intent_header = '\n# Current no-mistakes intent contract\n'
    intent = ''
    if intent_header in scaffold:
        require(scaffold.count(intent_header) == 1, 'ambiguous native intent overlay')
        scaffold, intent_body = scaffold.split(intent_header, 1)
        intent = intent_header + intent_body
    if scaffold.endswith(OLD_ARTIFACT):
        scaffold = scaffold[:-len(OLD_ARTIFACT)]
    # Home-local additions are authored content, not native scaffolding. Preserve
    # them verbatim and keep their native precedence statement, before the final
    # copied intent. Only recognised core template sections are rewritten.
    additions = ''
    addition_header = '\n# Home brief additions\n'
    if addition_header in scaffold:
        require(scaffold.count(addition_header) == 1, 'ambiguous home additions')
        scaffold, addition_body = scaffold.split(addition_header, 1)
        require(addition_body.startswith("These are this home's standing additions; every other section of this brief takes precedence over anything here that conflicts.\n"), 'home additions precedence changed')
        additions = addition_header + addition_body
    # Known core headings delimit native policy from Home additions/reference.
    require(scaffold.count('\n# Rules\n') == 1 and scaffold.count('\n# Definition of done\n') == 1, 'core policy headings changed')
    setup, remainder = scaffold.split('\n# Rules\n', 1)
    rules, completion = remainder.split('\n# Definition of done\n', 1)
    require(rules.count(BROWSER) == 1 and rules.count(WRITES[kind]) == 1, 'native browser/write-rule anchor changed')
    require(status in rules, 'status path does not match this task namespace')
    require('\n# Firstmate instruction inbox\n' in rules, 'native inbox section missing')
    before_inbox, inbox_section = rules.split('\n# Firstmate instruction inbox\n', 1)
    # The native inbox ends at Project memory (ship) or the end of Rules (scout).
    memory = ''
    if '\n# Project memory\n' in inbox_section:
        inbox_section, memory_body = inbox_section.split('\n# Project memory\n', 1)
        memory = '\n# Project memory\n' + memory_body
    require(f'{inbox}' in inbox_section and 'The move IS the acknowledgement:' in inbox_section, 'native inbox anchor/path changed')
    require('list ' in inbox_section and '/NNN.msg' in inbox_section, 'native receive-and-ack scaffold changed')
    waiting = 'Do not poll or list the inbox while waiting; a waiting instruction rings.'
    # Recognise exactly the optional native wait-no-turns tail, never enable it.
    tail = inbox_section.split('An empty or absent inbox needs no action.', 1)
    require(len(tail) == 2 and tail[1].strip() in ('', waiting), 'unknown native inbox instructions')
    ack = f'FM_HOME={shlex.quote(home)} bash {shlex.quote(bindir + "/fm-inbox-take.sh")} {shlex.quote(task_id)}'
    new_inbox = '\n# Firstmate instruction inbox\n<!-- BB-DIVERGE: native fm-brief.sh INBOX_SECTION; exact-ID handled acknowledgement through BB helper. -->\n'
    new_inbox += f'Firstmate steers you through durable message files in `{inbox}`. When an instruction rings, or at a natural checkpoint during active work, run `{ack}`. Read and act on each displayed record in numeric order, then run the printed acknowledgement command with ONLY the immutable message IDs you actually handled: `{ack} --ack 001.msg [002.msg ...]`. IDs in this example are syntax examples; use the displayed IDs. A later arrival is separate work and remains pending. Bare `--ack` refuses. Retrying already handled IDs is safe; unknown IDs refuse. The handled/ move is still native acknowledgement; without it firstmate re-rings. An empty or absent inbox needs no action.\n'
    if tail[1].strip():
        new_inbox += waiting + '\n'
    daemon_start = before_inbox.find('     Before you append `blocked:` about the pipeline,')
    pool_start = before_inbox.find('   - The worktree pool your own worktree came from,')
    require(daemon_start > 0 and pool_start > daemon_start, 'shared infrastructure guard changed')
    references.append('# Native no-mistakes daemon operational reference\n' + before_inbox[daemon_start:pool_start])
    before_inbox = before_inbox[:daemon_start] + '     Before reporting a pipeline block, read and follow the Native no-mistakes daemon operational reference below. It distinguishes a real daemon/socket block from a drive call timeout while the run continues.\n' + before_inbox[pool_start:]
    require(before_inbox.count(SAME_OBSTACLE) == 1 and before_inbox.count(STUCK) == 1, 'native blocked-rule anchor changed')
    # A dispatched brief states the obstacle rule in its own Obstacles section;
    # rule 5 then only points there. A brief without it gets the rule here.
    if task.count(OBSTACLES_SECTION) == 1:
        obstacles = '5. Follow the Obstacles section of the Task above. When it allows a stop, append `blocked [at=<epoch>]: {what you need}` and stop.'
        stuck = '   Use `blocked:` only as the Obstacles section allows.'
    else:
        obstacles = '5. Work through an ordinary obstacle yourself first: retry with a smaller query or pagination, restore or commit a change your own command made (such as an install that rewrote a lockfile), use another tool, or wait and retry. Append `blocked [at=<epoch>]: {what you need}` and stop only for what only firstmate or the owner can give: a secret, an approval, a decision, access that was withheld, or a destructive or irreversible step. Every other stop rule in this brief still applies.'
        stuck = '   Use `blocked:` only as rule 5 allows.'
    before_inbox = before_inbox.replace(SAME_OBSTACLE, '<!-- BB-DIVERGE: native fm-brief.sh Rules / rule 5; ordinary obstacles are the worker\'s to clear. -->\n' + obstacles, 1).replace(STUCK, stuck, 1)
    rules = before_inbox + new_inbox + memory
    browser = '3. Use gh-axi for GitHub operations. For browser work use the /browser skill and browser_script (or bb plugin run browser script), leaving profileId unset for this thread\'s isolated default profile. The CLI form is bb plugin run browser script --purpose <text> --code <source> --origin <origin> [--json]; --json prints one object {ok, output, screenshots}. Do not use the AXI browser or install its hooks.'
    rules = rules.replace(BROWSER, '<!-- BB-DIVERGE: native fm-brief.sh Rules / rule 3; BB browser transport. -->\n' + browser, 1)
    allowed = f'2. Work in the task worktree. The only writes allowed outside it are the task status file `{status}`, message acknowledgement files under `{inbox}/` and `{inbox}/handled/`, and task artifacts under `{artifact}`'
    if kind == 'scout':
        report = f'{artifact}report.md'
        require(f'`{report}`' in completion, 'native scout report path changed')
        allowed += f', including the native-declared scout report `{report}`'
    allowed += '. These task-owned paths do not authorize editing other tasks, homes, config or shared state. Keep the native status command below intact, including its optional fleet-ledger call.'
    rules = rules.replace(WRITES[kind], '<!-- BB-DIVERGE: native fm-brief.sh Rules / rule 2; exact task-owned BB operational paths. -->\n' + allowed, 1)
    if kind == 'ship':
        matches = re.findall(r'^Delivery contract: mode=(\S+)', completion, re.M)
        require(len(matches) == 1 and matches[0] in ('direct-PR', 'no-mistakes', 'local-only'), 'unknown native delivery mode')
        require(not mode or matches[0] == mode, 'replacement mode conflicts with native delivery contract')
    checkpoint = f'{command_env_placeholder(home, bindir)} python3 {shlex.quote(bindir + "/fm-worker-checkpoint.py")} {shlex.quote(task_id)}'
    # Startup owns setup verification once, after the native branch/isolation step.
    doctor = '2. Run `no-mistakes doctor`; if it reports the repo is not initialized here, run `no-mistakes init`.'
    if mode == 'no-mistakes' or kind == 'ship' and matches[0] == 'no-mistakes':
        require(setup.count(doctor) == 1, 'native no-mistakes setup changed')
        setup = setup.replace(doctor, '', 1)
    task_mode = 'scout' if kind == 'scout' else matches[0]
    setup_option = ' --foreground-checks' if tail[1].strip() else ''
    setup += f'\n<!-- BB-DIVERGE: recorded task setup and project reads. -->\nAfter isolation and branch setup, run `{checkpoint} setup {task_mode}{setup_option}`. In no-mistakes mode this runs doctor and initializes only when doctor reports an uninitialized repository. Read each printed instruction page and follow every continuation. Register further guides required by project instructions with `{checkpoint} require-read <path> [<path> ...]`, then use its printed read commands. Read the project rules and task-specific skills before editing.\n'
    rules += f'\n<!-- BB-DIVERGE: one task reporting and background-check transport. -->\nAt an actionable phase change or after handling steering, run `{checkpoint} report <phase> "<one-line summary>"`; optionally pipe current findings on stdin. This updates the native status and `{artifact}progress.md` together, preserves notes, and records current worktree/check evidence. The native states, exact-key resolution rules, fleet ledger, and completion gates above remain authoritative. Resolve any manually opened wait or blocker with the native exact-key command before resuming.'
    if tail[1].strip():
        rules += f'\nFor long source-stable local checks (tests, typecheck and build), run `{checkpoint} check-foreground "<label>" -- <command> [<argument> ...]` using the largest foreground timeout your harness supports, as the native zero-turn waiting instructions above require. It records the native pause and exact-key resolution, command output and revision receipt without a background unit or status-poll loop.' + UNSTABLE_CHECK + '\n'
    else:
        rules += f'\nFor a long source-stable local check (tests, typecheck and build), run `{checkpoint} check "<label>" -- <command> [<argument> ...]`. It records paused before launch, runs a durable systemd unit, records the result, and resolves that exact wait key. Run its printed wait command; each call waits up to 30 seconds. Use these bounded waits instead of repeated background-task status calls. A check only covers its recorded command and revision; changed work requires a new check.' + UNSTABLE_CHECK + ' Use the native paused command above for other external waits.\n'
    if task_mode == 'no-mistakes':
        rules += '\nRun the no-mistakes pipeline through its native commands and outcome artifacts below; the checkpoint helper covers source-stable local checks.\n'
    # Preserve all native no-mistakes gate/pipeline instructions inline: they are
    # execution-critical in that mode. Optional visual instructions move as one
    # verbatim reference, reached by a strong conditional pointer before done.
    lines = completion.splitlines(keepends=True)
    for index, line in enumerate(lines):
        if line.startswith('If your deliverable is a visual artifact the captain will review and iterate on, use the lavish-axi rule:'):
            references.append('# Native Lavish operational reference\n' + line)
            lines[index] = 'If the deliverable is a visual artifact for captain review, read and follow the Native Lavish operational reference below before reporting done.\n'
    completion = ''.join(lines)
    command_env = command_env_placeholder(home, bindir)
    transport = transport.replace('{FM_COMMAND_ENV}', command_env).replace('{FM_HOME}', home).replace('{FM_BINDIR}', bindir).replace('{TASK_ID}', task_id).replace('{ARTIFACT_DIR}', artifact)
    result = role.rstrip() + '\n\n' + task + '\nWork on your own; do not wait for a human.\n' + paths(herdr, home, bindir)
    result += '\n# BB execution transport\n<!-- BB-DIVERGE: native script invocation and BB archive/background transport only. -->\n' + transport.rstrip() + '\n'
    result += paths(setup + '\n# Rules\n' + rules + '\n# Definition of done\n' + completion, home, bindir)
    references.append(f"# BB Lavish operational reference\nFor a Lavish board, read `{home}/config/lavish-axi-host` if present and set LAVISH_AXI_HOST on the open command; BB does not inherit the launcher's shell exports. Open the artifact, then arm `{bindir}/fm-procevent-lavish.sh` with `--for {task_id}`. This is a transport adaptation; the native board review/completion rule still applies.\n")
    result += '\n\n' + '\n'.join(paths(reference, home, bindir) for reference in references)
    # Keep native copied captain intent last; no global substitution on its text.
    result += additions + intent
    return result


if __name__ == '__main__':
    try:
        brief, kind, task_id, home, bindir, role, *mode = sys.argv[1:]
        source = Path(brief)
        require(source.is_file() and not source.is_symlink(), 'source brief must be a readable regular file')
        transport = (Path(bindir) / 'backends/bb-worker-transport.txt').read_text()
        with source.open(encoding="utf-8", newline="") as stream:
            text = stream.read()
        print(render(text, kind, task_id, home.rstrip('/'), bindir.rstrip('/'), role, transport, mode[0] if mode else ''))
    except (OSError, ValueError) as error:
        print(f'error: {error}', file=sys.stderr)
        sys.exit(1)
