// Causal checks execute actual native scaffold/render/inbox code in isolated copies.
// No plugin installation in BB, worker turn, production home or live inbox is used.
import {cpSync,mkdtempSync,readFileSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const root=resolve('.'),scratch=mkdtempSync(join(tmpdir(),'fm-prompt-mutations-'));
const cases=[
 {name:'exact-ID inbox acknowledgement',file:'overlay/bin/fm-inbox-take.sh',old:true,test:'scripts/prompt-inbox.test.mjs',pattern:'read 001 then arrival 002'},
 {name:'one BB browser rule',file:'overlay/bin/backends/bb-worker-prompt.py',from:"rules = rules.replace(BROWSER, '<!-- BB-DIVERGE: native fm-brief.sh Rules / rule 3; BB browser transport. -->\\n' + browser, 1)",to:'rules = rules',test:'scripts/prompt-inbox.test.mjs',pattern:'worker renderer preserves task'},
 {name:'immutable Task rendering boundary',file:'overlay/bin/backends/bb-worker-prompt.py',from:'task = prefix[:herdr_start]',to:'task = paths(prefix[:herdr_start], home, bindir)',test:'scripts/prompt-inbox.test.mjs',pattern:'worker renderer preserves task'},
 {name:'exact task-owned allowed writes',file:'overlay/bin/backends/bb-worker-prompt.py',from:"rules = rules.replace(WRITES[kind], '<!-- BB-DIVERGE: native fm-brief.sh Rules / rule 2; exact task-owned BB operational paths. -->\\n' + allowed, 1)",to:'rules = rules',test:'scripts/prompt-inbox.test.mjs',pattern:'worker renderer preserves task'},
 {name:'resolved artifact directory',file:'overlay/bin/backends/bb-worker-transport.txt',from:'{ARTIFACT_DIR}',to:'data/<task-id>/',test:'scripts/prompt-inbox.test.mjs',pattern:'worker renderer preserves task'},
 {name:'authoritative replacement launch brief',file:'server.ts',from:'brief=${shQuote(`${briefDir}/launch-brief.md`)}; [ -e "$brief" ] || brief=${shQuote(`${briefDir}/brief.md`)}',to:'brief=${shQuote(`${briefDir}/brief.md`)}',test:'server.test.ts',pattern:'native replacement retry uses'},
 {name:'owned payload integrity at replacement',file:'server.ts',from:'python3 -c ${shQuote(verifyPayloads)} "$FM_BINDIR" ${shQuote(JSON.stringify(payloads))} || exit 1',to:':',test:'server.test.ts',pattern:'native replacement refuses a stale owned'},
 {name:'shipped renderer companion',file:'overlay/install-bb-backend.py',from:'shutil.copy2(overlay / "bin" / "backends" / "bb-worker-prompt.py", dest / "bb-worker-prompt.py")',to:'# omitted renderer companion',test:'scripts/prompt-inbox.test.mjs',pattern:'full installer ships'},
];
try {
 cpSync(root,scratch,{recursive:true,filter:path=>!['.git','node_modules','dist','__pycache__'].includes(basename(path))});symlinkSync(join(root,'node_modules'),join(scratch,'node_modules'),'dir');
 for(const c of cases) {
  const path=join(scratch,c.file),original=readFileSync(path,'utf8');let changed;
  if(c.old) {
   const prior=spawnSync('git',['show','33d5cb0:overlay/bin/fm-inbox-take.sh'],{cwd:root,encoding:'utf8'});if(prior.status!==0)throw new Error(prior.stderr);changed=prior.stdout;
  } else {if(!original.includes(c.from))throw new Error(`mutation anchor missing: ${c.name}`);changed=original.replace(c.from,c.to);}
  writeFileSync(path,changed);
  const result=spawnSync(process.execPath,['--test','--experimental-strip-types',`--test-name-pattern=${c.pattern}`,c.test],{cwd:scratch,encoding:'utf8',timeout:45000});writeFileSync(path,original);
  if(result.error||result.status===0||!/AssertionError|ERR_ASSERTION/.test(result.stdout+result.stderr))throw new Error(`${c.name} did not kill the behavior assertion:\n${result.stdout}\n${result.stderr}`);
  console.log(`PASS: removing ${c.name} fails ${c.pattern}`);
 }
} finally {rmSync(scratch,{recursive:true,force:true});}
