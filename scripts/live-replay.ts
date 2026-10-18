// Replay the "live is the only finish" rules on a COPY of the Firstmate records (owner decisions Q1, Q9,
// 18 Oct). It never opens the live database: make the copy first, for example
//   node -e 'new (require("node:sqlite").DatabaseSync)(process.argv[1],{readOnly:true}).prepare("VACUUM INTO ?").run(process.argv[2])' <data.db> /tmp/fm-copy.db
// then: node --experimental-strip-types scripts/live-replay.ts /tmp/fm-copy.db [--checks] [--max-compare N]
// Without --checks it only applies the new task states. With --checks it also reads production read-only
// (Expo, Coolify, the local Firstmate checkout, and `gh api .../compare` for at most N pairs) and reports
// which merged tasks a live check would make live. It writes nothing anywhere but the copy.
import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { LiveCheck } from "../owner/projects.ts";
import { readEnvFile, readProduction, taskLiveVerdict, type ProductionRead } from "../lib/live-checks.ts";
import { ruleOf } from "../lib/live-pass.ts";
import { createOwnerTasks, type OwnerTask, type TaskState } from "../lib/owner-tasks.ts";
import type { DeliveryRecord } from "../lib/pr-delivery.ts";

const args = process.argv.slice(2);
const path = args.find((arg) => !arg.startsWith("--") && !/^\d+$/.test(arg));
if (!path) throw new Error("usage: live-replay.ts <copy of data.db> [--checks] [--max-compare N]");
const real = realpathSync(path);
if (/\/\.bb-server\/(bb\.db|plugins\/)/.test(real)) throw new Error(`Refusing ${real}: replay a copy, never a live database.`);
const checks = args.includes("--checks");
const maxCompare = Number(args[args.indexOf("--max-compare") + 1]) || 40;

const raw = new DatabaseSync(real);
const db = Object.assign(raw, {
  transaction<T>(fn: () => T) {
    return () => { raw.exec("BEGIN"); try { const out = fn(); raw.exec("COMMIT"); return out; } catch (error) { raw.exec("ROLLBACK"); throw error; } };
  },
});
const deliveries = (raw.prepare("SELECT record FROM deliveries").all() as { record: string }[]).map((row) => JSON.parse(row.record) as DeliveryRecord);
const recordsFor = (task: OwnerTask) => deliveries.filter((r) => task.prs.includes(r.id) || task.crewIds.includes(r.taskId));
const before = new Map((raw.prepare("SELECT id, state FROM owner_task").all() as { id: string; state: TaskState }[]).map((row) => [row.id, row.state]));
const captains = (raw.prepare("SELECT DISTINCT captain FROM owner_task").all() as { captain: string }[]).map((row) => row.captain);
const tasks = createOwnerTasks(db);
const now = Date.now();
for (const captain of captains) tasks.reconcile(captain, recordsFor, now);
const after = captains.flatMap((captain) => tasks.list(captain, { includeClosed: true }));

const count = (states: Iterable<TaskState>) => { const out: Record<string, number> = {}; for (const s of states) out[s] = (out[s] ?? 0) + 1; return out; };
const wasMerged = after.filter((task) => before.get(task.id) === "merged");
const wasDone = after.filter((task) => before.get(task.id) === "done");
console.log(`Records: ${after.length} tasks, ${deliveries.length} PR records, captains ${captains.length}.`);
console.log(`Before: ${JSON.stringify(count(before.values()))}`);
console.log(`After the new states: ${JSON.stringify(count(after.map((task) => task.state)))}`);
console.log(`Of ${wasMerged.length} tasks that read as finished at "merged": all are open now (not live yet); by state ${JSON.stringify(count(wasMerged.map((task) => task.state)))}.`);
for (const task of wasMerged.filter((t) => t.state !== "merged")) console.log(`  reopened ${task.id} ${task.project ?? ""} -> ${task.state}: ${task.outcome ?? ""}`);
for (const task of wasDone.filter((t) => t.state !== "done")) console.log(`  old done ${task.id} ${task.project ?? ""} -> ${task.state}: ${task.outcome ?? ""}`);
for (const task of after.filter((t) => before.get(t.id) === "live" && t.state !== "live")) console.log(`  was live ${task.id} ${task.project ?? ""} -> ${task.state}: ${task.outcome ?? ""}`);
console.log(`Of ${wasDone.length} old "done" tasks: ${wasDone.filter((t) => t.state !== "done").length} reopened by PRs on their record or still open.`);

if (checks) {
  const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const loaded = execFileSync("git", ["-C", here, "rev-parse", "origin/main"], { encoding: "utf8" }).trim();
  const reads = new Map<string, Promise<ProductionRead>>();
  let compares = 0;
  const cache = new Map<string, boolean | null>();
  const contains = async (check: LiveCheck, repo: string, ancestor: string, descendant: string): Promise<boolean | null> => {
    const key = `${repo} ${ancestor} ${descendant}`;
    if (cache.has(key)) return cache.get(key)!;
    let answer: boolean | null = null;
    if (check.kind === "plugin-reload" && check.plugin === "firstmate") {
      try { execFileSync("git", ["-C", here, "merge-base", "--is-ancestor", ancestor, descendant], { stdio: "ignore" }); answer = true; }
      catch (error) { answer = (error as { status?: number }).status === 1 ? false : null; }
    } else if (compares < maxCompare) {
      compares += 1;
      try {
        const status = execFileSync("gh", ["api", `repos/${repo}/compare/${ancestor}...${descendant}`, "--jq", ".status"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        answer = status === "ahead" || status === "identical" ? true : status === "behind" || status === "diverged" ? false : null;
      } catch { answer = null; }
    }
    cache.set(key, answer);
    return answer;
  };
  // The merge time and files of a merged PR, read with `gh pr view` inside the same request cap.
  const details = async (record: DeliveryRecord) => {
    if (compares >= maxCompare) return null;
    compares += 1;
    try {
      const out = JSON.parse(execFileSync("gh", ["pr", "view", String(record.number), "--repo", record.repository, "--json", "mergedAt,files", "--jq", "{mergedAt, files: [.files[].path]}"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })) as { mergedAt: string | null; files: string[] };
      return { mergedAt: out.mergedAt ? Date.parse(out.mergedAt) : null, files: out.files };
    } catch { return null; }
  };
  const production = (check: LiveCheck) => {
    const key = JSON.stringify(check);
    if (!reads.has(key)) reads.set(key, readProduction(check, {
      fetch: (url, init) => fetch(url, init), env: readEnvFile,
      // The replay stands for a reload of origin/main: what the repair thread loads after it merges.
      loadedCommit: async (plugin) => plugin === "firstmate" ? { label: "Firstmate at origin/main", sha: loaded } : `the ${plugin} plugin does not report the commit it loaded yet`,
    }));
    return reads.get(key)!;
  };
  const verdicts: Array<{ task: OwnerTask; live: boolean; why: string }> = [];
  for (const task of after.filter((t) => t.state === "merged")) {
    const records = recordsFor(task);
    const rule = ruleOf(task, records);
    const verdict = await taskLiveVerdict(rule?.live, records, { production, contains, readback: () => [], details });
    verdicts.push({ task, live: verdict.live, why: verdict.live ? verdict.evidence : verdict.missing ? `live check missing: ${verdict.missing}` : verdict.unknown ? "not told yet (compare budget)" : "production does not hold it yet" });
  }
  const byProject = new Map<string, { live: number; notLive: number; reasons: Map<string, number> }>();
  for (const v of verdicts) {
    const key = ruleOf(v.task, recordsFor(v.task))?.name ?? v.task.project ?? "no project";
    const row = byProject.get(key) ?? { live: 0, notLive: 0, reasons: new Map() };
    if (v.live) row.live += 1; else { row.notLive += 1; row.reasons.set(v.why, (row.reasons.get(v.why) ?? 0) + 1); }
    byProject.set(key, row);
  }
  console.log(`\nLive checks (read-only; ${compares} GitHub compares):`);
  for (const [project, row] of byProject) {
    console.log(`  ${project}: ${row.live} live, ${row.notLive} not live yet`);
    for (const [why, n] of row.reasons) console.log(`    ${n} × ${why.slice(0, 200)}`);
  }
  for (const v of verdicts.filter((x) => x.live)) console.log(`  live ${v.task.id} ${v.task.project ?? ""}: ${v.why.slice(0, 200)}`);
  console.log(`Total: ${verdicts.filter((v) => v.live).length} of ${verdicts.length} merged tasks proven live; ${verdicts.filter((v) => !v.live).length} stay on Not live yet.`);
}
