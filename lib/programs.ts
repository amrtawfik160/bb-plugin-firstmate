import { clip, formatAge } from "./owner-asks.ts";

/** One GitHub issue, spelled `owner/repo#n` in lower case. */
export type TicketRef = string & { readonly __ticketRef: unique symbol };

const REF = /^([\w.-]+)\/([\w.-]+)#(\d+)$/;

/** Read an issue URL, `owner/repo#n`, or `#n` inside `repo`, or null. */
export function ticketRef(text: string, repo?: string): TicketRef | null {
  const raw = text.trim();
  const url = raw.match(/^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)\b/i);
  if (url) return `${url[1]}/${url[2]}#${url[3]}`.toLowerCase() as TicketRef;
  if (REF.test(raw)) return raw.toLowerCase() as TicketRef;
  const bare = raw.match(/^#(\d+)$/);
  return bare && repo ? `${repo}#${bare[1]}`.toLowerCase() as TicketRef : null;
}

export const repoOf = (ref: TicketRef): string => ref.slice(0, ref.indexOf("#"));
export const numberOf = (ref: TicketRef): number => Number(ref.slice(ref.indexOf("#") + 1));

/** Where a ticket stands. Each state carries the fact that proves it: a running ticket has its
 * crew, a done ticket its merged PR or closed issue, a dropped ticket the owner's words. */
export type TicketState =
  | { kind: "waiting-deps" }
  | { kind: "ready" }
  | { kind: "running"; crewId: string }
  | { kind: "in-review"; pr: string; crewId: string | null }
  | { kind: "done"; proof: { by: "pr-merged"; pr: string } | { by: "issue-closed" } }
  | { kind: "blocked-on-owner"; reason: string; askId: string | null }
  | { kind: "dropped"; ownerWords: string };

export type TicketKind = TicketState["kind"];

export interface Ticket {
  ref: TicketRef;
  title: string;
  /** Tickets of this program that must be done or dropped first. */
  dependsOn: TicketRef[];
  state: TicketState;
  /** When the ticket entered its current state. */
  since: number;
}

/** A multi-ticket job the owner asked for (an epic). Open while any ticket is not done or dropped. */
export interface Program {
  id: string;
  captain: string;
  project: string | null;
  title: string;
  /** The epic issue URL, or null for a hand-built list. */
  source: string | null;
  sourceRefs: string[];
  /** The owner task the program keeps open. */
  taskId: string | null;
  tickets: Ticket[];
  /** Ready tickets the captain was already told about: each ready ticket wakes the captain once. */
  announced: TicketRef[];
  /** The last time a ticket entered or left running or in review. */
  lastActiveAt: number;
  remindedAt: number | null;
  /** The last time ticket states were read from GitHub. */
  checkedAt: number;
  /** The last read of ticket states failed, and no read has worked since. Absent on older records. */
  checkFailure?: { at: number; error: string } | null;
  createdAt: number;
  updatedAt: number;
}

const TERMINAL = new Set<TicketKind>(["done", "dropped"]);
const ACTIVE = new Set<TicketKind>(["running", "in-review"]);

/** Which states a ticket may move to. Readiness itself is decided by its dependencies, in `settle`. */
export const TICKET_TRANSITIONS: Record<TicketKind, readonly TicketKind[]> = {
  "waiting-deps": ["ready", "running", "in-review", "done", "blocked-on-owner", "dropped"],
  ready: ["waiting-deps", "running", "in-review", "done", "blocked-on-owner", "dropped"],
  running: ["ready", "in-review", "done", "blocked-on-owner", "dropped"],
  "in-review": ["ready", "running", "done", "blocked-on-owner", "dropped"],
  "blocked-on-owner": ["waiting-deps", "running", "in-review", "done", "dropped"],
  done: [],
  dropped: [],
};

export const isOpenTicket = (ticket: Pick<Ticket, "state">): boolean => !TERMINAL.has(ticket.state.kind);
export const isOpenProgram = (program: Pick<Program, "tickets">): boolean => program.tickets.some(isOpenTicket);

/** What happened to a ticket. Facts come from Firstmate's own records; captain moves from the tool. */
export type ProgramFact =
  | { kind: "dispatched"; ticket: TicketRef; crewId: string }
  | { kind: "pr-open"; ticket: TicketRef; pr: string }
  | { kind: "pr-merged"; ticket: TicketRef; pr: string }
  /** The crew ended, or its PR closed unmerged, and nothing still carries the ticket. */
  | { kind: "work-stopped"; ticket: TicketRef; crewId: string | null }
  | { kind: "issue-closed"; ticket: TicketRef }
  | { kind: "blocked"; ticket: TicketRef; reason: string; askId: string | null }
  | { kind: "unblocked"; ticket: TicketRef }
  | { kind: "dropped"; ticket: TicketRef; ownerWords: string };

function next(ticket: Ticket, fact: ProgramFact): TicketState | null {
  const state = ticket.state;
  switch (fact.kind) {
    case "dispatched":
      // A fix crew on a PR in review keeps the ticket in review.
      if (state.kind === "in-review") return { ...state, crewId: fact.crewId };
      return { kind: "running", crewId: fact.crewId };
    case "pr-open":
      return { kind: "in-review", pr: fact.pr, crewId: state.kind === "running" || state.kind === "in-review" ? state.crewId : null };
    case "pr-merged":
      return { kind: "done", proof: { by: "pr-merged", pr: fact.pr } };
    case "issue-closed":
      return { kind: "done", proof: { by: "issue-closed" } };
    case "work-stopped": {
      const crewId = state.kind === "running" || state.kind === "in-review" ? state.crewId : null;
      if (!ACTIVE.has(state.kind) || (fact.crewId !== null && crewId !== fact.crewId)) return null;
      return { kind: "ready" };
    }
    case "blocked": {
      const reason = fact.reason.trim();
      if (reason === "") throw new Error(`Blocking ticket ${fact.ticket} needs a reason.`);
      return { kind: "blocked-on-owner", reason, askId: fact.askId };
    }
    case "unblocked":
      return state.kind === "blocked-on-owner" ? { kind: "waiting-deps" } : null;
    case "dropped": {
      const ownerWords = fact.ownerWords.trim();
      if (ownerWords === "") throw new Error(`Dropping ticket ${fact.ticket} needs the owner's words.`);
      return { kind: "dropped", ownerWords };
    }
    default: {
      const never: never = fact;
      throw new Error(`Unknown fact ${JSON.stringify(never)}`);
    }
  }
}

const sameState = (a: TicketState, b: TicketState) => JSON.stringify(a) === JSON.stringify(b);

/** Apply one fact. A fact the state machine refuses throws; a fact that changes nothing returns the same program. */
export function applyFact(program: Program, fact: ProgramFact, at: number): Program {
  const index = program.tickets.findIndex((ticket) => ticket.ref === fact.ticket);
  if (index < 0) throw new Error(`Program ${program.id} has no ticket ${fact.ticket}.`);
  const ticket = program.tickets[index]!;
  const to = next(ticket, fact);
  if (to === null || sameState(ticket.state, to)) return program;
  if (to.kind !== ticket.state.kind && !TICKET_TRANSITIONS[ticket.state.kind].includes(to.kind)) {
    throw new Error(`Ticket ${ticket.ref} is ${ticket.state.kind}; it cannot become ${to.kind}.`);
  }
  const tickets = program.tickets.slice();
  tickets[index] = { ...ticket, state: to, since: to.kind === ticket.state.kind ? ticket.since : at };
  const active = ACTIVE.has(ticket.state.kind) || ACTIVE.has(to.kind);
  return settle({ ...program, tickets, updatedAt: at, ...(active ? { lastActiveAt: at } : {}) }, at);
}

/** Move tickets between waiting and ready by their dependencies. A dropped dependency no longer
 * holds anything back: the owner chose to stop it, and a ticket that waited on it forever would stall unseen. */
export function settle(program: Program, at: number): Program {
  const resolved = new Set(program.tickets.filter((ticket) => !isOpenTicket(ticket)).map((ticket) => ticket.ref));
  let changed = false;
  const tickets = program.tickets.map((ticket) => {
    const free = ticket.dependsOn.every((ref) => resolved.has(ref));
    if (ticket.state.kind === "waiting-deps" && free) { changed = true; return { ...ticket, state: { kind: "ready" } as const, since: at }; }
    if (ticket.state.kind === "ready" && !free) { changed = true; return { ...ticket, state: { kind: "waiting-deps" } as const, since: at }; }
    return ticket;
  });
  return changed ? { ...program, tickets, updatedAt: at } : program;
}

/** One issue as read from GitHub, before it becomes a ticket: its GitHub "blocked by" links, not its text. */
export type IssueFacts = { ref: TicketRef; title: string; closed: boolean; blockedBy: readonly TicketRef[] };

export type NewProgram = Pick<Program, "captain" | "project" | "title" | "source" | "sourceRefs" | "taskId"> & {
  issues: readonly IssueFacts[];
  at: number;
};

/** Build a program from its issues. Dependencies outside the program are left out and reported;
 * a dependency cycle is refused, because no ticket in it could ever become ready. */
export function buildProgram(id: string, input: NewProgram): { program: Program; outside: string[] } {
  if (input.issues.length === 0) throw new Error("A program needs at least one ticket.");
  const refs = new Set(input.issues.map((issue) => issue.ref));
  const outside: string[] = [];
  const tickets: Ticket[] = input.issues.map((issue) => {
    const named = [...new Set(issue.blockedBy)].filter((ref) => ref !== issue.ref);
    for (const ref of named) if (!refs.has(ref)) outside.push(`${issue.ref} depends on ${ref}`);
    return {
      ref: issue.ref,
      title: issue.title.replace(/\s+/g, " ").trim().slice(0, 200),
      dependsOn: named.filter((ref) => refs.has(ref)),
      state: issue.closed ? { kind: "done", proof: { by: "issue-closed" } } : { kind: "waiting-deps" },
      since: input.at,
    };
  });
  const cycle = findCycle(tickets);
  if (cycle !== null) throw new Error(`Tickets depend on each other in a circle: ${cycle.join(" -> ")}. Fix the issues' "blocked by" links on GitHub first.`);
  const program = settle({
    id, captain: input.captain, project: input.project, title: input.title.replace(/\s+/g, " ").trim().slice(0, 120),
    source: input.source, sourceRefs: [...new Set(input.sourceRefs)], taskId: input.taskId,
    tickets, announced: [], lastActiveAt: input.at, remindedAt: null, checkedAt: input.at, createdAt: input.at, updatedAt: input.at,
  }, input.at);
  // The create result lists the ready tickets, so they are told already.
  return { program: { ...program, announced: readyRefs(program) }, outside };
}

function findCycle(tickets: readonly Ticket[]): TicketRef[] | null {
  const deps = new Map(tickets.map((ticket) => [ticket.ref, ticket.dependsOn]));
  const done = new Set<TicketRef>();
  const path: TicketRef[] = [];
  const visit = (ref: TicketRef): TicketRef[] | null => {
    if (done.has(ref)) return null;
    const at = path.indexOf(ref);
    if (at >= 0) return [...path.slice(at), ref];
    path.push(ref);
    for (const dep of deps.get(ref) ?? []) {
      const found = visit(dep);
      if (found) return found;
    }
    path.pop();
    done.add(ref);
    return null;
  };
  for (const ticket of tickets) {
    const found = visit(ticket.ref);
    if (found) return found;
  }
  return null;
}

export const readyRefs = (program: Pick<Program, "tickets">): TicketRef[] => program.tickets.filter((ticket) => ticket.state.kind === "ready").map((ticket) => ticket.ref);

/** Ready tickets the captain has not been told about, and the program that records them as told. */
export function newlyReady(program: Program): { refs: TicketRef[]; program: Program } {
  const ready = readyRefs(program);
  const refs = ready.filter((ref) => !program.announced.includes(ref));
  // A ticket that left ready and comes back is news again.
  const announced = program.announced.filter((ref) => ready.includes(ref));
  return { refs, program: refs.length === 0 && announced.length === program.announced.length ? program : { ...program, announced: [...announced, ...refs] } };
}

export const STALL_MS = 2 * 60 * 60_000;
export const STALL_REMIND_EVERY_MS = 6 * 60 * 60_000;

/** Since when an open program has had ready tickets and nothing running or in review, or null. */
export function stalledSince(program: Program): number | null {
  if (program.tickets.some((ticket) => ACTIVE.has(ticket.state.kind))) return null;
  const ready = program.tickets.filter((ticket) => ticket.state.kind === "ready");
  if (ready.length === 0) return null;
  return Math.max(program.lastActiveAt, Math.min(...ready.map((ticket) => ticket.since)));
}

export function isStalled(program: Program, now: number): boolean {
  const since = stalledSince(program);
  return since !== null && now - since >= STALL_MS;
}

/** Whether the captain gets a stall reminder now: once a stall passes two hours, then every six. */
export function stallReminderDue(program: Program, now: number): boolean {
  const since = stalledSince(program);
  if (since === null || now - since < STALL_MS) return false;
  return program.remindedAt === null || program.remindedAt < since + STALL_MS || now - program.remindedAt >= STALL_REMIND_EVERY_MS;
}

export type ProgramCounts = Record<"total" | "done" | "dropped" | "running" | "inReview" | "ready" | "waiting" | "onOwner", number>;

export function programCounts(program: Pick<Program, "tickets">): ProgramCounts {
  const count = (kind: TicketKind) => program.tickets.filter((ticket) => ticket.state.kind === kind).length;
  return {
    total: program.tickets.length, done: count("done"), dropped: count("dropped"), running: count("running"), inReview: count("in-review"),
    ready: count("ready"), waiting: count("waiting-deps"), onOwner: count("blocked-on-owner"),
  };
}

/** `cyndra-ai/cyndra-saas#2424` reads as `#2424` when every ticket shares one repo. */
export function shortTicket(program: Pick<Program, "tickets">, ref: TicketRef): string {
  const repos = new Set(program.tickets.map((ticket) => repoOf(ticket.ref)));
  return repos.size === 1 ? `#${numberOf(ref)}` : ref.replace(/^[^/]*\//, "");
}

/** The one line the board and digest show per open program. A failed GitHub read says how old the ticket states are. */
export function programLine(program: Program, now: number): string {
  const c = programCounts(program);
  const parts = [
    `${c.done}/${c.total - c.dropped} done`,
    c.running > 0 ? `${c.running} running` : "",
    c.inReview > 0 ? `${c.inReview} in review` : "",
    c.ready > 0 ? `${c.ready} ready` : "",
    c.waiting > 0 ? `${c.waiting} waiting on deps` : "",
    c.onOwner > 0 ? `${c.onOwner} on you` : "",
    c.dropped > 0 ? `${c.dropped} dropped` : "",
  ].filter((part) => part !== "");
  const failure = program.checkFailure ? ` · GitHub read failed ${formatAge(now - program.checkFailure.at)} ago; ticket states are ${formatAge(now - program.checkedAt)} old` : "";
  return `${clip(program.title, 50)}: ${parts.join(", ")}${failure}`;
}

/** What the owner must act on in a program, or null: a stall past two hours, or a ticket blocked on
 * the owner without a question card. */
export function programNeedsOwner(program: Program, now: number): string | null {
  const reasons: string[] = [];
  if (isStalled(program, now)) {
    const ready = readyRefs(program).map((ref) => shortTicket(program, ref));
    reasons.push(`${ready.join(", ")} ready, nothing running for ${formatAge(now - stalledSince(program)!)}`);
  }
  const blocked = program.tickets.filter((ticket) => ticket.state.kind === "blocked-on-owner" && ticket.state.askId === null);
  for (const ticket of blocked) if (ticket.state.kind === "blocked-on-owner") reasons.push(`${shortTicket(program, ticket.ref)} waits on you: ${clip(ticket.state.reason, 80)}`);
  return reasons.length === 0 ? null : `${program.id} ${clip(program.title, 50)}: ${reasons.join("; ")}`;
}

const STATE_WORDS: Record<TicketKind, string> = {
  "waiting-deps": "waiting on deps",
  ready: "ready",
  running: "running",
  "in-review": "in review",
  done: "done",
  "blocked-on-owner": "on the owner",
  dropped: "dropped",
};

function ticketDetail(ticket: Ticket, program: Program): string {
  const s = ticket.state;
  switch (s.kind) {
    case "waiting-deps": {
      const open = ticket.dependsOn.filter((ref) => program.tickets.find((t) => t.ref === ref && isOpenTicket(t)));
      return open.length > 0 ? ` on ${open.map((ref) => shortTicket(program, ref)).join(", ")}` : "";
    }
    case "running": return ` crew ${s.crewId}`;
    case "in-review": return ` ${s.pr}${s.crewId ? ` crew ${s.crewId}` : ""}`;
    case "done": return s.proof.by === "pr-merged" ? ` (${s.proof.pr} merged)` : " (issue closed)";
    case "blocked-on-owner": return `: ${clip(s.reason, 80)}${s.askId ? ` (ask ${s.askId})` : ""}`;
    case "dropped": return `: "${clip(s.ownerWords, 80)}"`;
    case "ready": return "";
    default: {
      const never: never = s;
      return String(never);
    }
  }
}

/** The program in full for the captain: its line, then one line per ticket. */
export function programText(program: Program, now: number): string {
  const head = `${program.id} ${programLine(program, now)}${program.taskId ? ` · task ${program.taskId}` : ""}${program.source ? ` · ${program.source}` : ""}${isOpenProgram(program) ? "" : " · closed"}`;
  const stall = programNeedsOwner(program, now);
  return [
    head,
    ...(stall ? [`Needs attention: ${stall}`] : []),
    ...program.tickets.map((ticket) => `- ${shortTicket(program, ticket.ref)} ${clip(ticket.title, 70)} — ${STATE_WORDS[ticket.state.kind]}${ticketDetail(ticket, program)}`),
  ].join("\n");
}

/** The one wake the captain gets when tickets become ready. */
export function readyWakeText(program: Program, refs: readonly TicketRef[]): string {
  const names = refs.map((ref) => shortTicket(program, ref));
  return `Program ${program.title} (${program.id}): ${names.length === 1 ? `ticket ${names[0]} is` : `tickets ${names.join(", ")} are`} ready; dispatch ${names.length === 1 ? "it" : "them"}. Pass ticket on each dispatch so the program tracks it. If one should wait, mark it with firstmate_program set.`;
}

export function stallReminderText(program: Program, now: number): string {
  const ready = readyRefs(program).map((ref) => shortTicket(program, ref));
  return `Program ${program.title} (${program.id}) has stalled: ${ready.join(", ")} ${ready.length === 1 ? "is" : "are"} ready and nothing has run for ${formatAge(now - stalledSince(program)!)}. ${programLine(program, now)}. Dispatch the ready tickets, or mark each one blocked or dropped with firstmate_program set. The owner sees this stall in the next digest.`;
}

type Database = {
  exec(sql: string): unknown;
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T>(fn: () => T): () => T;
};

export type Programs = {
  create(input: NewProgram): { program: Program; outside: string[] };
  get(id: string): Program | undefined;
  list(captain: string, scope?: { includeClosed?: boolean }): Program[];
  /** The open program that keeps this owner task open. */
  holding(taskId: string): Program | undefined;
  /** Apply facts in order, all or none. */
  apply(id: string, captain: string, facts: readonly ProgramFact[], at: number): Program;
  /** Change a program's bookkeeping (what was told, when GitHub was read) on its current record. */
  update(id: string, captain: string, change: (program: Program) => Program): Program;
};

export function createPrograms(db: Database): Programs {
  db.exec(`CREATE TABLE IF NOT EXISTS program (
    id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, captain TEXT NOT NULL, open INTEGER NOT NULL, task TEXT, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS program_captain ON program(captain, open);`);

  const parse = (row: { record: string }) => JSON.parse(row.record) as Program;

  function get(id: string): Program | undefined {
    const row = db.prepare("SELECT record FROM program WHERE id=?").get(id) as { record: string } | undefined;
    return row ? parse(row) : undefined;
  }

  function save(program: Program): Program {
    db.prepare("UPDATE program SET open=?, task=?, record=? WHERE id=?").run(isOpenProgram(program) ? 1 : 0, program.taskId, JSON.stringify(program), program.id);
    return program;
  }

  return {
    create(input) {
      return db.transaction(() => {
        // The same epic for the same captain is one program: creating it again returns it.
        const existing = input.source === null ? undefined
          : (db.prepare("SELECT record FROM program WHERE captain=? ORDER BY seq").all(input.captain) as { record: string }[]).map(parse).find((p) => p.source === input.source);
        if (existing) return { program: existing, outside: [] };
        const last = db.prepare("SELECT max(seq) AS seq FROM program").get() as { seq: number | null };
        const seq = (last.seq ?? 0) + 1;
        const built = buildProgram(`P${seq}`, input);
        db.prepare("INSERT INTO program VALUES (?,?,?,?,?,?)").run(built.program.id, seq, built.program.captain, isOpenProgram(built.program) ? 1 : 0, built.program.taskId, JSON.stringify(built.program));
        return built;
      })();
    },
    get,
    list(captain, scope = {}) {
      const rows = (scope.includeClosed
        ? db.prepare("SELECT record FROM program WHERE captain=? ORDER BY seq").all(captain)
        : db.prepare("SELECT record FROM program WHERE captain=? AND open=1 ORDER BY seq").all(captain)) as { record: string }[];
      return rows.map(parse);
    },
    holding(taskId) {
      const row = db.prepare("SELECT record FROM program WHERE task=? AND open=1 ORDER BY seq LIMIT 1").get(taskId) as { record: string } | undefined;
      return row ? parse(row) : undefined;
    },
    apply(id, captain, facts, at) {
      return update(id, captain, (program) => facts.reduce((current, fact) => applyFact(current, fact, at), program));
    },
    update,
  };

  function update(id: string, captain: string, change: (program: Program) => Program): Program {
    return db.transaction(() => {
      const program = get(id);
      if (!program || program.captain !== captain) throw new Error(`No program ${id} for this captain.`);
      const changed = change(program);
      return changed === program ? program : save(changed);
    })();
  }
}
