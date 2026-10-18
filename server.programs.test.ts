import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createFakePluginHost, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import plugin from "./server.ts";
import { manifestSkillIds } from "./scripts/plugin-skill-fixture.mjs";
import { createOwnerTasks } from "./lib/owner-tasks.ts";
import { createDeliveries } from "./lib/pr-delivery.ts";
import { createPrograms } from "./lib/programs.ts";

type Host = ReturnType<typeof createFakePluginHost>;

// The real case: epic Cyndra-AI/cyndra-saas#2422 on 15 Oct, when only #2423 was closed.
const epic = JSON.parse(readFileSync(new URL("./test/fixtures/dmpro-epic-2422.json", import.meta.url), "utf8")) as {
  epic: { number: number; title: string };
  subIssues: { number: number; title: string; state: string; blockedBy: number[] }[];
};
const EPIC_URL = "https://github.com/Cyndra-AI/cyndra-saas/issues/2422";
const capCtx = { threadId: "thr_cap", projectId: "proj_1" } as never;

type SubIssue = { number: number; title: string; state: string; blockedBy: number[] };

/** Host commands answered like a host with gh: the epic and its sub-issues a page of 100 at a time
 * like the GitHub API, and the state of each ticket a query names. */
function github(host: Host, closed: () => number[] = () => [], options: { subIssues?: SubIssue[]; fail?: () => boolean; missing?: number[] } = {}) {
  const subIssues = options.subIssues ?? epic.subIssues;
  const commands: string[] = [];
  const terminals = new Map<string, string>();
  let n = 0;
  const page = (command: string, items: string[]) => {
    const at = Number(command.match(/[?&]page=(\d+)/)?.[1] ?? 1);
    return items.slice((at - 1) * 100, at * 100);
  };
  host.harness.sdk.stub("terminals.create", async (args: { start: { command: string } }) => { const id = `term${++n}`; terminals.set(id, args.start.command); commands.push(args.start.command); return { id }; });
  host.harness.sdk.stub("terminals.get", async () => ({ status: "running" }));
  host.harness.sdk.stub("terminals.close", async () => ({}));
  host.harness.sdk.stub("terminals.output", async ({ terminalId }: { terminalId: string }) => {
    const command = terminals.get(terminalId)!;
    let stdout = "";
    let exitCode = 0;
    if (command.includes("sub_issues")) {
      stdout = [
        ...(command.includes("{title}|tojson") ? [JSON.stringify({ title: epic.epic.title })] : []),
        ...page(command, subIssues.map((issue) => JSON.stringify({ number: issue.number, title: issue.title, state: issue.state, repo: "Cyndra-AI/cyndra-saas", blockers: issue.blockedBy.length }))),
      ].join("\n");
    } else if (command.includes("dependencies/blocked_by")) {
      // One gh call per blocked issue; each prints one line.
      stdout = [...command.matchAll(/issues\/(\d+)\/dependencies\/blocked_by/g)].map((m) => {
        const issue = subIssues.find((i) => i.number === Number(m[1]))!;
        return JSON.stringify({ repo: "Cyndra-AI/cyndra-saas", number: issue.number, blockedBy: issue.blockedBy.map((n) => ({ repo: "Cyndra-AI/cyndra-saas", number: n })) });
      }).join("\n");
    } else if (command.includes("gh api graphql")) {
      if (options.fail?.()) {
        exitCode = 1;
      } else {
        // Each ticket the query names, with its real state. A missing issue (deleted, or a PR) is null and a
        // NOT_FOUND error; gh then exits 1 and prints the whole response, not the --jq rows.
        const shut = new Set(closed());
        const missing = new Set(options.missing ?? []);
        const numbers = [...command.matchAll(/issue\(number:(\d+)\)/g)].map((m) => Number(m[1]));
        const found = numbers.filter((n) => !missing.has(n));
        if (found.length < numbers.length || !command.includes("--jq")) {
          exitCode = found.length < numbers.length ? 1 : 0;
          stdout = JSON.stringify({
            data: { r0: Object.fromEntries(numbers.map((n) => [`i${n}`, missing.has(n) ? null : { state: shut.has(n) ? "CLOSED" : "OPEN" }])) },
            ...(exitCode === 1 ? { errors: numbers.filter((n) => missing.has(n)).map((n) => ({ type: "NOT_FOUND", path: ["r0", `i${n}`], message: `Could not resolve to an Issue with the number of ${n}.` })) } : {}),
          });
        } else {
          stdout = found.map((n) => JSON.stringify({ repo: "Cyndra-AI/cyndra-saas", number: n, state: shut.has(n) ? "CLOSED" : "OPEN" })).join("\n");
        }
      }
    }
    const stderr = exitCode === 0 ? "" : options.missing?.length ? options.missing.map((n) => `Could not resolve to an Issue with the number of ${n}.`).join("\n") : "HTTP 502: Bad Gateway";
    const payload = JSON.stringify({ protocol: "FM_HOST_CAPTURE_V1", exitCode, stdout, stderr });
    return { nextSeq: 1, chunks: [{ dataBase64: Buffer.from(`${payload}\n__FM_HOST_RC:0\n`).toString("base64") }] };
  });
  return commands;
}

async function captainHost() {
  const host = createFakePluginHost({ pluginId: "firstmate", agentSkillIds: manifestSkillIds(new URL(".", import.meta.url).pathname) });
  await host.bb.storage.kv.set("captain-project:thr_cap", "proj_1");
  await plugin(host.bb);
  await host.harness.behavior.setSettings({ fmReliability: JSON.stringify({ inboundLedger: "on", telegramThreading: "on", asyncDispatch: "on" }) });
  host.harness.sdk.stub("threads.getPluginMetadata", async ({ threadId }: { threadId: string }) => (threadId === "thr_cap" ? { captain: "true" } : {}));
  host.harness.sdk.stub("threads.list", async () => []);
  host.harness.sdk.stub("threads.get", async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, projectId: "proj_1", status: "idle", environmentId: "env_cap" } as never));
  host.harness.sdk.stub("threads.spawn", async () => ({ id: "thr_new" }));
  host.harness.sdk.stub("threads.send", async () => ({}));
  host.harness.sdk.stub("threadSections.list", async () => []);
  host.harness.sdk.stub("threadSections.create", async () => ({ id: "sec_crews" }));
  host.harness.sdk.stub("environments.list", async () => [{ id: "env_cap", hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }]);
  host.harness.sdk.stub("environments.get", async () => ({ id: "env_cap", hostId: "host_1", status: "ready", isWorktree: false, path: "/repo" }));
  host.harness.sdk.stub("projects.get", async () => ({ id: "proj_1", name: "Cyndra", kind: "repo" }));
  host.harness.sdk.stub("plugins.callRpc", async () => ({ ok: true, queued: 1, duplicate: false, mode: "on" }));
  return host;
}

function tool(host: Host, name: string) {
  const found = host.harness.inspection.registrations.agentTools.find((t) => t.name === name);
  assert.ok(found, `tool ${name} not registered`);
  return found!;
}

function text(result: unknown): string {
  const raw = typeof result === "string" ? result : (result as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("\n");
  return raw.replace(/[\s⁡-⁤]+$/u, "");
}

const isError = (result: unknown) => typeof result === "object" && result !== null && (result as { isError?: boolean }).isError === true;
const program = (host: Host, input: Record<string, unknown>) => tool(host, "firstmate_program").execute(input, capCtx);
const board = async (host: Host) => (await host.harness.behavior.callRpc("telegramCommand", { command: "board", threadId: "thr_cap" }) as { text: string }).text;
const wakes = (host: Host) => host.harness.sdk.callsTo("threads.send")
  .map((call) => JSON.stringify(call)).filter((call) => call.includes("Program DM Pro epic"));

test("14 Oct repro: the DM Pro epic becomes a program the captain cannot lose, and its owner task cannot close early", async () => {
  const host = await captainHost();
  try {
    const commands = github(host);
    const created = await program(host, { action: "create", epic: EPIC_URL, title: "DM Pro epic", refs: ["tg:985604794:4404"] });
    assert.ok(!isError(created), text(created));
    assert.match(text(created), /^Program P1 is open and keeps owner task T1 open until every ticket is done or dropped\.\nP1 DM Pro epic: 1\/20 done, 2 ready, 17 waiting on deps · task T1 · https:\/\/github\.com\/cyndra-ai\/cyndra-saas\/issues\/2422/);
    assert.match(text(created), /\n- #2425 Plugins: attach to an agent .* — waiting on deps on #2424\n/);
    assert.match(text(created), /\nReady now: #2424, #2428\. Dispatch them with ticket set on each dispatch/);
    assert.equal(commands.filter((c) => c.includes("gh api")).length, 2, "one host command reads the epic and its sub-issues, one reads the blocked-by links");
    assert.equal([...commands.find((c) => c.includes("dependencies/blocked_by"))!.matchAll(/issues\/(\d+)\/dependencies\/blocked_by/g)].length, 18, "only the 18 sub-issues with blockers are read");

    // The same epic again is the same program.
    assert.match(text(await program(host, { action: "create", epic: "cyndra-ai/cyndra-saas#2422", refs: ["tg:985604794:4404"] })), /^Program P1 already tracks this epic\./);

    // The owner task stays open while tickets are open.
    const close = await tool(host, "firstmate_task").execute({ action: "close", id: "T1", state: "live", reason: "first ticket in production" }, capCtx);
    assert.ok(isError(close));
    assert.match(text(close), /Task T1 holds program P1 \(DM Pro epic\): 19 of 20 tickets are open\./);

    // One line per open program on the owner's board, in place of its task.
    assert.match(await board(host), /🔧 In progress \(1\)\n- P1 Cyndra · DM Pro epic: 1\/20 done, 2 ready, 17 waiting on deps$/);

    // A dispatch with ticket marks it running; the title is not read.
    const dispatched = await tool(host, "firstmate_dispatch").execute({ projectId: "proj_1", task: "Build the plugin catalog", taskId: "dmpro-2424", title: "Catalog and install lifecycle", ticket: "#2424", origin: { kind: "captain", reason: "program ticket" } }, capCtx);
    assert.match(text(dispatched), /Program P1 ticket #2424 is running\./);
    const unknown = await tool(host, "firstmate_dispatch").execute({ projectId: "proj_1", task: "Other", taskId: "other", ticket: "#9999", origin: { kind: "captain", reason: "test" } }, capCtx);
    assert.match(text(unknown), /Warning: the program does not track this crew: No open program has ticket #9999\./);
    const stored = createPrograms(host.bb.storage.database()).get("P1")!;
    assert.deepEqual(stored.tickets.find((t) => t.ref === "cyndra-ai/cyndra-saas#2424")!.state, { kind: "running", crewId: "dmpro-2424" });
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a merged PR closes the ticket and the captain gets one wake naming the tickets that became ready", async () => {
  const host = await captainHost();
  try {
    github(host);
    await program(host, { action: "create", epic: EPIC_URL, title: "DM Pro epic", refs: ["tg:985604794:4404"] });
    await tool(host, "firstmate_dispatch").execute({ projectId: "proj_1", task: "Build the plugin catalog", taskId: "dmpro-2424", ticket: "#2424", origin: { kind: "captain", reason: "program ticket" } }, capCtx);
    const deliveries = createDeliveries(host.bb.storage.database());
    deliveries.register({ url: "https://github.com/Cyndra-AI/cyndra-saas/pull/2450", taskId: "dmpro-2424", projectId: "proj_1", owner: "thr_cap", home: "", requirement: "merged" } as never);
    const record = deliveries.get("cyndra-ai/cyndra-saas#2450")!;
    deliveries.save({ ...record, status: "complete", forgeState: "merged", mergeCommitSha: "m1" });
    for (let i = 0; i < 2; i++) await host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
    const sent = wakes(host);
    assert.equal(sent.length, 1, "the ready tickets wake the captain once");
    assert.match(sent[0]!, /Program DM Pro epic \(P1\): tickets #2425, #2427 are ready; dispatch them\./);
    const shown = text(await program(host, { action: "show", id: "P1" }));
    assert.match(shown, /^P1 DM Pro epic: 2\/20 done, 3 ready, 15 waiting on deps/);
    assert.match(shown, /- #2424 .* — done \(cyndra-ai\/cyndra-saas#2450 merged\)/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("dropping every open ticket with the owner's words closes the program; its task waits for its merged ticket to go live", async () => {
  const host = await captainHost();
  try {
    github(host);
    await program(host, { action: "create", epic: EPIC_URL, title: "DM Pro epic", refs: ["tg:985604794:4404"] });
    const tickets = epic.subIssues.filter((issue) => issue.state === "open").map((issue) => `#${issue.number}`);
    const refused = await program(host, { action: "set", id: "P1", tickets, state: "dropped", reason: "" });
    assert.match(text(refused), /needs the owner's words/);
    const dropped = await program(host, { action: "set", id: "P1", tickets, state: "dropped", reason: "Stop DM Pro, we buy a tool instead" });
    assert.match(text(dropped), /Program P1 is closed; owner task T1 is merged\./, "its one merged ticket still has to go live");
    assert.equal(createOwnerTasks(host.bb.storage.database()).get("T1")!.state, "merged");
    assert.equal(text(await program(host, { action: "list" })), "No program is open.");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("bb firstmate program runs the same operations from the CLI", async () => {
  const host = await captainHost();
  try {
    github(host);
    const run = (argv: string[]) => host.harness.behavior.runCli(argv, capCtx) as Promise<{ exitCode: number; stdout?: string; stderr?: string }>;
    const created = await run(["program", "create", EPIC_URL, "--title", "DM Pro epic", "--ref", "tg:985604794:4404"]);
    assert.equal(created.exitCode, 0, created.stderr);
    assert.match(created.stdout!, /^Program P1 is open/);
    const blocked = await run(["program", "set", "P1", "#2428", "--state", "blocked", "--reason", "Which X egress provider?"]);
    assert.match(blocked.stdout!, /- #2428 .* — on the owner: Which X egress provider\?/);
    assert.match((await run(["program", "list"])).stdout!, /^P1 DM Pro epic: 1\/20 done, 1 ready, 17 waiting on deps, 1 on you/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("14 Oct repro: ready tickets with nothing running for 2 hours remind the captain once, and ticket states are read every 30 minutes", async () => {
  const host = await captainHost();
  try {
    let closed: number[] = [];
    const commands = github(host, () => closed);
    await program(host, { action: "create", epic: EPIC_URL, title: "DM Pro epic", refs: ["tg:985604794:4404"] });
    const store = createPrograms(host.bb.storage.database());
    // As on 14 Oct: the plan was told at 19:25 and nothing ran after #2423 merged.
    const back = Date.now() - 3 * 60 * 60_000;
    store.update("P1", "thr_cap", (p) => ({ ...p, lastActiveAt: back, checkedAt: back, tickets: p.tickets.map((t) => ({ ...t, since: back })) }));
    const idle = () => host.harness.behavior.emitThreadEvent("thread.idle", { thread: makeThreadResponse({ id: "thr_cap", status: "idle" }), lastAssistantText: "ok" });
    await idle();
    await idle();
    const sent = wakes(host);
    assert.equal(sent.length, 1, "one reminder, not one per turn");
    assert.match(sent[0]!, /Program DM Pro epic \(P1\) has stalled: #2424, #2428 are ready and nothing has run for 3 h\./);
    assert.match(await board(host), /📌 Needs you \(1\)\n1\. P1 DM Pro epic: #2424, #2428 ready, nothing running for 3 h/);
    assert.equal(commands.filter((c) => c.includes("gh api graphql")).length, 1, "ticket states are read once per 30 minutes");

    // Someone closes #2428 on GitHub: refresh reads it now and #2429 becomes ready.
    closed = [2428, 9999];
    const refreshed = text(await program(host, { action: "refresh" }));
    assert.match(refreshed, /^P1 DM Pro epic: 2\/20 done, 2 ready, 16 waiting on deps/);
    assert.equal(store.get("P1")!.tickets.find((t) => t.ref === "cyndra-ai/cyndra-saas#2429")!.state.kind, "ready");
    assert.match(wakes(host).at(-1)!, /ticket #2429 is ready; dispatch it\./);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

const createEpic = (host: Host) => program(host, { action: "create", epic: EPIC_URL, title: "DM Pro epic", refs: ["tg:985604794:4404"] });

test("two refreshes at the same time send one wake for a ticket that became ready", async () => {
  const host = await captainHost();
  try {
    github(host, () => [2428]);
    await createEpic(host);
    await Promise.all([program(host, { action: "refresh" }), program(host, { action: "refresh" })]);
    assert.equal(wakes(host).filter((wake) => wake.includes("#2429")).length, 1);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a failed GitHub read shows in the refresh result and on the board, with the age of the data", async () => {
  const host = await captainHost();
  try {
    let fail = false;
    github(host, () => [], { fail: () => fail });
    await createEpic(host);
    const store = createPrograms(host.bb.storage.database());
    const back = Date.now() - 45 * 60_000;
    store.update("P1", "thr_cap", (p) => ({ ...p, checkedAt: back }));
    fail = true;
    const refreshed = await program(host, { action: "refresh" });
    assert.match(text(refreshed), /^P1 DM Pro epic: 1\/20 done, 2 ready, 17 waiting on deps · GitHub read failed 0 min ago; ticket states are 45 min old/);
    assert.match(text(refreshed), /GitHub read of ticket states failed: HTTP 502: Bad Gateway/);
    assert.equal(store.get("P1")!.checkedAt, back, "the next refresh reads the missed closures again");
    assert.match(await board(host), /- P1 Cyndra · DM Pro epic: 1\/20 done, 2 ready, 17 waiting on deps · GitHub read failed 0 min ago; ticket states are 45 min old$/m);

    fail = false;
    const recovered = text(await program(host, { action: "refresh" }));
    assert.doesNotMatch(recovered, /failed/);
    assert.match(recovered, /Ticket states read from GitHub 0 min ago\./);
    assert.doesNotMatch(await board(host), /failed/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("a ticket GitHub cannot read (deleted, or a PR) is named and keeps its state; every other ticket still updates", async () => {
  const host = await captainHost();
  try {
    github(host);
    await createEpic(host);
    github(host, () => [2428], { missing: [2424] });
    const refreshed = text(await program(host, { action: "refresh" }));
    const store = createPrograms(host.bb.storage.database());
    const state = (n: number) => store.get("P1")!.tickets.find((t) => t.ref === `cyndra-ai/cyndra-saas#${n}`)!.state.kind;
    assert.equal(state(2428), "done", "a closed ticket in the same query still closes");
    assert.equal(state(2424), "ready", "the unreadable ticket keeps its last state");
    assert.match(refreshed, /^P1 DM Pro epic: 2\/20 done, .* · GitHub cannot read #2424 \(deleted, or not an issue\); its state is kept · task T1/);
    assert.doesNotMatch(refreshed, /failed/);
    assert.match(await board(host), /^- P1 Cyndra · DM Pro epic: 2\/20 done, .* · GitHub cannot read #2424 \(deleted, or not an issue\); its state is kept$/m);

    github(host, () => [2428]);
    assert.doesNotMatch(text(await program(host, { action: "refresh" })), /cannot read/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("an epic whose tickets are all closed closes its program at once and its task waits to go live", async () => {
  const host = await captainHost();
  try {
    github(host, () => [], { subIssues: epic.subIssues.map((issue) => ({ ...issue, state: "closed" })) });
    const created = text(await createEpic(host));
    assert.match(created, /Program P1 is closed; owner task T1 is merged\./);
    assert.equal(createOwnerTasks(host.bb.storage.database()).get("T1")!.state, "merged");
    assert.equal(text(await program(host, { action: "list" })), "No program is open.");
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("running needs a crew this captain has", async () => {
  const host = await captainHost();
  try {
    github(host);
    await createEpic(host);
    const refused = await program(host, { action: "set", id: "P1", tickets: ["#2424"], state: "running", crewId: "nonexistent-crew" });
    assert.ok(isError(refused));
    assert.match(text(refused), /No crew nonexistent-crew for this captain\./);
    assert.equal(createPrograms(host.bb.storage.database()).get("P1")!.tickets.find((t) => t.ref === "cyndra-ai/cyndra-saas#2424")!.state.kind, "ready");
    await tool(host, "firstmate_dispatch").execute({ projectId: "proj_1", task: "Build the plugin catalog", taskId: "dmpro-2424", origin: { kind: "captain", reason: "program ticket" } }, capCtx);
    const running = await program(host, { action: "set", id: "P1", tickets: ["#2424"], state: "running", crewId: "dmpro-2424" });
    assert.ok(!isError(running), text(running));
    assert.match(text(running), /- #2424 .* — running crew dmpro-2424/);
  } finally {
    await host.harness.lifecycle.dispose();
  }
});

test("sub-issues are read page by page up to 500; refresh reads each open ticket's own state, however busy the repo", async () => {
  const many = (count: number): SubIssue[] => Array.from({ length: count }, (_, i) => ({ number: 3001 + i, title: `Ticket ${i + 1}`, state: "open", blockedBy: [] }));
  const host = await captainHost();
  try {
    // A busy repo: 600 other issues closed in the same minute as ticket #3150.
    const closed = [...Array.from({ length: 600 }, (_, i) => 10_000 + i), 3150];
    const commands = github(host, () => closed, { subIssues: many(150) });
    assert.match(text(await createEpic(host)), /^Program P1 is open/);
    const store = createPrograms(host.bb.storage.database());
    assert.equal(store.get("P1")!.tickets.length, 150);
    await program(host, { action: "refresh" });
    assert.equal(store.get("P1")!.tickets.find((t) => t.ref === "cyndra-ai/cyndra-saas#3150")!.state.kind, "done");
    const reads = commands.filter((c) => c.includes("gh api graphql"));
    assert.equal(reads.length, 2, "150 tickets are two queries of at most 100");
    assert.equal(reads.flatMap((c) => [...c.matchAll(/issue\(number:/g)]).length, 150, "each open ticket is read, and nothing else");
  } finally {
    await host.harness.lifecycle.dispose();
  }
  const big = await captainHost();
  try {
    github(big, () => [], { subIssues: many(501) });
    const refused = await createEpic(big);
    assert.ok(isError(refused));
    assert.match(text(refused), /has more than 500 sub-issues; a program reads at most 500\. Split the epic\./);
  } finally {
    await big.harness.lifecycle.dispose();
  }
});
