import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectForName, type LiveCheck, type LiveRule } from "../owner/projects.ts";
import { readEnvFile, readProduction, taskLiveVerdict, type LiveDeps, type ProductionRead, type ReaderDeps } from "./live-checks.ts";
import type { DeliveryRecord } from "./pr-delivery.ts";

const merged = (id: string, sha: string): DeliveryRecord => ({ id, repository: id.split("#")[0]!, status: "complete", forgeState: "merged", mergeCommitSha: sha }) as DeliveryRecord;

/** History as child -> parent: a commit holds every commit on its chain. */
function history(edges: Record<string, string>) {
  return async (_check: LiveCheck, _repo: string, ancestor: string, descendant: string) => {
    for (let at: string | undefined = descendant; at !== undefined; at = edges[at]) if (at === ancestor) return true;
    return false;
  };
}

function deps(reads: Record<string, ProductionRead>, edges: Record<string, string>, readback: string | null = null): LiveDeps & { asked: string[] } {
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
  };
}

const safi = projectForName("Safi")!.live!;

// FORGOTTEN-WORK section 7: Safi production OTA a7021b2c was built from aa40ebbe (PR 575); PR 576 merged later would not be in it.
test("Safi: merged work is live only when both the production and the preview OTA hold its merge commit", async () => {
  const reads = { "eas:production+preview": { ok: true as const, runs: [{ label: "production OTA a7021b2c", sha: "aa40ebbe" }, { label: "preview OTA 0a29da02", sha: "aa40ebbe" }] } };
  const edges = { aa40ebbe: "2fc73e18", "2fc73e18": "6e24f934", later01: "aa40ebbe" };
  const live = await taskLiveVerdict(safi, [merged("amrtawfik160/safi#573", "2fc73e18"), merged("amrtawfik160/safi#575", "aa40ebbe")], deps(reads, edges));
  assert.equal(live.live, true);
  assert.match((live as { evidence: string }).evidence, /production OTA a7021b2c \(aa40ebbe\) and preview OTA 0a29da02 \(aa40ebbe\) holds amrtawfik160\/safi#573/);
  assert.match((live as { evidence: string }).evidence, /Not read: the backend deploy/);
  assert.deepEqual(await taskLiveVerdict(safi, [merged("amrtawfik160/safi#576", "later01")], deps(reads, edges)), { live: false, missing: null, unknown: false }, "read, and not in production yet");
  const onlyProduction = { "eas:production+preview": { ok: true as const, runs: [{ label: "production OTA x", sha: "later01" }, { label: "preview OTA y", sha: "aa40ebbe" }] } };
  assert.equal((await taskLiveVerdict(safi, [merged("amrtawfik160/safi#576", "later01")], deps(onlyProduction, edges))).live, false, "the preview channel must hold it too");
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
  assert.deepEqual(verdict, { live: false, missing: "the Expo token has no access to app 59afc438", unknown: false });
  const proved = await taskLiveVerdict(woo, [merged("amrtawfik160/dr.woo#129", "3fc0f8f")], deps(unread, {}, "Build 7 read back in Externals from App Store Connect"));
  assert.deepEqual(proved, { live: true, evidence: "Build 7 read back in Externals from App Store Connect." }, "a TestFlight read-back in the public-link group proves the task");
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
