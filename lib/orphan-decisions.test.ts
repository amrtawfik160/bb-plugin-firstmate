import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { foldOpenDecisions } from "./policy.ts";
import { orphanCandidateScript, orphanResolveLines, parseOrphanCandidates, parseStaleLavishSources, staleLavishSourceScript } from "./orphan-decisions.ts";

const OLD = new Date(Date.now() - 7200_000);

function candidates(files: Record<string, { body: string; meta?: boolean; old?: boolean }>): string[] {
  const dir = mkdtempSync(join(tmpdir(), "fm-orphan-"));
  try {
    for (const [id, f] of Object.entries(files)) {
      writeFileSync(join(dir, `${id}.status`), f.body);
      if (f.old !== false) utimesSync(join(dir, `${id}.status`), OLD, OLD);
      if (f.meta) writeFileSync(join(dir, `${id}.meta`), "kind=ship\n");
    }
    const res = spawnSync("bash", ["-c", orphanCandidateScript(dir, 3600)], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    return parseOrphanCandidates(res.stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("candidates are quiet metaless status files that mention a decision verb", () => {
  assert.deepEqual(candidates({
    orphan: { body: "working: x\nblocked [at=1]: CI billing\n" },
    withmeta: { body: "blocked: x\n", meta: true },
    recent: { body: "blocked: x\n", old: false },
    nodecision: { body: "working: x\ndone: y\n" },
  }), ["orphan"]);
});

test("orphan resolve lines close exactly the decisions native keeps open for a metaless log", () => {
  const lines = [
    "blocked [at=1]: [key=ci] PR https://github.com/o/r/pull/1805 pushed; CI blocked",
    "needs-decision: [key=scope] which scope?",
    "resolved [key=scope]: answered",
    "blocked: keyless block",
    "done: PR merged",
  ];
  assert.deepEqual(foldOpenDecisions(lines, "unknown").map((d) => d.key), ["ci", "default"], "unknown kind never collapses on done");
  const closers = orphanResolveLines(lines, "auto-closed: crew gone");
  assert.deepEqual(closers, ["resolved [key=ci]: auto-closed: crew gone", "resolved [key=default]: auto-closed: crew gone"]);
  assert.deepEqual(foldOpenDecisions([...lines, ...closers], "unknown"), []);
});

test("stale Lavish sources are the ones whose artifact no longer exists", () => {
  const dir = mkdtempSync(join(tmpdir(), "fm-procevent-"));
  try {
    mkdirSync(join(dir, "procevent"));
    const alive = join(dir, "review.html");
    writeFileSync(alive, "<html></html>");
    const source = (artifact: string) => `adapter=lavish\nkind=task-owned\nowner_task=1a7058a0\nargc=3\nargv:\n/home/bin/fm-procevent-lavish.sh\npoll\n${artifact}\n`;
    writeFileSync(join(dir, "procevent", "lavish-gone.source"), source(join(dir, "torn-down-worktree/review.html")));
    writeFileSync(join(dir, "procevent", "lavish-live.source"), source(alive));
    writeFileSync(join(dir, "procevent", "quota-x.source"), source("/nowhere"));
    const res = spawnSync("bash", ["-c", staleLavishSourceScript(dir)], { encoding: "utf8" });
    assert.equal(res.status, 0, res.stderr);
    assert.deepEqual(parseStaleLavishSources(res.stdout), ["lavish-gone"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
