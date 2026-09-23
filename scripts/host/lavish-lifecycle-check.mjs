// Run with node scripts/host/lavish-lifecycle-check.mjs on this systemd host.
// Uses the installed Lavish and a disposable service/store, never port 4387.
// --mutate-idle and --mutate-restart must fail, proving each service setting.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

const flags = process.argv.slice(2);
if (flags.includes('--help')) {
  console.log('Usage: sudo node scripts/host/lavish-lifecycle-check.mjs [--mutate-idle | --mutate-restart]\nRuns installed Lavish in a disposable systemd service and session store.\nChecks idle survival and saved review recovery after exit/restart.\nMutation flags deliberately remove one protection; each must exit nonzero.');
  process.exit(0);
}
assert.ok(flags.length <= 1 && flags.every(flag => ['--mutate-idle', '--mutate-restart'].includes(flag)), 'unknown arguments; use --help');
const root = await mkdtemp(join(tmpdir(), 'lavish-lifecycle-'));
const name = `lavish-lifecycle-${process.pid}.service`;
const unitPath = `/run/systemd/system/${name}`;
let installed = false;
const control = (...args) => execFileSync('systemctl', args, { encoding: 'utf8' }).trim();
const socket = createServer();
await new Promise(resolve => socket.listen(0, '127.0.0.1', resolve));
const port = socket.address().port;
await new Promise(resolve => socket.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const pid = () => control('show', name, '-p', 'MainPID', '--value');
async function healthy() {
  try { return (await fetch(`${origin}/health`)).ok; } catch { return false; }
}
async function until(check, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(message);
}
try {
  let unit = await readFile(new URL('./lavish-axi.service', import.meta.url), 'utf8');
  const cli = realpathSync(execFileSync('which', ['lavish-axi'], { encoding: 'utf8' }).trim());
  const server = process.env.LAVISH_AXI_TEST_SERVER || join(dirname(cli), 'server.mjs');
  await readFile(server); // Refuse an unknown installation before creating a unit.
  const envPath = join(root, 'service.env');
  await writeFile(envPath, [
    `HOME=${root}`, `LAVISH_AXI_STATE_DIR=${root}`, `LAVISH_AXI_SERVER=${server}`,
    `LAVISH_AXI_PORT=${port}`, 'LAVISH_AXI_ALLOWED_HOSTS=127.0.0.1',
  ].join('\n') + '\n', { mode: 0o600 });
  unit = unit.replace('EnvironmentFile=/etc/lavish-axi.env', `EnvironmentFile=${envPath}`);
  if (process.argv.includes('--mutate-idle')) {
    unit = unit.replace('LAVISH_AXI_IDLE_TIMEOUT_MS=off', 'LAVISH_AXI_IDLE_TIMEOUT_MS=250');
  }
  if (process.argv.includes('--mutate-restart')) unit = unit.replace('Restart=always', 'Restart=no');
  await writeFile(unitPath, unit, { flag: 'wx' });
  installed = true;
  control('daemon-reload');
  control('start', name);
  await until(healthy, 'service failed to start');
  const initialPid = pid();
  const artifact = join(root, 'canary.html');
  await writeFile(artifact, '<!doctype html><title>Lifecycle canary</title><h1>Saved review survives</h1>');
  const opened = await fetch(`${origin}/api/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ file: artifact }),
  });
  assert.equal(opened.status, 200);
  const before = JSON.parse(await readFile(join(root, 'state.json'), 'utf8'));
  const session = Object.values(before.sessions)[0];
  assert.ok(session.key);
  const review = `${origin}/session/${session.key}`;
  assert.equal((await fetch(review)).status, 200);
  // No browser, poller, or keepalive connection during this interval.
  await delay(1600);
  assert.equal(pid(), initialPid, 'idle review server exited');
  assert.equal(await healthy(), true, 'idle review server disappeared');
  console.log('PASS idle: same process with no browser or poller');

  control('kill', '--kill-whom=main', '--signal=SIGTERM', name);
  await until(async () => pid() !== initialPid && await healthy(), 'service did not recover after exit');
  assert.equal((await fetch(review)).status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')), before);
  console.log('PASS recovery: new process, same review URL and exact saved state');

  control('restart', name);
  await until(healthy, 'service failed normal restart');
  assert.equal((await fetch(review)).status, 200);
  assert.deepEqual(JSON.parse(await readFile(join(root, 'state.json'), 'utf8')), before);
  console.log('PASS normal restart: same review URL and exact saved state');
} finally {
  if (installed) {
    control('stop', name);
    await rm(unitPath);
    control('daemon-reload');
  }
  await rm(root, { recursive: true, force: true });
}
