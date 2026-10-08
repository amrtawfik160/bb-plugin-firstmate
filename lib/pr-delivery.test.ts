import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { formatBoard } from "./owner-board.ts";
import { boardPullRequests, createDeliveries, parseForge, type DeliveryRecord } from "./pr-delivery.ts";

function record(n: number, over: Partial<DeliveryRecord> = {}): DeliveryRecord {
  return {
    id: `acme/repo#${n}`, repository: "acme/repo", number: n, url: `https://github.com/acme/repo/pull/${n}`, headSha: "sha", mergeCommitSha: null,
    taskId: `t${n}`, projectId: "proj_1", owner: "thr_cap", home: "", workers: [], requirement: "merged", status: "waiting-checks",
    blocker: "", nextAction: "", nextCheckAt: 0, observedAt: null, freshness: "fresh", error: null, errors: 0, ownerNeeded: false,
    verifiedCommitSha: null, disposition: null, notification: { desired: null, delivered: null, queued: null, retryAt: 0 },
    actionDueAt: 0, updatedAt: 1_000 + n, ...over,
  };
}

test("each tracked PR status maps to one plain board state, and finished PRs are left out", () => {
  const rows = boardPullRequests([
    record(1, { status: "waiting-checks" }),
    record(2, { status: "failing-checks" }),
    record(3, { status: "ready-to-merge", title: "Ship it" }),
    record(4, { status: "waiting-approval" }),
    record(5, { status: "waiting-review" }),
    record(6, { status: "pr-delivered" }),
    record(7, { status: "failing-checks", ownerNeeded: true }),
    record(8, { status: "draft" }),
    record(9, { status: "changes-requested" }),
    record(10, { status: "waiting-native-gates" }),
    record(11, { status: "merged-needs-verification" }),
    record(12, { status: "closed-needs-disposition" }),
    record(13, { status: "complete" }),
    record(14, { status: "explicitly-abandoned" }),
    record(15, { status: "pr-delivered", forgeState: "merged" }),
  ]);
  assert.deepEqual(rows.map((r) => [r.ref, r.title ?? null, r.state]), [
    ["acme/repo#1", null, "checks running"],
    ["acme/repo#2", null, "checks failed"],
    ["acme/repo#3", "Ship it", "ready to merge"],
    ["acme/repo#4", null, "ready to merge"],
    ["acme/repo#5", null, "ready to merge"],
    ["acme/repo#6", null, "ready to merge"],
    ["acme/repo#7", null, "waiting on you"],
    ["acme/repo#8", null, "draft"],
    ["acme/repo#9", null, "changes requested"],
    ["acme/repo#10", null, "ready to merge"],
  ]);
});

test("a PR's age on the board comes from GitHub when known", () => {
  const [known, unknown] = boardPullRequests([record(1, { openedAt: 500 }), record(2)]);
  assert.equal(known!.openedAt, 500);
  assert.equal(unknown!.openedAt, 1_002);
});

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

/** GitHub's answer for hazw80801/runants#1759 on Oct 7: green, mergeable, and the captain's do-not-merge comment. */
function runants1759(over: Record<string, unknown> = {}) {
  return {
    headRefOid: "3ef8a02", state: "OPEN", isDraft: false, mergeable: "MERGEABLE", reviewDecision: "", reviews: [],
    statusCheckRollup: [{ conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }, { conclusion: "SUCCESS" }],
    title: "style(ui): restyle empty states and surfaces toward Shopify admin look", createdAt: "2026-10-07T16:17:52Z",
    commits: [{ oid: "3ef8a02", committedDate: "2026-10-07T16:15:00Z" }],
    labels: [],
    comments: [{ author: { login: "amrtawfik160" }, createdAt: "2026-10-07T18:35:27Z", body: "Not ready: the first screenshots were mock pages, not the real app. The worker is redoing the restyle on real routes. Do not merge yet." }],
    ...over,
  };
}

function boardFor(forge: Record<string, unknown>): string {
  const store = createDeliveries(db() as never);
  store.register({ url: "https://github.com/hazw80801/runants/pull/1759", taskId: "runants-shopify-ui", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_crew" });
  for (let pass = 0; pass < 2; pass++) store.observe("hazw80801/runants#1759", parseForge(forge), false);
  return boardOf(store);
}

/** The owner's board for these records, with nothing else on it. */
function boardOf(store: ReturnType<typeof createDeliveries>): string {
  return formatBoard({ asks: [], calls: [], tasks: [], records: store.list({ owner: "thr_cap" }), since: 0, now: 0 });
}

/** The single PR's plain board state. */
const stateOf = (store: ReturnType<typeof createDeliveries>) => boardPullRequests(store.list({ owner: "thr_cap" }))[0]!.state;

test("a green PR with a do-not-merge comment on its current head is on hold, not ready to merge", () => {
  assert.equal(boardFor(runants1759()), [
    "📌 Needs you: nothing right now.",
    "",
    "✅ Done since you last looked: nothing new.",
    "",
    "🔧 In progress: nothing open.",
    "Other PRs: [runants#1759](https://github.com/hazw80801/runants/pull/1759) on hold",
  ].join("\n"));
});

test("a do-not-merge label holds the PR whatever its head", () => {
  assert.match(boardFor(runants1759({ comments: [], labels: [{ name: "do-not-merge" }] })), /^Other PRs: \[runants#1759\]\(https:\/\/github\.com\/hazw80801\/runants\/pull\/1759\) on hold$/m);
});

test("a new commit after the do-not-merge comment lifts the hold, and an approval comment does not hold", () => {
  assert.match(boardFor(runants1759({ commits: [{ oid: "3ef8a02", committedDate: "2026-10-07T19:00:00Z" }] })), /^1\. PR \[runants#1759\]\(https:\/\/github\.com\/hazw80801\/runants\/pull\/1759\) style\(ui\): .* · ready to merge$/m);
  assert.match(boardFor(runants1759({ comments: [{ author: { login: "amrtawfik160" }, createdAt: "2026-10-07T18:35:27Z", body: "Checked on the real app. Merge it." }] })), /^1\. PR \[runants#1759\]\(https:\/\/github\.com\/hazw80801\/runants\/pull\/1759\) style\(ui\): .* · ready to merge$/m);
});

/** Observe each GitHub answer in turn for #1759, as the follow-up sweep does, and return the board after the last. */
function boardAfter(...answers: Record<string, unknown>[]): { board: string; store: ReturnType<typeof createDeliveries> } {
  const store = createDeliveries(db() as never);
  store.register({ url: "https://github.com/hazw80801/runants/pull/1759", taskId: "runants-shopify-ui", projectId: "proj_1", owner: "thr_cap", home: "", worker: "thr_crew" });
  for (const answer of answers) store.observe("hazw80801/runants#1759", parseForge(answer), false);
  return { store, board: boardOf(store) };
}
const redo = { headRefOid: "9c41d07", commits: [{ oid: "3ef8a02", committedDate: "2026-10-07T16:15:00Z" }, { oid: "9c41d07", committedDate: "2026-10-07T20:10:00Z" }] };

test("a held PR that gets new commits needs a captain check before it can show ready to merge", () => {
  const { board, store } = boardAfter(runants1759(), runants1759(redo), runants1759(redo));
  assert.equal(board, [
    "📌 Needs you: nothing right now.",
    "",
    "✅ Done since you last looked: nothing new.",
    "",
    "🔧 In progress: nothing open.",
    "Other PRs: [runants#1759](https://github.com/hazw80801/runants/pull/1759) changed since hold, needs a check",
  ].join("\n"));
  assert.throws(() => store.clearHold("hazw80801/runants#1759", "thr_cap", " "), /needs a reason/);
  store.clearHold("hazw80801/runants#1759", "thr_cap", "Checked the redo on the real routes");
  store.observe("hazw80801/runants#1759", parseForge(runants1759(redo)), false);
  assert.equal(stateOf(store), "ready to merge");
});

test("removing the hold label on the same head lifts the hold without a check, and a merge ends it", () => {
  const labelled = runants1759({ comments: [], labels: [{ name: "do-not-merge" }] });
  assert.match(boardAfter(labelled, runants1759({ comments: [] })).board, /^1\. PR \[runants#1759\]\(https:\/\/github\.com\/hazw80801\/runants\/pull\/1759\) style\(ui\): .* · ready to merge$/m);
  const merged = boardAfter(runants1759(), runants1759({ ...redo, state: "MERGED", mergeCommit: { oid: "m1" } }));
  assert.equal(merged.store.get("hazw80801/runants#1759")?.status, "complete");
  assert.equal(merged.store.get("hazw80801/runants#1759")?.heldHead, null);
});
