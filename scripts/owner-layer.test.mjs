import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync, execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const ROOT = process.cwd();
const PIN = readFileSync(join(ROOT, "overlay/patch-base.txt"), "utf8").trim();
const RULES = JSON.parse(readFileSync(join(ROOT, "owner/rules.json"), "utf8")).rules;
const PLUGIN_RULES = RULES.filter((rule) => rule.layer === "plugin");

function copyRepo() {
  const root = mkdtempSync(join(tmpdir(), "owner-layer-"));
  for (const file of execFileSync("git", ["ls-files", "-co", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)) {
    if (file.startsWith("third-party/") || file === "runtime-assets/runtime.tar.gz") continue;
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(ROOT, file), join(root, file));
  }
  return root;
}

function check(root, ...args) {
  return spawnSync(process.execPath, [join(ROOT, "scripts/owner-layer-check.mjs"), "--root", root, ...args], { encoding: "utf8" });
}

const edit = (root, rel, fn) => writeFileSync(join(root, rel), fn(readFileSync(join(root, rel), "utf8")));

test("the snapshot README names the current pin", () => {
  assert.match(readFileSync(join(ROOT, "native-snapshot/README.md"), "utf8"), new RegExp(`Current snapshot: \`${PIN}\``));
});

test("every owner rule is present where the owner layer applies it", () => {
  const r = check(ROOT);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, new RegExp(`owner layer ok: ${PLUGIN_RULES.length} plugin rules`));
});

test("the owner map lists every registered rule with its old and new place", () => {
  const r = check(ROOT, "--map");
  assert.equal(r.status, 0, r.stderr);
  for (const rule of RULES) assert.ok(r.stdout.includes(`| \`${rule.id}\` | ${rule.rule} | \`${rule.old}\` | \`${rule.file}\` |`), rule.id);
});

test("a dropped or reworded owner rule fails the check and names the rule", () => {
  const root = copyRepo();
  try {
    for (const rule of PLUGIN_RULES) {
      const original = readFileSync(join(root, rule.file), "utf8");
      writeFileSync(join(root, rule.file), original.split(rule.anchor).join(rule.anchor.replace(/\w+/, "CHANGED")));
      const r = check(root);
      assert.equal(r.status, 1, `${rule.id}: reworded rule passed`);
      assert.match(r.stdout, new RegExp(`OWNER_RULE_MISSING: ${rule.id} `), r.stdout);
      writeFileSync(join(root, rule.file), original);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an owner rule may not live in a file that a re-pin rewrites", () => {
  const root = copyRepo();
  try {
    edit(root, "owner/rules.json", (s) => {
      const json = JSON.parse(s);
      json.rules.push({ id: "in-native-copy", layer: "plugin", rule: "x", old: "x", file: "skills/ship-landing/SKILL.md", anchor: "---" });
      return JSON.stringify(json);
    });
    const r = check(root);
    assert.equal(r.status, 1, r.stdout);
    assert.match(r.stdout, /OWNER_RULE_IN_NATIVE_COPY: in-native-copy skills\/ship-landing\/SKILL.md/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the host check reads host files only when asked and reports a missing rule", () => {
  const home = mkdtempSync(join(tmpdir(), "owner-host-"));
  try {
    const off = check(ROOT);
    assert.doesNotMatch(off.stdout, /HOST/);
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/owner-layer-check.mjs"), "--root", ROOT, "--host"], { encoding: "utf8", env: { ...process.env, HOME: home, FM_HOME: join(home, "fm") } });
    assert.equal(r.status, 1, r.stdout);
    for (const rule of RULES.filter((x) => x.layer === "host")) assert.match(r.stdout, new RegExp(`OWNER_RULE_MISSING: ${rule.id} `), r.stdout);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

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

function repin(root, native, sha) {
  return spawnSync(process.execPath, ["scripts/refresh-native-pin.mjs", native, sha], { cwd: root, encoding: "utf8" });
}

test("a re-pin keeps every owner rule and every adapted skill on the new pin", () => {
  const root = copyRepo();
  const { native, sha } = syntheticNative();
  try {
    const before = Object.fromEntries(PLUGIN_RULES.map((rule) => [rule.file, readFileSync(join(root, rule.file), "utf8")]));
    const r = repin(root, native, sha);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /owner layer ok/);
    assert.match(r.stdout, /skill-fidelity: OK/);
    for (const [file, text] of Object.entries(before)) {
      assert.equal(readFileSync(join(root, file), "utf8"), text.replaceAll(PIN, sha).replaceAll(`native-snapshot/${PIN.slice(0, 8)}`, `native-snapshot/${sha.slice(0, 8)}`), `${file} changed beyond the pin`);
    }
    assert.match(readFileSync(join(root, "entry-skills/captain/SKILL.md"), "utf8"), new RegExp(`sha: ${sha}`));
    assert.equal(readFileSync(join(root, "native-snapshot", sha.slice(0, 8), "AGENTS.md"), "utf8"), readFileSync(join(native, "AGENTS.md"), "utf8"));
    assert.match(readFileSync(join(root, "native-snapshot/README.md"), "utf8"), new RegExp(`Current snapshot: \`${sha}\``));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(native, { recursive: true, force: true });
  }
});

test("a re-pin fails when the new native drops a sentence an owner divergence quotes", () => {
  const root = copyRepo();
  const quote = "Use `bin/fm-pr-merge.sh` for every task PR merge so merge metadata is recorded and an unproved merge is refused instead of reported as landed";
  const { native, sha } = syntheticNative((dir) => {
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.ok(agents.includes(quote), "fixture quote missing from the pinned AGENTS.md");
    writeFileSync(join(dir, "AGENTS.md"), agents.replace(quote, "Merge task PRs with the merge helper"));
  });
  try {
    const r = repin(root, native, sha);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /PIN REFUSED/);
    assert.match(r.stderr, /entry-skills\/captain\/SKILL\.md.*native-quote/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(native, { recursive: true, force: true });
  }
});

test("a re-pin refuses before writing when the new native removes a file a BB skill copies", () => {
  const root = copyRepo();
  const { native, sha } = syntheticNative((dir) => rmSync(join(dir, ".agents/skills/ship-landing/SKILL.md")));
  try {
    const before = readFileSync(join(root, "lib/upstream-surface.ts"), "utf8");
    const r = repin(root, native, sha);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /NATIVE_SOURCE_GONE: skills\/ship-landing\/SKILL\.md copies \.agents\/skills\/ship-landing\/SKILL\.md/);
    assert.match(r.stdout, /PIN REFUSED: .* Nothing was written\./);
    assert.equal(readFileSync(join(root, "lib/upstream-surface.ts"), "utf8"), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(native, { recursive: true, force: true });
  }
});
