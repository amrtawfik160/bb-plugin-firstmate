import assert from "node:assert/strict";
import test from "node:test";
import { judgePreApproval, judgePreApprovalBound } from "./pre-approval-judge.ts";

const MERGE_AND_DEPLOY = "merge after you finish and deploy this to production";
const FORBID = "do not merge after you finish";

test("without a Decisions key the judge fails closed, including for merge-after-finish wording", async () => {
  assert.equal(await judgePreApproval(MERGE_AND_DEPLOY, { apiKey: "" }), "neither");
  assert.equal(await judgePreApproval(FORBID, { apiKey: "" }), "neither");
});

test("the judge never classifies from a word list: a no/no Decisions answer stays neither", async () => {
  const seen: string[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push(String(init?.body ?? ""));
    return new Response(JSON.stringify({
      answers: [
        { name: "merge_after_finish", choice: "no", confidence: 0.9 },
        { name: "deploy_to_production", choice: "no", confidence: 0.9 },
      ],
    }), { status: 200 });
  }) as typeof globalThis.fetch;
  assert.equal(await judgePreApproval(MERGE_AND_DEPLOY, { apiKey: "sk-test", fetch }), "neither");
  assert.equal(await judgePreApproval(FORBID, { apiKey: "sk-test", fetch }), "neither");
  assert.equal(seen.length, 2);
  assert.match(seen[0]!, /merge after you finish/);
  assert.doesNotMatch(JSON.stringify(seen), /\/merge after you finish\//);
});

test("Decisions yes on merge, deploy, or both is recorded as that allowance", async () => {
  const fetchOf = (merge: string, deploy: string) => (async () => new Response(JSON.stringify({
    answers: [
      { name: "merge_after_finish", choice: merge, confidence: 0.8 },
      { name: "deploy_to_production", choice: deploy, confidence: 0.8 },
    ],
  }), { status: 200 })) as typeof globalThis.fetch;
  assert.equal(await judgePreApproval("x", { apiKey: "k", fetch: fetchOf("yes", "no") }), "merge");
  assert.equal(await judgePreApproval("x", { apiKey: "k", fetch: fetchOf("no", "yes") }), "deploy");
  assert.equal(await judgePreApproval("x", { apiKey: "k", fetch: fetchOf("yes", "yes") }), "both");
});

test("a Decisions error, timeout or low confidence fails closed", async () => {
  const errorFetch = (async () => new Response("no", { status: 500 })) as typeof globalThis.fetch;
  assert.equal(await judgePreApproval("merge after you finish", { apiKey: "k", fetch: errorFetch }), "neither");
  const low = (async () => new Response(JSON.stringify({
    answers: [
      { name: "merge_after_finish", choice: "yes", confidence: 0.1 },
      { name: "deploy_to_production", choice: "yes", confidence: 0.1 },
    ],
  }), { status: 200 })) as typeof globalThis.fetch;
  assert.equal(await judgePreApproval("x", { apiKey: "k", fetch: low }), "neither");
});

test("a missing or none matching_task leaves the record unbound", async () => {
  const fetchOf = (choice?: string) => (async () => new Response(JSON.stringify({
    answers: [
      { name: "merge_after_finish", choice: "yes", confidence: 0.9 },
      { name: "deploy_to_production", choice: "no", confidence: 0.9 },
      ...(choice ? [{ name: "matching_task", choice, confidence: 0.9 }] : []),
    ],
  }), { status: 200 })) as typeof globalThis.fetch;
  const tasks = [{ id: "T1", title: "Fix billing totals", project: "Cyndra" }];
  const missing = await judgePreApprovalBound("build a new avatar picker, merge after you finish", { apiKey: "k", fetch: fetchOf(), tasks });
  assert.equal(missing.allows, "merge");
  assert.equal(missing.task, "");
  const none = await judgePreApprovalBound("new work", { apiKey: "k", fetch: fetchOf("none"), tasks });
  assert.equal(none.task, "");
  const named = await judgePreApprovalBound("billing", { apiKey: "k", fetch: fetchOf("T1"), tasks });
  assert.equal(named.task, "T1");
});

test("an aborted Decisions request fails closed", async () => {
  const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    await new Promise<never>((_resolve, reject) => {
      const fail = () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (init?.signal?.aborted) fail();
      init?.signal?.addEventListener("abort", fail, { once: true });
    });
  }) as typeof globalThis.fetch;
  assert.equal(await judgePreApproval("merge after you finish", { apiKey: "k", fetch, timeoutMs: 20 }), "neither");
});
