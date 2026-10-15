import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  applyFact, buildProgram, createPrograms, dependenciesIn, newlyReady, programCounts, programLine, programNeedsOwner, readyRefs, refsIn,
  stallReminderDue, stalledSince, ticketRef, TICKET_TRANSITIONS, type IssueFacts, type Program, type TicketKind, type TicketRef,
} from "./programs.ts";

// The real case: epic Cyndra-AI/cyndra-saas#2422, read on 15 Oct when only #2423 was closed.
const epic = JSON.parse(readFileSync(new URL("../test/fixtures/dmpro-epic-2422.json", import.meta.url), "utf8")) as {
  epic: { number: number; title: string; table: string };
  subIssues: { number: number; title: string; state: string; body: string }[];
};
const REPO = "cyndra-ai/cyndra-saas";
const ref = (n: number) => `${REPO}#${n}` as TicketRef;
const issues: IssueFacts[] = epic.subIssues.map((i) => ({ ref: ref(i.number), title: i.title, body: i.body, closed: i.state === "closed" }));
const H = 60 * 60_000;
// 14 Oct 19:25 UTC: the captain told the owner the plan.
const PLAN_AT = Date.UTC(2026, 9, 14, 19, 25);

const dmPro = (at = PLAN_AT): Program => buildProgram("P1", {
  captain: "thr_pse43vv6tn", project: "Cyndra", title: "DM Pro epic", source: "https://github.com/Cyndra-AI/cyndra-saas/issues/2422",
  sourceRefs: ["tg:985604794:4404"], taskId: "T180", epicBody: epic.epic.table, issues, at,
}).program;

function db() {
  const raw = new DatabaseSync(":memory:");
  return Object.assign(raw, {
    transaction<T>(fn: () => T) {
      return () => {
        raw.exec("BEGIN");
        try { const out = fn(); raw.exec("COMMIT"); return out; } catch (error) { raw.exec("ROLLBACK"); throw error; }
      };
    },
  });
}

const kindOf = (program: Program, n: number) => program.tickets.find((t) => t.ref === ref(n))!.state.kind;

test("issue refs read from URLs, owner/repo#n and #n inside the repo", () => {
  assert.equal(ticketRef("https://github.com/Cyndra-AI/cyndra-saas/issues/2424"), ref(2424));
  assert.equal(ticketRef("Cyndra-AI/cyndra-saas#2424"), ref(2424));
  assert.equal(ticketRef("#2424", REPO), ref(2424));
  assert.equal(ticketRef("#2424"), null, "a bare number needs a repo");
  assert.deepEqual(refsIn("DM Pro #2424: catalog (see Cyndra-AI/cyndra-saas#2423, T172)", REPO), [ref(2424), ref(2423)]);
  assert.deepEqual(dependenciesIn("Blocked by: #2423, #2424\n\n## What\nmentions #9\n\n## Blocked by\n\n- #2425\n- None", REPO), [ref(2423), ref(2424), ref(2425)]);
  assert.deepEqual(dependenciesIn("## Blocked by\n\n- None (can start immediately)", REPO), []);
});

test("the DM Pro epic becomes 20 tickets: #2423 done, #2424 and #2428 ready, 17 waiting on deps", () => {
  const program = dmPro();
  assert.equal(program.tickets.length, 20);
  assert.deepEqual(programCounts(program), { total: 20, done: 1, dropped: 0, running: 0, inReview: 0, ready: 2, waiting: 17, onOwner: 0 });
  assert.deepEqual(readyRefs(program), [ref(2424), ref(2428)]);
  assert.deepEqual(program.tickets.find((t) => t.ref === ref(2425))!.dependsOn, [ref(2423), ref(2424)]);
  assert.deepEqual(program.tickets.find((t) => t.ref === ref(2442))!.dependsOn, [ref(2430), ref(2437), ref(2424)]);
  assert.equal(programLine(program), "DM Pro epic: 1/20 done, 2 ready, 17 waiting on deps");
  assert.deepEqual(newlyReady(program).refs, [], "the create result already lists the ready tickets");
});

test("the epic's table alone gives the dependencies when issue bodies name none", () => {
  const bare = issues.map((issue) => ({ ...issue, body: "" }));
  const program = buildProgram("P1", { captain: "c", project: null, title: "DM Pro", source: null, sourceRefs: [], taskId: null, epicBody: epic.epic.table, issues: bare, at: 0 }).program;
  assert.deepEqual(readyRefs(program), [ref(2424), ref(2428)]);
});

test("dispatch, PR and merge move a ticket, and its dependents become ready with one wake", () => {
  let program = dmPro();
  program = applyFact(program, { kind: "dispatched", ticket: ref(2424), crewId: "c2424" }, PLAN_AT + H);
  assert.equal(kindOf(program, 2424), "running");
  program = applyFact(program, { kind: "pr-open", ticket: ref(2424), pr: `${REPO}#2450` }, PLAN_AT + 2 * H);
  assert.deepEqual(program.tickets.find((t) => t.ref === ref(2424))!.state, { kind: "in-review", pr: `${REPO}#2450`, crewId: "c2424" });
  program = applyFact(program, { kind: "pr-merged", ticket: ref(2424), pr: `${REPO}#2450` }, PLAN_AT + 3 * H);
  assert.equal(kindOf(program, 2424), "done");
  // #2425 waits on #2423 and #2424; #2427 waits on #2424 only.
  assert.deepEqual(readyRefs(program), [ref(2425), ref(2427), ref(2428)]);
  const first = newlyReady(program);
  assert.deepEqual(first.refs, [ref(2425), ref(2427)]);
  assert.deepEqual(newlyReady(first.program).refs, [], "each ready ticket wakes the captain once");
  assert.equal(programLine(first.program), "DM Pro epic: 2/20 done, 3 ready, 15 waiting on deps");
});

test("a crew that ends without a PR puts its ticket back to ready; a PR closed unmerged does the same", () => {
  let program = applyFact(dmPro(), { kind: "dispatched", ticket: ref(2428), crewId: "c2428" }, PLAN_AT + H);
  program = applyFact(program, { kind: "work-stopped", ticket: ref(2428), crewId: "other" }, PLAN_AT + 2 * H);
  assert.equal(kindOf(program, 2428), "running", "another crew's end does not move it");
  program = applyFact(program, { kind: "work-stopped", ticket: ref(2428), crewId: "c2428" }, PLAN_AT + 2 * H);
  assert.equal(kindOf(program, 2428), "ready");
});

test("the 14 Oct stall: ready tickets with nothing running remind the captain after 2 hours, then every 6", () => {
  // T172 (#2423) merged and nothing else ran: #2424 and #2428 ready from 19:25.
  const program = dmPro();
  assert.equal(stalledSince(program), PLAN_AT);
  assert.equal(stallReminderDue(program, PLAN_AT + H), false);
  assert.equal(stallReminderDue(program, PLAN_AT + 2 * H), true);
  assert.equal(programNeedsOwner(program, PLAN_AT + 13 * H), "P1 DM Pro epic: #2424, #2428 ready, nothing running for 13 h");
  const reminded = { ...program, remindedAt: PLAN_AT + 2 * H };
  assert.equal(stallReminderDue(reminded, PLAN_AT + 3 * H), false);
  assert.equal(stallReminderDue(reminded, PLAN_AT + 8 * H), true);
  const running = applyFact(program, { kind: "dispatched", ticket: ref(2424), crewId: "c1" }, PLAN_AT + 3 * H);
  assert.equal(stalledSince(running), null);
  assert.equal(programNeedsOwner(running, PLAN_AT + 9 * H), null);
  // The crew ends without a PR: the stall clock restarts from that moment, not from 19:25.
  const stopped = applyFact(running, { kind: "work-stopped", ticket: ref(2424), crewId: "c1" }, PLAN_AT + 5 * H);
  assert.equal(stalledSince(stopped), PLAN_AT + 5 * H);
  assert.equal(stallReminderDue({ ...stopped, remindedAt: PLAN_AT + 2 * H }, PLAN_AT + 7 * H), true);
});

test("invalid moves are refused: done and dropped are final, dropping needs owner words, blocking needs a reason", () => {
  const program = dmPro();
  assert.throws(() => applyFact(program, { kind: "dispatched", ticket: ref(2423), crewId: "c" }, 1), /#2423 is done; it cannot become running/);
  assert.throws(() => applyFact(program, { kind: "dropped", ticket: ref(2424), ownerWords: " " }, 1), /needs the owner's words/);
  assert.throws(() => applyFact(program, { kind: "blocked", ticket: ref(2424), reason: "", askId: null }, 1), /needs a reason/);
  assert.throws(() => applyFact(program, { kind: "dispatched", ticket: ref(9999), crewId: "c" }, 1), /no ticket/);
  const kinds = Object.keys(TICKET_TRANSITIONS) as TicketKind[];
  for (const kind of kinds) assert.ok(!TICKET_TRANSITIONS[kind].includes(kind));
  assert.deepEqual(TICKET_TRANSITIONS.done, []);
  assert.deepEqual(TICKET_TRANSITIONS.dropped, []);
});

test("blocking on the owner shows on the owner's list; unblocking returns the ticket to its dependencies", () => {
  let program = applyFact(dmPro(), { kind: "blocked", ticket: ref(2428), reason: "Which X egress provider?", askId: null }, PLAN_AT + H);
  assert.equal(programLine(program), "DM Pro epic: 1/20 done, 1 ready, 17 waiting on deps, 1 on you");
  assert.match(programNeedsOwner(program, PLAN_AT + H)!, /#2428 waits on you: Which X egress provider\?/);
  program = applyFact(program, { kind: "unblocked", ticket: ref(2428) }, PLAN_AT + 2 * H);
  assert.equal(kindOf(program, 2428), "ready");
});

test("a dropped dependency frees its dependents; a program closes when every ticket is done or dropped", () => {
  let program = applyFact(dmPro(), { kind: "dropped", ticket: ref(2428), ownerWords: "skip the spike, use the existing worker" }, PLAN_AT + H);
  assert.equal(kindOf(program, 2429), "ready");
  const store = createPrograms(db());
  const created = store.create({ captain: "thr_cap", project: null, title: "Two", source: "https://github.com/o/r/issues/1", sourceRefs: [], taskId: "T1",
    epicBody: "", issues: [{ ref: ticketRef("o/r#2")!, title: "a", body: "", closed: false }, { ref: ticketRef("o/r#3")!, title: "b", body: "Blocked by: #2", closed: false }], at: 0 }).program;
  assert.equal(store.holding("T1")?.id, created.id);
  assert.equal(store.create({ captain: "thr_cap", project: null, title: "Again", source: "https://github.com/o/r/issues/1", sourceRefs: [], taskId: "T2", epicBody: "", issues: [{ ref: ticketRef("o/r#2")!, title: "a", body: "", closed: false }], at: 1 }).program.id, created.id, "the same epic is one program");
  program = store.apply(created.id, "thr_cap", [{ kind: "issue-closed", ticket: ticketRef("o/r#2")! }, { kind: "dropped", ticket: ticketRef("o/r#3")!, ownerWords: "not needed" }], 5);
  assert.equal(store.list("thr_cap").length, 0);
  assert.equal(store.list("thr_cap", { includeClosed: true }).length, 1);
  assert.equal(store.holding("T1"), undefined);
  assert.throws(() => store.apply(created.id, "thr_other", [], 6), /No program P1 for this captain/);
});

test("tickets that depend on each other in a circle are refused", () => {
  assert.throws(() => buildProgram("P1", { captain: "c", project: null, title: "Loop", source: null, sourceRefs: [], taskId: null, epicBody: "", at: 0,
    issues: [{ ref: ticketRef("o/r#1")!, title: "a", body: "Blocked by: #2", closed: false }, { ref: ticketRef("o/r#2")!, title: "b", body: "Blocked by: #1", closed: false }] }), /in a circle: o\/r#1 -> o\/r#2 -> o\/r#1/);
});
