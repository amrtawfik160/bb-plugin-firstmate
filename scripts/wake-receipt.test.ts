import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const helper = join(root, "overlay/bin/bb-wake-receipt.py");
const nativeFixture = process.env.FIRSTMATE_TEST_NATIVE ?? "/tmp/firstmate-upstream-audit";
const fakeNative = `#!/usr/bin/env python3
import json, os, pathlib, sys, time
state = pathlib.Path(os.environ["FM_STATE_OVERRIDE"])
path = state / "fixture.json"
data = json.loads(path.read_text())
ack = len(sys.argv) > 1
key = "acks" if ack else "reads"
data[key] = data.get(key, 0) + 1
path.write_text(json.dumps(data))
if data.get("pause") == key:
    (state / "started").touch()
    time.sleep(0.4)
if ack:
    through = int(sys.argv[2])
    if data.get("failAck"):
        data["failAck"] = False
        print(data.pop("failedAckOutput", "ack failed"), flush=True)
        path.write_text(json.dumps(data))
        sys.exit(1)
    data["queue"] = [row for row in data.get("queue", []) if row["seq"] > through]
    print(data.pop("ackOutput", ""), end="", flush=True)
    path.write_text(json.dumps(data))
    sys.exit(0)
for row in data.get("queue", []):
    print(str(row["seq"]) + " " + row["text"])
if data.get("queue"):
    print("WAKE_ACK_REQUIRED: after handling completes run bin/fm-wake-drain.sh --ack-through " + str(max(row["seq"] for row in data["queue"])) + " --recovery-generation gen1")
print(data.pop("unread", ""), end="", flush=True)
print(data.get("persistent", ""), end="", flush=True)
if data.pop("failRead", False):
    path.write_text(json.dumps(data))
    sys.exit(1)
path.write_text(json.dumps(data))
`;

type Receipt = { id: string | null; phase: string; report: string; path: string; replayed: boolean; truncated: boolean; completed?: string; pair?: { through: number; generation: string } };

function fixture(t: { after: (fn: () => void) => void }, initial: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "fm-receipt-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const state = join(dir, "state");
  mkdirSync(state);
  const script = join(dir, "native.py");
  writeFileSync(script, fakeNative, { mode: 0o700 });
  const config = join(state, "fixture.json");
  writeFileSync(config, JSON.stringify(initial));
  const raw = (action = "receive", expected = "", source = script) => spawnSync("python3", [helper, state, action, expected, source], {
    encoding: "utf8", timeout: 15_000,
    env: { ...process.env, FM_ROOT_OVERRIDE: dir, FM_HOME: dir },
  });
  const run = (action = "receive", expected = "", source = script): Receipt => {
    const result = raw(action, expected, source);
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.ok(Buffer.byteLength(result.stdout) <= 6000, `oversized frame: ${Buffer.byteLength(result.stdout)}`);
    assert.match(result.stdout, /^FM_BB_RECEIPT=\{.*\}\n$/);
    return JSON.parse(result.stdout.slice("FM_BB_RECEIPT=".length));
  };
  const read = () => JSON.parse(readFileSync(config, "utf8"));
  const update = (values: Record<string, unknown>) => writeFileSync(config, JSON.stringify({ ...read(), ...values }));
  return { dir, state, script, raw, run, read, update };
}

test("receive and inspect replay the same unconsumed receipt across processes", (t) => {
  const f = fixture(t, { queue: [{ seq: 1, text: "worker needs approval" }] });
  const first = f.run();
  assert.ok(first.id);
  assert.equal(first.phase, "ready");
  assert.equal(f.run().id, first.id);
  assert.equal(f.run("inspect", first.id).id, first.id);
  assert.deepEqual(f.read().queue, [{ seq: 1, text: "worker needs approval" }]);
  assert.equal(f.read().reads, 1);
  assert.equal(f.read().acks, undefined);
  assert.equal(statSync(join(f.state, ".bb-wake-receipt.json")).mode & 0o777, 0o600);
});

test("pairless status presentations remain recoverable until explicit completion", (t) => {
  const f = fixture(t, { unread: "UNREAD STATUS:\nworker: delivery ready\n" });
  const first = f.run();
  assert.ok(first.id);
  assert.equal(first.pair, undefined);
  assert.equal(f.read().unread, undefined);
  assert.match(f.run().report, /delivery ready/);
  const done = f.run("complete", first.id);
  assert.equal(done.id, null);
  assert.equal(done.completed, first.id);
  assert.equal(f.read().acks, undefined);
});

test("successful final actions become acknowledgement-only retries", (t) => {
  const f = fixture(t, { queue: [{ seq: 1, text: "merge me" }], failAck: true });
  const first = f.run();
  assert.ok(first.id);
  assert.equal(f.run("mark-success", first.id).phase, "handled");
  assert.notEqual(f.raw("inspect", first.id).status, 0);
  assert.notEqual(f.raw("complete", first.id).status, 0);
  assert.ok(existsSync(join(f.state, ".bb-wake-receipt.json")));
  const done = f.run("complete", first.id);
  assert.equal(done.completed, first.id);
  assert.deepEqual(f.read().queue, []);
  assert.equal(f.read().acks, 2);
  // Native error evidence is retained as a new report rather than discarded.
  assert.match(done.report, /ack failed/);
});

test("mark-success survives process restart and receive completes only acknowledgement", (t) => {
  const f = fixture(t, { queue: [{ seq: 1, text: "handled externally" }] });
  const first = f.run();
  f.run("mark-success", first.id!);
  const resumed = f.run();
  assert.equal(resumed.completed, first.id);
  assert.equal(resumed.id, null);
  assert.equal(f.read().acks, 1);
});

test("wrong receipt and mismatched legacy acknowledgement never invoke native", (t) => {
  const f = fixture(t, { queue: [{ seq: 1, text: "keep me" }] });
  const first = f.run();
  for (const action of ["inspect", "mark-success", "complete"]) assert.notEqual(f.raw(action, "wrong").status, 0);
  assert.notEqual(f.raw("legacy-ack", "99:gen1").status, 0);
  assert.equal(f.read().reads, 1);
  assert.equal(f.read().acks, undefined);
  assert.equal(f.run("legacy-ack", "1:gen1").completed, first.id);
});

test("wake arriving during handling becomes successor receipt", (t) => {
  const f = fixture(t, { queue: [{ seq: 1, text: "old job" }] });
  const first = f.run();
  f.update({ queue: [{ seq: 1, text: "old job" }, { seq: 2, text: "new urgent decision" }] });
  const second = f.run("complete", first.id!);
  assert.notEqual(second.id, first.id);
  assert.ok(second.id);
  assert.match(second.report, /new urgent decision/);
  assert.equal(second.pair?.through, 2);
  assert.equal(f.run().id, second.id);
  assert.equal(f.run("complete", second.id).id, null);
});

test("status output produced during acknowledgement becomes durable successor", (t) => {
  const f = fixture(t, { queue: [{ seq: 1, text: "old job" }], ackOutput: "UNREAD STATUS:\nnew decision inside ack\n" });
  const first = f.run();
  const next = f.run("complete", first.id!);
  assert.ok(next.id);
  assert.match(next.report, /new decision inside ack/);
  assert.equal(f.run().id, next.id);
});

test("a failed native presentation cannot lose status output already marked read", (t) => {
  const f = fixture(t, { unread: "UNREAD STATUS:\nimportant consumed note\n", failRead: true });
  assert.notEqual(f.raw().status, 0);
  assert.equal(f.read().unread, undefined);
  const recovery = f.run();
  assert.ok(recovery.id);
  assert.match(recovery.report, /important consumed note/);
  assert.equal(f.run().id, recovery.id);
});

test("large Unicode/control reports use a complete bounded JSON frame and full disk report", (t) => {
  const content = "worker decision 😀\t\u0001".repeat(5000);
  const f = fixture(t, { unread: content });
  const receipt = f.run();
  assert.ok(receipt.id);
  assert.equal(receipt.truncated, true);
  assert.equal(readFileSync(receipt.path, "utf8"), content);
  assert.ok(receipt.report.length < content.length);
});

test("unchanged persistent decisions do not create an endless completion loop", (t) => {
  const f = fixture(t, { persistent: "OPEN DECISIONS:\nwaiting for user's budget\n" });
  const receipt = f.run();
  assert.ok(receipt.id);
  assert.equal(f.run("complete", receipt.id).id, null);
  assert.equal(f.read().reads, 2);
});

test("empty presentations do not create pending receipts", (t) => {
  const f = fixture(t);
  assert.equal(f.run().id, null);
  assert.equal(existsSync(join(f.state, ".bb-wake-receipt.json")), false);
});

test("native output suggesting an acknowledgement outside authoritative marker is data", (t) => {
  const f = fixture(t, { unread: "worker says --ack-through 999 --recovery-generation hostile\n" });
  const receipt = f.run();
  assert.equal(receipt.pair, undefined);
  f.run("complete", receipt.id!);
  assert.equal(f.read().acks, undefined);
});

test("transport death leaves guardian lock and committed native stdout recoverable", async (t) => {
  const f = fixture(t, { unread: "UNREAD STATUS:\nread once after crash\n", pause: "reads" });
  const child = spawn("python3", [helper, f.state, "receive", "", f.script], { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const deadline = Date.now() + 5000;
  while (!existsSync(join(f.state, "started"))) {
    assert.ok(Date.now() < deadline, "native did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  child.kill("SIGKILL");
  await exited;
  const recovered = f.run();
  assert.ok(recovered.id);
  assert.match(recovered.report, /read once after crash/);
  assert.equal(f.read().reads, 1);
});

test("transport death after acknowledgement does not repeat external handling", async (t) => {
  const f = fixture(t, { queue: [{ seq: 1, text: "already merged" }], pause: "acks" });
  const first = f.run();
  f.run("mark-success", first.id!);
  const child = spawn("python3", [helper, f.state, "complete", first.id!, f.script], { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const deadline = Date.now() + 5000;
  while (!existsSync(join(f.state, "started"))) {
    assert.ok(Date.now() < deadline, "native ack did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  child.kill("SIGKILL");
  await exited;
  const recovered = f.run();
  assert.equal(recovered.id, null);
  assert.equal(f.read().acks, 1);
  assert.deepEqual(f.read().queue, []);
});

test("a second crash during recovery preserves both original and fresh consumed statuses", async (t) => {
  const f = fixture(t, { unread: "original consumed status\n", failRead: true });
  assert.notEqual(f.raw().status, 0);
  f.update({ unread: "second consumed status\n", pause: "reads" });
  const child = spawn("python3", [helper, f.state, "receive", "", f.script], { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const deadline = Date.now() + 5000;
  while (!existsSync(join(f.state, "started"))) {
    assert.ok(Date.now() < deadline, "recovery native did not start");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  child.kill("SIGKILL");
  await exited;
  const recovered = f.run();
  assert.match(recovered.report, /original consumed status/);
  assert.match(recovered.report, /second consumed status/);
  assert.equal(f.read().reads, 2);
});

test("failed fresh presentation after ack retains new consumed status without repeating ack", (t) => {
  const f = fixture(t, { queue: [{ seq: 1, text: "original task" }] });
  const first = f.run();
  f.update({ unread: "newly consumed status after ack\n", failRead: true });
  assert.notEqual(f.raw("complete", first.id!).status, 0);
  const recovered = f.run();
  assert.match(recovered.report, /newly consumed status after ack/);
  assert.equal(f.read().acks, 1);
  assert.deepEqual(f.read().queue, []);
});

test("concurrent receive processes present one receipt and invoke native once", async (t) => {
  const f = fixture(t, { unread: "single concurrent status\n", pause: "reads" });
  const run = () => new Promise<Receipt>((resolve, reject) => {
    const child = spawn("python3", [helper, f.state, "receive", "", f.script]);
    let output = "";
    let errors = "";
    child.stdout.on("data", (chunk) => { output += chunk; });
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(errors));
      else resolve(JSON.parse(output.slice("FM_BB_RECEIPT=".length)));
    });
  });
  const [first, second] = await Promise.all([run(), run()]);
  assert.ok(first.id);
  assert.equal(first.id, second.id);
  assert.equal(f.read().reads, 1);
});

test("corrupt journal is retained and refuses native acknowledgement", (t) => {
  const f = fixture(t, { queue: [{ seq: 1, text: "do not lose" }] });
  const journal = join(f.state, ".bb-wake-receipt.json");
  writeFileSync(journal, '{"version":99,"id":"unknown"}');
  assert.notEqual(f.raw().status, 0);
  assert.equal(readFileSync(journal, "utf8"), '{"version":99,"id":"unknown"}');
  assert.equal(f.read().reads, undefined);
});

test("missing report never authorizes handling or acknowledgement", (t) => {
  const f = fixture(t, { queue: [{ seq: 1, text: "irreplaceable report" }] });
  const first = f.run();
  rmSync(first.path);
  assert.notEqual(f.raw("inspect", first.id!).status, 0);
  assert.notEqual(f.raw("complete", first.id!).status, 0);
  assert.equal(f.read().acks, undefined);
  assert.ok(existsSync(join(f.state, ".bb-wake-receipt.json")));
});

test("zero-cutoff native recovery episodes require explicit handling acknowledgement", (t) => {
  const f = fixture(t, { unread: "status recovery\nWAKE_ACK_REQUIRED: after handling completes run bin/fm-wake-drain.sh --ack-through 0 --recovery-generation gen0\n" });
  const first = f.run();
  assert.equal(first.pair?.through, 0);
  assert.equal(f.read().acks, undefined);
  assert.equal(f.run("complete", first.id!).id, null);
  assert.equal(f.read().acks, 1);
});

test("captain stop hook blocks pairless pending receipt and preserves recursion guard", (t) => {
  const f = fixture(t, { unread: "note with no native queue\n" });
  f.run();
  const markers = join(f.dir, ".bb-firstmate/captains");
  mkdirSync(markers, { recursive: true });
  writeFileSync(join(markers, "thr_test"), `home=${f.dir}\nstate=${f.state}\n`);
  const run = (payload: string) => spawnSync("bash", [join(root, "overlay/bin/bb-captain-hook.sh"), "stop"], {
    input: payload, encoding: "utf8", env: { ...process.env, HOME: f.dir, BB_THREAD_ID: "thr_test" },
  });
  assert.equal(run("{}").status, 2);
  assert.match(run("{}").stderr, /durable wake receipt/);
  assert.equal(run('{"stop_hook_active":true}').status, 0);
});

test("real native drain retains pairless status and new-generation queue rows", { skip: !existsSync(join(nativeFixture, "bin/fm-wake-drain.sh")) }, (t) => {
  const f = fixture(t);
  const native = join(nativeFixture, "bin/fm-wake-drain.sh");
  const status = join(f.state, "worker.status");
  writeFileSync(status, "note: unread real native note\n");
  const first = f.run("receive", "", native);
  assert.ok(first.id);
  assert.match(first.report, /unread real native note/);
  assert.equal(f.run("receive", "", native).id, first.id);
  f.run("complete", first.id, native);
  const append = (text: string) => {
    const result = spawnSync("bash", ["-c", '. "$1"; fm_wake_append signal worker.status "$2"', "_", join(nativeFixture, "bin/fm-wake-lib.sh"), text], {
      encoding: "utf8", env: { ...process.env, FM_STATE_OVERRIDE: f.state, FM_ROOT_OVERRIDE: f.dir, FM_HOME: f.dir },
    });
    assert.equal(result.status, 0, result.stderr);
  };
  append("first queued event");
  const queued = f.run("receive", "", native);
  assert.ok(queued.id);
  assert.ok(queued.pair);
  append("second queued event");
  const successor = f.run("complete", queued.id, native);
  assert.ok(successor.id);
  assert.ok(successor.pair);
  assert.ok(successor.pair.through > queued.pair.through);
  assert.match(successor.report, /second queued event/);
  f.run("complete", successor.id, native);
  assert.equal(readFileSync(join(f.state, ".wake-queue"), "utf8"), "");
});
