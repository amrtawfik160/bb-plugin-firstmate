// Writes the native-owned files for a new pin. Run it through
// scripts/refresh-native-pin.mjs, which refuses a pin that changes owner bytes.
// This never checks out or edits native.
import { readFileSync,writeFileSync,readdirSync,mkdirSync } from 'node:fs';
import { join,dirname } from 'node:path';
import { execFileSync,spawnSync } from 'node:child_process';
const [native,sha]=process.argv.slice(2);
if (!native || !/^[a-f0-9]{40}$/.test(sha ?? '')) throw new Error('Usage: node scripts/vendor-native-pin.mjs <native clone> <audited SHA>');
const git=(...args)=>execFileSync('git',['-C',native,...args],{ encoding:'utf8' });
const old=readFileSync('overlay/patch-base.txt','utf8').trim();
function markdownFiles(root) {
  return readdirSync(root,{withFileTypes:true}).flatMap(entry=>entry.isDirectory() ? markdownFiles(join(root,entry.name)) : entry.name.endsWith('.md') ? [join(root,entry.name)] : []);
}
const sourced=[...markdownFiles('skills'),...markdownFiles('entry-skills')].flatMap(file=>{
  const original=readFileSync(file,'utf8');
  const header=/<!-- BB-SOURCE\s+([\s\S]*?)-->/.exec(original);
  return header ? [{ file,original,header,source:/native:\s*(\S+)/.exec(header[1])[1] }] : [];
});
const gone=sourced.filter(({ source })=>spawnSync('git',['-C',native,'cat-file','-e',`${sha}:${source}`]).status !== 0);
if (gone.length > 0) {
  for (const { file,source } of gone) console.log(`NATIVE_SOURCE_GONE: ${file} copies ${source}, which ${sha.slice(0,8)} does not have`);
  console.log(`PIN REFUSED: ${sha} removed native files that BB skills copy. Nothing was written.`);
  process.exit(1);
}
for (const { file,original,header,source } of sourced) {
  const snapshot=/snapshot:\s*(\S+)/.exec(header[1])[1];
  const next=snapshot.replace(old.slice(0,8),sha.slice(0,8));
  const text=git('show',`${sha}:${source}`);
  mkdirSync(dirname(next),{ recursive:true });writeFileSync(next,text);
  const marker=header[0].replaceAll(old,sha).replaceAll(`native-snapshot/${old.slice(0,8)}`,`native-snapshot/${sha.slice(0,8)}`);
  let updated=original.replace(header[0],marker);
  if (old !== sha && /fidelity:\s*verbatim/.test(header[1])) {
    const frontmatter=/^---\n[\s\S]*?\n---\n/.exec(text)?.[0];
    if (/^---\n/.test(original) && frontmatter) updated=frontmatter+'\n'+marker+'\n'+text.slice(frontmatter.length);
    else {
      const body=text.replace(/^---\n[\s\S]*?\n---\n/, '').trimStart();
      updated=marker+'\n\n'+body;
    }
  }
  writeFileSync(file,updated);
}
const agents=git('show',`${sha}:AGENTS.md`);
const section=agents.slice(agents.indexOf('## 9.'),agents.indexOf('\n## 10.') === -1 ? undefined : agents.indexOf('\n## 10.'));
writeFileSync(`native-snapshot/${sha.slice(0,8)}/AGENTS.section-9.md`,section);
const scripts=git('ls-tree','-r','--name-only',sha,'bin').trim().split('\n').map(p=>p.slice(4));
const callable=scripts.filter(p=>/^fm-[a-z0-9-]+\.sh$/.test(p)).map(p=>p.slice(3,-3));
const support=scripts.filter(p=>!/^fm-[a-z0-9-]+\.sh$/.test(p));
const manifest=readFileSync('lib/upstream-surface.ts','utf8');
const skills=JSON.parse(/UPSTREAM_SKILL_NAMES = (\[.*?\]) as const/.exec(manifest)[1]);
writeFileSync('lib/upstream-surface.ts',`// Generated from kunchenguid/firstmate at ${sha} plus the BB backend adapter.\nexport const UPSTREAM_FIRSTMATE_SHA = ${JSON.stringify(sha)};\nexport const UPSTREAM_SCRIPT_NAMES = ${JSON.stringify(callable.sort())} as const;\nexport const UPSTREAM_SKILL_NAMES = ${JSON.stringify(skills)} as const;\nexport const PINNED_SCRIPT_SUPPORT_FILES = ${JSON.stringify([...new Set([...support,'backends/bb.sh'])].sort())} as const;\n`);
writeFileSync('overlay/patch-base.txt',sha+'\n');
const readme=readFileSync('native-snapshot/README.md','utf8');
writeFileSync('native-snapshot/README.md',readme.replace(/Current snapshot: `[0-9a-f]{40}`/,`Current snapshot: \`${sha}\``));
console.log(`Vendored ${sha}.`);
