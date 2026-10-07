import assert from "node:assert/strict";
import test from "node:test";
import { boardPullRequests, type DeliveryRecord } from "./pr-delivery.ts";

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
    ["acme/repo#2", null, "checks failing"],
    ["acme/repo#3", "Ship it", "ready to merge"],
    ["acme/repo#4", null, "ready to merge"],
    ["acme/repo#5", null, "waiting for review"],
    ["acme/repo#6", null, "waiting for review"],
    ["acme/repo#7", null, "waiting on you"],
    ["acme/repo#8", null, "draft"],
    ["acme/repo#9", null, "changes requested"],
    ["acme/repo#10", null, "waiting for review"],
  ]);
});

test("a PR's age on the board comes from GitHub when known", () => {
  const [known, unknown] = boardPullRequests([record(1, { openedAt: 500 }), record(2)]);
  assert.equal(known!.openedAt, 500);
  assert.equal(unknown!.openedAt, 1_002);
});
