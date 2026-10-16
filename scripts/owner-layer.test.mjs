import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = process.cwd();
const PIN = readFileSync(join(ROOT, "overlay/patch-base.txt"), "utf8").trim();

function copyRepo() {
  const root = mkdtempSync(join(tmpdir(), "owner-layer-"));
  for (const file of execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)) {
    if (file.startsWith("third-party/") || file === "runtime-assets/runtime.tar.gz" || !existsSync(join(ROOT, file))) continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
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
  const git = (...args) => execFileSync("git", ["-C", native, ...args], { encoding: "utf8" });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "synthetic native");
  return { native, sha: git("rev-parse", "HEAD").trim() };
}

// A writer that vendors the pin with the real writer, then makes one extra edit.
function badWriter(dir, edit) {
  const path = join(dir, "bad-writer.mjs");
  writeFileSync(path, `
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const r = spawnSync(process.execPath, ["scripts/vendor-native-pin.mjs", ...process.argv.slice(2)], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status);
const edit = ${JSON.stringify(edit)};
const file = edit.file.replace(/^~\\//, process.env.HOME + "/");
const text = existsSync(file) ? readFileSync(file, "utf8") : "";
if (edit.from !== undefined && !text.includes(edit.from)) { console.error("bad writer: text not found"); process.exit(9); }
writeFileSync(file, edit.from === undefined ? text + edit.to : text.replace(edit.from, edit.to));
`);
  return path;
}

// A writer that vendors the pin, then runs \`code\` with fs, path, root and home in scope.
function codeWriter(dir, code) {
  const path = join(dir, "code-writer.mjs");
  writeFileSync(path, `
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
const r = spawnSync(process.execPath, ["scripts/vendor-native-pin.mjs", ...process.argv.slice(2)], { stdio: "inherit" });
if (r.status !== 0) process.exit(r.status);
const root = process.cwd();
const home = process.env.HOME;
${code}
`);
  return path;
}

function repin(root, native, sha, { home, writer } = {}) {
  const env = { ...process.env, HOME: home ?? process.env.HOME, FM_HOME: home ? join(home, "fm") : "" };
  if (writer) env.REPIN_WRITER = writer;
  return spawnSync(process.execPath, ["scripts/refresh-native-pin.mjs", native, sha], { cwd: root, encoding: "utf8", env });
}

function withRepin(run, mutate) {
  const root = copyRepo();
  const home = fakeHost();
  const { native, sha } = syntheticNative(mutate);
  try {
    run({ root, home, native, sha });
  } finally {
    for (const dir of [root, home, native]) rmSync(dir, { recursive: true, force: true });
  }
}

test("the snapshot README names the current pin", () => {
  assert.match(readFileSync(join(ROOT, "native-snapshot/README.md"), "utf8"), new RegExp(`Current snapshot: \`${PIN}\``));
});

test("a re-pin changes only native files and native regions", () => {
  withRepin(({ root, home, native, sha }) => {
    const routing = readFileSync(join(root, "entry-skills/skill-routing/SKILL.md"), "utf8");
    const captain = readFileSync(join(root, "entry-skills/captain/SKILL.md"), "utf8");
    const r = repin(root, native, sha, { home });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /ownership ok: \d+ owner files, \d+ mixed files, 3 host files unchanged/);
    assert.match(r.stdout, /skill-fidelity: OK/);
    assert.equal(readFileSync(join(root, "entry-skills/skill-routing/SKILL.md"), "utf8"), routing);
    assert.equal(readFileSync(join(root, "entry-skills/captain/SKILL.md"), "utf8"), captain.replace(`sha: ${PIN}`, `sha: ${sha}`).replace(`native-snapshot/${PIN.slice(0, 8)}/`, `native-snapshot/${sha.slice(0, 8)}/`));
    assert.equal(readFileSync(join(root, "native-snapshot", sha.slice(0, 8), "AGENTS.md"), "utf8"), readFileSync(join(native, "AGENTS.md"), "utf8"));
    assert.match(readFileSync(join(root, "native-snapshot/README.md"), "utf8"), new RegExp(`Current snapshot: \`${sha}\``));
  });
});

const OWNER_EDITS = [
  ["the checker's reword of the reply-style rule", { file: "entry-skills/skill-routing/SKILL.md", from: "user keep the user's reply style.", to: "user ignore the user's reply style." }],
  ["a deleted routing row", { file: "entry-skills/skill-routing/SKILL.md", from: "| PR body | `pr` |\n", to: "" }],
  ["a deleted telegram.md line", { file: "entry-skills/captain/references/telegram.md", from: "A turn that only handled crew wakes, with nothing for the owner, ends with no text.\n", to: "" }],
  ["an edit to the BB-only text of a mixed file", { file: "entry-skills/captain/SKILL.md", from: "Merge only through `firstmate_merge`", to: "Merge with gh" }],
  ["an edit to a crew-brief rule", { file: "owner/crew-rules.ts", from: "spawn no sub-agents", to: "spawn sub-agents" }],
];

for (const [name, edit] of OWNER_EDITS) {
  test(`a re-pin with ${name} is refused and the file restored`, () => {
    withRepin(({ root, home, native, sha }) => {
      const original = readFileSync(join(root, edit.file), "utf8");
      const r = repin(root, native, sha, { home, writer: badWriter(home, { ...edit, file: join(root, edit.file) }) });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, new RegExp(`OWNER_BYTES_CHANGED: ${edit.file.replace(/[.]/g, "\\.")}`));
      assert.match(r.stdout, /PIN REFUSED/);
      assert.equal(readFileSync(join(root, edit.file), "utf8"), original, "owner file restored");
    });
  });
}

test("a re-pin that adds an owner file is refused and the file removed", () => {
  withRepin(({ root, home, native, sha }) => {
    const r = repin(root, native, sha, { home, writer: badWriter(home, { file: join(root, "owner/extra.md"), to: "new rule\n" }) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /OWNER_BYTES_CHANGED: owner\/extra\.md \(added\)/);
    assert.ok(!existsSync(join(root, "owner/extra.md")));
  });
});

for (const file of ["~/.claude/CLAUDE.md", "~/.bb-server/AGENTS.md", "~/fm/data/captain.md"]) {
  test(`a re-pin that edits the host file ${file} is refused and the file restored`, () => {
    withRepin(({ root, home, native, sha }) => {
      const path = join(home, file.slice(2));
      const original = readFileSync(path, "utf8");
      const r = repin(root, native, sha, { home, writer: badWriter(home, { file, to: "extra\n" }) });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /HOST_FILE_CHANGED: /);
      assert.match(r.stdout, /PIN REFUSED/);
      assert.equal(readFileSync(path, "utf8"), original, "host file restored");
    });
  });
}

test("a re-pin whose native copy differs from the pin is refused", () => {
  withRepin(({ root, home, native, sha }) => {
    const r = repin(root, native, sha, { home, writer: badWriter(home, { file: join(root, "native-snapshot", sha.slice(0, 8), "AGENTS.md"), to: "extra\n" }) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`NATIVE_COPY_DIFFERS: native-snapshot/${sha.slice(0, 8)}/AGENTS\\.md`));
  });
});

test("a re-pin fails when the new native drops a sentence an owner divergence quotes", () => {
  const quote = "Use `bin/fm-pr-merge.sh` for every task PR merge so merge metadata is recorded and an unproved merge is refused instead of reported as landed";
  withRepin(({ root, home, native, sha }) => {
    const r = repin(root, native, sha, { home });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /PIN REFUSED/);
    assert.match(r.stderr, /entry-skills\/captain\/SKILL\.md.*native-quote/);
  }, (dir) => {
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.ok(agents.includes(quote), "fixture quote missing from the pinned AGENTS.md");
    writeFileSync(join(dir, "AGENTS.md"), agents.replace(quote, "Merge task PRs with the merge helper"));
  });
});

test("a re-pin refuses before writing when the new native removes a file a BB skill copies", () => {
  withRepin(({ root, home, native, sha }) => {
    const before = readFileSync(join(root, "lib/upstream-surface.ts"), "utf8");
    const r = repin(root, native, sha, { home });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /NATIVE_SOURCE_GONE: skills\/ship-landing\/SKILL\.md copies \.agents\/skills\/ship-landing\/SKILL\.md/);
    assert.match(r.stdout, /PIN REFUSED: .* Nothing was written\./);
    assert.equal(readFileSync(join(root, "lib/upstream-surface.ts"), "utf8"), before);
  }, (dir) => rmSync(join(dir, ".agents/skills/ship-landing/SKILL.md")));
});

const CREW_RULES = "owner/crew-rules.ts";

function assertRestored(root, files) {
  for (const [rel, bytes] of Object.entries(files)) {
    assert.ok(!lstatSync(join(root, rel)).isSymbolicLink(), `${rel} is still a link`);
    assert.ok(lstatSync(join(root, rel)).isFile(), `${rel} is not a regular file`);
    assert.equal(readFileSync(join(root, rel), "utf8"), bytes, `${rel} restored`);
  }
}

const ownerFiles = (root) => Object.fromEntries(readdirSync(join(root, "owner")).map((name) => [`owner/${name}`, readFileSync(join(root, "owner", name), "utf8")]));

const LINK_ATTACKS = [
  ["a link to a file with the same bytes", `fs.writeFileSync(path.join(home, "copy.ts"), fs.readFileSync("${CREW_RULES}")); fs.rmSync("${CREW_RULES}"); fs.symlinkSync(path.join(home, "copy.ts"), "${CREW_RULES}");`],
  ["a link to a host file", `fs.rmSync("${CREW_RULES}"); fs.symlinkSync(path.join(home, ".claude/CLAUDE.md"), "${CREW_RULES}");`],
  ["a dangling link", `fs.rmSync("${CREW_RULES}"); fs.symlinkSync(path.join(home, "missing.ts"), "${CREW_RULES}");`],
  ["the owner folder replaced by a link to the home", `fs.rmSync("owner", { recursive: true }); fs.symlinkSync(home, "owner");`],
  ["the owner folder renamed", `fs.renameSync("owner", "renamed-owner");`],
  ["the owner folder deleted", `fs.rmSync("owner", { recursive: true });`],
];

for (const [name, code] of LINK_ATTACKS) {
  test(`a re-pin with ${name} is refused and every owner file restored as a regular file`, () => {
    withRepin(({ root, home, native, sha }) => {
      const owner = ownerFiles(root);
      const host = readFileSync(join(home, ".claude/CLAUDE.md"), "utf8");
      const r = repin(root, native, sha, { home, writer: codeWriter(home, code) });
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /OWNER_BYTES_CHANGED: owner/);
      assert.match(r.stdout, /PIN REFUSED: .*restored and checked/);
      assert.doesNotMatch(r.stdout + r.stderr, /RESTORE FAILED|ENOENT|EISDIR/);
      assertRestored(root, owner);
      assert.ok(!existsSync(join(root, "renamed-owner")), "renamed folder removed");
      assert.equal(readFileSync(join(home, ".claude/CLAUDE.md"), "utf8"), host, "host file untouched by restore");
    });
  });
}

test("a re-pin that changes an owner script's mode is refused and the mode restored", () => {
  withRepin(({ root, home, native, sha }) => {
    const script = "scripts/skill-roots-check.sh";
    const mode = statSync(join(root, script)).mode;
    const r = repin(root, native, sha, { home, writer: codeWriter(home, `fs.chmodSync("${script}", 0o644);`) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /OWNER_BYTES_CHANGED: scripts\/skill-roots-check\.sh/);
    assert.equal(statSync(join(root, script)).mode, mode);
  });
});

test("a native file entry protects only that exact path, not a sibling with the same prefix", () => {
  withRepin(({ root, home, native, sha }) => {
    const sibling = "lib/upstream-surface.ts.owner.md";
    writeFileSync(join(root, sibling), "owner policy\n");
    const r = repin(root, native, sha, { home, writer: codeWriter(home, `fs.writeFileSync("${sibling}", "changed\\n");`) });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /OWNER_BYTES_CHANGED: lib\/upstream-surface\.ts\.owner\.md/);
    assert.equal(readFileSync(join(root, sibling), "utf8"), "owner policy\n");
  });
});
