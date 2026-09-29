// Runs native startup under the real calling harness and under an orphaned host
// process; no model requests, crew dispatches, or existing fleet mutations.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { captainStartupCommand } from "../server.ts";
import { cloneAtBase, discoverCheckout, INSTALLER, OVERLAY } from "./fm-fixture.mjs";

const checkout = discoverCheckout();
assert.ok(checkout, "a real Firstmate checkout is required");
const work = mkdtempSync(join(tmpdir(), "fm-startup-live-"));
const home = join(work, "home");
const oldTransport = process.argv.includes("--mutate-host-transport");
try {
  const clone = cloneAtBase(checkout, home);
  assert.ok(clone.ok, clone.reason);
  const install = spawnSync("python3", [INSTALLER, "--home", home, "--overlay", OVERLAY], { encoding: "utf8" });
  assert.equal(install.status, 0, install.stderr);
  const command = captainStartupCommand(home, "session-start", ["--source", "startup"]);
  const env = { ...process.env, FM_SESSION_START_TIMEOUT: "30" };
  const detached = async () => {
    const output = join(work, "detached.json");
    const python = `import os,sys,time,subprocess,json
if os.fork(): sys.exit(0)
while os.getppid()!=1: time.sleep(0.01)
r=subprocess.run(['bash','-c',sys.argv[1]],text=True,capture_output=True)
with open(sys.argv[2], 'w') as f: json.dump({'status':r.returncode,'stdout':r.stdout,'stderr':r.stderr},f)
`;
    const result = spawnSync("python3", ["-c", python, command, output], { env, stdio: "ignore", timeout: 1000 });
    assert.equal(result.status, 0);
    for (let n = 0; n < 400 && !existsSync(output); n++) await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(existsSync(output), "detached native startup must finish");
    return JSON.parse(readFileSync(output, "utf8"));
  };
  const live = oldTransport ? await detached() : spawnSync("bash", ["-c", command], { env, encoding: "utf8", timeout: 40000 });
  assert.match(live.stdout, /lock acquired: harness pid \d+/, "native startup must acquire its real harness lock");
  assert.doesNotMatch(live.stdout, /READ-ONLY SESSION|cannot locate harness/);
  const lock = readFileSync(join(home, "state/.lock"), "utf8").trim();
  assert.equal(readFileSync(join(home, "state/.session-start-complete"), "utf8").trim(), lock, "full native startup must complete for this lock owner");
  assert.match(lock, /^\d+$/);
  const lostAncestry = await detached();
  assert.match(lostAncestry.stdout, /cannot locate harness process in ancestry/);
  assert.match(lostAncestry.stdout, /READ-ONLY SESSION/);
  assert.equal(readFileSync(join(home, "state/.lock"), "utf8").trim(), lock, "refusal must preserve the real lock owner");
  assert.equal(spawnSync("git", ["-C", home, "status", "--porcelain"], { encoding: "utf8" }).stdout, "");
  console.log("PASS: real native startup acquires the harness lock; host transport refuses read-only and preserves ownership; tracked sources stay clean.");
} finally {
  // Native deferred network probes are bounded; allow their report publication
  // to settle before deleting the disposable home.
  await new Promise(resolve => setTimeout(resolve, 1000));
  rmSync(work, { recursive: true, force: true });
}
