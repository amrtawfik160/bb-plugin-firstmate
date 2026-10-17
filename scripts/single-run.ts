// One run at a time for a weekly automation script. The script runs again under `flock -n`
// on its lock file, so the kernel holds the lock for as long as the run lives and frees it
// when the run ends or dies. No lock is ever judged by its age.
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const BUSY = 75;

export function singleRun(lock: string, label: string): void {
  if (process.env.FM_SINGLE_RUN_LOCK === lock) return;
  mkdirSync(dirname(lock), { recursive: true });
  const r = spawnSync("flock", ["-n", "-E", String(BUSY), lock, process.execPath, ...process.execArgv, ...process.argv.slice(1)], {
    stdio: "inherit",
    env: { ...process.env, FM_SINGLE_RUN_LOCK: lock },
  });
  if (r.error) throw new Error(`${label}: flock could not start: ${r.error.message}`);
  if (r.status === BUSY) {
    console.log(`${label}: none: another run holds the lock`);
    process.exit(0);
  }
  process.exit(r.status ?? 1);
}
