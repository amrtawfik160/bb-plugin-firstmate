import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = process.cwd();
const PIN = readFileSync(join(ROOT, "overlay/patch-base.txt"), "utf8").trim();
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });
const commit = (dir) => git(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "base");

function copyRepo() {
  const root = mkdtempSync(join(tmpdir(), "owner-layer-"));
  for (const file of git(ROOT, "ls-files", "-co", "--exclude-standard").split("\n").filter(Boolean)) {
    if (file.startsWith("third-party/") || file === "runtime-assets/runtime.tar.gz" || !existsSync(join(ROOT, file))) continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
  git(root, "init", "-q");
  git(root, "add", "-A");
  commit(root);
  return root;
}

function fakeHost() {
  const home = mkdtempSync(join(tmpdir(), "owner-host-"));
  const files = { ".bb-server/AGENTS.md": "# Writing replies to me\nrule\n", ".claude/CLAUDE.md": "- write a changelog\n", "fm/data/captain.md": "# Owner instructions\nrule\n" };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(home, rel)), { recursive: true });
    writeFileSync(join(home, rel), text);
  }
  return home;
}

// Copies each snapshot to its BB-SOURCE native path: some snapshots sit at a
// different path than native (skills/ahoy vs .agents/skills/ahoy).
function bbSources(root, dir) {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const rel = join(dir, entry.name);
    if (entry.isDirectory()) return bbSources(root, rel);
    if (!entry.name.endsWith(".md")) return [];
    const header = /<!-- BB-SOURCE\s+([\s\S]*?)-->/.exec(readFileSync(join(root, rel), "utf8"));
    return header ? [{ native: /native:\s*(\S+)/.exec(header[1])[1], snapshot: /snapshot:\s*(\S+)/.exec(header[1])[1] }] : [];
  });
}

function syntheticNative(mutate) {
  const native = mkdtempSync(join(tmpdir(), "owner-native-"));
  for (const { native: path, snapshot } of [...bbSources(ROOT, "skills"), ...bbSources(ROOT, "entry-skills")]) {
    mkdirSync(dirname(join(native, path)), { recursive: true });
    cpSync(join(ROOT, snapshot), join(native, path));
  }
  mkdirSync(join(native, "bin"), { recursive: true });
  writeFileSync(join(native, "bin/fm-example.sh"), "#!/bin/sh\n");
  mutate?.(native);
  git(native, "init", "-q");
  git(native, "add", "-A");
  commit(native);
  return { native, sha: git(native, "rev-parse", "HEAD").trim() };
}

// A writer that vendors the pin with the real writer, then runs `code` with fs,
// path, the fake host `home` and the `live` checkout in scope.
function writer(dir, root, code) {
  const path = join(dir, `writer-${Math.random().toString(36).slice(2)}.mjs`);
  writeFileSync(path, `
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
const r = spawnSync(process.execPath, ["scripts/vendor-native-pin.mjs", ...process.argv.slice(2)], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status);
const home = ${JSON.stringify(dir)};
const live = ${JSON.stringify(root)};
const edit = (file, from, to) => { const text = fs.readFileSync(file, "utf8"); if (!text.includes(from)) process.exit(9); fs.writeFileSync(file, text.replace(from, to)); };
${code}
`);
  return path;
}

function repin(root, native, sha, home, writerPath) {
  const env = { ...process.env, HOME: home, FM_HOME: join(home, "fm") };
  if (writerPath) env.REPIN_WRITER = writerPath;
  return spawnSync(process.execPath, ["scripts/refresh-native-pin.mjs", native, sha], { cwd: root, encoding: "utf8", env });
}

const liveState = (root) => git(root, "rev-parse", "HEAD") + git(root, "status", "--porcelain", "--untracked-files=all");
const branchOf = (stdout) => /on branch (\S+) at (\S+)\./.exec(stdout);

function withRepin(run, mutate, setup) {
  const root = copyRepo();
  setup?.(root);
  const home = fakeHost();
  const { native, sha } = syntheticNative(mutate);
  try {
    const live = liveState(root);
    run({ root, home, native, sha });
    assert.equal(liveState(root), live, "the live checkout is never written");
  } finally {
    for (const line of git(root, "worktree", "list", "--porcelain").split("\n")) {
      const dir = line.startsWith("worktree ") ? line.slice("worktree ".length) : null;
      if (dir !== null && dir !== root && existsSync(dir)) rmSync(dir, { recursive: true, force: true });
    }
    for (const dir of [root, home, native]) rmSync(dir, { recursive: true, force: true });
  }
}

function refused(r, pattern) {
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stdout, pattern);
  assert.match(r.stdout, /PIN REFUSED: .*not used/);
  assert.doesNotMatch(r.stderr, /\n\s+at /, "no stack trace");
}

test("the snapshot README names the current pin", () => {
  assert.match(readFileSync(join(ROOT, "native-snapshot/README.md"), "utf8"), new RegExp(`Current snapshot: \`${PIN}\``));
});

test("a re-pin writes a sync branch that changes only native files and native regions", () => {
  withRepin(({ root, home, native, sha }) => {
    const r = repin(root, native, sha, home);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ownership ok: \d+ changed paths are native-owned; 3 host files unchanged/);
    assert.match(r.stdout, /skill-fidelity: OK/);
    const [, branch, dir] = branchOf(r.stdout);
    const changed = git(root, "diff", "--name-only", "HEAD", branch).split("\n").filter(Boolean);
    assert.ok(changed.includes("entry-skills/captain/SKILL.md") && changed.includes(`native-snapshot/${sha.slice(0, 8)}/AGENTS.md`), changed.join(" "));
    assert.equal(git(root, "diff", "HEAD", branch, "--", "entry-skills/skill-routing", "owner"), "");
    assert.equal(git(root, "show", `${branch}:entry-skills/captain/SKILL.md`), readFileSync(join(root, "entry-skills/captain/SKILL.md"), "utf8").replace(`sha: ${PIN}`, `sha: ${sha}`).replace(`native-snapshot/${PIN.slice(0, 8)}/`, `native-snapshot/${sha.slice(0, 8)}/`));
    assert.match(git(root, "show", `${branch}:native-snapshot/README.md`), new RegExp(`Current snapshot: \`${sha}\``));
    git(root, "worktree", "remove", "--force", dir);
  });
});

test("the writer runs in a fresh worktree with an empty HOME and no FM_HOME", () => {
  withRepin(({ root, home, native, sha }) => {
    const r = repin(root, native, sha, home, writer(home, root, `fs.writeFileSync(path.join(home, "seen.json"), JSON.stringify({ cwd: process.cwd(), home: process.env.HOME, entries: fs.readdirSync(process.env.HOME), fm: process.env.FM_HOME ?? null }));`));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const seen = JSON.parse(readFileSync(join(home, "seen.json"), "utf8"));
    assert.notEqual(seen.cwd, root);
    assert.equal(seen.cwd, branchOf(r.stdout)[2]);
    assert.notEqual(seen.home, home);
    assert.deepEqual(seen.entries, []);
    assert.equal(seen.fm, null);
  });
});

const CREW_RULES = "owner/crew-rules.ts";

const OWNER_CHANGES = [
  ["rewords the reply-style rule", "entry-skills/skill-routing/SKILL.md", `edit("entry-skills/skill-routing/SKILL.md", "user keep the user's reply style.", "user ignore the user's reply style.");`],
  ["deletes a routing row", "entry-skills/skill-routing/SKILL.md", `edit("entry-skills/skill-routing/SKILL.md", "| PR body | \`pr\` |\\n", "");`],
  ["deletes a telegram.md line", "entry-skills/captain/references/telegram.md", `edit("entry-skills/captain/references/telegram.md", "A turn that only handled crew wakes, with nothing for the owner, ends with no text.\\n", "");`],
  ["edits the BB-only text of a mixed file", "entry-skills/captain/SKILL.md", `edit("entry-skills/captain/SKILL.md", "Merge only through \`firstmate_merge\`", "Merge with gh");`],
  ["edits a crew-brief rule", CREW_RULES, `edit("${CREW_RULES}", "spawn no sub-agents", "spawn sub-agents");`],
  ["adds an owner file", "owner/extra.md", `fs.writeFileSync("owner/extra.md", "new rule\\n");`],
  ["replaces an owner file with a link to identical bytes", CREW_RULES, `fs.writeFileSync(path.join(home, "copy.ts"), fs.readFileSync("${CREW_RULES}")); fs.rmSync("${CREW_RULES}"); fs.symlinkSync(path.join(home, "copy.ts"), "${CREW_RULES}");`],
  ["replaces an owner file with a link to a host file", CREW_RULES, `fs.rmSync("${CREW_RULES}"); fs.symlinkSync(path.join(home, ".claude/CLAUDE.md"), "${CREW_RULES}");`],
  ["replaces an owner file with a dangling link", CREW_RULES, `fs.rmSync("${CREW_RULES}"); fs.symlinkSync(path.join(home, "missing.ts"), "${CREW_RULES}");`],
  ["replaces owner/ with a link to the home", CREW_RULES, `fs.rmSync("owner", { recursive: true }); fs.symlinkSync(home, "owner");`],
  ["renames owner/", CREW_RULES, `fs.renameSync("owner", "renamed-owner");`],
  ["deletes owner/", CREW_RULES, `fs.rmSync("owner", { recursive: true });`],
  ["changes an owner script's mode", "scripts/skill-roots-check.sh", `fs.chmodSync("scripts/skill-roots-check.sh", 0o644);`],
  ["edits a sibling of a native file that shares its prefix", "lib/upstream-surface.ts.owner.md", `fs.writeFileSync("lib/upstream-surface.ts.owner.md", "changed\\n");`],
  ["edits owner files and then locks owner/ against writes", CREW_RULES, `edit("${CREW_RULES}", "spawn no sub-agents", "spawn sub-agents"); edit("server.ts", "import", "import"); fs.chmodSync("owner", 0o555);`],
];

for (const [name, file, code] of OWNER_CHANGES) {
  test(`the writer ${name} -> refused, branch not used`, () => {
    withRepin(({ root, home, native, sha }) => {
      const r = repin(root, native, sha, home, writer(home, root, code));
      refused(r, new RegExp(`OWNER_CHANGED: ${file.replace(/[.]/g, "\\.")} `));
      assert.equal(git(root, "branch", "--list", "native-pin/*"), "", "refused branch deleted");
    }, undefined, (root) => {
      if (!file.endsWith(".owner.md")) return;
      writeFileSync(join(root, file), "owner policy\n");
      git(root, "add", file);
      commit(root);
    });
  });
}

test("the writer changes a folder's mode -> nothing used changes: git records no folder modes", () => {
  withRepin(({ root, home, native, sha }) => {
    const mode = statSync(join(root, "owner")).mode;
    const r = repin(root, native, sha, home, writer(home, root, `fs.chmodSync("owner", 0o500);`));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(git(root, "diff", "HEAD", branchOf(r.stdout)[1], "--", "owner"), "");
    assert.equal(statSync(join(root, "owner")).mode, mode, "the live owner/ keeps its mode");
  });
});

test("the writer writes into the live checkout -> refused", () => {
  const root = copyRepo();
  const home = fakeHost();
  const { native, sha } = syntheticNative();
  try {
    const r = repin(root, native, sha, home, writer(home, root, `fs.writeFileSync(path.join(live, "${CREW_RULES}"), "changed\\n");`));
    refused(r, /LIVE_CHECKOUT_CHANGED/);
  } finally {
    for (const dir of [root, home, native]) rmSync(dir, { recursive: true, force: true });
  }
});

for (const file of [".claude/CLAUDE.md", ".bb-server/AGENTS.md", "fm/data/captain.md"]) {
  test(`the writer edits the host file ~/${file} -> refused`, () => {
    withRepin(({ root, home, native, sha }) => {
      const r = repin(root, native, sha, home, writer(home, root, `fs.appendFileSync(path.join(home, "${file}"), "extra\\n");`));
      refused(r, new RegExp(`HOST_FILE_CHANGED: ${join(home, file).replace(/[.]/g, "\\.")} \\(content\\)`));
    });
  });
}

test("the writer edits the target of a host-file link -> refused", () => {
  withRepin(({ root, home, native, sha }) => {
    const link = join(home, ".claude/CLAUDE.md");
    writeFileSync(join(home, "policy-target.md"), readFileSync(link));
    rmSync(link);
    symlinkSync(join(home, "policy-target.md"), link);
    const r = repin(root, native, sha, home, writer(home, root, `fs.writeFileSync(path.join(home, "policy-target.md"), "host policy lost\\n");`));
    refused(r, /HOST_FILE_CHANGED: .*CLAUDE\.md \(content\)/);
  });
});

test("the writer swaps a host-file link for another link with the same content -> refused", () => {
  withRepin(({ root, home, native, sha }) => {
    const link = join(home, ".claude/CLAUDE.md");
    writeFileSync(join(home, "a.md"), readFileSync(link));
    writeFileSync(join(home, "b.md"), readFileSync(link));
    rmSync(link);
    symlinkSync(join(home, "a.md"), link);
    const r = repin(root, native, sha, home, writer(home, root, `fs.rmSync(path.join(home, ".claude/CLAUDE.md")); fs.symlinkSync(path.join(home, "b.md"), path.join(home, ".claude/CLAUDE.md"));`));
    refused(r, /HOST_FILE_CHANGED: .*CLAUDE\.md \(link\)/);
  });
});

test("the writer leaves a native copy that differs from the pin -> refused", () => {
  withRepin(({ root, home, native, sha }) => {
    const r = repin(root, native, sha, home, writer(home, root, `fs.appendFileSync("native-snapshot/${sha.slice(0, 8)}/AGENTS.md", "extra\\n");`));
    refused(r, new RegExp(`NATIVE_COPY_DIFFERS: native-snapshot/${sha.slice(0, 8)}/AGENTS\\.md`));
  });
});

test("the new native drops a sentence an owner divergence quotes -> refused, branch kept for the sync", () => {
  const quote = "Use `bin/fm-pr-merge.sh` for every task PR merge so merge metadata is recorded and an unproved merge is refused instead of reported as landed";
  withRepin(({ root, home, native, sha }) => {
    const r = repin(root, native, sha, home);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /entry-skills\/captain\/SKILL\.md.*native-quote/);
    assert.match(r.stdout, /PIN REFUSED: .*fix the skills on branch native-pin\//);
    git(root, "worktree", "remove", "--force", branchOf(r.stdout)[2]);
  }, (dir) => {
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.ok(agents.includes(quote), "fixture quote missing from the pinned AGENTS.md");
    writeFileSync(join(dir, "AGENTS.md"), agents.replace(quote, "Merge task PRs with the merge helper"));
  });
});

test("the new native removes a file a BB skill copies -> refused before writing", () => {
  withRepin(({ root, home, native, sha }) => {
    const r = repin(root, native, sha, home);
    assert.match(r.stdout, /NATIVE_SOURCE_GONE: skills\/ship-landing\/SKILL\.md copies \.agents\/skills\/ship-landing\/SKILL\.md/);
    refused(r, /WRITER_FAILED/);
  }, (dir) => rmSync(join(dir, ".agents/skills/ship-landing/SKILL.md")));
});
