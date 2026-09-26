#!/usr/bin/env node
// Live acceptance: actual server.ts, native inbox scripts, BB host terminals and
// BB queued messages. Uses the caller's ACTIVE thread; no agent is spawned.
// Installs a temporary plugin with isolated settings/storage. Only its delivery
// cleanup service and renamed CLI are registered; other fleet surfaces stay off.
// Usage (inside an active BB thread): node scripts/live-inbox-delivery-check.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "fm-inbox-live-"));
const home = join(scratch, "home");
const proof = join(scratch, "plugin");
const pluginId = `fm-inbox-proof-${process.pid}`;
let installed = false;
let threadId;
let before = new Set();
function command(args) {
  const r = spawnSync("bb", args, { encoding: "utf8", timeout: 120_000, maxBuffer: 8 << 20 });
  assert.equal(r.status, 0, `bb ${args.slice(0, 3).join(" ")}: ${r.stderr || r.stdout}`);
  return r.stdout;
}
const json = (...args) => JSON.parse(command(args));
const delay = ms => new Promise(r => setTimeout(r, ms));
const queue = () => json("thread", "queue", "list", threadId, "--json");
try {
  const context = json("status", "--json");
  threadId = context.thread?.id;
  const projectId = context.project?.id;
  const hostId = context.thread?.environment?.hostId;
  assert.ok(threadId && projectId && hostId, "Run inside a BB project thread");
  assert.equal(context.thread.status, "active", "Proof requires an active caller so notifications cannot start a turn");
  before = new Set(queue().map(row => row.id));
  mkdirSync(join(home, "state"), { recursive: true });
  symlinkSync(join(process.env.FM_TEST_HOME ?? "/root/firstmate", "bin"), join(home, "bin"));
  mkdirSync(proof);
  symlinkSync(join(root, "node_modules"), join(proof, "node_modules"));
  const crew = { id: "proof", task: "isolated inbox transport proof", projectId, threadId,
    parentThreadId: threadId, providerId: null, worktree: false, shape: "scout", posture: "local-only",
    nativeHome: home, createdAt: new Date().toISOString() };
  writeFileSync(join(proof, "package.json"), JSON.stringify({ name: pluginId, version: "0.0.1", type: "module",
    bb: { name: "Temporary inbox delivery proof", description: "Isolated Firstmate transport acceptance", branding: { icon: "Ship" }, server: "./server.ts" },
    devDependencies: { "@get-bb/plugin-sdk": "0.4.104" } }));
  writeFileSync(join(proof, "server.ts"), `import plugin from ${JSON.stringify(join(root, "server.ts"))};
export default async function(bb) {
  await bb.storage.kv.set("crews", [${JSON.stringify(crew)}]);
  const adapter = new Proxy(bb, { get(target, key) {
    if (key === "agents") return {registerTool() {}, configure() {}};
    if (key === "events") return {on() {}};
    if (key === "experimental_hooks") return {on() {}};
    if (key === "background") return {service(name, impl) {
      if (name === "captain-wake-release") bb.background.service(name, impl);
    }};
    if (key === "cli") return {register(spec) {bb.cli.register({...spec, name:${JSON.stringify(pluginId)}});}};
    return Reflect.get(target, key);
  }});
  await plugin(adapter);
}`);
  command(["plugin", "build", proof]);
  command(["plugin", "install", proof, "--yes", "--json"]); installed = true;
  for (const [key, value] of Object.entries({ fmHome: home, fmHostId: hostId, tellOwner: "real" })) {
    command(["plugin", "config", pluginId, "set", key, value, "--json"]);
  }
  for (const body of ["First proof instruction", "Second proof instruction"]) {
    const result = command([pluginId, "tell", "proof", "--queue", `--message=${body}`]);
    assert.match(result, /Queued for crew proof/);
  }
  const rows = queue().filter(row => !before.has(row.id));
  assert.equal(rows.length, 1, "two native records must produce one BB queued notification");
  const text = rows[0].content[0].text;
  assert.match(text, /Firstmate instruction waiting/);
  assert.doesNotMatch(text, /First proof instruction|Second proof instruction/);
  const inbox = join(home, "state/proof.inbox");
  assert.match(readFileSync(join(inbox, "001.msg"), "utf8"), /First proof instruction/);
  assert.match(readFileSync(join(inbox, "002.msg"), "utf8"), /Second proof instruction/);
  console.log("PASS actual native writer + BB terminal transport preserve two records, queue one pointer");
  // Act as the receiving worker: read each native body, then acknowledge it.
  mkdirSync(join(inbox, "handled"), { recursive: true });
  for (const name of ["001.msg", "002.msg"]) renameSync(join(inbox, name), join(inbox, "handled", name));
  command(["plugin", "reload", pluginId, "--json"]);
  for (let n = 0; n < 35 && queue().some(row => row.id === rows[0].id); n++) await delay(1000);
  const finalRows = queue();
  assert.ok(!finalRows.some(row => row.id === rows[0].id), "acknowledged pointer survived reload/reconciliation");
  for (const id of before) assert.ok(finalRows.some(row => row.id === id), "an unrelated queue row was removed");
  console.log("PASS actual plugin service removes acknowledged BB pointer after reload, preserves existing queue");
} finally {
  // Never leave proof input for the caller's next turn. Delete only this scratch pointer.
  if (threadId) for (const row of queue()) {
    if (!before.has(row.id) && row.content.length === 1 && row.content[0].type === "text"
      && row.content[0].text.includes(`${home}/state/proof.inbox`)) {
      command(["thread", "queue", "delete", threadId, row.id, "--json"]);
    }
  }
  if (installed) command(["plugin", "remove", pluginId, "--json"]);
  rmSync(scratch, { recursive: true, force: true });
}
