// Mirrors the documented package root semantics for SDK configuration fixtures.
// The installed-server regression separately verifies actual BB discovery.
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
export function manifestSkillIds(root) {
 const manifest=JSON.parse(readFileSync(join(root,'package.json'),'utf8')),ids=new Set();
 for(const directory of manifest.bb.skills??['skills']){
  const parent=directory.replace(/\/\*$/,'');
  for(const entry of readdirSync(join(root,parent),{withFileTypes:true})){
   if(!entry.isDirectory())continue;
   try{if(lstatSync(join(root,parent,entry.name,'SKILL.md')).isFile())ids.add(entry.name);}catch{}
  }
 }
 return [...ids].sort();
}
