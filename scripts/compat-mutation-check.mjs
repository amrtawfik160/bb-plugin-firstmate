// Only real scratch native policy executes; fake BB records transport, never model turns.
import {cpSync,mkdtempSync,readFileSync,writeFileSync,rmSync,symlinkSync} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
const root=resolve('.'),scratch=mkdtempSync(join(tmpdir(),'fm-compat-mutations-'));
const old='2d833ff147cd26a5c461e914e06854e0eb2707ce';
const cases=[
 {name:'old loader clause paired with old loop',file:`overlay/compat/${old}/firstmate-bb-backend.patch`,from:'+      siblings="fm-composer-lib.sh fm-transition-lib.sh"',to:'+      set -- fm-composer-lib.sh fm-transition-lib.sh',test:'scripts/native-compat.test.mjs',pattern:'exact native 2d833ff1 patches install'},
 {name:'unknown native SHA admission',file:'overlay/install-bb-backend.py',from:'head = head_commit(home)',to:`head = '${old}'`,test:'scripts/native-compat.test.mjs',pattern:'unknown source SHA'},
 {name:'remote declared old-patch payloads',file:'server.ts',from:`  "compat/${old}/firstmate-bb-backend.patch",\n`,to:'',test:'scripts/native-compat.test.mjs',pattern:'remote overlay manifest'},
 {name:'recorded exact patch identity verification',file:'overlay/install-bb-backend.py',from:'if manifest.get("patch-set") != selected_sha or manifest.get("patch-set-sha") != selected_digest:',to:'if False:',test:'scripts/native-compat.test.mjs',pattern:'remote overlay manifest'},
 {name:'FIFO nonblocking validation',file:'overlay/bin/fm-inbox-take.py',from:' | os.O_NONBLOCK',to:'',test:'scripts/prompt-inbox.test.mjs',pattern:'FIFO messages'},
];
try {
 cpSync(root,scratch,{recursive:true,filter:path=>!['.git','node_modules','dist','__pycache__'].includes(basename(path))});symlinkSync(join(root,'node_modules'),join(scratch,'node_modules'),'dir');
 for(const c of cases) {
  const path=join(scratch,c.file),original=readFileSync(path,'utf8');if(!original.includes(c.from))throw new Error(`missing mutation anchor: ${c.name}`);writeFileSync(path,original.replace(c.from,c.to));
  const result=spawnSync(process.execPath,['--test','--experimental-strip-types',`--test-name-pattern=${c.pattern}`,c.test],{cwd:scratch,encoding:'utf8',timeout:30000});writeFileSync(path,original);
  if(result.error||result.status===0||!/AssertionError|ERR_ASSERTION/.test(result.stdout+result.stderr))throw new Error(`${c.name} did not kill the behavioral assertion:\n${result.stdout}\n${result.stderr}`);
  console.log(`PASS: removing ${c.name} fails ${c.pattern}`);
 }
} finally {rmSync(scratch,{recursive:true,force:true});}
