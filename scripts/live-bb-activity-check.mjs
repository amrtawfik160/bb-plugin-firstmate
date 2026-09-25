#!/usr/bin/env node
// Runs the candidate adapter and native scripts against a real, owned BB thread.
// A disposable read-only plugin exposes the candidate SDK helper without reloading
// the installed firstmate plugin. The bridge routes only that new CLI command;
// every thread operation is the real BB CLI. No synthetic activity is injected.
import assert from "node:assert/strict";
import { spawnSync, spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), "fm-activity-live-"));
const native = process.env.FM_TEST_HOME ?? "/root/firstmate";
const home = join(scratch, "home");
const proof = join(scratch, "plugin");
const bridge = join(scratch, "bridge");
const project = process.env.BB_PROJECT_ID;
const pluginId = `fm-activity-proof-${process.pid}`;
let threadId;
let installed = false;
let watcher;
function command(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 120_000, maxBuffer: 4 << 20, ...opts });
  assert.equal(r.status, 0, `${cmd} ${args.slice(0, 3).join(" ")}: ${r.stderr}\n${r.stdout}`);
  return r.stdout;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const realBb = command("bash", ["-c", "command -v bb"]).trim();
const bb = (...args) => command(realBb, args);
const json = (...args) => JSON.parse(bb(...args));
function report(label, info) { console.log(`PASS ${label}${info ? ` — ${info}` : ""}`); }
try {
  assert.ok(project, "Run inside a BB project");
  mkdirSync(proof); mkdirSync(bridge);
  cpSync(join(root, "lib/bb-activity.ts"), join(proof, "activity.ts"));
  symlinkSync(join(root, "node_modules"), join(proof, "node_modules"));
  writeFileSync(join(proof, "package.json"), JSON.stringify({ name: pluginId, version: "0.0.1", type: "module", bb: { name: "Temporary Firstmate Activity Proof", description: "Read-only live activity acceptance", branding: { icon: "Ship" }, server: "./server.ts" }, devDependencies: { "@get-bb/plugin-sdk": "0.4.104" } }));
  writeFileSync(join(proof, "server.ts"), `import { readBbActivity } from "./activity.ts";
export default function(bb) {
  bb.cli.register({name:${JSON.stringify(pluginId)},summary:"Temporary read-only activity proof",async run(argv) {
    try { return {exitCode:0,stdout:JSON.stringify(await readBbActivity(bb.sdk,argv[0]))}; }
    catch(error) { return {exitCode:1,stderr:String(error)}; }
  }});
}`);
  bb("plugin", "build", proof);
  bb("plugin", "install", proof, "--yes", "--json"); installed = true;
  writeFileSync(join(bridge, "bb"), `#!/bin/sh
if [ "$1" = firstmate ] && [ "$2" = activity ]; then
  shift 2
  exec ${JSON.stringify(realBb)} ${pluginId} "$@"
fi
exec ${JSON.stringify(realBb)} "$@"
`, { mode: 0o755 });
  command("git", ["clone", "--quiet", "--local", native, home]);
  command("git", ["-C", home, "checkout", "--quiet", "--detach", readFileSync(join(root, "overlay/patch-base.txt"), "utf8").trim()]);
  command("python3", [join(root, "overlay/install-bb-backend.py"), "--home", home, "--overlay", join(root, "overlay"), "--project-id", project]);
  mkdirSync(join(home, "state"), { recursive: true }); mkdirSync(join(home, "data"), { recursive: true });
  const bin = join(home, "bin-bb");
  const env = { ...process.env, FM_HOME: home, FM_ROOT_OVERRIDE: home, FM_STATE_OVERRIDE: join(home, "state"), FM_CONFIG_OVERRIDE: join(home, "config"), FM_BACKEND: "bb", FM_POLL: "1", FM_STALE_ESCALATE_SECS: "8", FM_BUSY_TURN_MAX_SECS: "8", FM_WATCH_HANDLING_SUCCESSOR: "1", FM_HEARTBEAT: "300", PROOF_BRIDGE: bridge, PROOF_BIN: bin };
  const shell = code => command("bash", ["-c", 'export PATH="$PROOF_BRIDGE:$PATH"; ' + code], { env });
  writeFileSync(join(scratch, "prompt"), `This is an isolated transport acceptance test. Do not edit files or use firstmate tools. Immediately run one exec_command: python3 -u -c 'import time,pathlib; [(print("activity-proof", i, flush=True), time.sleep(2)) for i in range(18)]; pathlib.Path(${JSON.stringify(join(scratch, "silent"))}).touch(); time.sleep(70)' with yield_time_ms=1000. Continue waiting with write_stdin using yield_time_ms=30000 until it finishes. If a Firstmate instruction arrives, read and move its inbox record as requested; it only asks for acknowledgement. Finish DONE: activity proof complete. No planning or research.`);
  const spawned = json("thread", "spawn", "--project", project, "--environment", root, "--title", "Disposable Firstmate activity proof", "--prompt-file", join(scratch, "prompt"), "--visibility", "hidden", "--json");
  threadId = spawned.id ?? spawned.thread?.id;
  assert.ok(threadId);
  env.PROOF_THREAD = threadId;
  const activity = () => json(pluginId, threadId, "--json");
  // Bounded readiness: observe the real provider's first work event.
  let initial;
  for (let i = 0; i < 30; i++) {
    initial = activity();
    if (initial.activity) break;
    await delay(1000);
  }
  assert.ok(initial.activity, "provider emitted no activity event");
  const capture = () => shell('. "$PROOF_BIN/fm-backend.sh"; fm_backend_capture bb "bb:$PROOF_THREAD" 40');
  const first = capture(); assert.match(first, /\[BB activity: \d+/);
  assert.equal(shell('. "$PROOF_BIN/fm-backend.sh"; fm_backend_composer_state bb "bb:$PROOF_THREAD"'), "empty");
  report("running thread has an empty native composer", threadId);
  writeFileSync(join(home, "state", "proof.meta"), `id=proof\nendpoint_task_id=proof\nkind=ship\nbackend=bb\nharness=bb\nwindow=bb:${threadId}\nbb_thread_id=${threadId}\nproject=${root}\nworktree=\n`);
  let watcherOut = "";
  watcher = spawn("bash", ["-c", 'export PATH="$PROOF_BRIDGE:$PATH"; exec "$PROOF_BIN/fm-watch.sh"'], { env, stdio: ["ignore", "pipe", "pipe"] });
  watcher.stdout.on("data", data => { watcherOut += data; }); watcher.stderr.on("data", data => { watcherOut += data; });
  await delay(18_000);
  const second = capture(); assert.notEqual(second, first, "real tool/model work never changed native capture");
  assert.ok(existsSync(join(home, "state", ".hash-bb_" + threadId)), "native watcher never captured the owned crew");
  assert.ok(existsSync(join(home, "state", "proof.progress")), "native busy-turn progress was not recorded");
  assert.equal(watcher.exitCode, null, `watcher exited early: ${watcherOut}`);
  assert.doesNotMatch(watcherOut, /possible wedge|demand-deep-inspection|activity capture failed/);
  report("real native watcher survives tool work beyond both accelerated bounds", "18s observation / 8s busy bound / 8s wedge threshold");
  for (let i = 0; i < 45 && !existsSync(join(scratch, "silent")); i++) await delay(1000);
  assert.ok(existsSync(join(scratch, "silent")), "owned command never entered its silent phase");
  for (let i = 0; i < 50 && watcher.exitCode === null; i++) await delay(1000);
  assert.equal(watcher.exitCode, 0, `native watcher did not detect the stalled tool: ${watcherOut}`);
  assert.match(watcherOut, /possible wedge/);
  report("real native watcher still escalates an active silent tool", "recorded progress stopped; true stall remained visible");
  watcher = undefined;
  const inbox = join(home, "state", "proof.inbox"); mkdirSync(inbox); mkdirSync(join(inbox, "handled"));
  writeFileSync(join(inbox, "001.msg"), "Acknowledge this transport proof by moving this file to handled/. Continue the running command.\n");
  env.PROOF_RECORD = join(inbox, "001.msg");
  const ring = shell('. "$PROOF_BIN/fm-task-inbox-lib.sh"; fm_task_inbox_ring bb "bb:$PROOF_THREAD" "$PROOF_RECORD"; printf "ring=%s" "$?"');
  assert.equal(ring, "ring=0");
  const events = json("thread", "log", threadId, "--json", "--all");
  assert.ok(events.some(row => JSON.stringify(row.data).includes(": Firstmate instruction waiting:")), "real steer was not accepted into thread events");
  report("real native inbox ring accepts a running-thread steer", "no composer skip; event-log delivery confirmed");
  bb("thread", "wait", threadId, "--timeout", "90s", "--json");
  const stable = capture(); await delay(1200); assert.equal(capture(), stable);
  report("quiet captures do not invent activity between polls");
  const line = shell('. "$PROOF_BIN/fm-task-inbox-lib.sh"; fm_task_inbox_doorbell_line "$PROOF_RECORD"');
  // A scheduled queue row is the same accepted-row contract as an interaction
  // hold, without putting a question or approval into the user's interface.
  const queued = json("thread", "tell", threadId, line, "--send-at", "1h", "--json");
  assert.equal(queued.delivery, "queued");
  const beforeQueue = json("thread", "queue", "list", threadId, "--json");
  assert.equal(shell('. "$PROOF_BIN/fm-task-inbox-lib.sh"; fm_task_inbox_ring bb "bb:$PROOF_THREAD" "$PROOF_RECORD"; printf "ring=%s" "$?"'), "ring=0");
  const afterQueue = json("thread", "queue", "list", threadId, "--json");
  assert.deepEqual(afterQueue.map(row => row.id), beforeQueue.map(row => row.id));
  bb("thread", "queue", "delete", threadId, queued.queuedMessage.id, "--json");
  report("native re-ring reuses a real accepted queue row", "no duplicate queued message");
} finally {
  if (watcher) { watcher.kill("SIGTERM"); await new Promise(resolve => watcher.once("exit", resolve)); }
  if (threadId) {
    try {
      for (const row of json("thread", "queue", "list", threadId, "--json")) bb("thread", "queue", "delete", threadId, row.id, "--json");
    } catch (error) { console.error(`queue cleanup: ${error}`); }
    for (const args of [["thread", "stop", threadId], ["thread", "archive", threadId]]) {
      try { bb(...args); } catch (error) { console.error(`cleanup: ${error}`); }
    }
    console.log(`Owned proof thread archived: ${threadId}`);
  }
  if (installed) { try { bb("plugin", "remove", pluginId, "--json"); } catch (error) { console.error(`cleanup: ${error}`); } }
  if (process.env.FM_KEEP_PROOF === "1") console.log(`Scratch retained: ${scratch}`);
  else rmSync(scratch, { recursive: true, force: true });
}
