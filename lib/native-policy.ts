/** Read policy from the exact selected runtime. SDK 0.4.104 only accepts static
 * skill ids; supplying global copied skills would mix two native revisions. */
export const AUDITED_POLICY_COMMITS=['2d833ff147cd26a5c461e914e06854e0eb2707ce','1f3e769616fdf9f31f85f4c3e6a9f71606634238'] as const;
export function nativeSkillPath(name:string,reference?:string,source?:string) {
  if (!/^[a-z0-9][a-z0-9-]{0,100}$/.test(name)) throw new Error('Use an exact native skill name');
  function normalize(path:string) {
    if (!/^[A-Za-z0-9._/-]+$/.test(path) || path.startsWith('/')) throw new Error('Use a relative native resource path');
    const parts:string[]=[];
    for(const part of path.split('/')) {
      if (!part || part==='.') continue;
      if (part==='..') {if (!parts.length) throw new Error('Native reference escapes selected runtime');parts.pop();}
      else parts.push(part);
    }
    if (!parts.length) throw new Error('Native reference must name a file');
    return parts.join('/');
  }
  const base=normalize(source ?? `.agents/skills/${name}/SKILL.md`);
  const link=reference ?? (source ? '' : 'SKILL.md');
  if (/^[\/]|[\\\x00-\x1f]/.test(link)) throw new Error('Use a relative native reference');
  const hash=link.indexOf('#'),file=hash<0 ? link : link.slice(0,hash),fragment=hash<0 ? '' : link.slice(hash+1);
  return {path:file ? normalize(base.slice(0,base.lastIndexOf('/')+1)+file) : base,base,fragment};
}
export const nativePolicyReadPython=String.raw`import hashlib,json,os,pathlib,re,stat,subprocess,sys
env={**os.environ,'GIT_CONFIG_GLOBAL':os.devnull,'GIT_CONFIG_SYSTEM':os.devnull}
for key in ['GIT_DIR','GIT_WORK_TREE','GIT_INDEX_FILE','GIT_OBJECT_DIRECTORY','GIT_ALTERNATE_OBJECT_DIRECTORIES']: env.pop(key,None)
root=pathlib.Path(sys.argv[1]); request=json.loads(sys.argv[2])
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
def verified(relative):
 p=root/relative
 if not p.is_file() or p.resolve()!=p or not p.resolve().is_relative_to(root.resolve()): raise ValueError('Native policy file missing or symlinked')
 fd=os.open(p,os.O_RDONLY|os.O_NONBLOCK|os.O_NOFOLLOW)
 with os.fdopen(fd,'rb') as f:
  if not stat.S_ISREG(os.fstat(f.fileno()).st_mode): raise ValueError('Native policy must be a regular file')
  data=f.read(2097153)
 expected=subprocess.check_output(['git','-C',str(root),'show',head+':'+relative],env=env)
 if data!=expected: raise ValueError('Native policy bytes differ from selected Git snapshot; repair the selected runtime explicitly')
 if len(data)>2097152: raise ValueError('Native policy exceeds 2 MiB complete-read limit; no truncation')
 return data
result=dict(commit=identity,root=str(root))
if request['operation']=='catalog':
 entries=[]
 paths=subprocess.check_output(['git','-C',str(root),'ls-tree','-r','--name-only','-z',head,'--','.agents/skills'],env=env).decode().split('\0')
 for path in sorted(p for p in paths if p.endswith('/SKILL.md')):
  data=verified(path); text=data.decode('utf-8')
  match=re.match(r'\A---\r?\n(.*?)\r?\n---(?:\r?\n|$)',text,re.S)
  if not match or not re.search(r'^name: .+',match[1],re.M) or not re.search(r'^description: .+',match[1],re.M): raise ValueError('Incomplete native trigger frontmatter: '+path)
  entries.append(dict(path=path,sha256=hashlib.sha256(data).hexdigest(),frontmatter=match[1]))
 if not entries: raise ValueError('Selected native trigger inventory is empty')
 result.update(entries=entries,contractSha256=hashlib.sha256(verified('AGENTS.md')).hexdigest())
else:
 verified(request['base'])
 data=verified(request['path'])
 result.update(path=request['path'],fragment=request['fragment'],sha256=hashlib.sha256(data).hexdigest(),sizeBytes=len(data))
print(json.dumps(result))
`;
