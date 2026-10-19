import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { provisionScript, takeMainScript, devStartScript, devUnit, devAppCommand, unshippedScript, foldScript, rollbackFoldScript, extraTaskWorktreeScript, deleteTaskBranchScript } from './workstream-runtime.ts';
import { parseFoldOutput } from './workstream-fold.ts';
import { UNSAVED_WORK_SCRIPT, unsavedWorkFindings } from './finished-crew-retire.ts';
import type { Workstream } from './workstreams.ts';

const git = (dir:string,...args:string[]) => execFileSync('git',['-C',dir,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
const commit = (dir:string) => { git(dir,'add','-A'); git(dir,'-c','user.name=fixture','-c','user.email=fixture@test','commit','-qm','work'); };

test('real Git: repeat creation preserves work, each Ship takes main, unsaved work refuses cleanup', () => {
  const dir = mkdtempSync(join(tmpdir(),'fm-workstream-'));
  try {
    const remote = join(dir,'origin.git'), source = join(dir,'source'), path = join(dir,'work stream');
    execFileSync('git',['init','--bare','-q',remote]);
    execFileSync('git',['init','-qb','main',source]);
    writeFileSync(join(source,'base.txt'),'base'); commit(source);
    git(source,'remote','add','origin',remote); git(source,'push','-u','origin','main');
    const branch = 'workstream/ws-fixture';
    const script = provisionScript(source,path,branch);
    execFileSync('bash',['-c',script],{stdio:'pipe'});
    writeFileSync(join(path,'design.txt'),'first change'); commit(path);
    const head = git(path,'rev-parse','HEAD');
    execFileSync('bash',['-c',script],{stdio:'pipe'});
    assert.equal(git(path,'rev-parse','HEAD'),head,'retry must preserve commits');
    const check = () => unsavedWorkFindings(execFileSync('bash',['-c',UNSAVED_WORK_SCRIPT,'check',path,'ws-fixture'],{encoding:'utf8'}));
    assert.deepEqual(check(),['1 commit(s) on no remote']);
    git(path,'push','-u','origin',branch);
    assert.deepEqual(check(),[]);
    git(source,'merge','--ff-only',branch); git(source,'push','origin','main');
    writeFileSync(join(source,'main.txt'),'new main'); commit(source); git(source,'push','origin','main');
    const repo = {repository:'cyndra-ai/app',projectId:'p',hostId:'h',path,sourcePath:source,branch,environmentId:null};
    execFileSync('bash',['-c',takeMainScript(repo)],{stdio:'pipe'});
    assert.equal(existsSync(join(path,'main.txt')),true);
    assert.equal(git(path,'rev-parse','HEAD'),git(source,'rev-parse','HEAD'));
    writeFileSync(join(path,'design.txt'),'second change'); commit(path);
    git(path,'push','origin',branch); git(source,'merge','--ff-only',branch); git(source,'push','origin','main');
    execFileSync('bash',['-c',takeMainScript(repo)],{stdio:'pipe'});
    assert.equal(git(path,'rev-parse','HEAD'),git(source,'rev-parse','HEAD'));
    writeFileSync(join(path,'dirty.txt'),'keep');
    assert.deepEqual(check(),['1 uncommitted file(s)']);
    assert.throws(() => execFileSync('bash',['-c',takeMainScript(repo)],{stdio:'pipe'}));
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('dev unit is dedicated and Cyndra command uses workstream port with explicit auth setting', () => {
  const w: Workstream = {id:'ws-fixture',name:'Design',threadId:'cap',projectId:'p',requestId:'create',state:'open',supportsDevLink:true,provisioned:true,repos:[],taskIds:[],jobs:[],devLink:{state:'stopped',port:5200,realLogin:false},closeTopicRequested:false,ship:{state:'idle'},createdAt:0,updatedAt:0};
  const repo = {repository:'cyndra-ai/app',projectId:'p',hostId:'h',path:'/tmp/work stream',sourcePath:'/main',branch:'workstream/ws-fixture',environmentId:null};
  const script = devStartScript(w,repo,'bun x vite --port {port} --strictPort --host 0.0.0.0');
  assert.equal(devUnit(w),'fm-workstream-ws-fixture.service');
  assert.match(script,/VITE_LOCAL_AUTH_BYPASS=true/);
  assert.match(script,/--port 25200/);
  assert.match(script,/bb connect expose 5200 --json/);
  assert.doesNotMatch(script,/fm-f5f15031/);
});

test('dev start executes only its dedicated systemd unit and exposes its fixed port through fake host commands', () => {
  const dir = mkdtempSync(join(tmpdir(),'fm-workstream-dev-'));
  try {
    const bin = join(dir,'bin'), log = join(dir,'calls'); mkdirSync(bin);
    const commands = {
      systemctl:'case "$1" in is-active) exit 1;; *) exit 0;; esac',
      ss:'exit 0',
      curl:'[ -z "$TEST_LOG" ] || printf "%s\\n" "$*" >> "$TEST_LOG"; exit 0',
      'systemd-run':'printf "%s\\n" "$@" >> "$TEST_LOG"',
      bb:'printf "%s\\n" "$*" >> "$TEST_LOG"; echo \'{"url":"https://dev.example.test"}\'',
    };
    for (const [name,body] of Object.entries(commands)) { writeFileSync(join(bin,name),`#!/bin/sh\n${body}\n`); chmodSync(join(bin,name),0o755); }
    const w: Workstream = {id:'ws-test',name:'Design',threadId:'cap',projectId:'p',requestId:'create',state:'open',supportsDevLink:true,provisioned:true,repos:[],taskIds:[],jobs:[],devLink:{state:'starting',port:5200,realLogin:false},closeTopicRequested:false,ship:{state:'idle'},createdAt:0,updatedAt:0};
    const repo = {repository:'cyndra-ai/app',projectId:'p',hostId:'h',path:'/fixture path',sourcePath:'/main',branch:'workstream/ws-test',environmentId:null};
    const output = execFileSync('bash',['-c',devStartScript(w,repo,'bun x vite --port {port}','dev.example.test')],{encoding:'utf8',env:{...process.env,PATH:`${bin}:${process.env.PATH}`,TEST_LOG:log}});
    assert.match(output,/https:\/\/dev.example.test/);
    const calls = readFileSync(log,'utf8');
    assert.match(calls,/--unit=fm-workstream-ws-test.service/);
    assert.match(calls,/VITE_LOCAL_AUTH_BYPASS=true/);
    assert.match(calls,/__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS=dev.example.test/);
    assert.match(calls,/connect expose 5200 --json/);
    assert.match(calls,/http:\/\/127.0.0.1:5200/);
    assert.doesNotMatch(calls,/fm-f5f15031/);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('dev command completes setup before starting the app', () => {
  const dir = mkdtempSync(join(tmpdir(),'fm-workstream-setup-'));
  try {
    const proof = join(dir,'proof');
    const repo = {repository:'cyndra-ai/app',projectId:'p',hostId:'h',path:dir,sourcePath:'/source path',branch:'workstream/ws-test',environmentId:null};
    const command = devAppCommand(repo,`printf '%s:setup' {source} > '${proof}' && printf ":running" >> '${proof}'`,25200);
    execFileSync('bash',['-c',command],{stdio:'pipe'});
    assert.equal(readFileSync(proof,'utf8'),'/source path:setup:running');
  } finally { rmSync(dir,{recursive:true,force:true}); }
});


test('real Git: fold merges a crew worktree into the workstream branch and names changed files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fm-fold-ok-'));
  try {
    const remote = join(dir, 'origin.git'), source = join(dir, 'source'), ws = join(dir, 'ws'), crew = join(dir, 'crew');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    execFileSync('git', ['init', '-qb', 'main', source]);
    git(source, 'config', 'user.name', 'fixture'); git(source, 'config', 'user.email', 'fixture@test');
    writeFileSync(join(source, 'base.txt'), 'base'); commit(source);
    git(source, 'remote', 'add', 'origin', remote); git(source, 'push', '-u', 'origin', 'main');
    const branch = 'workstream/ws-fold';
    execFileSync('bash', ['-c', provisionScript(source, ws, branch)], { stdio: 'pipe' });
    execFileSync('bash', ['-c', extraTaskWorktreeScript(ws, crew, 'task/ws-fold/one', branch)], { stdio: 'pipe' });
    writeFileSync(join(crew, 'feature.txt'), 'from crew'); commit(crew);
    const output = execFileSync('bash', ['-c', foldScript(ws, crew, branch)], { encoding: 'utf8' });
    const parsed = parseFoldOutput(output);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.conflict, false);
    assert.ok(parsed.files.includes('feature.txt'));
    assert.equal(existsSync(join(ws, 'feature.txt')), true);
    git(source, 'worktree', 'remove', '--force', crew);
    execFileSync('bash', ['-c', deleteTaskBranchScript(source, 'task/ws-fold/one')], { stdio: 'pipe' });
    assert.equal(git(source, 'branch', '--list', 'task/ws-fold/one'), '');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real Git: a fold conflict leaves the workstream branch unchanged so the same crew can fix it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fm-fold-conflict-'));
  try {
    const remote = join(dir, 'origin.git'), source = join(dir, 'source'), ws = join(dir, 'ws'), crew = join(dir, 'crew');
    execFileSync('git', ['init', '--bare', '-q', remote]);
    execFileSync('git', ['init', '-qb', 'main', source]);
    git(source, 'config', 'user.name', 'fixture'); git(source, 'config', 'user.email', 'fixture@test');
    writeFileSync(join(source, 'clash.txt'), 'base'); commit(source);
    git(source, 'remote', 'add', 'origin', remote); git(source, 'push', '-u', 'origin', 'main');
    const branch = 'workstream/ws-conflict';
    execFileSync('bash', ['-c', provisionScript(source, ws, branch)], { stdio: 'pipe' });
    execFileSync('bash', ['-c', extraTaskWorktreeScript(ws, crew, 'task/ws-conflict/one', branch)], { stdio: 'pipe' });
    writeFileSync(join(ws, 'clash.txt'), 'workstream'); commit(ws);
    writeFileSync(join(crew, 'clash.txt'), 'crew'); commit(crew);
    const before = git(ws, 'rev-parse', 'HEAD');
    assert.throws(() => execFileSync('bash', ['-c', foldScript(ws, crew, branch)], { stdio: 'pipe' }));
    assert.equal(git(ws, 'rev-parse', 'HEAD'), before);
    assert.equal(readFileSync(join(ws, 'clash.txt'), 'utf8'), 'workstream');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('real Git: a partial multi-repo fold rolls back the first repo when the second conflicts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fm-fold-rollback-'));
  try {
    const make = (name: string) => {
      const remote = join(dir, `${name}.git`), source = join(dir, `${name}-source`), ws = join(dir, `${name}-ws`), crew = join(dir, `${name}-crew`);
      execFileSync('git', ['init', '--bare', '-q', remote]);
      execFileSync('git', ['init', '-qb', 'main', source]);
      git(source, 'config', 'user.name', 'fixture'); git(source, 'config', 'user.email', 'fixture@test');
      writeFileSync(join(source, 'file.txt'), 'base'); commit(source);
      git(source, 'remote', 'add', 'origin', remote); git(source, 'push', '-u', 'origin', 'main');
      const branch = `workstream/${name}`;
      execFileSync('bash', ['-c', provisionScript(source, ws, branch)], { stdio: 'pipe' });
      execFileSync('bash', ['-c', extraTaskWorktreeScript(ws, crew, `task/${name}/one`, branch)], { stdio: 'pipe' });
      return { ws, crew, branch };
    };
    const first = make('one');
    const second = make('two');
    writeFileSync(join(first.crew, 'ok.txt'), 'ok'); commit(first.crew);
    writeFileSync(join(second.ws, 'file.txt'), 'ws'); commit(second.ws);
    writeFileSync(join(second.crew, 'file.txt'), 'crew'); commit(second.crew);
    const firstBefore = git(first.ws, 'rev-parse', 'HEAD');
    execFileSync('bash', ['-c', foldScript(first.ws, first.crew, first.branch)], { stdio: 'pipe' });
    assert.equal(existsSync(join(first.ws, 'ok.txt')), true);
    assert.throws(() => execFileSync('bash', ['-c', foldScript(second.ws, second.crew, second.branch)], { stdio: 'pipe' }));
    execFileSync('bash', ['-c', rollbackFoldScript(first.ws)], { stdio: 'pipe' });
    assert.equal(git(first.ws, 'rev-parse', 'HEAD'), firstBefore);
    assert.equal(existsSync(join(first.ws, 'ok.txt')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('squash-merged work is not shipped again or counted in the next unshipped age', () => {
  const dir = mkdtempSync(join(tmpdir(),'fm-workstream-squash-'));
  try {
    const remote = join(dir,'origin.git'), source = join(dir,'source'), path = join(dir,'work');
    execFileSync('git',['init','--bare','-q',remote]);
    execFileSync('git',['init','-qb','main',source]);
    git(source,'config','user.name','fixture'); git(source,'config','user.email','fixture@test');
    writeFileSync(join(source,'base'),'base'); commit(source);
    git(source,'remote','add','origin',remote); git(source,'push','-u','origin','main');
    const branch = 'workstream/ws-squash';
    execFileSync('bash',['-c',provisionScript(source,path,branch)],{stdio:'pipe'});
    const repo = {repository:'cyndra-ai/app',projectId:'p',hostId:'h',path,sourcePath:source,branch,environmentId:null};
    const unshipped = () => execFileSync('bash',['-c',unshippedScript(repo)],{encoding:'utf8'}).trim();
    for (let i = 0; i < 2; i++) {
      const date = String(1800000000 + i * 100);
      writeFileSync(join(path,`design-${i}`),'change'); git(path,'add','-A');
      execFileSync('git',['-C',path,'commit','-qm','change'],{env:{...process.env,GIT_COMMITTER_DATE:`${date} +0000`}});
      assert.equal(unshipped(),date,'only commits after the previous Ship set the age');
      git(path,'push','-u','origin',branch);
      git(source,'merge','--squash',branch); commit(source); git(source,'push','origin','main');
      execFileSync('bash',['-c',takeMainScript(repo)],{stdio:'pipe'});
      assert.notEqual(git(path,'rev-list','--count','origin/main..HEAD'),'0','squash retains branch ancestry');
      assert.equal(unshipped(),'','a repeated Ship must not open an empty PR');
    }
  } finally { rmSync(dir,{recursive:true,force:true}); }
});
