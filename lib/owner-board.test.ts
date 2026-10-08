import assert from "node:assert/strict";
import test from "node:test";
import type { OwnerAsk } from "./owner-asks.ts";
import { BOARD_MAX_CHARS, formatBoard, formatDigest, type BoardInput } from "./owner-board.ts";
import type { OwnerTask } from "./owner-tasks.ts";
import type { DeliveryRecord } from "./pr-delivery.ts";

const NOW = Date.UTC(2026, 9, 7, 12, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const SINCE = NOW - 12 * HOUR;

function ask(over: Partial<OwnerAsk> & Pick<OwnerAsk, "id" | "text">): OwnerAsk {
  return {
    captain: "thr_cap", kind: "question", options: [], recommended: null, defaultAt: null, irreversible: false,
    state: "open", resolution: null, createdAt: NOW - 5 * MIN, resolvedAt: null, ...over,
  };
}

function task(id: string, over: Partial<OwnerTask> = {}): OwnerTask {
  return {
    id, captain: "thr_cap", project: null, title: `Task ${id}`, sourceRefs: [], state: "working", prs: [], crewIds: [],
    backfilled: false, createdAt: NOW - HOUR, updatedAt: NOW - HOUR, ...over,
  };
}

function pr(id: string, over: Partial<DeliveryRecord> = {}): DeliveryRecord {
  const [repository, number] = id.split("#") as [string, string];
  return {
    id, repository, number: Number(number), url: `https://github.com/${repository}/pull/${number}`, headSha: "sha", mergeCommitSha: null,
    taskId: `crew-${number}`, projectId: "proj_1", owner: "thr_cap", home: "", workers: [], requirement: "merged", status: "waiting-checks",
    blocker: "", nextAction: "", nextCheckAt: 0, observedAt: null, freshness: "fresh", error: null, errors: 0, ownerNeeded: false,
    verifiedCommitSha: null, disposition: null, notification: { desired: null, delivered: null, queued: null, retryAt: 0 },
    actionDueAt: 0, updatedAt: NOW - HOUR, ...over,
  };
}

const merged = (id: string, over: Partial<DeliveryRecord> = {}) => pr(id, { status: "complete", forgeState: "merged", mergeCommitSha: "m1", ...over });

const input = (over: Partial<BoardInput> = {}): BoardInput => ({ asks: [], calls: [], tasks: [], records: [], since: SINCE, now: NOW, ...over });

/** The Oct 7 board: nothing asked, one task ready, two still running, several finished overnight. */
function liveLike(): BoardInput {
  return input({
    tasks: [
      task("T1", { project: "Areliaa", title: "Fix the Metricool sync", createdAt: NOW - 50 * HOUR, updatedAt: NOW - 50 * HOUR }),
      task("T7", { project: "Areliaa", title: "Agent group chats part 2", state: "merged", prs: ["amrtawfik160/areliaa#281", "amrtawfik160/areliaa#282"], createdAt: NOW - 30 * HOUR, updatedAt: NOW - 2 * HOUR }),
      task("T9", { title: "Old cleanup", state: "done", createdAt: NOW - 40 * HOUR, updatedAt: NOW - 20 * HOUR }),
      task("T13", { project: "RunAnts", title: "Improve RunAnts UI to look like Shopify, with screenshots", crewIds: ["runants-shopify-ui"], createdAt: NOW - 5 * HOUR, updatedAt: NOW - HOUR }),
      task("T14", { title: "Weekly email test to amr@cyndra.ai", state: "done", createdAt: NOW - 20 * HOUR, updatedAt: NOW - 3 * HOUR }),
      task("T15", { project: "Cyndra", title: "Memory screen", state: "ready", prs: ["cyndra-ai/cyndra-saas#2115"], createdAt: NOW - 4 * HOUR, updatedAt: NOW - 30 * MIN }),
      task("T16", { title: "Brands audit", state: "dropped", dropReason: "Owner moved the audit to next week", createdAt: NOW - 6 * HOUR, updatedAt: NOW - 4 * HOUR }),
    ],
    records: [
      merged("amrtawfik160/areliaa#281", { updatedAt: NOW - 2 * HOUR }),
      merged("amrtawfik160/areliaa#282", { updatedAt: NOW - 2 * HOUR }),
      pr("hazw80801/runants#1759", { taskId: "runants-shopify-ui", status: "on-hold", title: "style(ui): restyle empty states" }),
      pr("cyndra-ai/cyndra-saas#2115", { status: "ready-to-merge", title: "Memory screen" }),
      pr("hazw80801/runants#1770", { status: "ready-to-merge", title: "Fix the checkout total rounding on the cart page and the receipt", openedAt: NOW - 3 * HOUR }),
      pr("hazw80801/runants#1771", { status: "waiting-checks", title: "Bump deps", openedAt: NOW - 2 * HOUR }),
      merged("amrtawfik160/areliaa#283", { title: "Bump the email template", updatedAt: NOW - HOUR }),
      merged("amrtawfik160/areliaa#270", { title: "Merged before you last looked", updatedAt: SINCE - 1 }),
    ],
  });
}

test("the board shows what needs the owner, what finished since they last looked, and what is still running", () => {
  assert.equal(formatBoard(liveLike()), [
    "📌 Needs you (2)",
    "1. T15 Cyndra · Memory screen · ready for you · 4 h · [cyndra-saas#2115](https://github.com/cyndra-ai/cyndra-saas/pull/2115) ready to merge",
    "2. PR [runants#1770](https://github.com/hazw80801/runants/pull/1770) Fix the checkout total rounding on the cart page… · ready to merge",
    "",
    "✅ Done since you last looked (4)",
    "- T7 Areliaa · Agent group chats part 2 · merged",
    "- T14 Weekly email test to amr@cyndra.ai · done",
    "- T16 Brands audit · dropped: Owner moved the audit to next week",
    "- PR [areliaa#283](https://github.com/amrtawfik160/areliaa/pull/283) Bump the email template · merged",
    "",
    "🔧 In progress (2)",
    "- T1 Areliaa · Fix the Metricool sync · 2 d · stale 2 d",
    "- T13 RunAnts · Improve RunAnts UI to look like Shopify, with screenshots · 5 h · [runants#1759](https://github.com/hazw80801/runants/pull/1759) on hold",
    "Other PRs: [runants#1771](https://github.com/hazw80801/runants/pull/1771) checks running",
  ].join("\n"));
});

test("an empty board is three short lines", () => {
  assert.equal(formatBoard(input()), [
    "📌 Needs you: nothing right now.",
    "",
    "✅ Done since you last looked: nothing new.",
    "",
    "🔧 In progress: nothing open.",
  ].join("\n"));
});

test("with no task running, open pull requests still show under the empty In progress line", () => {
  assert.equal(formatBoard(input({ records: [pr("acme/web#7", { status: "failing-checks" }), pr("acme/repo#9", { status: "draft", openedAt: NOW - 2 * HOUR })] })), [
    "📌 Needs you: nothing right now.",
    "",
    "✅ Done since you last looked: nothing new.",
    "",
    "🔧 In progress: nothing open.",
    "Other PRs: [repo#9](https://github.com/acme/repo/pull/9) draft; [web#7](https://github.com/acme/web/pull/7) checks failed",
  ].join("\n"));
});

test("Needs you lists open asks oldest first, then crew items, then tasks and PRs, with the answer hint", () => {
  const text = formatBoard(input({
    asks: [
      ask({ id: "a000002", kind: "approval", text: "Deploy billing to production?", createdAt: NOW - 3 * HOUR, irreversible: true, options: [{ label: "Deploy", value: "deploy" }], recommended: 0 }),
      ask({ id: "a000001", kind: "question", text: "Dark   mode\nby default?", options: [{ label: "Yes", value: "yes" }, { label: "No", value: "no" }], recommended: 1, defaultAt: Date.UTC(2026, 9, 7, 16, 0), messageUrl: "https://t.me/c/200/3004" }),
      ask({ id: "a000003", kind: "blocker", text: "q".repeat(300), createdAt: NOW - 30_000 }),
      ask({ id: "a000004", text: "closed", state: "answered" }),
    ],
    calls: ["x".repeat(200)],
    tasks: [task("T3", { state: "needs_you", title: "Pick the pricing page copy", createdAt: NOW - 30 * HOUR, updatedAt: NOW - 25 * HOUR })],
    records: [pr("acme/repo#4", { status: "failing-checks", ownerNeeded: true, title: "Lost manager" })],
  }));
  assert.equal(text, [
    "📌 Needs you (6)",
    "1. ✅ Deploy billing to production? (3 h, ask a000002) Recommended: Deploy.",
    "2. ❓ Dark mode by default? (5 min, ask a000001) Recommended: No. Auto at 16:00 UTC. https://t.me/c/200/3004",
    `3. ⛔ ${"q".repeat(139)}… (0 min, ask a000003)`,
    `4. ${"x".repeat(159)}…`,
    "5. T3 Pick the pricing page copy · needs you · 30 h · stale 25 h",
    "6. PR [repo#4](https://github.com/acme/repo/pull/4) Lost manager · waiting on you",
    "Tap a question's button or reply to it to answer.",
    "",
    "✅ Done since you last looked: nothing new.",
    "",
    "🔧 In progress: nothing open.",
  ].join("\n"));
});

test("Needs you shows 15 items and Done shows 8, each with a true count", () => {
  const text = formatBoard(input({
    calls: Array.from({ length: 18 }, (_, i) => `call ${i + 1}`),
    tasks: Array.from({ length: 10 }, (_, i) => task(`T${i + 1}`, { state: "done", updatedAt: NOW - (i + 1) * MIN })),
  }));
  assert.equal(text, [
    "📌 Needs you (18)",
    ...Array.from({ length: 15 }, (_, i) => `${i + 1}. call ${i + 1}`),
    "…and 3 more",
    "",
    "✅ Done since you last looked (10)",
    ...Array.from({ length: 8 }, (_, i) => `- T${i + 1} Task T${i + 1} · done`),
    "…and 2 more",
    "",
    "🔧 In progress: nothing open.",
  ].join("\n"));
});

test("an overfull board drops In progress lines first and keeps every Needs you item", () => {
  const tasks = Array.from({ length: 60 }, (_, i) => task(`T${i + 1}`, { project: "RunAnts", title: `Rework screen ${i + 1} ${"w".repeat(80)}` }));
  const text = formatBoard(input({ asks: [ask({ id: "a000001", text: "Ship it?" })], calls: ["? d1 :: Use Postgres? (yes / no)"], tasks }));
  const line = (n: number) => `- T${n} RunAnts · Rework screen ${n} ${"w".repeat(60 - `Rework screen ${n} `.length - 1)}… · 1 h`;
  const head = [
    "📌 Needs you (2)",
    "1. ❓ Ship it? (5 min, ask a000001)",
    "2. ? d1 :: Use Postgres? (yes / no)",
    "Tap a question's button or reply to it to answer.",
    "",
    "✅ Done since you last looked: nothing new.",
    "",
    "🔧 In progress (60)",
  ];
  const board = (kept: number) => [...head, ...Array.from({ length: kept }, (_, i) => line(i + 1)), `…and ${60 - kept} more`].join("\n");
  const kept = Array.from({ length: 60 }, (_, i) => i).findLast((n) => board(n).length <= BOARD_MAX_CHARS)!;
  assert.ok(kept > 0 && kept < 60);
  assert.equal(text, board(kept));
  assert.ok(text.length <= BOARD_MAX_CHARS, String(text.length));
});

test("every PR on the board links to its GitHub page under its short name", () => {
  assert.equal(formatBoard(input({
    tasks: [task("T2", { project: "Cyndra", title: "Memory screen", prs: ["cyndra-ai/cyndra-saas#2146"] })],
    records: [
      pr("cyndra-ai/cyndra-saas#2140", { status: "failing-checks", ownerNeeded: true, title: "Lost manager" }),
      pr("cyndra-ai/cyndra-saas#2146", { status: "waiting-review" }),
      merged("amrtawfik160/areliaa#283", { title: "Bump the email template" }),
      pr("hazw80801/runants#1771", { status: "draft" }),
    ],
  })), [
    "📌 Needs you (1)",
    "1. PR [cyndra-saas#2140](https://github.com/cyndra-ai/cyndra-saas/pull/2140) Lost manager · waiting on you",
    "",
    "✅ Done since you last looked (1)",
    "- PR [areliaa#283](https://github.com/amrtawfik160/areliaa/pull/283) Bump the email template · merged",
    "",
    "🔧 In progress (1)",
    "- T2 Cyndra · Memory screen · 1 h · [cyndra-saas#2146](https://github.com/cyndra-ai/cyndra-saas/pull/2146) ready to merge",
    "Other PRs: [runants#1771](https://github.com/hazw80801/runants/pull/1771) draft",
  ].join("\n"));
});

test("the board limit counts what the owner sees, so long link addresses drop nothing", () => {
  const records = Array.from({ length: 15 }, (_, i) => pr(`acme/repo#${i + 1}`, { ownerNeeded: true, url: `https://github.com/acme/repo/pull/${i + 1}?${"q".repeat(300)}`, openedAt: NOW - (15 - i) * MIN }));
  const text = formatBoard(input({ records }));
  assert.ok(text.length > BOARD_MAX_CHARS, String(text.length));
  assert.equal(text, [
    "📌 Needs you (15)",
    ...records.map((r, i) => `${i + 1}. PR [repo#${i + 1}](${r.url}) · waiting on you`),
    "",
    "✅ Done since you last looked: nothing new.",
    "",
    "🔧 In progress: nothing open.",
  ].join("\n"));
  const digest = formatDigest(input({ records }));
  assert.ok(!digest.includes("]("), digest);
  assert.match(digest, /^1\. PR repo#1 · waiting on you$/m);
});

test("the digest lists what needs the owner, what finished, and which tasks went quiet", () => {
  const live = liveLike();
  const text = formatDigest({ ...live, tasks: [...live.tasks, task("T20", { state: "needs_you", title: "Quiet one", createdAt: NOW - 30 * HOUR, updatedAt: NOW - 30 * HOUR })] });
  assert.equal(text, [
    "Needs you (3)",
    "1. T15 Cyndra · Memory screen · ready for you · 4 h · cyndra-saas#2115 ready to merge",
    "2. T20 Quiet one · needs you · 30 h · stale 30 h",
    "3. PR runants#1770 Fix the checkout total rounding on the cart page… · ready to merge",
    "",
    "Done (4)",
    "- T7 Areliaa · Agent group chats part 2 · merged",
    "- T14 Weekly email test to amr@cyndra.ai · done",
    "- T16 Brands audit · dropped: Owner moved the audit to next week",
    "- PR areliaa#283 Bump the email template · merged",
    "",
    "Stale (2): T1, T20",
  ].join("\n"));
});

test("the digest caps Needs you at 5 and stale ids at 15, and skips empty blocks", () => {
  const tasks = Array.from({ length: 17 }, (_, i) => task(`T${i + 1}`, { updatedAt: NOW - 25 * HOUR }));
  assert.equal(formatDigest(input({ calls: Array.from({ length: 7 }, (_, i) => `call ${i + 1}`), tasks })), [
    "Needs you (7)",
    ...Array.from({ length: 5 }, (_, i) => `${i + 1}. call ${i + 1}`),
    "…and 2 more",
    "",
    `Stale (17): ${Array.from({ length: 15 }, (_, i) => `T${i + 1}`).join(", ")}, …`,
  ].join("\n"));
});

test("the digest is empty when nothing needs the owner, nothing finished, and nothing is stale", () => {
  assert.equal(formatDigest(input({ tasks: [task("T1")], records: [pr("acme/repo#1"), merged("acme/repo#2", { updatedAt: SINCE - 1 })] })), "");
});

test("Oct 8 repro: PR words say what the PR needs, and nobody is told a PR waits for their review", () => {
  const prs = [
    pr("cyndra-ai/cyndra-saas#2163", { taskId: "perf-7", status: "waiting-native-gates" }),
    pr("cyndra-ai/cyndra-saas#2164", { taskId: "perf-1", status: "waiting-review" }),
    pr("cyndra-ai/cyndra-saas#2167", { taskId: "perf-5", status: "waiting-checks" }),
    pr("cyndra-ai/cyndra-saas#2168", { taskId: "perf-5", status: "failing-checks" }),
    pr("hazw80801/runants#1759", { taskId: "runants-ui", status: "changed-since-hold" }),
    pr("hazw80801/runants#1760", { taskId: "runants-ui", status: "on-hold" }),
    pr("amrtawfik160/safi#510", { taskId: "safi-pdf", status: "pr-delivered", requirement: "pr", blocker: "PR delivered; checks pending or unknown" }),
  ];
  assert.equal(formatBoard(input({
    tasks: [
      task("T32", { project: "Cyndra", title: "Perf 1", crewIds: ["perf-1"] }),
      task("T35", { project: "Cyndra", title: "Perf 5+6", crewIds: ["perf-5"] }),
      task("T36", { project: "Cyndra", title: "Perf 7", crewIds: ["perf-7"] }),
      task("T13", { project: "RunAnts", title: "Shopify UI", crewIds: ["runants-ui"] }),
      task("T41", { project: "Safi", title: "Export PDF", crewIds: ["safi-pdf"] }),
    ],
    records: prs,
  })), [
    "📌 Needs you: nothing right now.",
    "",
    "✅ Done since you last looked: nothing new.",
    "",
    "🔧 In progress (5)",
    "- T13 RunAnts · Shopify UI · 1 h · [runants#1759](https://github.com/hazw80801/runants/pull/1759) changed since hold, needs a check; [runants#1760](https://github.com/hazw80801/runants/pull/1760) on hold",
    "- T32 Cyndra · Perf 1 · 1 h · [cyndra-saas#2164](https://github.com/cyndra-ai/cyndra-saas/pull/2164) ready to merge",
    "- T35 Cyndra · Perf 5+6 · 1 h · [cyndra-saas#2167](https://github.com/cyndra-ai/cyndra-saas/pull/2167) checks running; [cyndra-saas#2168](https://github.com/cyndra-ai/cyndra-saas/pull/2168) checks failed",
    "- T36 Cyndra · Perf 7 · 1 h · [cyndra-saas#2163](https://github.com/cyndra-ai/cyndra-saas/pull/2163) ready to merge",
    "- T41 Safi · Export PDF · 1 h · [safi#510](https://github.com/amrtawfik160/safi/pull/510) checks running",
  ].join("\n"));
});
