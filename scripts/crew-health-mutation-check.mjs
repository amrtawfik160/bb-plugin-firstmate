// Mutate isolated source copies. No live worker, home, or plugin is changed.
import {cpSync,mkdtempSync,readFileSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const root=resolve('.'),scratch=mkdtempSync(join(tmpdir(),'fm-crew-health-mutations-'));
const helper='overlay/bin/fm-worker-checkpoint.py';
const cases=[
 {name:'completed provider activity',file:'server.ts',from:'types: BB_ACTIVITY_TYPES,',to:'types: BB_ACTIVITY_TYPES.filter(type => type !== "item/completed"),',test:'server.test.ts',pattern:'completed worker tools prevent'},
 {name:'report-only specification',file:'server.ts',from:'const defaultSpec = crew.shape === "scout"',to:'const defaultSpec = false',test:'server.test.ts',pattern:'report-only dispatch fills'},
 {name:'recorded startup instruction',file:'overlay/bin/backends/bb-worker-prompt.py',line:'    setup += f',test:'scripts/prompt-inbox.test.mjs',pattern:'worker renderer preserves task'},
 {name:'installed checkpoint integrity',file:'overlay/install-bb-backend.py',from:'"fm-bb-probe-lib.sh", "fm-worker-checkpoint.py",\n)',to:'"fm-bb-probe-lib.sh",\n)',test:'scripts/prompt-inbox.test.mjs',pattern:'full installer ships'},
 {name:'required project reads',file:helper,from:"if hashlib.sha256(text.encode()).hexdigest() != record['sha256'] or record['readThrough'] < len(text):",to:'if False:',test:'scripts/worker-checkpoint.test.mjs',pattern:'setup requires complete'},
 {name:'native delivery mode identity',file:helper,from:'if expected and mode != expected:',to:'if False:',test:'scripts/worker-checkpoint.test.mjs',pattern:'cannot substitute a lighter'},
 {name:'doctor setup',file:helper,from:"if 'not initialized' in (result.stdout + result.stderr).lower():",to:'if False:',test:'scripts/worker-checkpoint.test.mjs',pattern:'setup executes doctor'},
 {name:'report before completion',file:helper,from:'        report(data, *values)\n        status(home, state, args.task, *values)',to:'        status(home, state, args.task, *values)\n        report(data, *values)',test:'scripts/worker-checkpoint.test.mjs',pattern:'failed progress write'},
 {name:'paired progress report',file:helper,from:"atomic(data / 'progress.md', '\\n'.join(lines))",to:'pass',test:'scripts/worker-checkpoint.test.mjs',pattern:'report writes native status'},
 {name:'paused before validation',file:helper,line:"            status(home, state, args.task, 'paused',",test:'scripts/worker-checkpoint.test.mjs',pattern:'background validation records paused'},
 {name:'exact wait resolution',file:helper,line:"                status(home, state, args.task, 'resolved', f'{row[\"label\"]} finished",test:'scripts/worker-checkpoint.test.mjs',pattern:'background validation records paused'},
 {name:'native zero-turn validation',file:helper,from:"if setup.get('foregroundChecks') and not foreground:",to:'if False:',test:'scripts/worker-checkpoint.test.mjs',pattern:'native zero-turn waiting'},
 {name:'interrupted unit detection',file:helper,from:"if unit_stopped(row['id']):",to:'if False:',test:'scripts/worker-checkpoint.test.mjs',pattern:'unit that ends without'},
 {name:'untracked revision identity',file:helper,line:"    for name in sorted(git('ls-files',",replacement:'    for name in []:',test:'scripts/worker-checkpoint.test.mjs',pattern:'stale result after untracked'},
];
try {
 cpSync(root,scratch,{recursive:true,filter:path=>!['.git','node_modules','dist','__pycache__'].includes(basename(path))});
 symlinkSync(join(root,'node_modules'),join(scratch,'node_modules'),'dir');
 for(const c of cases) {
  const path=join(scratch,c.file),original=readFileSync(path,'utf8');let changed;
  if(c.line) {
   const lines=original.split('\n'),matches=lines.map((line,i)=>line.startsWith(c.line)?i:-1).filter(i=>i>=0);
   if(matches.length!==1)throw new Error('Ambiguous mutation anchor: '+c.name);
   const i=matches[0];lines[i]=c.replacement??lines[i].match(/^\s*/)[0]+'pass';changed=lines.join('\n');
  } else {
   if(!original.includes(c.from))throw new Error('Mutation anchor missing: '+c.name);
   changed=original.replace(c.from,c.to);
  }
  writeFileSync(path,changed);
  const result=spawnSync(process.execPath,['--test','--experimental-strip-types',`--test-name-pattern=${c.pattern}`,c.test],{cwd:scratch,encoding:'utf8',timeout:60000,maxBuffer:4*1024*1024});
  writeFileSync(path,original);
  if(result.error || result.status===0 || !/AssertionError|ERR_ASSERTION/.test(result.stdout+result.stderr))throw new Error(`${c.name} did not kill its behavior assertion:\n${result.stdout}\n${result.stderr}`);
  console.log(`PASS: removing ${c.name} fails ${c.pattern}`);
 }
}finally{rmSync(scratch,{recursive:true,force:true});}
