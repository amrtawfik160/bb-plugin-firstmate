import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parseStaleLavishSources, staleLavishSourceScript } from "./orphan-decisions.ts";

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
