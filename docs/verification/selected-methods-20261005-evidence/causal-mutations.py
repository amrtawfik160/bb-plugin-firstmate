from pathlib import Path
import subprocess
cases=[
('default-on','server.ts','let methodsProfile=(await baseSettings.get()).selectedMethods;','let methodsProfile="selected-v1";','native defaults route'),
('role-reference','lib/selected-methods.ts','const owned=`${role}-methods`;','const owned=name;','public methods selection'),
('bytes','lib/method-assets.ts','58969d5ce4be511de3ab325472088d39e9809bb10823b2bc57f4f19eadd15225','0'*64,'public methods selection'),
('pr-trigger','server.ts','meta.shape==="ship" && meta.posture==="direct-PR"?','false?','direct-PR body author'),
('pr-revision','server.ts','METHODS_REVISION,externalIdentity]);','METHODS_REVISION]);','direct-PR body author'),
('pr-owner','server.ts','["BB-methods",identity.threadId,identity.meta.nativeHome??null,role,methodsProfile,METHODS_REVISION,externalIdentity]','["BB-methods",role,methodsProfile,METHODS_REVISION,externalIdentity]','direct-PR body author'),
('pr-equivalence','lib/selected-methods.ts','if(loaded.some(copy=>copy.content!==loaded[0]!.content))','if(false && loaded.some(copy=>copy.content!==loaded[0]!.content))','PR author resolves provider-specific'),
('pr-provider','lib/selected-methods.ts',"const applicable=matches.filter(skill=>skill.provider==null || skill.provider===thread.providerId);","const applicable=[] as typeof matches;",'PR author resolves provider-specific'),
('pr-explicit-id','server.ts','signal,raceAbort,selected?.id);','signal,raceAbort);','explicit installation PR source'),
('pr-explicit-version','server.ts','if(selected && (resolved.source.revision','if(false && selected && (resolved.source.revision','explicit installation PR source'),
('pr-explicit-name','lib/selected-methods.ts',"filter(skill=>skill.name==='pr')","filter(skill=>true)",'explicit installation PR source'),
('activity','server.ts','    presentation:{suppress:true},','', 'captain tool activity'),
('pr-cancel','lib/selected-methods.ts','await read(sdk.skills.list(workspace),signal)','await sdk.skills.list(workspace)','PR skill lookup cancellation'),
]
for label,path,before,after,pattern in cases:
 p=Path(path);original=p.read_text();assert before in original,label
 try:
  p.write_text(original.replace(before,after,1))
  result=subprocess.run(['node','--test','--experimental-strip-types','--test-name-pattern='+pattern,'server.test.ts' if label=='activity' else 'server.methods.test.mjs'],capture_output=True,text=True,timeout=15)
  Path('/tmp/fm-methods-mutation-'+label+'.log').write_text(result.stdout+result.stderr)
  assert result.returncode!=0,label+' survived';print(label+': killed')
 finally:p.write_text(original)
