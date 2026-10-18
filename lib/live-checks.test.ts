import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectForName, type LiveCheck, type LiveRule } from "../owner/projects.ts";
import { easBuildCommit, readEnvFile, readProduction, taskLiveVerdict, type LiveDeps, type PrDetails, type ProductionRead, type ReaderDeps, type ReleaseEvidence } from "./live-checks.ts";
import type { DeliveryRecord } from "./pr-delivery.ts";

const merged = (id: string, sha: string): DeliveryRecord => ({ id, repository: id.split("#")[0]!, status: "complete", forgeState: "merged", mergeCommitSha: sha }) as DeliveryRecord;

/** History as child -> parent: a commit holds every commit on its chain. */
function history(edges: Record<string, string>) {
  return async (_check: LiveCheck, _repo: string, ancestor: string, descendant: string) => {
    for (let at: string | undefined = descendant; at !== undefined; at = edges[at]) if (at === ancestor) return true;
    return false;
  };
}

function deps(reads: Record<string, ProductionRead>, edges: Record<string, string>, readback: ReleaseEvidence[] = [], details: Record<string, PrDetails> = {}): LiveDeps & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    production: async (check) => {
      const key = check.kind === "eas-update" ? `eas:${check.channels.join("+")}` : check.kind === "plugin-reload" ? `plugin:${check.plugin}` : check.kind;
      asked.push(key);
      return reads[key] ?? { ok: false, missing: `no fake for ${key}` };
    },
    contains: history(edges),
    readback: () => readback,
    details: async (record) => details[record.id] ?? null,
  };
}

const app = (mergedAt = 0): PrDetails => ({ mergedAt, files: ["artifacts/mobile/app/(tabs)/index.tsx"] });
const backend = (mergedAt = 0): PrDetails => ({ mergedAt, files: ["artifacts/mobile/app/x.tsx", "artifacts/mobile/convex/goals.ts"] });

const safi = projectForName("Safi")!.live!;

// FORGOTTEN-WORK section 7: Safi production OTA a7021b2c was built from aa40ebbe (PR 575); PR 576 merged later would not be in it.
test("Safi: merged work is live only when both the production and the preview OTA hold its merge commit", async () => {
  const reads = { "eas:production+preview": { ok: true as const, runs: [{ label: "production OTA a7021b2c", sha: "aa40ebbe" }, { label: "preview OTA 0a29da02", sha: "aa40ebbe" }] } };
  const edges = { aa40ebbe: "2fc73e18", "2fc73e18": "6e24f934", later01: "aa40ebbe" };
  const files = { "amrtawfik160/safi#573": app(), "amrtawfik160/safi#575": app(), "amrtawfik160/safi#576": app() };
  const live = await taskLiveVerdict(safi, [merged("amrtawfik160/safi#573", "2fc73e18"), merged("amrtawfik160/safi#575", "aa40ebbe")], deps(reads, edges, [], files));
  assert.equal(live.live, true);
  assert.match((live as { evidence: string }).evidence, /production OTA a7021b2c \(aa40ebbe\) and preview OTA 0a29da02 \(aa40ebbe\) holds amrtawfik160\/safi#573/);
  assert.match((live as { evidence: string }).evidence, /No change to the Convex backend, so no backend deploy is needed\.$/);
  assert.deepEqual(await taskLiveVerdict(safi, [merged("amrtawfik160/safi#576", "later01")], deps(reads, edges, [], files)), { live: false, missing: null, unknown: false }, "read, and not in production yet");
  const onlyProduction = { "eas:production+preview": { ok: true as const, runs: [{ label: "production OTA x", sha: "later01" }, { label: "preview OTA y", sha: "aa40ebbe" }] } };
  assert.equal((await taskLiveVerdict(safi, [merged("amrtawfik160/safi#576", "later01")], deps(onlyProduction, edges, [], files))).live, false, "the preview channel must hold it too");
});

// Checker 162-verdict-1 fix 1: both OTA channels held a merge that changed the Convex backend, and the task went live with no backend evidence.
test("Safi: a merge that changes the Convex backend stays not live while the backend deploy cannot be read; unread files prove nothing", async () => {
  const reads = { "eas:production+preview": { ok: true as const, runs: [{ label: "production OTA p", sha: "m1" }, { label: "preview OTA q", sha: "m1" }] } };
  const touched = await taskLiveVerdict(safi, [merged("amrtawfik160/safi#577", "m1")], deps(reads, {}, [], { "amrtawfik160/safi#577": backend() }));
  assert.equal(touched.live, false);
  assert.match((touched as { missing: string }).missing, /^amrtawfik160\/safi#577 changes the Convex backend, and the backend was not read: Convex keeps no record of the deployed commit/);
  assert.deepEqual(await taskLiveVerdict(safi, [merged("amrtawfik160/safi#577", "m1")], deps(reads, {})), { live: false, missing: null, unknown: true }, "files not read yet: nothing is proven");
  assert.equal((await taskLiveVerdict(safi, [merged("amrtawfik160/safi#577", "m1")], { ...deps(reads, {}), details: undefined })).live, false);
});

test("a project with no check, or a repo no check covers, says the live check is missing instead of guessing", async () => {
  const cyndra = projectForName("Cyndra")!.live!;
  const verdict = await taskLiveVerdict(cyndra, [merged("cyndra-ai/cyndra-saas#2535", "abc")], deps({}, {}));
  assert.equal(verdict.live, false);
  assert.match((verdict as { missing: string }).missing, /no record says which commit Cyndra production runs/);
  const plugins = projectForName("bb-plugin-firstmate")!.live!;
  assert.match((await taskLiveVerdict(plugins, [merged("cyndra-ai/agent-orchestrator#12", "abc")], deps({}, {})) as { missing: string }).missing, /no live check for agent-orchestrator/);
  assert.match((await taskLiveVerdict(undefined, [merged("a/b#1", "abc")], deps({}, {})) as { missing: string }).missing, /no live rule/);
});

test("a check that cannot read production is a missing check; a later check of the same PR can still prove it", async () => {
  const woo = projectForName("Dr Woo")!.live!;
  const unread = { "eas:production": { ok: false as const, missing: "the Expo token has no access to app 59afc438" } };
  const verdict = await taskLiveVerdict(woo, [merged("amrtawfik160/dr.woo#129", "3fc0f8f")], deps(unread, {}));
  assert.deepEqual(verdict, { live: false, missing: "no release read-back in the required group; the Expo token has no access to app 59afc438", unknown: false });
  const build7 = { text: "Build 7 read back in Externals from App Store Connect", commit: "b7" };
  const proved = await taskLiveVerdict(woo, [merged("amrtawfik160/dr.woo#129", "3fc0f8f")], deps(unread, { b7: "3fc0f8f" }, [build7], { "amrtawfik160/dr.woo#129": app(1_000) }));
  assert.deepEqual(proved, { live: true, evidence: "Live check: Build 7 read back in Externals from App Store Connect (built from b7, which holds amrtawfik160/dr.woo#129)." }, "a TestFlight read-back of a build whose commit holds the merge proves it");
});

// Checker 162-verdict-1 fix 2 and 162-verdict-2: only the build's commit decides. A build from an older
// cycle, from an old branch, or with an unread commit proves nothing, however new its build time.
test("Dr Woo: a read-back proves a merge only when its build commit holds it; build time never proves it", async () => {
  const woo = projectForName("Dr Woo")!.live!;
  const unread = { "eas:production": { ok: false as const, missing: "no Expo access" } };
  const pr = merged("amrtawfik160/dr.woo#140", "newmerge");
  const oldBranch = { text: "Build 8 in Externals, built later from an old branch", commit: "oldbranch", builtAt: 2_000 };
  assert.deepEqual(await taskLiveVerdict(woo, [pr], deps(unread, { oldbranch: "older" }, [oldBranch], { [pr.id]: app(1_000) })), { live: false, missing: null, unknown: false }, "a known commit without the merge: not live, whatever the time");
  const unknown: LiveDeps = { ...deps(unread, {}, [{ text: "Build 8 in Externals", commit: "unknownbranch", builtAt: 2_000 }], { [pr.id]: app(1_000) }), contains: async () => null };
  assert.deepEqual(await taskLiveVerdict(woo, [pr], unknown), { live: false, missing: null, unknown: true }, "containment not told: not proven");
  assert.deepEqual(await taskLiveVerdict(woo, [pr], deps(unread, {}, [{ text: "Build 8 in Externals", builtAt: 2_000 }], { [pr.id]: app(1_000) })), { live: false, missing: "the release read-back names no build commit: build commit not read; no Expo access", unknown: false }, "no commit on the read-back");
  assert.equal((await taskLiveVerdict(woo, [pr], deps(unread, { build9: "newmerge" }, [oldBranch, { text: "Build 9 in Externals", commit: "build9" }], { [pr.id]: app(1_000) }))).live, true, "built from a commit holding the merge");
});

test("plugins are live once the loaded commit holds the merge; an unknown answer is neither live nor missing", async () => {
  const plugins = projectForName("bb-plugin-firstmate")!.live!;
  const loaded = { "plugin:firstmate": { ok: true as const, runs: [{ label: "Firstmate loaded on this host", sha: "3a3a2eca" }] } };
  const edges = { "3a3a2eca": "e2aa1348", e2aa1348: "d03b70aa" };
  assert.equal((await taskLiveVerdict(plugins, [merged("amrtawfik160/bb-plugin-firstmate#157", "e2aa1348")], deps(loaded, edges))).live, true);
  assert.equal((await taskLiveVerdict(plugins, [merged("amrtawfik160/bb-plugin-firstmate#158", "f00dfeed")], deps(loaded, edges))).live, false);
  const unknown: LiveDeps = { ...deps(loaded, edges), contains: async () => null };
  assert.deepEqual(await taskLiveVerdict(plugins, [merged("amrtawfik160/bb-plugin-firstmate#158", "f00dfeed")], unknown), { live: false, missing: null, unknown: true });
  const telegram = await taskLiveVerdict(plugins, [merged("amrtawfik160/bb-plugin-telegram#66", "abc")], deps({ "plugin:telegram": { ok: false, missing: "the Telegram plugin does not report the commit it loaded" } }, {}));
  assert.deepEqual(telegram, { live: false, missing: "the Telegram plugin does not report the commit it loaded", unknown: false });
});

test("every merged PR of a task must be live; one missing keeps the task open", async () => {
  const rule: LiveRule = { definition: "d", next: "n", actor: "a", checks: [{ kind: "plugin-reload", plugin: "firstmate", repos: ["o/fm"] }] };
  const reads = { "plugin:firstmate": { ok: true as const, runs: [{ label: "loaded", sha: "b" }] } };
  assert.equal((await taskLiveVerdict(rule, [merged("o/fm#1", "a"), merged("o/fm#2", "c")], deps(reads, { b: "a" }))).live, false);
  assert.equal((await taskLiveVerdict(rule, [merged("o/fm#1", "a"), merged("o/fm#2", "b")], deps(reads, { b: "a" }))).live, true);
});

function fakeFetch(answers: Array<{ status?: number; body: unknown }>) {
  const calls: Array<{ url: string; headers: Record<string, string>; body?: string }> = [];
  const fetch: ReaderDeps["fetch"] = async (url, init) => {
    calls.push({ url, headers: init.headers, ...(init.body ? { body: init.body } : {}) });
    const answer = answers.shift() ?? { status: 500, body: {} };
    return { ok: (answer.status ?? 200) < 400, status: answer.status ?? 200, json: async () => answer.body };
  };
  return { fetch, calls };
}

const easUpdate = (group: string, sha: string | null, createdAt: string) => ({ data: { app: { byId: { updateChannelByName: { updateBranches: [{ name: "x", updates: [{ group, gitCommitHash: sha, createdAt }] }] } } } } });

test("the EAS reader reads the newest update of each channel with the token from the env file, and names a refused token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fm-live-"));
  const file = join(dir, "expo.env");
  writeFileSync(file, "EXPO_TOKEN=secret-value\n");
  const check: LiveCheck = { kind: "eas-update", appId: "app-1", channels: ["production", "preview"], envFile: file };
  const { fetch, calls } = fakeFetch([{ body: easUpdate("a7021b2c-48f6", "aa40ebbe", "2026-10-18T10:41:57Z") }, { body: easUpdate("0a29da02-b73a", "aa40ebbe", "2026-10-18T10:39:09Z") }]);
  const read = await readProduction(check, { fetch, env: readEnvFile, loadedCommit: async () => "none" });
  assert.deepEqual(read, { ok: true, runs: [
    { label: "production OTA a7021b2c", sha: "aa40ebbe", at: Date.parse("2026-10-18T10:41:57Z") },
    { label: "preview OTA 0a29da02", sha: "aa40ebbe", at: Date.parse("2026-10-18T10:39:09Z") },
  ] });
  assert.equal(calls[0]!.headers.authorization, "Bearer secret-value");
  assert.match(calls[1]!.body!, /"ch":"preview"/);
  const refused = fakeFetch([{ body: { errors: [{ extensions: { errorCode: "UNAUTHORIZED_ERROR" } }], data: null } }]);
  const answer = await readProduction(check, { fetch: refused.fetch, env: readEnvFile, loadedCommit: async () => "none" });
  assert.deepEqual(answer, { ok: false, missing: `the Expo token in ${file} has no access to app app-1` });
  assert.doesNotMatch(JSON.stringify(answer), /secret-value/, "the token never reaches a result");
  const noHash = fakeFetch([{ body: easUpdate("g", null, "2026-10-18T10:41:57Z") }]);
  assert.deepEqual(await readProduction(check, { fetch: noHash.fetch, env: readEnvFile, loadedCommit: async () => "none" }), { ok: false, missing: "the newest production OTA update names no commit" });
});

test("the Coolify reader needs its token, URL and app in the env file, then reads the newest finished deploy", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fm-live-"));
  const file = join(dir, "areliaa.env");
  writeFileSync(file, "COOLIFY_BASE_URL=https://coolify.example/\nCOOLIFY_APPLICATION_UUID=app9\nCOOLIFY_PASSWORD=pw\n");
  const check: LiveCheck = { kind: "coolify-deploy", envFile: file, baseUrlVar: "COOLIFY_BASE_URL", appVar: "COOLIFY_APPLICATION_UUID", tokenVar: "COOLIFY_API_TOKEN" };
  const none = fakeFetch([]);
  assert.deepEqual(await readProduction(check, { fetch: none.fetch, env: readEnvFile, loadedCommit: async () => "none" }), { ok: false, missing: `no COOLIFY_API_TOKEN in ${file}` });
  assert.equal(none.calls.length, 0, "no request without a token");
  writeFileSync(file, "COOLIFY_BASE_URL=https://coolify.example/\nCOOLIFY_APPLICATION_UUID=app9\nCOOLIFY_API_TOKEN=tok\n");
  const { fetch, calls } = fakeFetch([{ body: { count: 2, deployments: [{ status: "in_progress", commit: "ffff111" }, { status: "finished", commit: "27bc41d0", deployment_uuid: "d1", finished_at: "2026-10-18T06:45:00Z" }] } }]);
  assert.deepEqual(await readProduction(check, { fetch, env: readEnvFile, loadedCommit: async () => "none" }), { ok: true, runs: [{ label: "Coolify deploy d1", sha: "27bc41d0", at: Date.parse("2026-10-18T06:45:00Z") }] });
  assert.equal(calls[0]!.url, "https://coolify.example/api/v1/deployments/applications/app9?skip=0&take=10");
  const head = fakeFetch([{ body: [{ status: "finished", commit: "HEAD" }] }]);
  assert.deepEqual(await readProduction(check, { fetch: head.fetch, env: readEnvFile, loadedCommit: async () => "none" }), { ok: false, missing: "Coolify lists no finished deploy with a commit" });
});

test("the plugin reader reports the loaded commit, or why it is not known", async () => {
  const check: LiveCheck = { kind: "plugin-reload", plugin: "telegram" };
  const base = { fetch: fakeFetch([]).fetch, env: () => null };
  assert.deepEqual(await readProduction(check, { ...base, loadedCommit: async () => "the Telegram plugin does not report the commit it loaded" }), { ok: false, missing: "the Telegram plugin does not report the commit it loaded" });
  assert.deepEqual(await readProduction(check, { ...base, loadedCommit: async () => ({ label: "Telegram loaded", sha: "fa0e1d95" }) }), { ok: true, runs: [{ label: "Telegram loaded", sha: "fa0e1d95" }] });
});

// Checker 162-verdict-2: EAS builds carry gitCommitHash, so a read-back's build commit is read there when the crew gives none.
test("the EAS build lookup finds a build's commit by id or iOS build number, and says why when it cannot", async () => {
  const builds = { data: { app: { byId: { builds: [
    { id: "2018d35a-b880", platform: "IOS", gitCommitHash: "61c8c825", appBuildVersion: "21" },
    { id: "cd685739-9621", platform: "IOS", gitCommitHash: null, appBuildVersion: "20" },
  ] } } } };
  const deps = (body: unknown) => ({ fetch: fakeFetch([{ body }]).fetch, env: () => ({ EXPO_TOKEN: "t" }) });
  assert.deepEqual(await easBuildCommit("app", "/f.env", "21", deps(builds)), { commit: "61c8c825" });
  assert.deepEqual(await easBuildCommit("app", "/f.env", "2018d35a-b880", deps(builds)), { commit: "61c8c825" });
  assert.deepEqual(await easBuildCommit("app", "/f.env", "20", deps(builds)), { missing: "EAS build 20 names no commit" });
  assert.deepEqual(await easBuildCommit("app", "/f.env", "99", deps(builds)), { missing: "EAS lists no build 99 among the app's last 50 builds" });
  assert.deepEqual(await easBuildCommit("app", "/f.env", "21", { ...deps(builds), env: () => null }), { missing: "no EXPO_TOKEN in /f.env" });
  assert.deepEqual(await easBuildCommit("app", "/f.env", "21", deps({ errors: [{ extensions: { errorCode: "UNAUTHORIZED_ERROR" } }] })), { missing: "the Expo token in /f.env has no access to app app" });
});
