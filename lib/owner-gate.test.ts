import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createOwnerAsks } from "./owner-asks.ts";
import { createProductionApprovals } from "./production-approval.ts";
import {
  OWNER_APPROVAL_CONTEXT,
  approvalFor,
  createOwnerGate,
  gatedAskResolve,
  ownerApprovalStatus,
  ownerDispatchSource,
  preApprovalCovers,
  prodCheck,
  quotePreApproval,
  type GateCard,
  type PreApproval,
} from "./owner-gate.ts";

const HEAD = "a".repeat(40);
const NEXT = "b".repeat(40);
const PR = "cyndra-ai/cyndra-saas#2570";
const OTHER = "cyndra-ai/cyndra-saas#1";

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

function card(over: Partial<GateCard> & Pick<GateCard, "id">): GateCard {
  return {
    prs: [PR],
    head: HEAD,
    kind: "approval",
    irreversible: false,
    state: "answered",
    resolution: "Approve",
    answeredByOwner: true,
    createdAt: 1,
    ...over,
  };
}

const pre = (over: Partial<PreApproval> = {}): PreApproval => ({
  id: "p1",
  ownerMessageRef: "tg:1:99",
  quote: "merge after you finish",
  task: "T12",
  generation: 1,
  project: "Cyndra",
  allows: "merge",
  createdAt: 1,
  ...over,
});

test("the GitHub context name is Owner approval", () => {
  assert.equal(OWNER_APPROVAL_CONTEXT, "Owner approval");
});

test("success status only after an owner Approve naming the PR at its head", () => {
  const approved = ownerApprovalStatus({
    pr: PR, head: HEAD, cards: [card({ id: "a1" })],
    coverage: () => "covers", preApprovals: [],
  });
  assert.equal(approved.state, "success");
  assert.match(approved.description, /Owner Approve/i);

  const unnamed = ownerApprovalStatus({
    pr: PR, head: HEAD, cards: [card({ id: "a1", prs: [OTHER] })],
    coverage: () => "covers", preApprovals: [],
  });
  assert.equal(unnamed.state, "pending");

  const open = ownerApprovalStatus({
    pr: PR, head: HEAD, cards: [card({ id: "a1", state: "open", resolution: null })],
    coverage: () => "covers", preApprovals: [],
  });
  assert.equal(open.state, "pending");
});

test("a new author commit after owner Approve flips the status back to pending", () => {
  const status = ownerApprovalStatus({
    pr: PR, head: NEXT, cards: [card({ id: "a1" })],
    coverage: () => "new-author", preApprovals: [],
  });
  assert.equal(status.state, "pending");
  assert.match(status.description, /new author commits after approval/i);
});

test("a base merge of an approved head stays success", () => {
  const status = ownerApprovalStatus({
    pr: PR, head: NEXT, cards: [card({ id: "a1" })],
    coverage: () => "covers", preApprovals: [],
  });
  assert.equal(status.state, "success");
});

test("the newest owner No wins over an older Approve and over a pre-approval", () => {
  const status = ownerApprovalStatus({
    pr: PR, head: HEAD,
    cards: [card({ id: "a2", resolution: "No", createdAt: 2 }), card({ id: "a1", createdAt: 1 })],
    coverage: () => "covers",
    preApprovals: [pre()],
    task: "T12",
    taskOpen: true,
  });
  assert.equal(status.state, "pending");
  assert.match(status.description, /No/);
});

test("the latest owner-answer time wins even when its card was issued earlier", () => {
  const status = ownerApprovalStatus({
    pr: PR, head: HEAD,
    cards: [
      card({ id: "later-issued", resolution: "Approve", createdAt: 2, answeredAt: 10 }),
      card({ id: "earlier-issued", resolution: "No", createdAt: 1, answeredAt: 20 }),
    ],
    coverage: () => "covers",
    preApprovals: [pre()],
    task: "T12",
    taskOpen: true,
  });
  assert.equal(status.state, "pending");
  assert.match(status.description, /No/);
});

test("pre-approval covers only its task's PRs and expires when the task closes", () => {
  const covering = preApprovalCovers(pre(), { task: "T12", what: "merge", taskOpen: true });
  assert.equal(covering, true);
  assert.equal(preApprovalCovers(pre(), { task: "T9", what: "merge", taskOpen: true }), false);
  assert.equal(preApprovalCovers(pre(), { task: "T12", what: "deploy", taskOpen: true }), false);
  assert.equal(preApprovalCovers(pre({ allows: "both" }), { task: "T12", what: "deploy", taskOpen: true }), true);
  assert.equal(preApprovalCovers(pre(), { task: "T12", what: "merge", taskOpen: false }), false);

  const ok = ownerApprovalStatus({
    pr: PR, head: HEAD, cards: [], coverage: () => "unknown",
    preApprovals: [pre()], task: "T12", taskOpen: true,
  });
  assert.equal(ok.state, "success");
  assert.match(ok.description, /pre-approval/i);

  const otherTask = ownerApprovalStatus({
    pr: PR, head: HEAD, cards: [], coverage: () => "unknown",
    preApprovals: [pre()], task: "T9", taskOpen: true,
  });
  assert.equal(otherTask.state, "pending");

  const closed = ownerApprovalStatus({
    pr: PR, head: HEAD, cards: [], coverage: () => "unknown",
    preApprovals: [pre()], task: "T12", taskOpen: false,
  });
  assert.equal(closed.state, "pending");
});

test("captain self-resolve on an approval or irreversible card only cancels it", () => {
  assert.equal(gatedAskResolve({ kind: "approval", irreversible: false }, { ownerConfirmed: false }), "cancel");
  assert.equal(gatedAskResolve({ kind: "question", irreversible: true }, { ownerConfirmed: false }), "cancel");
  assert.equal(gatedAskResolve({ kind: "approval", irreversible: false }, { ownerConfirmed: true }), "answer");
  assert.equal(gatedAskResolve({ kind: "question", irreversible: false }, { ownerConfirmed: false }), "answer");
  assert.equal(gatedAskResolve({ kind: "approval", irreversible: false }, { ownerConfirmed: false, cancelled: true }), "cancel");
  assert.equal(gatedAskResolve({ kind: "approval", irreversible: false }, { ownerConfirmed: false, reopen: true }), "reopen");
});

test("a captain-answered Approve cannot produce a success status (a7ro6jg)", () => {
  const status = ownerApprovalStatus({
    pr: PR, head: HEAD,
    cards: [card({ id: "a7ro6jg", answeredByOwner: false, state: "answered", resolution: "Approve" })],
    coverage: () => "covers", preApprovals: [],
  });
  assert.equal(status.state, "pending");
});

test("prod-check exits non-zero without an approval or pre-approval for that work", () => {
  const refused = prodCheck({
    project: "Cyndra", what: "deploy", task: "T12",
    cards: [], preApprovals: [], taskOpen: true,
  });
  assert.equal(refused.ok, false);
  assert.match(refused.reason, /approval/i);

  const viaCard = prodCheck({
    project: "Cyndra", what: "merge", pr: PR, head: HEAD,
    cards: [card({ id: "a1" })], coverage: () => "covers",
    preApprovals: [],
  });
  assert.equal(viaCard.ok, true);

  const viaPre = prodCheck({
    project: "Cyndra", what: "deploy", task: "T12",
    cards: [], preApprovals: [pre({ allows: "deploy" })], taskOpen: true,
  });
  assert.equal(viaPre.ok, true);

  const expired = prodCheck({
    project: "Cyndra", what: "merge", task: "T12", pr: PR, head: HEAD,
    cards: [], preApprovals: [pre()], taskOpen: false,
  });
  assert.equal(expired.ok, false);
});

test("deploy uses the newest owner decision and the current PR head", () => {
  const stale = prodCheck({
    project: "Cyndra", what: "deploy", pr: PR, head: NEXT, task: "T12",
    cards: [card({ id: "a1" })], coverage: () => "new-author",
    preApprovals: [], taskOpen: true,
  });
  assert.equal(stale.ok, false);

  const laterNo = prodCheck({
    project: "Cyndra", what: "deploy", pr: PR, head: HEAD,
    cards: [card({ id: "a2", resolution: "No", createdAt: 2 }), card({ id: "a1", createdAt: 1 })],
    coverage: () => "covers",
    preApprovals: [],
  });
  assert.equal(laterNo.ok, false);
});

test("a question card or another captain's Approve cannot authorize this work", () => {
  const viaQuestion = ownerApprovalStatus({
    pr: PR, head: HEAD, cards: [card({ id: "q1", kind: "question" })],
    coverage: () => "covers", preApprovals: [],
  });
  assert.equal(viaQuestion.state, "pending");

  const viaOther = ownerApprovalStatus({
    pr: PR, head: HEAD, cards: [card({ id: "a1", captain: "thr_other" })],
    coverage: () => "covers", preApprovals: [], captain: "thr_cap",
  });
  assert.equal(viaOther.state, "pending");

  const viaOwn = ownerApprovalStatus({
    pr: PR, head: HEAD, cards: [card({ id: "a1", captain: "thr_cap" })],
    coverage: () => "covers", preApprovals: [], captain: "thr_cap",
  });
  assert.equal(viaOwn.state, "success");
});

test("explicit task pre-approval cannot authorize a different PR", () => {
  const refused = prodCheck({
    project: "Cyndra", what: "merge", task: "T12", pr: OTHER, head: HEAD,
    cards: [], preApprovals: [pre()], taskOpen: true, taskPrs: [PR],
  });
  assert.equal(refused.ok, false);
});

test("the result text quotes the owner's pre-approval words", () => {
  assert.match(quotePreApproval(pre()), /"merge after you finish"/);
  assert.match(quotePreApproval(pre()), /T12/);
});

test("the store records a pre-approval and a deploy without approval", () => {
  const database = db();
  createOwnerAsks(database);
  createProductionApprovals(database);
  const gate = createOwnerGate(database);
  const stored = gate.recordPreApproval({
    ownerMessageRef: "tg:1:99", quote: "deploy this to production", task: "T12", project: "Cyndra", allows: "deploy", createdAt: 10,
  });
  assert.equal(gate.covering({ task: "T12", what: "deploy", taskOpen: true })?.id, stored.id);
  assert.equal(gate.covering({ task: "T12", what: "merge", taskOpen: true }), undefined);

  const asks = createOwnerAsks(database);
  const ask = asks.create({
    captain: "thr_cap", kind: "approval", text: `Merge ${PR}?`,
    options: [{ label: "Approve", value: "approve" }, { label: "No", value: "no" }], createdAt: 1,
  });
  createProductionApprovals(database).bindCard(ask.id, [{ pr: PR, head: HEAD }]);
  asks.resolve(ask.id, "thr_cap", "answered", "Approve", 2, "owner");
  const loaded = gate.cardsForPr(PR);
  assert.equal(loaded[0]?.answeredByOwner, true);
  assert.equal(loaded[0]?.head, HEAD);

  const sighting = gate.recordDeploy({ project: "Safi", source: "live-pass", detail: "OTA production", approved: false, at: 11, task: "T12" });
  assert.equal(sighting.approved, false);
  assert.equal(gate.unapprovedDeploys().some((row) => row.id === sighting.id), true);
});

test("a failed status POST is retried on the same head until it succeeds", () => {
  const database = db();
  const gate = createOwnerGate(database);
  assert.equal(gate.statusPostNeeded(PR, HEAD), false);
  gate.needStatusPost(PR, HEAD, "GitHub temporary 503", 1);
  assert.equal(gate.statusPostNeeded(PR, HEAD), true);
  assert.equal(gate.statusPostNeeded(PR.toUpperCase(), HEAD), true);
  gate.clearStatusPost(PR, HEAD);
  assert.equal(gate.statusPostNeeded(PR, HEAD), false);
});

test("prod-check merge uses approvalFor so a later No beats pre-approval", () => {
  const out = prodCheck({
    project: "Cyndra", what: "merge", pr: PR, head: HEAD, task: "T12",
    cards: [card({ id: "a2", resolution: "No", createdAt: 2 })],
    coverage: () => "covers",
    preApprovals: [pre()],
    taskOpen: true,
    generation: 1,
  });
  assert.equal(out.ok, false);
});

test("a pre-approval of an earlier opening does not cover a reopened task", () => {
  assert.equal(preApprovalCovers(pre(), { task: "T12", what: "merge", taskOpen: true, generation: 2 }), false);
  assert.equal(approvalFor({
    pr: PR, head: HEAD, action: "merge", cards: [], coverage: () => "unknown",
    preApprovals: [pre()], task: "T12", taskOpen: true, generation: 2,
  }).state, "pending");
});

test("an unbound pre-approval binds once to the first matching task epoch", () => {
  const database = db();
  const gate = createOwnerGate(database);
  const stored = gate.recordPreApproval({
    ownerMessageRef: "tg:1:99", quote: "merge after you finish", task: "", project: "Cyndra", allows: "merge", createdAt: 10,
  });
  assert.equal(stored.generation, 0);
  assert.equal(gate.bindPreApproval(stored.id, "T12", 1), true);
  assert.equal(gate.listPreApprovals("").length, 0);
  assert.equal(gate.listPreApprovals("T12")[0]?.generation, 1);
  assert.equal(gate.bindPreApproval(stored.id, "T99", 1), false);
  assert.equal(gate.listPreApprovals("T12").length, 1);
});

test("an owner message ref issues permission once and a replay creates nothing", () => {
  const database = db();
  const gate = createOwnerGate(database);
  const first = gate.recordPreApproval({
    ownerMessageRef: "tg:200:8811", quote: "merge after you finish", task: "T1", project: "Cyndra", allows: "both", createdAt: 10, generation: 1,
  });
  const replay = gate.recordPreApproval({
    ownerMessageRef: "tg:200:8811", quote: "merge after you finish", task: "T1", project: "Cyndra", allows: "both", createdAt: 20, generation: 2,
  });
  assert.equal(replay.id, first.id);
  assert.equal(replay.generation, 1);
  assert.equal(gate.listPreApprovals().length, 1);
});

test("a newer unanswered card is ignored so an earlier owner No still wins", () => {
  const out = approvalFor({
    pr: PR, head: HEAD, action: "merge",
    cards: [
      card({ id: "open", state: "open", resolution: null, answeredByOwner: false, createdAt: 3 }),
      card({ id: "no", resolution: "No", createdAt: 2 }),
    ],
    coverage: () => "covers",
    preApprovals: [pre()],
    task: "T12",
    taskOpen: true,
    generation: 1,
  });
  assert.equal(out.state, "pending");
  assert.match(out.description, /No/);
});

test("owner dispatch source is BB's origin record, never the text", () => {
  const base = { initiator: "user", senderThreadId: null, origin: null, originPluginId: null };
  assert.equal(ownerDispatchSource(base), null);
  assert.equal(ownerDispatchSource({ ...base, origin: "plugin", originPluginId: "other-plugin" }), null);
  assert.equal(ownerDispatchSource({ ...base, senderThreadId: "thr_crew", originPluginId: "telegram" }), null);
  assert.equal(ownerDispatchSource({ ...base, origin: "cli" }), null);
  assert.equal(ownerDispatchSource({ ...base, origin: "plugin", originPluginId: "telegram" }), "telegram");
  assert.equal(ownerDispatchSource({ ...base, submissionPluginId: "telegram" }), "telegram");
  assert.equal(ownerDispatchSource({ ...base, origin: "app" }), null);
  assert.equal(ownerDispatchSource({ initiator: "user", senderThreadId: null, origin: undefined, originPluginId: undefined }), "omitted");
});

test("cardsForPr still reads owner No after captain cancel or reopen", () => {
  const database = db();
  const asks = createOwnerAsks(database);
  const gate = createOwnerGate(database);
  gate.recordPreApproval({
    ownerMessageRef: "tg:200:1", quote: "merge after you finish", task: "T12", project: "Cyndra", allows: "merge", createdAt: 1,
  });
  const ask = asks.create({
    captain: "thr_cap", kind: "approval", text: `Merge ${PR}?`,
    options: [{ label: "Approve", value: "approve" }, { label: "No", value: "no" }], createdAt: 2,
  });
  createProductionApprovals(database).bindCard(ask.id, [{ pr: PR, head: HEAD }]);
  asks.resolve(ask.id, "thr_cap", "answered", "No", 3, "owner");
  asks.resolve(ask.id, "thr_cap", "cancelled", "Captain clearing old card", 4);
  const loaded = gate.cardsForPr(PR);
  assert.equal(loaded[0]?.answeredByOwner, true);
  assert.equal(loaded[0]?.resolution, "No");
  assert.equal(approvalFor({
    pr: PR, head: HEAD, action: "merge", cards: loaded, coverage: () => "covers",
    preApprovals: [pre()], task: "T12", taskOpen: true, generation: 1,
  }).state, "pending");
});

test("cardsForPr uses stored owner-answer time so a later No on an earlier card wins", () => {
  const database = db();
  const asks = createOwnerAsks(database);
  const gate = createOwnerGate(database);
  const first = asks.create({
    captain: "thr_cap", kind: "approval", text: `Merge ${PR}?`,
    options: [{ label: "Approve", value: "approve" }, { label: "No", value: "no" }], createdAt: 1,
  });
  createProductionApprovals(database).bindCard(first.id, [{ pr: PR, head: HEAD }]);
  asks.resolve(first.id, "thr_cap", "answered", "No", 10, "owner");
  asks.resolve(first.id, "thr_cap", "open", "Ask owner again", 11);
  const second = asks.create({
    captain: "thr_cap", kind: "approval", text: `Merge ${PR}?`,
    options: [{ label: "Approve", value: "approve" }, { label: "No", value: "no" }], createdAt: 2,
  });
  createProductionApprovals(database).bindCard(second.id, [{ pr: PR, head: HEAD }]);
  asks.resolve(second.id, "thr_cap", "answered", "Approve", 20, "owner");
  assert.equal(approvalFor({
    pr: PR, head: HEAD, action: "merge", cards: gate.cardsForPr(PR), coverage: () => "covers",
    preApprovals: [pre()], task: "T12", taskOpen: true, generation: 1,
  }).state, "success");
  asks.resolve(first.id, "thr_cap", "answered", "No", 30, "owner");
  const loaded = gate.cardsForPr(PR);
  assert.equal(loaded.find((row) => row.id === first.id)?.answeredAt, 30);
  assert.equal(loaded.find((row) => row.id === second.id)?.answeredAt, 20);
  assert.equal(approvalFor({
    pr: PR, head: HEAD, action: "merge", cards: loaded, coverage: () => "covers",
    preApprovals: [pre()], task: "T12", taskOpen: true, generation: 1,
  }).state, "pending");
});

test("no-PR prod-check uses approvalFor so a covering pre-approval still succeeds", () => {
  const out = prodCheck({
    project: "Cyndra", what: "deploy", task: "T12",
    cards: [], preApprovals: [pre({ allows: "deploy" })], taskOpen: true, generation: 1,
  });
  assert.equal(out.ok, true);
  assert.match(out.reason, /pre-approval/);
});
