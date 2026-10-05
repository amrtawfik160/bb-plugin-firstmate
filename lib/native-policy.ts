/** Read policy from the exact selected runtime. SDK 0.4.104 only accepts static
 * skill ids; supplying global copied skills would mix two native revisions. */
export const AUDITED_POLICY_COMMITS=['2d833ff147cd26a5c461e914e06854e0eb2707ce','1f3e769616fdf9f31f85f4c3e6a9f71606634238'] as const;
export function nativeSkillPath(name:string,reference='SKILL.md') {
  if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(name) || !/^[A-Za-z0-9._/-]+$/.test(reference) || reference.split('/').some(p=>!p || p==='.' || p==='..')) throw new Error('Use an exact native skill name and a relative reference without traversal');
  return `.agents/skills/${name}/${reference}`;
}
export const nativePolicyReadPython=String.raw`import hashlib,json,os,pathlib,subprocess,sys
env={**os.environ,'GIT_CONFIG_GLOBAL':os.devnull,'GIT_CONFIG_SYSTEM':os.devnull}
for key in ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES']: env.pop(key,None)
root=pathlib.Path(sys.argv[1]); relative=sys.argv[2]
head=subprocess.check_output(['git','-C',str(root),'rev-parse','HEAD'],text=True,env=env).strip()
descriptor=root/'.bb-native-runtime.json'
identity=head
if descriptor.exists():
 raw=descriptor.read_bytes()
 if raw!=subprocess.check_output(['git','-C',str(root),'show',head+':.bb-native-runtime.json'],env=env): raise ValueError('Bundled policy descriptor differs from selected snapshot')
 d=json.loads(raw); identity=d['upstreamCommit']
 if head!=sys.argv[4]: raise ValueError('Unrecognized bundled policy snapshot')
allowed=json.loads(sys.argv[3])
if identity not in allowed: raise ValueError('Unknown native policy revision; use an audited runtime, no implicit upgrade')
p=root/relative
if not p.is_file() or p.resolve()!=p or not p.resolve().is_relative_to(root.resolve()): raise ValueError('Native policy file missing or symlinked')
data=p.read_bytes()
expected=subprocess.check_output(['git','-C',str(root),'show',head+':'+relative],env=env)
if data!=expected: raise ValueError('Native policy bytes differ from selected Git snapshot; repair the selected runtime explicitly')
if len(data)>200000: raise ValueError('Native policy file exceeds complete-read limit; read the exact selected file in the agent shell')
print(json.dumps(dict(commit=identity,root=str(root),path=relative,sha256=hashlib.sha256(data).hexdigest(),text=data.decode('utf-8'))))
`;
