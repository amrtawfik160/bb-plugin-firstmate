import assert from "node:assert/strict";
import test from "node:test";
import { FINISHED_RETIRE_GRACE_MS, finishedRetireVerdict, latestStatusAt, openCaptainHoldOrigins, type FinishedCrewFacts } from "./finished-crew-retire.ts";

const now = 1_792_330_000_000;
const old = Math.floor((now - FINISHED_RETIRE_GRACE_MS - 60_000) / 1000);
const facts = (extra: Partial<FinishedCrewFacts> = {}): FinishedCrewFacts => ({
  shape: "scout", secondmate: false, keptAfterMerge: false, nativeHome: "/native", threadStatus: "idle",
  statusLines: [`working [at=${old - 600}]: reading`, `done [at=${old}]: report ready at data/x/report.md`],
  deliveryOpen: false, untrackedPr: false, ownerQuestionOpen: false, ...extra,
});

// Live home thr_pse43vv6tn, 18 Oct: 0805f156 wrote "done" on 13 Oct, stayed idle, and its row
// was still under "In flight".
test("an idle crew whose done line is older than the grace period is retired", () => {
  assert.deepEqual(finishedRetireVerdict(facts(), now), { retire: true, note: "report ready at data/x/report.md" });
});

test("a crew that is not finished, or still needed, is kept with the reason", () => {
  const fresh = Math.floor((now - 60_000) / 1000);
  const cases: Array<[Partial<FinishedCrewFacts>, RegExp]> = [
    [{ threadStatus: "running" }, /thread is running/],
    [{ threadStatus: null }, /unreadable/],
    [{ statusLines: [`done [at=${old}]: x`, `working [at=${old + 5}]: follow-up`] }, /latest status is working/],
    [{ statusLines: [`failed [at=${old}]: build broke`] }, /latest status is failed/],
    [{ statusLines: [`done [at=${fresh}]: x`] }, /less than 2 hours/],
    [{ statusLines: ["done: x"] }, /no time/],
    [{ deliveryOpen: true }, /open PR delivery/],
    [{ untrackedPr: true }, /not tracked/],
    [{ ownerQuestionOpen: true }, /owner card or question/],
    [{ keptAfterMerge: true }, /kept by the captain/],
    [{ secondmate: true }, /secondmate/],
    [{ nativeHome: "" }, /no native home/],
  ];
  for (const [extra, reason] of cases) {
    const verdict = finishedRetireVerdict(facts(extra), now);
    assert.equal(verdict.retire, false, JSON.stringify(extra));
    assert.match((verdict as { reason: string }).reason, reason);
  }
});

test("latestStatusAt reads the latest status line's time tag and skips plugin notes", () => {
  assert.equal(latestStatusAt([`done [at=100]: x`, "note: FM_DELIVERY_NOTICE=a#1"]), 100_000);
  assert.equal(latestStatusAt([]), null);
  for (const verb of ["waiting", "note"]) {
    assert.equal(latestStatusAt(["done [at=100]: complete", `${verb} [at=200]: follow-up`]), 200_000);
    assert.equal(latestStatusAt(["done [at=100]: complete", `${verb}: follow-up`]), null);
    assert.equal(finishedRetireVerdict(facts({ statusLines: [`done [at=${old}]: complete`, `${verb}: follow-up`] }), now).retire, false);
  }
  assert.equal(finishedRetireVerdict(facts({ statusLines: [`done [at=${old}]: complete`, "note: FM_DELIVERY_NOTICE=a#1"] }), now).retire, true);
});

// Checker 156-verdict-1, finding 1: the live backlog held open captain questions
// 58c2825e-debt-entry-choice and 16829bb8-owner-proof for two finished crews.
test("openCaptainHoldOrigins names the crews that an open captain-held backlog row came from", () => {
  const backlog = [
    "# Backlog",
    "## In flight",
    "- [ ] 0805f156 - read-only preview (kind: scout) (since 2026-10-13)",
    "- [ ] c9 - own row held for the captain (kind: ship) (since 2026-10-13) (hold: fm-hold-v1:QQ==) (hold-kind: captain)",
    "## Queued",
    "- [ ] 58c2825e-debt-entry-choice - Safi: choose how to add a debt (repo: Safi) (kind: captain) (since 2026-10-13) (hold: fm-hold-v1:UmVw)",
    "  Captain hold set: 2026-10-13T11:32:36Z",
    "  Captain hold origin: 58c2825e",
    "",
    "  Origin: 58c2825e",
    "- [ ] 9ce34da9 - Owner's words (kind: ship)",
    "  Origin: 1bd0090d",
    "## Done",
    "- [x] effb86fb-arm-swap - Swap a server? (kind: captain) (done 2026-10-18) (hold: fm-hold-v1:QQ==) (hold-kind: captain)",
    "  Captain hold origin: effb86fb",
  ].join("\n");
  assert.deepEqual([...openCaptainHoldOrigins(backlog)].sort(), ["58c2825e", "c9"]);
});

// Forgotten-work audit, 18 Oct: crew 2803e0af had 34 commits only on this machine.
test("the unsaved-work check finds uncommitted files, commits on no remote and stashes on the crew's branches", async () => {
  const { execFileSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { UNSAVED_WORK_SCRIPT, unsavedWorkFindings } = await import("./finished-crew-retire.ts");
  const root = mkdtempSync(join(tmpdir(), "fm-unsaved-"));
  try {
    const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
    const origin = join(root, "origin.git");
    git(root, "init", "-q", "--bare", "-b", "main", origin);
    const repo = join(root, "repo");
    git(root, "clone", "-q", origin, repo);
    writeFileSync(join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-q", "-m", "base");
    git(repo, "push", "-q", "origin", "HEAD:main");
    const check = (dir: string) => unsavedWorkFindings(execFileSync("bash", ["-c", UNSAVED_WORK_SCRIPT, "check", dir, "c1"], { encoding: "utf8" }));

    const wt = join(root, "wt");
    git(repo, "worktree", "add", "-q", "-b", "fm/c1", wt);
    assert.deepEqual(check(wt), [], "a clean worktree whose commits are on the remote");

    writeFileSync(join(wt, "new.txt"), "x\n");
    assert.deepEqual(check(wt), ["1 uncommitted file(s)"]);
    git(wt, "add", "new.txt");
    git(wt, "commit", "-q", "-m", "local only");
    assert.deepEqual(check(wt), ["1 commit(s) on no remote"]);
    git(wt, "push", "-q", "origin", "fm/c1");
    assert.deepEqual(check(wt), []);

    git(wt, "checkout", "-q", "-b", "fm/c1-notify");
    writeFileSync(join(wt, "n.txt"), "n\n");
    git(wt, "add", "n.txt");
    git(wt, "commit", "-q", "-m", "stacked");
    git(wt, "checkout", "-q", "fm/c1");
    assert.deepEqual(check(wt), ["1 commit(s) on no remote"], "a commit on another fm/c1-* branch counts");
    git(wt, "branch", "-q", "-D", "fm/c1-notify");

    writeFileSync(join(wt, "a.txt"), "changed\n");
    git(wt, "stash", "push", "-q");
    assert.deepEqual(check(wt), ["1 stash(es)"]);
    git(wt, "stash", "drop", "-q");
    writeFileSync(join(repo, "a.txt"), "other\n");
    git(repo, "stash", "push", "-q");
    assert.deepEqual(check(wt), [], "a stash made on another branch is not this crew's");

    assert.deepEqual(check(join(root, "gone")), ["worktree unreadable"]);

    // Checker 156-verdict-2, finding 1: git status exits 128 on a corrupt index; that is no clean read.
    writeFileSync((await import("node:path")).resolve(wt, git(wt, "rev-parse", "--git-path", "index").trim()), "garbage");
    assert.deepEqual(check(wt), ["worktree check failed"]);
    assert.deepEqual(unsavedWorkFindings(""), ["worktree check failed"], "no completed check is no clean read");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

// Checker 156-verdict-3 reproduction: a plain repository whose HEAD is on a remote-tracking ref and
// whose index is corrupt.
test("the unsaved-work check fails closed on a corrupt index in a plain repository", async () => {
  const { execFileSync, spawnSync } = await import("node:child_process");
  const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { UNSAVED_WORK_SCRIPT, unsavedWorkFindings } = await import("./finished-crew-retire.ts");
  const dir = mkdtempSync(join(tmpdir(), "fm-corrupt-index-"));
  try {
    const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, encoding: "utf8" });
    git("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a"), "base");
    git("add", "a");
    git("commit", "-qm", "base");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    writeFileSync(join(dir, ".git/index"), "corrupt");
    assert.notEqual(spawnSync("git", ["status", "--porcelain"], { cwd: dir }).status, 0);
    const out = execFileSync("bash", ["-c", UNSAVED_WORK_SCRIPT, "check", dir, "corrupt1"], { encoding: "utf8" });
    assert.deepEqual(unsavedWorkFindings(out), ["worktree check failed"]);
    assert.deepEqual(unsavedWorkFindings("FM_UNSAVED uncommitted 1\n"), ["worktree check failed"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
