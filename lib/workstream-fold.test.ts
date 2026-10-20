import assert from "node:assert/strict";
import test from "node:test";
import {
  archiveKeepReason,
  CARD_TASK_STATES,
  compactTaskLine,
  currentJobs,
  crewOwnTestsPassed,
  FAILED_KEEP_MS,
  foldedPrNote,
  foldedPrVerdict,
  foldTouchesDevFiles,
  formatWorkstreamLookup,
  isAdoptedWorkstream,
  jobToCardState,
  LOOKUP_MAX_LINES,
  memAvailableBytes,
  MEMORY_GUARD_BYTES,
  memoryIsLow,
  parseFoldOutput,
  workstreamCardInput,
} from "./workstream-fold.ts";

test("MemAvailable below 3 GB is low, and a missing line is refused", () => {
  assert.equal(memAvailableBytes("MemTotal: 8000000 kB\nMemAvailable: 3145728 kB\n"), MEMORY_GUARD_BYTES);
  assert.equal(memoryIsLow(MEMORY_GUARD_BYTES - 1), true);
  assert.equal(memoryIsLow(MEMORY_GUARD_BYTES), false);
  assert.throws(() => memAvailableBytes("MemTotal: 1 kB\n"), /MemAvailable missing/);
});

test("a crew folds only when its report records tests passing", () => {
  assert.equal(crewOwnTestsPassed(""), false);
  assert.equal(crewOwnTestsPassed("tests failed\n0 pass"), false);
  assert.equal(crewOwnTestsPassed("12 fail, 3 pass"), false);
  assert.equal(crewOwnTestsPassed("1995 pass, 0 fail, 23 skip"), true);
  assert.equal(crewOwnTestsPassed("All tests passed."), true);
});

test("package, lock, vite/next/tsconfig and env files restart the dev link", () => {
  assert.equal(foldTouchesDevFiles(["src/app.ts"]), false);
  assert.equal(foldTouchesDevFiles(["package.json"]), true);
  assert.equal(foldTouchesDevFiles(["apps/web/pnpm-lock.yaml"]), true);
  assert.equal(foldTouchesDevFiles(["vite.config.ts"]), true);
  assert.equal(foldTouchesDevFiles(["next.config.mjs"]), true);
  assert.equal(foldTouchesDevFiles(["tsconfig.json"]), true);
  assert.equal(foldTouchesDevFiles([".env.local"]), true);
});

test("job states map onto the status card, and lookup stays at 15 lines", () => {
  assert.equal(jobToCardState("queued"), "queued");
  assert.equal(jobToCardState("waiting-memory"), "waiting-memory");
  assert.equal(jobToCardState("running"), "working");
  assert.equal(jobToCardState("folding"), "folding");
  assert.equal(jobToCardState("folded"), "folded");
  assert.equal(jobToCardState("finished"), "folding");
  assert.equal(jobToCardState("finished", true), "folding");
  assert.equal(jobToCardState("finished", false), "folded");
  assert.equal(jobToCardState("failed"), "failed");
  assert.equal(jobToCardState("kept-unsaved"), "kept-unsaved");
  assert.equal(jobToCardState("dropped"), "dropped");
  assert.ok(CARD_TASK_STATES.includes("waiting-memory"));
  const lookup = formatWorkstreamLookup({
    task: "T3",
    title: "Restyle composer",
    brief: "Change the composer tokens.\nMore brief than a card needs.",
    report: Array.from({ length: 20 }, (_, i) => `line ${i} of the last crew report`).join("\n"),
    files: ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts"],
  });
  assert.equal(lookup.split("\n").length <= LOOKUP_MAX_LINES, true);
  assert.match(lookup, /^T3 Restyle composer/);
  assert.match(lookup, /brief:/);
  assert.equal(compactTaskLine({ id: "T3", title: "Restyle composer", model: "gpt-6.1-sol", state: "working" }), "T3 Restyle composer gpt-6.1-sol working");
});

test("adopted workstreams are the ones with requestTaskIds or existing repos", () => {
  assert.equal(isAdoptedWorkstream({ repos: [] }), false);
  assert.equal(isAdoptedWorkstream({ requestTaskIds: ["T1"], repos: [] }), true);
  assert.equal(isAdoptedWorkstream({ repos: [{ existing: true }] }), true);
  assert.equal(FAILED_KEEP_MS, 7 * 24 * 60 * 60_000);
});

test("fold output names changed files, and a conflict is not a success", () => {
  assert.deepEqual(parseFoldOutput("FOLD_OK\npackage.json\nsrc/app.ts\n"), { ok: true, conflict: false, files: ["package.json", "src/app.ts"] });
  assert.deepEqual(parseFoldOutput("FOLD_CONFLICT\n"), { ok: false, conflict: true, files: [] });
});

test("the status card payload clips title, model and note and keeps revision", () => {
  const payload = workstreamCardInput({
    workstreamId: "ws-1",
    revision: 4,
    tasks: [{ task: "T1", title: "x".repeat(90), model: "m".repeat(50), state: "working", note: "n".repeat(140) }],
  });
  assert.equal(payload.revision, 4);
  assert.equal(payload.tasks[0]!.title.length, 80);
  assert.equal(payload.tasks[0]!.model.length, 40);
  assert.equal(payload.tasks[0]!.note?.length, 120);
});

test("the status card payload sends only T<n> task IDs of at most 24 characters", () => {
  const payload = workstreamCardInput({
    workstreamId: "ws-1",
    revision: 1,
    tasks: [
      { task: "editor-two", title: "crew before its task attaches", model: "m", state: "working" },
      { task: "T2", title: "attached", model: "m", state: "working" },
      { task: `T${"9".repeat(24)}`, title: "too long", model: "m", state: "queued" },
    ],
  });
  assert.deepEqual(payload.tasks.map((task) => task.task), ["T2"]);
});

test("fold output separates a safe wait from a conflict, and reads the new head", () => {
  assert.deepEqual(parseFoldOutput("FOLD_WAIT the workstream worktree has staged changes\n"), { ok: false, conflict: false, files: [], wait: "the workstream worktree has staged changes" });
  assert.deepEqual(parseFoldOutput("FOLD_HEAD abc1234\nFOLD_OK\na.ts\n"), { ok: true, conflict: false, files: ["a.ts"], head: "abc1234" });
});

test("the card and view take the latest job of each task, and a kept worktree shows on the card", () => {
  const jobs = [{ id: "a", taskId: "T1" }, { id: "b" }, { id: "c", taskId: "T1" }, { id: "d", taskId: "T2" }];
  assert.deepEqual(currentJobs(jobs).map((job) => job.id), ["b", "c", "d"]);
  assert.equal(jobToCardState("folded", true, "kept-unsaved"), "kept-unsaved");
  assert.equal(jobToCardState("folded", true, "pending"), "folded");
  assert.equal(compactTaskLine({ id: "T1", title: "Two\nlines", model: "m\n1", state: "working" }), "T1 Two lines m 1 working");
});

test("a crew is archived only when nothing still needs it", () => {
  const idle = { id: "thr", status: "idle", busy: false, archived: false, children: 0, dependents: 0 };
  const clear = { threads: [idle], parentRunning: false, others: [], heldBy: [] };
  assert.equal(archiveKeepReason(clear), null);
  assert.match(archiveKeepReason({ ...clear, threads: [{ ...idle, status: "active" }] })!, /still working/);
  assert.match(archiveKeepReason({ ...clear, threads: [{ ...idle, status: "unknown" }] })!, /still working/);
  assert.match(archiveKeepReason({ ...clear, threads: [{ ...idle, busy: true }] })!, /still working/);
  assert.match(archiveKeepReason({ ...clear, parentRunning: true })!, /captain/);
  assert.match(archiveKeepReason({ ...clear, threads: [{ ...idle, children: 1 }] })!, /child threads/);
  assert.match(archiveKeepReason({ ...clear, threads: [{ ...idle, dependents: 1 }] })!, /child threads/);
  assert.match(archiveKeepReason({ ...clear, others: ["thr_retry"] })!, /shared with thr_retry/);
  assert.match(archiveKeepReason({ ...clear, heldBy: ["task T2"] })!, /still used by task T2/);
  assert.equal(archiveKeepReason({ ...clear, threads: [{ ...idle, status: "active", archived: true }] }), null);
});

test("a fold disposes a task PR only when its head is the task branch and the workstream branch holds every commit", () => {
  const pr = { state: "CLOSED", headRefName: "task/one", headRefOid: "c", commits: ["a", "b", "c"] };
  const all = new Set(["a", "b", "c"]);
  assert.deepEqual(foldedPrVerdict(pr, ["task/one"], all), { action: "dispose" });
  assert.deepEqual(foldedPrVerdict({ ...pr, state: "OPEN" }, ["task/one"], all), { action: "dispose" });
  assert.deepEqual(foldedPrVerdict(pr, ["task/one"], new Set(["a", "b"])), { action: "keep", reason: "1 of 3 commits are not in the workstream branch" });
  assert.deepEqual(foldedPrVerdict({ ...pr, headRefOid: "d" }, ["task/one"], all), { action: "keep", reason: "1 of 4 commits are not in the workstream branch" }, "the PR head counts too");
  assert.deepEqual(foldedPrVerdict({ ...pr, state: "MERGED" }, ["task/one"], all), { action: "keep", reason: "it is merged" });
  assert.deepEqual(foldedPrVerdict({ ...pr, headRefName: "workstream/ws-1" }, ["task/one"], all), { action: "keep", reason: "its head workstream/ws-1 is not this task's branch" });
  assert.deepEqual(foldedPrVerdict({ ...pr, commits: [] }, ["task/one"], all), { action: "keep", reason: "its commits could not be read" });
  assert.equal(foldedPrNote("Cyndra SaaS UI", null), "Folded into workstream Cyndra SaaS UI; its commits ship in the workstream PR when it is opened.");
  assert.equal(foldedPrNote("Cyndra SaaS UI", "https://github.com/acme/repo/pull/9"), "Folded into workstream Cyndra SaaS UI; its commits ship in the workstream PR https://github.com/acme/repo/pull/9.");
});
