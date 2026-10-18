import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createOwnerTasks, type OwnerTask } from "./owner-tasks.ts";
import { createReleaseReadbacks } from "./release-readback.ts";
import { runLivePass, type LivePassDeps } from "./live-pass.ts";
import type { DeliveryRecord } from "./pr-delivery.ts";

const H = 60 * 60_000;

function memoryDb() {
  const raw = new DatabaseSync(":memory:");
  return Object.assign(raw, {
    transaction<T>(fn: () => T) {
      return () => { raw.exec("BEGIN"); try { const out = fn(); raw.exec("COMMIT"); return out; } catch (error) { raw.exec("ROLLBACK"); throw error; } };
    },
  });
}

const merged = (id: string, crew: string, sha: string) => ({ id, repository: id.split("#")[0]!, taskId: crew, status: "complete", forgeState: "merged", mergeCommitSha: sha, verifiedCommitSha: null, requirement: "merged" }) as DeliveryRecord;

function world() {
  const tasks = createOwnerTasks(memoryDb());
  const records = new Map<string, DeliveryRecord[]>();
  tasks.open({ captain: "c", project: "Safi", title: "Accounts header", sourceRefs: ["tg:1:1"], crewId: "s1", at: 0 });
  tasks.open({ captain: "c", project: "Safi", title: "Voice add", sourceRefs: ["tg:1:2"], crewId: "s2", at: 0 });
  tasks.open({ captain: "c", project: "Cyndra", title: "Maintenance banner", sourceRefs: ["tg:1:3"], crewId: "c1", at: 0 });
  records.set("s1", [merged("amrtawfik160/safi#560", "s1", "aa40ebbe7d899f96c7f08175c0434cb2b54396dc")]);
  records.set("s2", [merged("amrtawfik160/safi#576", "s2", "later01")]);
  records.set("c1", [merged("cyndra-ai/cyndra-saas#2535", "c1", "c0ffee")]);
  const recordsFor = (task: OwnerTask) => records.get(task.crewIds[0]!) ?? [];
  tasks.reconcile("c", recordsFor, 1);
  const alerts: Array<{ project: string | null; text: string; incident: string }> = [];
  let sendOk = true;
  const fetchCalls: string[] = [];
  const deps = (now: number, stallMemory = {}): LivePassDeps => ({
    captain: "c", now, tasks: () => tasks.list("c", { includeClosed: true }), recordsFor, running: new Set(),
    readers: {
      fetch: async (url, init) => {
        fetchCalls.push(url);
        const ch = JSON.parse(init.body!).variables.ch as string;
        return { ok: true, status: 200, json: async () => ({ data: { app: { byId: { updateChannelByName: { updateBranches: [{ updates: [{ group: `${ch}-group`, gitCommitHash: "aa40ebbe7d899f96c7f08175c0434cb2b54396dc", createdAt: "2026-10-18T10:41:57Z" }] }] } } } } }) };
      },
      env: () => ({ EXPO_TOKEN: "t" }),
      loadedCommit: async () => "not used",
    },
    contains: async (_check, _repo, ancestor, descendant) => ancestor === descendant,
    readback: () => [],
    details: async () => ({ mergedAt: 0, files: ["artifacts/mobile/app/index.tsx"] }),
    markLive: (task, evidence, check) => { tasks.move(task.id, "c", { to: "live", reason: evidence, checked: check }, now); return true; },
    alert: async (project, text, incident) => { if (!sendOk) return false; alerts.push({ project, text, incident }); return true; },
    stallMemory,
  });
  return { tasks, deps, alerts, fetchCalls, failSends: (fail: boolean) => { sendOk = !fail; } };
}

test("the pass moves merged work production holds to live with evidence, reads each check once, and marks Cyndra live check missing", async () => {
  const w = world();
  const out = await runLivePass(w.deps(2 * H));
  assert.deepEqual(out.live, ["T1"]);
  assert.equal(w.tasks.get("T1")!.state, "live");
  assert.match(w.tasks.get("T1")!.evidence!, /^Live check: production OTA producti \(aa40ebbe\) and preview OTA preview- \(aa40ebbe\) holds amrtawfik160\/safi#560/);
  assert.equal(w.tasks.get("T2")!.state, "merged", "safi#576 is not in the OTA yet");
  assert.equal(w.fetchCalls.length, 2, "one read per channel for both Safi tasks");
  assert.deepEqual(out.status["Safi"], { missing: null, at: 2 * H });
  assert.match(out.status["Cyndra"]!.missing!, /no record says which commit Cyndra production runs/);
  assert.deepEqual(w.alerts, [], "nothing has stalled yet");
});

test("each stall raises one alert per project naming who must act; a repeat waits 24 hours; an unsent alert stays due", async () => {
  const w = world();
  w.failSends(true);
  const unsent = await runLivePass(w.deps(30 * H));
  assert.deepEqual(unsent.alerted, []);
  assert.deepEqual(unsent.stallMemory, { tasks: {}, projects: {} }, "an alert that was not sent is not remembered");
  w.failSends(false);
  const first = await runLivePass(w.deps(30 * H, unsent.stallMemory));
  assert.deepEqual(w.alerts.map((a) => a.project), ["Safi", "Cyndra"]);
  assert.match(w.alerts[0]!.text, /T2 Voice add \(merged, not live, no step for 29 h\): the captain must publish the OTA update to preview and production and deploy the backend/);
  assert.match(w.alerts[1]!.text, /live check missing: no record says which commit Cyndra production runs/);
  assert.equal(w.alerts[0]!.incident, "stall-safi-1970-01-02T06");
  const again = await runLivePass(w.deps(31 * H, first.stallMemory));
  assert.deepEqual(again.alerted, []);
  assert.equal(w.alerts.length, 2);
  const nextDay = await runLivePass(w.deps(54 * H, again.stallMemory));
  assert.deepEqual(nextDay.alerted.sort(), ["T2", "T3"]);
});

// Checker 162-verdict-1 fix 2: an old Build 7 read-back made the new merge of a reopened task live.
test("a reopened Dr Woo task is not made live by the read-back of a build from before its new merge", async () => {
  const raw = memoryDb();
  const tasks = createOwnerTasks(raw);
  const readbacks = createReleaseReadbacks(raw);
  tasks.open({ captain: "c", project: "Dr Woo", title: "Redesign", sourceRefs: ["tg:1:1"], crewId: "old-crew", at: 0 });
  readbacks.record({ task: "T1", captain: "c", crewId: "old-crew", project: "Dr Woo", build: "7", group: "Externals", source: "app-store-connect", seen: "Build 7 in Externals", at: 5, builtAt: 4, commit: "build7" });
  tasks.move("T1", "c", { to: "live", reason: "Build 7 read back" }, 10);
  tasks.attach("T1", "c", { crewId: "new-crew", sourceRefs: ["tg:1:2"], at: 20 });
  const recordsFor = () => [{ ...merged("amrtawfik160/dr.woo#141", "new-crew", "newmerge"), openedAt: 20 }];
  tasks.reconcile("c", recordsFor, 30);
  const evidence = (task: OwnerTask) => readbacks.forTask(task.captain, task.id).map((row) => ({ text: `Build ${row.build} read back in ${row.group}`, ...(row.commit ? { commit: row.commit } : {}), ...(row.builtAt !== undefined ? { builtAt: row.builtAt } : {}) }));
  const pass = (now: number) => runLivePass({ captain: "c", now, tasks: () => tasks.list("c", { includeClosed: true }), recordsFor, running: new Set(),
    readers: { fetch: async () => { throw new Error("no production proof"); }, env: () => null, loadedCommit: async () => "unknown" }, contains: async (_check, _repo, ancestor, descendant) => descendant === "build9" && ancestor === "newmerge",
    readback: evidence, details: async () => ({ mergedAt: 25, files: ["app/x.tsx"] }),
    markLive: (item, text, checked) => { tasks.move(item.id, "c", { to: "live", reason: text, checked }, now); return true; },
    alert: async () => false, stallMemory: {} });
  assert.deepEqual((await pass(40)).live, [], "Build 7's commit does not hold the new merge");
  readbacks.record({ task: "T1", captain: "c", crewId: "new-crew", project: "Dr Woo", build: "9", group: "Externals", source: "app-store-connect", seen: "Build 9 in Externals", at: 45, builtAt: 44, commit: "build9" });
  assert.deepEqual((await pass(50)).live, ["T1"], "Build 9's commit holds the merge");
});
