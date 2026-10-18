// Backlog drift, 18 Oct: the live captain home listed 22 crews under "In flight" that had written
// a native done line and gone idle, some for 5 days. Their plugin tasks were closed; nothing ran
// the native teardown that closes the backlog row. Finished crews are now retired by the plugin.
import assert from "node:assert/strict";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { createDeliveries } from "./lib/pr-delivery.ts";
import { createOwnerAsks } from "./lib/owner-asks.ts";
import { createOwnerTasks } from "./lib/owner-tasks.ts";

const ctx = { threadId: "thr_cap", projectId: "proj_1" };
const old = Math.floor(Date.now() / 1000) - 3 * 60 * 60;
const fresh = Math.floor(Date.now() / 1000) - 60;

function crewRow(id: string, threadId: string, extra: Record<string, unknown> = {}) {
  return { id, task: "x", title: id, projectId: "proj_1", threadId, parentThreadId: "thr_cap", nativeHome: "/native", worktree: true, shape: "scout", posture: "direct-PR", createdAt: "2026-10-13T00:00:00.000Z", providerId: null, model: null, reasoningLevel: null, ...extra };
}

async function captainHost(status: Record<string, string>, threadStatus: Record<string, string | string[]> = {}, backlog = "# Backlog\n## In flight\n", unsaved: Record<string, string> = {}, onCommand: (command: string) => void | Promise<void> = () => {}) {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: ["captain", "firstmate"], settings: { fmHome: "/native", fmHostId: "host_1" } });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await plugin(host.bb);
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.list", async () => []);
  // A list is read one entry per call; the last entry repeats.
  const reads = new Map<string, number>();
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => {
    const seen = threadStatus[threadId] ?? "idle";
    const n = reads.get(threadId) ?? 0;
    reads.set(threadId, n + 1);
    const status = Array.isArray(seen) ? seen[Math.min(n, seen.length - 1)]! : seen;
    return makeThreadResponse({ id: threadId, projectId: "proj_1", status, environmentId: `env_${threadId}` });
  });
  host.harness.sdk.stub("files.read", async ({ path }: { path: string }) => {
    if (path === "/native/data/backlog.md") return { content: backlog, sizeBytes: backlog.length };
    throw new Error("HTTP 404: Path does not exist");
  });
  host.harness.sdk.stub("threads.send", async () => ({ delivery: "queued" }));
  host.harness.sdk.stub("threads.output", async () => ({ output: "" }));
  host.harness.sdk.stub("threads.stop", async () => ({}));
  host.harness.sdk.stub("threads.archive", async () => ({}));
  host.harness.sdk.stub("environments.get", async ({ environmentId }: { environmentId: string }) => ({ id: environmentId, hostId: "host_1", status: "ready", isWorktree: true, path: `/wt/${environmentId.slice(4)}` }));
  // A clean worktree for the unlanded-work refusal (#160) that runs inside the retirement.
  host.harness.sdk.stub("environments.diffFiles", async () => ({ files: [] }));
  host.harness.sdk.stub("environments.list", async () => [{ id: "env_source", hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("projects.get", async () => ({ id: "proj_1", name: "Cyndra", kind: "repo" }));
  const commands: string[] = [];
  const byId = new Map<string, string>();
  let n = 0;
  host.harness.sdk.stub("terminals.create", async (args: { start: { command: string } }) => { const id = `term${++n}`; byId.set(id, args.start.command); commands.push(args.start.command); return { id }; });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => {
    const command = byId.get(terminalId) ?? "";
    await onCommand(command);
    const crew = /\/native\/state\/([\w-]+)\.status/.exec(command)?.[1];
    // The unsaved-work check names the worktree /wt/<thread id>.
    const checked = command.includes("FM_UNSAVED") ? /\/wt\/(thr_\w+)/.exec(command)?.[1] : undefined;
    // The inbox probe reports a record still waiting, so reconciliation re-sends the doorbell.
    const payload = command.includes("pending=any") ? "pending\n" : checked !== undefined ? `${unsaved[checked] ?? ""}FM_UNSAVED checked\n` : crew !== undefined && !command.includes("fm-teardown.sh") ? status[crew] ?? "" : "";
    const captured = command.includes("FM_HOST_CAPTURE_V1");
    const out = captured ? JSON.stringify({ protocol: "FM_HOST_CAPTURE_V1", exitCode: 0, stdout: payload, stderr: "" }) : payload;
    return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${out}\n__FM_HOST_RC:0\n`).toString("base64") }] };
  });
  return { host, commands };
}
const teardowns = (commands: string[]) => commands.filter((c) => c.includes("fm-teardown.sh")).map((c) => /"\$FM_BINDIR\/fm-teardown\.sh" '\\''([\w-]+)/.exec(c)?.[1] ?? c);
const crewIds = async (host: Awaited<ReturnType<typeof captainHost>>["host"]) => ((await host.bb.storage.kv.get("crews")) as Array<{ id: string }>).map((c) => c.id);

for (const verb of ["waiting", "note"]) {
  test(`checker164: newer ${verb} after done must keep the crew in retire-finished and schedule`, async () => {
    const status = `done [at=${old}]: v1 complete\n${verb} [at=${fresh}]: WAITING for external CI; follow-up still pending\n`;
    const { host, commands } = await captainHost({ wait1: status });
    try {
      await host.bb.storage.kv.set("crews", [crewRow("wait1", "thr_wait")]);
      const dry = await host.harness.behavior.runCli(["retire-finished", "--captain", "thr_cap"], ctx);
      await host.harness.behavior.runSchedule("finished-crew-retire");
      assert.deepEqual({ dry: /would-retire/.test(dry.stdout), teardowns: teardowns(commands), crews: await crewIds(host) },
        { dry: false, teardowns: [], crews: ["wait1"] });
    } finally { await host.harness.lifecycle.dispose(); }
  });
}

test("the sweep retires an idle crew that reported done hours ago and keeps every crew still needed", async () => {
  const { host, commands } = await captainHost({
    done1: `working [at=${old - 600}]: reading\ndone [at=${old}]: report ready at data/done1/report.md\n`,
    fresh1: `done [at=${fresh}]: report ready\n`,
    busy1: `done [at=${old}]: report ready\n`,
    again1: `done [at=${old}]: v1\nworking [at=${old + 60}]: follow-up from the captain\n`,
    pr1: `done [at=${old}]: PR https://github.com/Cyndra-AI/cyndra-saas/pull/2487\n`,
  }, { thr_busy: "running" });
  try {
    await host.bb.storage.kv.set("crews", [
      crewRow("done1", "thr_done"), crewRow("fresh1", "thr_fresh"), crewRow("busy1", "thr_busy"), crewRow("again1", "thr_again"),
      crewRow("pr1", "thr_pr", { shape: "ship", prUrl: "https://github.com/Cyndra-AI/cyndra-saas/pull/2487" }),
    ]);
    const store = createDeliveries(host.bb.storage.database());
    store.register({ url: "https://github.com/Cyndra-AI/cyndra-saas/pull/2487", taskId: "pr1", projectId: "proj_1", owner: "thr_cap", home: "/native", worker: "thr_pr", requirement: "pr" });

    const dry = await host.harness.behavior.runCli(["retire-finished", "--captain", "thr_cap"], ctx);
    assert.equal(dry.exitCode, 0, dry.stderr);
    assert.match(dry.stdout, /would-retire\s+done1: report ready at data\/done1\/report\.md/);
    assert.match(dry.stdout, /kept\s+fresh1: finished less than 2 hours ago/);
    assert.match(dry.stdout, /kept\s+busy1: thread is running/);
    assert.match(dry.stdout, /kept\s+again1: latest status is working/);
    assert.match(dry.stdout, /kept\s+pr1: an open PR delivery still needs it/);
    assert.match(dry.stdout, /Dry run: 1 finished crew\(s\) would be retired; 4 kept/);
    assert.deepEqual(teardowns(commands), [], "a dry run tears nothing down");
    assert.equal((await crewIds(host)).length, 5);

    await host.harness.behavior.runSchedule("finished-crew-retire");
    assert.deepEqual(teardowns(commands), ["done1"], "native teardown closes the backlog row");
    assert.deepEqual((await crewIds(host)).sort(), ["again1", "busy1", "fresh1", "pr1"]);
  } finally { await host.harness.lifecycle.dispose(); }
});

test("retire-finished refuses a thread that is not a known captain", async () => {
  const { host } = await captainHost({});
  try {
    const out = await host.harness.behavior.runCli(["retire-finished", "--captain", "thr_other"], ctx);
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /not a known captain/);
  } finally { await host.harness.lifecycle.dispose(); }
});

// Owner answer, 18 Oct: an unattended retirement only when Firstmate's records show no open card or
// question for that crew.
test("a finished crew with an open owner card on its task or an unanswered decision is kept", async () => {
  const done = `done [at=${old}]: plan ready\n`;
  const { host, commands } = await captainHost({ card1: done, ask1: done, gone1: done });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("card1", "thr_card"), crewRow("ask1", "thr_ask"), crewRow("gone1", "thr_gone")]);
    const tasks = createOwnerTasks(host.bb.storage.database());
    const task = tasks.open({ captain: "thr_cap", project: "Cyndra", title: "Reachloop plan", sourceRefs: ["tg:1:1"], crewId: "card1", at: Date.now() });
    createOwnerAsks(host.bb.storage.database()).create({ captain: "thr_cap", kind: "question", text: "Which plan?", options: [], createdAt: Date.now(), project: "Cyndra", task: task.id });
    await host.bb.storage.kv.set("decisions", [
      { id: "d1", parentThreadId: "thr_cap", question: "Ship v2?", crewId: "ask1", status: "deferred", createdAt: "2026-10-18T00:00:00.000Z" },
      { id: "d2", parentThreadId: "thr_cap", question: "Old?", crewId: "gone1", status: "answered", answer: "yes", createdAt: "2026-10-17T00:00:00.000Z" },
    ]);
    const dry = await host.harness.behavior.runCli(["retire-finished", "--captain", "thr_cap"], ctx);
    assert.match(dry.stdout, /kept\s+card1: an owner card or question for it is still open/);
    assert.match(dry.stdout, /kept\s+ask1: an owner card or question for it is still open/);
    assert.match(dry.stdout, /would-retire\s+gone1: plan ready/, "an answered decision does not hold the crew");
    await host.harness.behavior.runSchedule("finished-crew-retire");
    assert.deepEqual(teardowns(commands), ["gone1"]);
  } finally { await host.harness.lifecycle.dispose(); }
});

// Checker 156-verdict-1, finding 1: an open native captain-held question from the crew keeps it.
test("a finished crew with an open captain-held backlog question is kept", async () => {
  const done = `done [at=${old}]: report ready; owner call 58c2825e-debt-entry-choice is open\n`;
  const backlog = ["# Backlog", "## In flight", "- [ ] held1 - x (kind: scout)", "- [ ] free1 - y (kind: scout)", "## Queued",
    "- [ ] held1-choice - Pick one (kind: captain) (since 2026-10-13) (hold: fm-hold-v1:UmVw)", "  Captain hold origin: held1", ""].join("\n");
  const { host, commands } = await captainHost({ held1: done, free1: `done [at=${old}]: report ready\n` }, {}, backlog);
  try {
    await host.bb.storage.kv.set("crews", [crewRow("held1", "thr_held"), crewRow("free1", "thr_free")]);
    const dry = await host.harness.behavior.runCli(["retire-finished", "--captain", "thr_cap"], ctx);
    assert.match(dry.stdout, /kept\s+held1: an owner card or question for it is still open/);
    assert.match(dry.stdout, /would-retire\s+free1/);
    await host.harness.behavior.runSchedule("finished-crew-retire");
    assert.deepEqual(teardowns(commands), ["free1"]);
    assert.equal(commands.some((c) => c.includes("fm-captain-hold.sh")), false, "no --none attestation for the held crew");
  } finally { await host.harness.lifecycle.dispose(); }
});

test("an unreadable native backlog keeps every finished crew", async () => {
  const { host, commands } = await captainHost({ done1: `done [at=${old}]: report ready\n` });
  try {
    host.harness.sdk.stub("files.read", async () => { throw new Error("HTTP 500: host busy"); });
    await host.bb.storage.kv.set("crews", [crewRow("done1", "thr_done")]);
    await host.harness.behavior.runSchedule("finished-crew-retire");
    assert.deepEqual(teardowns(commands), []);
    const dry = await host.harness.behavior.runCli(["retire-finished", "--captain", "thr_cap"], ctx);
    assert.match(dry.stdout, /kept\s+done1: native backlog unreadable/);
  } finally { await host.harness.lifecycle.dispose(); }
});

// Checker 156-verdict-1, finding 2: the crew restarted after the first idle read.
test("a crew that restarts between the eligibility read and the retirement is kept", async () => {
  const { host, commands } = await captainHost({ back1: `done [at=${old}]: report ready\n` }, { thr_back: ["idle", "running"] });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("back1", "thr_back")]);
    await host.harness.behavior.runSchedule("finished-crew-retire");
    assert.deepEqual(teardowns(commands), []);
    assert.equal(host.harness.sdk.callsTo("threads.stop").length + host.harness.sdk.callsTo("threads.archive").length, 0);
    assert.deepEqual(await crewIds(host), ["back1"]);
  } finally { await host.harness.lifecycle.dispose(); }
});

// Forgotten-work audit, 18 Oct: retiring a crew deletes its worktree; crew 2803e0af had 34 commits
// only on this machine.
test("a finished crew with unsaved work in its worktree is kept and reported to the captain once", async () => {
  const done = `done [at=${old}]: PR3 committed on fm/w1-notify\n`;
  const { host, commands } = await captainHost({ w1: done, d1: done, ok1: done }, {}, undefined, {
    thr_w1: "FM_UNSAVED unpushed 34\n", thr_d1: "FM_UNSAVED uncommitted 2\nFM_UNSAVED stashed 1\n",
  });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("w1", "thr_w1", { shape: "ship" }), crewRow("d1", "thr_d1"), crewRow("ok1", "thr_ok1")]);
    const dry = await host.harness.behavior.runCli(["retire-finished", "--captain", "thr_cap"], ctx);
    assert.match(dry.stdout, /kept\s+w1: unsaved work in \/wt\/thr_w1: 34 commit\(s\) on no remote/);
    assert.match(dry.stdout, /kept\s+d1: unsaved work in \/wt\/thr_d1: 2 uncommitted file\(s\), 1 stash\(es\)/);
    assert.match(dry.stdout, /would-retire\s+ok1/);
    const told = () => host.harness.sdk.callsTo("threads.send").map((call) => JSON.stringify(call[0])).filter((m) => m.includes("It was not retired"));
    assert.equal(told().length, 0, "a dry run tells nobody");
    await host.harness.behavior.runSchedule("finished-crew-retire");
    await host.harness.behavior.runSchedule("finished-crew-retire");
    assert.deepEqual(teardowns(commands), ["ok1"]);
    assert.equal(told().length, 2, `one notice per crew, not per sweep: ${told().join("\n")}`);
    assert.match(told().join(" "), /crew w1 finished, but \/wt\/thr_w1 has 34 commit\(s\) on no remote\. It was not retired/);
    assert.deepEqual((await crewIds(host)).sort(), ["d1", "w1"]);
  } finally { await host.harness.lifecycle.dispose(); }
});

// Checker 156-verdict-2, finding 2: the crew started running while its final native status read was
// in flight. The thread status is read after the native one, so the run is seen.
test("a crew that starts running during the final status read is kept", async () => {
  const threadStatus: Record<string, string> = {};
  let statusReads = 0;
  const { host, commands } = await captainHost({ late1: `done [at=${old}]: report ready\n` }, threadStatus, undefined, {}, (command) => {
    if (/\/native\/state\/late1\.status/.test(command) && !command.includes("fm-teardown.sh") && ++statusReads === 2) threadStatus["thr_late"] = "running";
  });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("late1", "thr_late")]);
    await host.harness.behavior.runSchedule("finished-crew-retire");
    assert.equal(statusReads >= 2, true, "the final native read ran");
    assert.deepEqual(teardowns(commands), []);
    assert.deepEqual(await crewIds(host), ["late1"]);
  } finally { await host.harness.lifecycle.dispose(); }
});

// Checker 156-verdict-2, finding 2: a restart through Firstmate and the retirement share one per-crew
// lock, held through the teardown.
test("a tell that is restarting the crew holds the retirement until the run is visible", async () => {
  const threadStatus: Record<string, string> = {};
  const { host, commands } = await captainHost({ tell1: `done [at=${old}]: report ready\n` }, threadStatus);
  try {
    await host.bb.storage.kv.set("crews", [crewRow("tell1", "thr_tell")]);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    host.harness.sdk.stub("threads.send", async (input: { threadId: string }) => {
      if (input.threadId === "thr_tell") { await gate; threadStatus["thr_tell"] = "running"; }
      return { delivery: "sent" };
    });
    const tell = host.harness.inspection.registrations.agentTools.find((t) => t.name === "firstmate_tell")!;
    const telling = tell.execute({ crewId: "tell1", message: "one more change, please" }, ctx);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const sweep = host.harness.behavior.runSchedule("finished-crew-retire");
    await new Promise((resolve) => setTimeout(resolve, 50));
    release();
    await telling;
    await sweep;
    assert.deepEqual(teardowns(commands), []);
    assert.deepEqual(await crewIds(host), ["tell1"]);
  } finally { await host.harness.lifecycle.dispose(); }
});

// Checker 156-verdict-3 (156-check-3-evidence/audit-156-r3.test.ts): a decision answered through
// Firstmate while the crew's teardown runs must not start the crew. Repair-thread decision: the
// answer waits for the crew's lock, then refuses because retirement won.
test("a decision answer during the crew's teardown waits for its lock and is refused once the crew is retired", async () => {
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  let blocked = false;
  let sentDuringTeardown = false;
  const threadStatus: Record<string, string> = { thr_dec: "idle" };
  const { host, commands } = await captainHost({ dec1: `done [at=${old}]: report ready` }, threadStatus, undefined, {}, async (command) => {
    if (command.includes("fm-teardown.sh")) { blocked = true; enteredResolve(); await release; blocked = false; }
  });
  let sweep: Promise<unknown> | undefined;
  let answering: Promise<{ exitCode: number; stdout: string; stderr: string }> | undefined;
  try {
    await host.bb.storage.kv.set("crews", [crewRow("dec1", "thr_dec")]);
    host.harness.sdk.stub("threads.send", async ({ threadId }: { threadId: string }) => {
      if (threadId === "thr_dec" && blocked) { sentDuringTeardown = true; threadStatus["thr_dec"] = "running"; }
      return { delivery: "sent" };
    });
    sweep = host.harness.behavior.runSchedule("finished-crew-retire");
    await entered;
    // A crew question arrives after the eligibility reads, while the teardown holds the crew's lock.
    const asked = await host.harness.behavior.runCli(["decide", "ask", "Continue with plan B?", "--crew", "dec1", "--json"], ctx);
    assert.equal(asked.exitCode, 0, asked.stderr);
    const decision = JSON.parse(asked.stdout) as { id: string };
    answering = host.harness.behavior.runCli(["decide", "answer", decision.id, "--", "Use plan B"], ctx);
    await Promise.race([answering, new Promise((resolve) => setTimeout(resolve, 300))]);
    const bypassed = sentDuringTeardown;
    releaseResolve();
    await sweep;
    const out = await answering;
    assert.equal(bypassed, false, "the answer must not start work while the retirement holds the crew's lock");
    assert.deepEqual(teardowns(commands), ["dec1"]);
    assert.equal(out.exitCode, 1);
    assert.match(out.stderr, /crew dec1 was retired before this answer reached it\. Nothing was recorded or sent; decision \S+ stays open/);
    assert.equal(sentDuringTeardown, false);
    const decisions = (await host.bb.storage.kv.get("decisions")) as Array<{ id: string; status: string }>;
    assert.equal(decisions.find((row) => row.id === decision.id)?.status, "open");
  } finally {
    releaseResolve();
    await Promise.allSettled([sweep, answering].filter(Boolean));
    await host.harness.lifecycle.dispose();
  }
});

// Checker 156-verdict-4 (156-check-4-evidence/audit-156-r4.test.ts), finding 2: the landed-PR
// retirement holds the crew's lock through its teardown, so a Firstmate tell waits for it.
test("a landed-PR retirement holds the crew's lock through teardown, so a tell cannot start the crew meanwhile", async () => {
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  let inTeardown = false;
  let sentDuringTeardown = false;
  const states: Record<string, string> = { thr_land: "idle" };
  const { host } = await captainHost({ land1: `done [at=${old}]: PR work merged` }, states, undefined, {}, async (command) => {
    if (command.includes("fm-teardown.sh")) { inTeardown = true; enteredResolve(); await release; inTeardown = false; }
  });
  let landing: Promise<unknown> | undefined;
  let telling: Promise<unknown> | undefined;
  try {
    await host.harness.behavior.setSettings({ fmHome: "" });
    const url = "https://github.com/Cyndra-AI/cyndra-saas/pull/2487";
    await host.bb.storage.kv.set("crews", [crewRow("land1", "thr_land", { shape: "ship", prUrl: url })]);
    host.harness.sdk.stub("environments.pullRequest", async () => ({ outcome: "available", pullRequest: { url, number: 2487, title: "Merged work", state: "merged", checks: { state: "passing" }, mergeability: { mergeable: "MERGEABLE" } } }));
    host.harness.sdk.stub("threads.send", async ({ threadId }: { threadId: string }) => {
      if (threadId === "thr_land" && inTeardown) { sentDuringTeardown = true; states["thr_land"] = "running"; }
      return { delivery: "sent" };
    });
    landing = host.harness.behavior.runCli(["bearings"], ctx);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("landed teardown did not start")), 5000); })]); } finally { clearTimeout(timer); }
    telling = host.harness.behavior.runCli(["tell", "land1", "--", "Continue with one more change"], ctx);
    await Promise.race([telling, new Promise((resolve) => setTimeout(resolve, 300))]);
    const bypassed = sentDuringTeardown;
    releaseResolve();
    await telling;
    await landing;
    assert.equal(bypassed, false, "the landed-PR retirement holds the same lock as a Firstmate tell");
  } finally {
    releaseResolve();
    await Promise.allSettled([landing, telling].filter(Boolean));
    await host.harness.lifecycle.dispose();
  }
});

// Checker 156-verdict-4, finding 1: the inbox doorbell re-send took the delivery lock, then the
// crew's; a tell took them the other way round. Both now take the crew's lock first.
test("a tell and the inbox doorbell re-send take the crew's lock first, so neither waits on the other forever", async () => {
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  let tellEnteredResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  const tellEntered = new Promise<void>((resolve) => { tellEnteredResolve = resolve; });
  let armed = false;
  let service: { controller: AbortController; done: Promise<unknown> } | undefined;
  let telling: Promise<unknown> | undefined;
  const { host } = await captainHost({ dead1: `done [at=${old}]: report ready` }, {}, undefined, {}, async (command) => {
    if (command.includes("pending=any")) { enteredResolve(); await release; }
  });
  try {
    await host.harness.behavior.setSettings({ tellOwner: "real" });
    await host.bb.storage.kv.set("crews", [crewRow("dead1", "thr_dead")]);
    await host.bb.storage.kv.set("inbox-delivery:thr_dead", { threadId: "thr_dead", hostId: "host_1", home: "/native", crewId: "dead1", senderThreadId: "thr_cap", doorbell: "Firstmate instruction waiting: dead1", queueIds: [], records: ["001.msg"], retry: true });
    host.harness.sdk.stub("threads.queuedMessages.list", async ({ threadId }: { threadId: string }) => { if (armed && threadId === "thr_dead") tellEnteredResolve(); return []; });
    let doorbells = 0;
    host.harness.sdk.stub("threads.send", async () => { doorbells++; return { delivery: "sent" }; });
    service = host.harness.behavior.runService("captain-wake-release");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("inbox probe did not start")), 5000); })]); } finally { clearTimeout(timer); }
    armed = true;
    telling = host.harness.behavior.runCli(["tell", "dead1", "--", "One more change"], ctx);
    telling.catch(() => {});
    // The tell waits behind the re-send for the crew's lock; it never reaches the delivery lock first.
    const enteredEarly = await Promise.race([tellEntered.then(() => true), new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 500))]);
    assert.equal(enteredEarly, false, "the tell must not pass the crew's lock while the re-send holds it");
    releaseResolve();
    let settled = false;
    try { settled = await Promise.race([telling.then(() => true), new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), 2000); })]); } finally { clearTimeout(timer); }
    assert.equal(settled, true, "the tell settles once the re-send releases the crew's lock");
    assert.ok(doorbells >= 1, "the pending record caused a real doorbell re-send");
  } finally {
    releaseResolve();
    if (service) { service.controller.abort(); await service.done; }
    await host.harness.lifecycle.dispose();
  }
});

// Checker 156-verdict-5, finding 2 (156-check-5-evidence): raw native teardown of a known crew through
// firstmate_fm or bb firstmate fm skipped the crew's lock. It is refused and points to forget --stop.
test("raw native teardown of a known crew is refused by firstmate_fm and bb firstmate fm, even while a tell holds its lock", async () => {
  let enteredResolve!: () => void;
  let releaseResolve!: () => void;
  const entered = new Promise<void>((resolve) => { enteredResolve = resolve; });
  const release = new Promise<void>((resolve) => { releaseResolve = resolve; });
  let telling: Promise<unknown> | undefined;
  const { host, commands } = await captainHost({ raw1: `done [at=${old}]: report ready` });
  try {
    await host.bb.storage.kv.set("crews", [crewRow("raw1", "thr_raw")]);
    host.harness.sdk.stub("threads.send", async () => { enteredResolve(); await release; return { delivery: "sent" }; });
    telling = host.harness.behavior.runCli(["tell", "raw1", "--", "Continue work"], ctx);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([entered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("tell did not enter send")), 5000); })]); } finally { clearTimeout(timer); }
    const fm = host.harness.inspection.registrations.agentTools.find((t) => t.name === "firstmate_fm")!;
    const out = await fm.execute({ script: "teardown", args: ["raw1"] }, ctx);
    const text = typeof out === "string" ? out : JSON.stringify(out);
    assert.match(text, /Refusing: raw1 is a Firstmate crew\. Retire it with firstmate_forget crewId=raw1 stop=true/);
    const cli = await host.harness.behavior.runCli(["fm", "teardown", "raw1"], ctx);
    assert.equal(cli.exitCode, 1);
    assert.match(cli.stderr, /Refusing: raw1 is a Firstmate crew/);
    const before = commands.filter((c) => c.includes("fm-teardown.sh")).length;
    releaseResolve();
    await telling;
    assert.equal(before, 0, "no native teardown while the tell holds the crew's lock");
    assert.equal(commands.filter((c) => c.includes("fm-teardown.sh")).length, 0, "and none afterwards either");
  } finally {
    releaseResolve();
    await Promise.allSettled([telling].filter(Boolean));
    await host.harness.lifecycle.dispose();
  }
});


test("workstream report storage does not make a finished crew a native retirement candidate", async () => {
  const { host, commands } = await captainHost({ws1:`done [at=${old}]: report ready\n`});
  try {
    await host.bb.storage.kv.set("crews", [crewRow("ws1", "thr_ws", {workstreamId:"ws-audit",worktree:false,reportDir:"/native/data/ws1"})]);
    await host.harness.behavior.runCli(["retire-finished", "--captain", "thr_cap"], ctx);
    await host.harness.behavior.runSchedule("finished-crew-retire");
    assert.deepEqual(teardowns(commands), []);
    assert.deepEqual(await crewIds(host), ["ws1"]);
    assert.ok(!commands.some(c=>c.includes("/state/ws1")), "no native lifecycle files are read for the workstream crew");
  } finally { await host.harness.lifecycle.dispose(); }
});
