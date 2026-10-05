import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// Execute the actual host command under a real PTY, as terminals.create does.
// This fixture invokes no forge, BB service, worker or model.
export function runPty(command) {
  const script=`import errno, os, pty, subprocess, sys
master, slave = pty.openpty()
process = subprocess.Popen(["bash", "--noprofile", "--norc", "-c", sys.argv[1]], stdout=slave, stderr=slave)
os.close(slave)
output = bytearray()
try:
 while True:
  chunk = os.read(master, 65536)
  if not chunk: break
  output.extend(chunk)
except OSError as error:
 if error.errno != errno.EIO: raise
finally:
 os.close(master)
sys.stdout.buffer.write(output)
sys.exit(process.wait())`;
  const result=spawnSync('python3',['-c',script,command],{encoding:'utf8',timeout:5000});
  assert.equal(result.status,0,result.error?.message ?? result.stderr);
  return result.stdout;
}

// The same complete JSON fields and progress prefix as the parent's real PR50
// host output. Under a PTY gh writes "Working..." before its JSON response.
export const mergedJson=JSON.stringify({headRefOid:'834dc3bfb35fcea6912f3a1f950b70fde9ad3d63',isDraft:false,mergeCommit:{oid:'870312ee6cfa13c784dce615e95ac01c9ebb5222'},mergeable:'UNKNOWN',reviewDecision:'',reviews:[],state:'MERGED',statusCheckRollup:[]});
