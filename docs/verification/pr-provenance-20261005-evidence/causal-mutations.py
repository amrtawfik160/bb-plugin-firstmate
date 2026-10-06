from pathlib import Path
import subprocess
import json

root = Path(__file__).resolve().parents[3]
evidence = Path(__file__).resolve().parent
cases = [
    ('omit-source-metadata', 'server.ts', 'return resource.source?prSourcePage(page,resource.source,FIRSTMATE_ROUTINE_MARKER):page;', 'return page;', 'public paged PR reads expose'),
    ('omit-metadata-byte-bound', 'lib/selected-methods.ts', '  if(Buffer.byteLength(metadata)>2048)', None, 'public PR reads refuse oversized'),
    ('omit-complete-serialized-bound', 'lib/selected-methods.ts', '  if(Buffer.byteLength(JSON.stringify({text:result+activityMarker}', None, 'public PR reads refuse oversized'),
    ('interpret-literal-source-replacement-tokens', 'lib/selected-methods.ts', "page.replace('\\nBEGIN_PAGE\\n',()=>", "page.replace('\\nBEGIN_PAGE\\n',", 'public paged PR reads expose'),
]
results=[]
for name, filename, before, after, pattern in cases:
    file=root/filename
    original=file.read_text()
    try:
        assert before in original, (name, 'mutation anchor drift')
        if after is None:
            changed=''.join(line for line in original.splitlines(keepends=True) if not line.startswith(before))
        else:
            changed=original.replace(before, after, 1)
        assert changed != original
        file.write_text(changed)
        result=subprocess.run(['node','--test','--experimental-strip-types','--test-name-pattern='+pattern,'server.methods.test.mjs'],cwd=root,capture_output=True,text=True,timeout=30)
        (evidence/(name+'.log')).write_text(result.stdout+result.stderr)
        assert result.returncode == 1, (name, result.returncode, result.stdout+result.stderr)
        results.append({'mutation':name,'test':pattern,'exitCode':result.returncode,'killed':True})
        print(name+': killed')
    finally:
        file.write_text(original)
(evidence/'causal-results.json').write_text(json.dumps(results,indent=2)+'\n')
