#!/usr/bin/env node
// Executes the installed native alarm functions with controlled BB activity responses.
// No worker status/progress is synthesized; this is a shell integration fixture,
// not an end-to-end proof that BB's interaction SDK reports a pending UI question.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INSTALLER, OVERLAY, discoverCheckout, cloneAtBase, sh } from "./fm-fixture.mjs";
const source = discoverCheckout();
assert.ok(source, "native checkout required; set FM_TEST_HOME");
const scratch = mkdtempSync(join(tmpdir(), "fm-bb-pending-input-"));
const home = join(scratch, "home");
const bridge = join(scratch, "bridge");
const fixture = join(scratch, "snapshot.json");
const probe = join(scratch, "probe.sh");
try {
  assert.ok(cloneAtBase(source, home).ok);
  const install = sh("python3", [INSTALLER, "--home", home, "--overlay", OVERLAY]);
  assert.equal(install.code, 0, install.out);
  mkdirSync(bridge); mkdirSync(join(home, "state"), { recursive: true });
  writeFileSync(join(bridge, "bb"), `#!/usr/bin/env python3\nimport json,sys,time,os\nif sys.argv[1:3] == ['firstmate','activity']:\n data=json.load(open(os.environ['BB_WAIT_FIXTURE']))\n if data.get('sleep'): time.sleep(data['sleep'])\n if data.get('fail'): sys.exit(1)\n print(json.dumps(data))\nelif sys.argv[1:3] == ['thread','show']:\n print(json.dumps({'id':'thr_waitproof','status':'active'}))\nelse:\n print('{}')\n`, { mode: 0o755 });
  writeFileSync(join(home, "state/proof.meta"), "backend=bb\nbb_thread_id=thr_waitproof\nwindow=bb:thr_waitproof\nharness=bb\nkind=ship\n");
  const status = join(home, "state/proof.status");
  writeFileSync(status, "working: fixture task awaiting tool result\n");
  writeFileSync(probe, `#!/usr/bin/env bash
set -eu
export PATH="$BB_WAIT_BRIDGE:$PATH" FM_HOME="$BB_WAIT_HOME" FM_ROOT_OVERRIDE="$BB_WAIT_HOME"
export FM_STATE_OVERRIDE="$FM_HOME/state" FM_CONFIG_OVERRIDE="$FM_HOME/config"
export FM_BACKEND=bb FM_STALE_ESCALATE_SECS=3 FM_WATCH_HANDLING_SUCCESSOR=1
. "$FM_HOME/bin-bb/fm-watch.sh"
printf '%s' "$(( $(date +%s) - 10 ))" > "$STATE/.stale-since-bb_thr_waitproof"
wedge_timer_check bb:thr_waitproof "$STATE/.stale-since-bb_thr_waitproof" 'non-terminal stale' "$STATE/.wedge-escalations-bb_thr_waitproof" proof hash
`);
  const statusMtime = statSync(status).mtimeMs;
  const base = { version: 1, threadId: "thr_waitproof", status: "active", runtimeStatus: "active", interactionCount: 1 };
  function run(data) {
    writeFileSync(fixture, JSON.stringify(data));
    const result = sh("bash", [probe], { env: { ...process.env, BB_WAIT_BRIDGE: bridge, BB_WAIT_HOME: home, BB_WAIT_FIXTURE: fixture }, timeout: 12_000 });
    assert.equal(result.code, 0, result.out);
    assert.equal(readFileSync(status, "utf8"), "working: fixture task awaiting tool result\n");
    assert.equal(statSync(status).mtimeMs, statusMtime);
    assert.equal(existsSync(join(home, "state/proof.progress")), false);
    return result.out;
  }
  const pending = run(base);
  assert.doesNotMatch(pending, /possible wedge/);
  assert.match(pending, /BB pending input/);
  console.log("PASS pending interaction follows native bounded wait deferral");
  assert.match(run({ ...base, interactionCount: 0 }), /possible wedge/);
  console.log("PASS cleared interaction resumes native wedge alarm at next threshold");
  assert.match(run({ ...base, status: "error" }), /possible wedge/);
  console.log("PASS pending input on a failed thread never hides a stall");
  const watcher = join(home, "bin-bb/fm-watch.sh");
  const fixed = readFileSync(watcher, "utf8");
  writeFileSync(watcher, readFileSync(join(home, "bin/fm-watch.sh"), "utf8"));
  assert.match(run(base), /possible wedge/);
  console.log("KILLED mutation: pristine native watcher false-alarms while input is pending");
  writeFileSync(watcher, fixed);
  for (const [label, data] of [
    ["wrong thread", { ...base, threadId: "thr_other" }],
    ["wrong version", { ...base, version: 2 }],
    ["noninteger count", { ...base, interactionCount: "1" }],
    ["query failure", { ...base, fail: true }],
    ["timeout", { ...base, sleep: 30 }],
  ]) {
    const began = Date.now();
    const out = run(data);
    assert.match(out, /possible wedge/);
    assert.match(out, /error: .*BB pending-input/);
    if (label === "timeout") assert.ok(Date.now() - began < 9_000, "BB wait query must be bounded");
    console.log(`PASS ${label} reports error and preserves native alarm`);
  }
  console.log("PASS worker status unchanged; no progress events fabricated");
} finally { rmSync(scratch, { recursive: true, force: true }); }
