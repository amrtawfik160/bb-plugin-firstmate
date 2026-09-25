import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { readBbActivity } from "./bb-activity.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const adapter = process.env.FM_TEST_BB_ADAPTER ?? join(root, "overlay/bin/backends/bb.sh");

test("activity captures real tool progress and excludes watchdog/accounting churn", async () => {
  const host = createFakePluginHost({ pluginId: "activity-test" });
  let events = [{ seq: 3, type: "item/completed", createdAt: 100 }];
  host.harness.sdk.stub("threads.get", async () => makeThreadResponse({ id: "thr_test", status: "active" }));
  host.harness.sdk.stub("threads.output", async () => ({ output: "unchanged assistant text" }));
  host.harness.sdk.stub("threads.interactions.list", async () => [{ status: "pending" }, { status: "resolved" }]);
  host.harness.sdk.stub("threads.events.list", async (args: { order: string; limit: string; types: string[] }) => {
    assert.equal(args.order, "desc"); assert.equal(args.limit, "1");
    return events.filter(event => args.types.includes(event.type)).slice(-1);
  });
  try {
    const first = await readBbActivity(host.bb.sdk, "thr_test");
    assert.equal(first.activity?.seq, 3);
    assert.equal(first.interactionCount, 1);
    events.push({ seq: 4, type: "system/provider-turn-watchdog", createdAt: 200 });
    events.push({ seq: 5, type: "thread/tokenUsage/updated", createdAt: 300 });
    assert.deepEqual(await readBbActivity(host.bb.sdk, "thr_test"), first);
    for (const type of ["item/started", "item/commandExecution/outputDelta", "item/toolCall/progress", "item/reasoning/textDelta"]) {
      events.push({ seq: events.length + 6, type, createdAt: 400 });
      const next = await readBbActivity(host.bb.sdk, "thr_test");
      assert.equal(next.activity?.type, type);
      assert.equal(next.output, first.output);
    }
    host.harness.sdk.stub("threads.events.list", async () => { throw new Error("unavailable"); });
    await assert.rejects(readBbActivity(host.bb.sdk, "thr_test"), /unavailable/);
  } finally { await host.harness.lifecycle.dispose(); }
});

function fixture(body: (run: (code: string) => ReturnType<typeof spawnSync>, files: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), "fm-activity-test-"));
  const bin = join(dir, "bin"); mkdirSync(bin);
  const snapshot = { version: 1, threadId: "thr_test", status: "active", output: "assistant unchanged", activity: { seq: 8, type: "item/completed", createdAt: 100 } };
  writeFileSync(join(dir, "activity"), JSON.stringify(snapshot));
  writeFileSync(join(dir, "show"), JSON.stringify({ thread: { status: "active", queuedMessageCount: 3 } }));
  writeFileSync(join(dir, "receipt"), JSON.stringify({ ok: true, delivery: "sent" }));
  writeFileSync(join(dir, "queue"), "[]");
  writeFileSync(join(bin, "bb"), `#!/usr/bin/env python3
import json, os, sys
from pathlib import Path
base = Path(os.environ["TEST_FILES"])
args = sys.argv[1:]
with (base / "calls").open("a") as f: f.write(json.dumps(args) + "\\n")
if args[:2] == ["firstmate", "activity"]:
    if (base / "fail-activity").exists(): sys.exit(1)
    print((base / "activity").read_text())
elif args[:2] == ["thread", "show"]: print((base / "show").read_text())
elif args[:3] == ["thread", "queue", "list"]: print((base / "queue").read_text())
elif args[:2] == ["thread", "tell"]: print((base / "receipt").read_text())
elif args[:2] == ["thread", "output"]: print(json.dumps({"output":"assistant unchanged"}))
else: sys.exit(1)
`, { mode: 0o755 });
  const run = (code: string) => spawnSync("bash", ["-c", 'export PATH="$TEST_FILES/bin:$PATH"; . "$ADAPTER" 2>/dev/null; ' + code], {
    encoding: "utf8", env: { ...process.env, ADAPTER: adapter, TEST_FILES: dir, FM_STATE_OVERRIDE: join(dir, "state"), PATH: `${bin}:${process.env.PATH}` },
  });
  try { body(run, dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("native capture changes for tool work, stays identical on repeated polls, and fails loudly if unavailable", () => fixture((run, dir) => {
  const capture = () => run("fm_backend_bb_capture thr_test 2");
  const first = capture(); assert.equal(first.status, 0, String(first.stderr));
  assert.match(String(first.stdout), /BB activity: 8 100 item\/completed/);
  assert.equal(capture().stdout, first.stdout);
  const snapshot = JSON.parse(readFileSync(join(dir, "activity"), "utf8"));
  snapshot.activity.seq = 9; snapshot.activity.type = "item/commandExecution/outputDelta";
  writeFileSync(join(dir, "activity"), JSON.stringify(snapshot));
  assert.notEqual(capture().stdout, first.stdout);
  assert.equal(String(capture().stdout).trim().split("\n").length, 2);
  writeFileSync(join(dir, "fail-activity"), "yes");
  const failure = capture(); assert.notEqual(failure.status, 0); assert.match(String(failure.stderr), /activity capture failed/);
  assert.doesNotMatch(readFileSync(join(dir, "calls"), "utf8"), /"output"/);
}));

test("a running, queued, or interaction-blocked BB thread has no terminal draft", () => fixture((run, dir) => {
  for (const status of ["active", "pending", "starting", "idle", "error"]) {
    writeFileSync(join(dir, "show"), JSON.stringify({ thread: { status, queuedMessageCount: 4 } }));
    assert.equal(run("fm_backend_bb_composer_state thr_test").stdout, "empty");
  }
  writeFileSync(join(dir, "show"), "{}");
  assert.equal(run("fm_backend_bb_composer_state thr_test").stdout, "unknown");
}));

test("native submit distinguishes accepted delivery from queued interaction and malformed receipts", () => fixture((run, dir) => {
  const send = () => run('fm_backend_bb_send_text_submit thr_test "course correction"');
  assert.equal(send().stdout, "empty");
  writeFileSync(join(dir, "receipt"), JSON.stringify({ ok: true, delivery: "queued", queuedMessage: { id: "q1", waitingOn: { kind: "interaction" } } }));
  const queued = send(); assert.equal(queued.stdout, "pending"); assert.match(String(queued.stderr), /accepted queued steer q1.*interaction.*do not resend/);
  writeFileSync(join(dir, "receipt"), JSON.stringify({ ok: true }));
  const unknown = send(); assert.equal(unknown.stdout, "send-failed"); assert.match(String(unknown.stderr), /missing accepted delivery receipt/);
}));

test("re-ringing a native inbox held by an interaction reuses the accepted queue row", () => fixture((run, dir) => {
  const text = ": Firstmate instruction waiting: list '/tmp/inbox'/*.msg";
  writeFileSync(join(dir, "queue"), JSON.stringify([{ id: "q1", content: [{ type: "text", text }], waitingOn: { kind: "interaction" } }]));
  writeFileSync(join(dir, "message"), text);
  const result = run('fm_backend_bb_send_text_submit thr_test "$(cat "$TEST_FILES/message")"');
  assert.equal(result.stdout, "pending");
  assert.doesNotMatch(readFileSync(join(dir, "calls"), "utf8"), /"tell"/);
}));


test("open interaction, unavailable host, and a queued turn are not active execution", () => fixture((run, dir) => {
  const snapshot = JSON.parse(readFileSync(join(dir, "activity"), "utf8"));
  const busy = () => run("fm_backend_bb_busy_state thr_test").stdout;
  assert.equal(busy(), "busy");
  snapshot.interactionCount = 1;
  writeFileSync(join(dir, "activity"), JSON.stringify(snapshot));
  assert.equal(busy(), "idle");
  snapshot.interactionCount = 0; snapshot.runtimeStatus = "host-reconnecting";
  writeFileSync(join(dir, "activity"), JSON.stringify(snapshot));
  assert.equal(busy(), "unknown");
  snapshot.runtimeStatus = "pending"; snapshot.status = "pending"; snapshot.queuedMessageCount = 1;
  writeFileSync(join(dir, "activity"), JSON.stringify(snapshot));
  assert.equal(busy(), "unknown");
}));


test("native busy-turn progress uses recorded event time and never the read clock", () => fixture((run, dir) => {
  const state = join(dir, "state"); mkdirSync(state);
  writeFileSync(join(state, "owned.meta"), "backend=bb\nwindow=bb:thr_test\nbb_thread_id=thr_test\n");
  writeFileSync(join(state, "foreign.meta"), "backend=bb\nwindow=bb:thr_else\nbb_thread_id=thr_else\n");
  const capture = () => run("fm_backend_bb_capture thr_test 2");
  assert.equal(capture().status, 0);
  const progress = join(state, "owned.progress");
  assert.equal(statSync(progress).mtimeMs, 100);
  const inode = statSync(progress).ino;
  assert.equal(capture().status, 0);
  assert.equal(statSync(progress).ino, inode, "unchanged event must not rewrite progress");
  assert.equal(statSync(progress).mtimeMs, 100, "old event must not look fresh on first read");
  assert.throws(() => statSync(join(state, "foreign.progress")), /ENOENT/);
  const snapshot = JSON.parse(readFileSync(join(dir, "activity"), "utf8"));
  snapshot.activity.seq = 10; snapshot.activity.createdAt = 200;
  writeFileSync(join(dir, "activity"), JSON.stringify(snapshot));
  assert.equal(capture().status, 0);
  assert.equal(statSync(progress).mtimeMs, 200);
  snapshot.activity.seq = 8; snapshot.activity.createdAt = 100;
  writeFileSync(join(dir, "activity"), JSON.stringify(snapshot));
  assert.equal(capture().status, 0);
  assert.equal(statSync(progress).mtimeMs, 200, "late older snapshots must not regress progress");
}));
