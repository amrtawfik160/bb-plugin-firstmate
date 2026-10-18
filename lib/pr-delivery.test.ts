import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { formatBoard } from "./owner-board.ts";
import { spawnSync } from "node:child_process";
import { boardPullRequests, createDeliveries, decisionLine, parseForge, PR_VIEW_JQ, prBranchOwner, type DeliveryRecord } from "./pr-delivery.ts";

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
    record(16, { status: "pr-delivered", verifiedCommitSha: "sha" }),
    record(17, { status: "needs-verification" }),
    record(18, { status: "merged-unverified", forgeState: "merged" }),
  ]);
  assert.deepEqual(rows.map((r) => [r.ref, r.title ?? null, r.state]), [
    ["acme/repo#1", null, "checks running"],
    ["acme/repo#2", null, "checks failed"],
    ["acme/repo#3", "Ship it", "ready to merge"],
    ["acme/repo#4", null, "ready to merge"],
    ["acme/repo#5", null, "ready to merge"],
    ["acme/repo#6", null, "not verified"],
    ["acme/repo#7", null, "waiting on you"],
    ["acme/repo#8", null, "draft"],
    ["acme/repo#9", null, "changes requested"],
    ["acme/repo#10", null, "ready to merge"],
    ["acme/repo#16", null, "ready to merge"],
    ["acme/repo#17", null, "not verified"],
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
  for (let pass = 0; pass < 2; pass++) verified(store, store.observe("hazw80801/runants#1759", parseForge(forge), false));
  store.observe("hazw80801/runants#1759", parseForge(forge), false);
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
  for (const answer of answers) verified(store, store.observe("hazw80801/runants#1759", parseForge(answer), false));
  return { store, board: boardOf(store) };
}
function verified(store: ReturnType<typeof createDeliveries>, r: DeliveryRecord) {
  if (r.forgeState === "open" && r.verifiedCommitSha !== r.headSha) store.verify(r.id, "thr_cap", r.headSha, { driven: "opened the routes in the browser", seen: "they render" });
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
  verified(store, store.observe("hazw80801/runants#1759", parseForge(runants1759(redo)), false));
  store.observe("hazw80801/runants#1759", parseForge(runants1759(redo)), false);
  assert.equal(stateOf(store), "ready to merge");
});

test("removing the hold label on the same head lifts the hold without a check, and a merge ends it", () => {
  const labelled = runants1759({ comments: [], labels: [{ name: "do-not-merge" }] });
  assert.match(boardAfter(labelled, runants1759({ comments: [] })).board, /^1\. PR \[runants#1759\]\(https:\/\/github\.com\/hazw80801\/runants\/pull\/1759\) style\(ui\): .* · ready to merge$/m);
  const merged = boardAfter(runants1759(), runants1759({ state: "MERGED", mergeCommit: { oid: "m1" } }));
  assert.equal(merged.store.get("hazw80801/runants#1759")?.status, "complete");
  assert.equal(merged.store.get("hazw80801/runants#1759")?.heldHead, null);
});

test("a PR branch belongs to the crew it is named after, then to the worktree it came from", () => {
  const crews = [
    { key: "a", taskId: "c7c70edb", envBranch: "bb/ship-audit-thr_a", checkedOut: ["fm/c7c70edb-agents", "main"] },
    { key: "b", taskId: "c7c70edb9", envBranch: "bb/ship-other-thr_b", checkedOut: ["fix/crash", "fm/c7c70edb-agents", "main"] },
  ];
  assert.equal(prBranchOwner("fm/c7c70edb", crews)?.key, "a");
  assert.equal(prBranchOwner("fm/c7c70edb-workflows", crews)?.key, "a", "a later branch of the same crew");
  assert.equal(prBranchOwner("fm/c7c70edb9-x", crews)?.key, "b", "the longest crew id wins");
  assert.equal(prBranchOwner("fm/c7c70edb-agents", crews)?.key, "a", "the name outranks another worktree that checked the branch out");
  assert.equal(prBranchOwner("bb/ship-other-thr_b-2", crews)?.key, "b");
  assert.equal(prBranchOwner("fix/crash", crews)?.key, "b");
  assert.equal(prBranchOwner("main", crews), undefined, "a default branch proves nothing");
  assert.equal(prBranchOwner("fm/c7c70edbx", crews), undefined);
  assert.equal(prBranchOwner("docs/elsewhere", crews), undefined);
});

test("an open PR untouched for 24 hours is due for a decision once per day, in one line with its link", () => {
  const store = createDeliveries(new DatabaseSync(":memory:") as never);
  const day = 86_400_000, now = 10 * day;
  store.save(record(1, { status: "pr-delivered", forgeState: "open", title: "Fix login", touchedAt: now - 3 * day - 1000 }));
  store.save(record(2, { status: "waiting-approval", forgeState: "open", touchedAt: now - 1000 }));
  store.save(record(3, { status: "complete", forgeState: "merged", touchedAt: now - 5 * day }));
  store.save(record(4, { status: "closed-needs-disposition", forgeState: "closed", touchedAt: now - 5 * day }));
  store.save(record(5, { status: "failing-checks", forgeState: "open", touchedAt: now - 2 * day, notification: { desired: "x", delivered: "x", queued: null, retryAt: 0, attemptedAt: now - 1000 } }));
  store.save(record(6, { status: "pr-delivered", forgeState: "open", owner: null, ownerNeeded: true, touchedAt: now - 5 * day }));
  const due = store.needingDecision(now);
  assert.deepEqual(due.map((r) => r.number), [1], "fresh, decided, just-notified and unmanaged PRs are left out");
  const line = decisionLine(due[0]!, now);
  assert.equal(line.includes("\n"), false);
  assert.match(line, /Fix login/); assert.match(line, /3 days/); assert.match(line, /https:\/\/github\.com\/acme\/repo\/pull\/1$/);
  store.markDecisionAsked([due[0]!.id], now);
  assert.deepEqual(store.needingDecision(now + day - 2000), []);
  assert.deepEqual(store.needingDecision(now + day).map((r) => r.number), [1, 5, 2], "asked again a day later, with the PRs that went quiet since");
});

test("a crew's undecided PRs are the open ones: merged, closed and abandoned PRs have a decision", () => {
  const store = createDeliveries(new DatabaseSync(":memory:") as never);
  store.save(record(1, { taskId: "c1", status: "pr-delivered", forgeState: "open" }));
  store.save(record(2, { taskId: "c1", status: "complete", forgeState: "merged" }));
  store.save(record(3, { taskId: "c1", status: "merged-needs-verification", forgeState: "merged" }));
  store.save(record(4, { taskId: "c1", status: "closed-needs-disposition", forgeState: "closed" }));
  store.save(record(5, { taskId: "c1", status: "explicitly-abandoned", forgeState: "open" }));
  store.save(record(6, { taskId: "c2", status: "waiting-checks" }));
  assert.deepEqual(store.undecided("c1", "proj_1").map((r) => r.number), [1]);
  assert.deepEqual(store.undecided("c2", "proj_1").map((r) => r.number), [6], "a PR not read on GitHub yet counts as open");
});

// 15 Oct: Cyndra PR 2315 (PR-only delivery) merged through gh in a release window with no
// verification record; its row went to complete with verifiedCommitSha null.
const HEAD_2315 = "1e13624758430744eab185a675a89e67f16d1c7f";
const MERGE_2315 = "bf33e4b58dd2c2a0b3e6ada3ed60104a3dfa44f0";
const seen = (over: Partial<Parameters<ReturnType<typeof createDeliveries>["observe"]>[1]> = {}) => ({
  headSha: HEAD_2315, state: "open" as const, draft: false, checks: "passing" as const, review: "approved" as const, reviewHeadSha: HEAD_2315,
  mergeCommitSha: null, mergeable: "mergeable" as const, ...over,
});
const track = (store: ReturnType<typeof createDeliveries>, requirement: DeliveryRecord["requirement"]) =>
  store.register({ url: "https://github.com/Cyndra-AI/cyndra-saas/pull/2315", taskId: "0940c38e", projectId: "proj_1", owner: "thr_pse43vv6tn", home: "/home", worker: "thr_crew", requirement });

test("a green PR without a verification record for its head is not merge-ready", () => {
  const store = createDeliveries(new DatabaseSync(":memory:") as never);
  const r = track(store, "merged");
  store.observe(r.id, seen(), true, 1);
  const green = store.observe(r.id, seen(), true, 2);
  assert.equal(green.status, "needs-verification");
  assert.match(green.blocker, /^No verification record for head 1e13624/);
  assert.match(green.nextAction, /CI and unit tests are not verification/);
  assert.deepEqual(boardPullRequests([green]).map((p) => p.state), ["not verified"]);
  assert.throws(() => store.verify(r.id, "thr_pse43vv6tn", "1e13624", { driven: "", seen: "CI green, 112 unit tests pass" }), /needs driven/);
  assert.throws(() => store.verify(r.id, "thr_pse43vv6tn", "abcdef0", { driven: "sent hello", seen: "a reply" }), /does not match the current head 1e13624/);
  const verified = store.verify(r.id, "thr_pse43vv6tn", "1e13624", { driven: "sent hello to the staging bot", seen: "the reply arrived" });
  assert.equal(verified.verifiedCommitSha, HEAD_2315);
  assert.equal(store.observe(r.id, seen(), true, 2).status, "ready-to-merge");
  const pushed = store.observe(r.id, seen({ headSha: "2222222222222222222222222222222222222222", reviewHeadSha: "2222222222222222222222222222222222222222" }), true, 3);
  assert.equal(pushed.verifiedCommitSha, null, "a new head drops the record");
  assert.equal(store.observe(r.id, seen({ headSha: pushed.headSha, reviewHeadSha: pushed.headSha }), true, 4).status, "needs-verification");
});

test("a PR-only delivery without a record shows not verified on the board", () => {
  const store = createDeliveries(new DatabaseSync(":memory:") as never);
  const r = track(store, "pr");
  const open = store.observe(r.id, seen(), false, 1);
  assert.equal(open.status, "pr-delivered");
  assert.deepEqual(boardPullRequests([open]).map((p) => p.state), ["not verified"]);
});

test("PR 2315 merged outside Firstmate without a record is merged-unverified, and the captain is told once", () => {
  const store = createDeliveries(new DatabaseSync(":memory:") as never);
  const r = track(store, "pr");
  store.observe(r.id, seen(), false, 1);
  const merged = store.observe(r.id, seen({ state: "merged", mergeCommitSha: MERGE_2315 }), false, 2);
  assert.equal(merged.status, "merged-unverified");
  assert.match(merged.blocker, /^Merged outside Firstmate with no verification record/);
  assert.notEqual(merged.notification.desired, null);
  const notice = merged.notification.desired;
  store.save({ ...store.get(r.id)!, notification: { ...store.get(r.id)!.notification, delivered: notice } });
  const later = store.observe(r.id, seen({ state: "merged", mergeCommitSha: MERGE_2315 }), false, 2 + 2 * 86_400_000);
  assert.equal(later.notification.desired, notice, "no repeat and no overdue notice");
  assert.ok(later.nextCheckAt >= 2 + 2 * 86_400_000 + 86_400_000 - 1, "a merged PR is not re-read every minute");
  assert.equal(store.verify(r.id, "thr_pse43vv6tn", "bf33e4b", { driven: "sent hello after the restart", seen: "the reply arrived" }).status, "complete");
});

test("a PR verified before merge, or merged with the owner's waiver, completes on merge", () => {
  const store = createDeliveries(new DatabaseSync(":memory:") as never);
  const r = track(store, "merged");
  store.observe(r.id, seen(), true, 1);
  store.verify(r.id, "thr_pse43vv6tn", HEAD_2315, { driven: "sent hello to the staging bot", seen: "the reply arrived" });
  assert.equal(store.observe(r.id, seen({ state: "merged", mergeCommitSha: MERGE_2315 }), true, 2).status, "complete");
  const other = createDeliveries(new DatabaseSync(":memory:") as never);
  const w = track(other, "merged");
  other.observe(w.id, seen(), true, 1);
  other.waive(w.id, "thr_pse43vv6tn", "ship it now, I will test on my phone", HEAD_2315);
  assert.equal(other.get(w.id)!.unverifiedMerge?.words, "ship it now, I will test on my phone");
  assert.equal(other.observe(w.id, seen({ state: "merged", mergeCommitSha: MERGE_2315 }), true, 2).status, "complete");
});

// 15 Oct: `gh pr view` for cyndra-saas 2322 returned 101,399 bytes (commits alone 83,705).
// The host reader keeps the last 64 KB, so every read since 13 Oct failed to parse.
test("the PR read keeps only what the observation uses, so a 100 KB answer fits the 64 KB host read", () => {
  const head = "c".repeat(40);
  const commits = Array.from({ length: 300 }, (_, i) => ({ oid: i === 299 ? head : String(i).padStart(40, "0"), committedDate: `2026-10-14T0${Math.floor(i / 100)}:00:00Z`,
    messageHeadline: "x".repeat(80), messageBody: "y".repeat(160), authors: [{ email: "a@b.c", name: "A", login: "a" }] }));
  const comments = Array.from({ length: 80 }, (_, i) => ({ author: { login: "a" }, createdAt: "2026-10-13T00:00:00Z", body: `${i} ${"z".repeat(3000)}` }));
  comments.push({ author: { login: "amrtawfik160" }, createdAt: "2026-10-14T09:00:00Z", body: "Do not merge: the redo still drops messages" });
  const full = {
    state: "MERGED", isDraft: false, headRefOid: head, title: "fix(runtime): Telegram", createdAt: "2026-10-13T00:00:00Z", updatedAt: "2026-10-14T10:00:00Z",
    statusCheckRollup: [{ name: "test", conclusion: "SUCCESS", detailsUrl: "https://ci" }], reviewDecision: "", reviews: [{ state: "COMMENTED", body: "w".repeat(5000), submittedAt: "2026-10-13T00:00:00Z", commit: { oid: head } }],
    mergeable: "UNKNOWN", mergeCommit: { oid: "ca784e614e9456093c8ec56c52b4bee6e06923d8" }, labels: [], comments, commits,
  };
  assert.ok(JSON.stringify(full).length > 100_000);
  const jq = spawnSync("jq", ["-c", PR_VIEW_JQ], { input: JSON.stringify(full), encoding: "utf8" });
  assert.equal(jq.status, 0, jq.stderr);
  assert.ok(jq.stdout.length < 65_536, `${jq.stdout.length} bytes`);
  const trimmed = parseForge(JSON.parse(jq.stdout));
  assert.deepEqual(trimmed, parseForge(full));
  assert.equal(trimmed.state, "merged");
  assert.equal(trimmed.mergeCommitSha, "ca784e614e9456093c8ec56c52b4bee6e06923d8");
  assert.equal(trimmed.hold, "Do not merge: the redo still drops messages");
});

// PR 129 review: a "Do not merge" after character 2,000 of a long comment was cut by the
// trim, so the hold disappeared.
test("a do-not-merge after character 2,000 of a comment or review still holds the PR after the trim", () => {
  const head = "a".repeat(40);
  const late = `${"Explanation of the redo. ".repeat(120)}Do not merge: the redo still drops messages`;
  for (const where of ["comments", "reviews"] as const) {
    const full = {
      state: "OPEN", isDraft: false, headRefOid: head, reviewDecision: "", mergeable: "MERGEABLE", labels: [], statusCheckRollup: [],
      commits: [{ committedDate: "2026-10-15T09:00:00Z" }],
      comments: where === "comments" ? [{ createdAt: "2026-10-15T10:00:00Z", body: late }] : [],
      reviews: where === "reviews" ? [{ state: "COMMENTED", submittedAt: "2026-10-15T10:00:00Z", commit: { oid: head }, body: late }] : [],
    };
    assert.ok(late.indexOf("Do not merge") > 2000);
    const jq = spawnSync("jq", ["-c", PR_VIEW_JQ], { input: JSON.stringify(full), encoding: "utf8" });
    assert.equal(jq.status, 0, jq.stderr);
    const hold = parseForge(JSON.parse(jq.stdout)).hold;
    assert.ok(parseForge(full).hold, where);
    assert.match(hold ?? "", /Do not merge: the redo still drops messages/, where);
  }
});

// PR 129 review: "All checks have passed" made a verification record; a word list cannot
// judge every wording. A record now takes two fields: what was driven and what was seen.
test("a verification record needs what was driven and what was seen; a CI sentence alone records nothing", () => {
  const store = createDeliveries(new DatabaseSync(":memory:") as never);
  const r = track(store, "merged");
  store.observe(r.id, seen(), true, 1);
  for (const evidence of [{ driven: "", seen: "All checks have passed" }, { driven: "the staging bot", seen: " " }, "All checks have passed"] as never[]) {
    assert.throws(() => store.verify(r.id, "thr_pse43vv6tn", "1e13624", evidence), /needs driven \(what you drove on the real changed surface\) and seen \(what you saw\)/);
  }
  assert.equal(store.get(r.id)!.verifiedCommitSha, null);
  const done = store.verify(r.id, "thr_pse43vv6tn", "1e13624", { driven: "sent hello to the staging bot", seen: "the reply arrived in 2 s" });
  assert.equal(done.verifiedCommitSha, HEAD_2315);
  assert.deepEqual({ ...done.verification!, at: 0 }, { crewId: null, actor: "thr_pse43vv6tn", commitSha: HEAD_2315, driven: "sent hello to the staging bot", seen: "the reply arrived in 2 s", at: 0 });
});

// PR 129 review: a waiver given for head A still counted after a push to head B, so an
// outside merge of B read complete instead of merged-unverified.
test("an owner waiver covers only the head it was given for", () => {
  const store = createDeliveries(new DatabaseSync(":memory:") as never);
  const r = track(store, "merged");
  store.observe(r.id, seen(), true, 1);
  store.waive(r.id, "thr_pse43vv6tn", "ship it now, I will test on my phone", HEAD_2315);
  const next = "2222222222222222222222222222222222222222";
  store.observe(r.id, seen({ headSha: next, reviewHeadSha: next }), true, 2);
  assert.equal(store.observe(r.id, seen({ headSha: next, reviewHeadSha: next, state: "merged", mergeCommitSha: MERGE_2315 }), true, 3).status, "merged-unverified");
});

test("a PR read unchanged is read less and less often, and any change or pending check brings it back to minutes", () => {
  const store = createDeliveries(new DatabaseSync(":memory:") as never);
  const r = store.register({ url: "https://github.com/acme/repo/pull/7", taskId: "c1", projectId: "p", owner: "thr_cap", home: "", worker: "thr_c1", requirement: "pr" });
  const seen = { headSha: "a1", state: "open", draft: false, checks: "passing", review: "approved", reviewHeadSha: "a1", mergeCommitSha: null, mergeable: "mergeable" } as const;
  let now = 1_000_000_000;
  const delays: number[] = [];
  for (let read = 0; read < 7; read++) { const next = store.observe(r.id, seen, false, now); delays.push((next.nextCheckAt - now) / 60_000); now = next.nextCheckAt; }
  assert.deepEqual(delays, [1, 2, 4, 8, 16, 30, 30], "minutes until the next read of a quiet PR");
  const pushed = store.observe(r.id, { ...seen, headSha: "b2", reviewHeadSha: "b2" }, false, now);
  assert.equal((pushed.nextCheckAt - now) / 60_000, 1, "a new head is read again within a minute");
  now = pushed.nextCheckAt;
  for (let read = 0; read < 5; read++) { const next = store.observe(r.id, { ...seen, headSha: "b2", checks: "pending" }, false, now); assert.ok(next.nextCheckAt - now <= 2 * 60_000, "pending checks are read at least every two minutes"); now = next.nextCheckAt; }
});
