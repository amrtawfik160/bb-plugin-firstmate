#!/usr/bin/env node
// Guarded re-pin: node scripts/refresh-native-pin.mjs <native clone> <audited SHA>
//
// owner/ownership.json splits every file into native-owned and owner-owned.
// The writer (scripts/vendor-native-pin.mjs) may change only native files and
// the native regions of mixed files. This guard records every owner byte and
// every host file before the writer runs, and refuses the pin (PIN REFUSED,
// exit 1) when any of them changed: it restores them and names each one. It
// then refuses when a native copy differs from the pin, or when skill fidelity
// finds native text that differs outside a BB marker; those native files stay
// written so a sync can fix the skills that copy them.
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const [native, sha] = process.argv.slice(2);
if (!native || !/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Usage: node scripts/refresh-native-pin.mjs <native clone> <audited SHA>");
const manifest = JSON.parse(readFileSync("owner/ownership.json", "utf8"));

function walk(dir = ".", out = { entries: [], dirs: [] }) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (manifest.skip.some((skip) => `${rel}/`.startsWith(skip))) continue;
    if (entry.isDirectory()) {
      out.dirs.push(rel);
      walk(rel, out);
    } else out.entries.push(rel);
  }
  return out;
}

const header = (text) => /<!-- BB-SOURCE\s+([\s\S]*?)-->/.exec(text);
const isSkillDoc = (rel) => /^(?:entry-skills|skills)\/.*\.md$/.test(rel);
const nativePath = (rel) => manifest.native.paths.some((path) => (path.endsWith("/") ? rel.startsWith(path) : rel === path));

// An entry as the filesystem holds it, links not followed.
function entryAt(path) {
  let stat;
  try { stat = lstatSync(path); } catch { return null; }
  if (stat.isSymbolicLink()) return { type: "link", target: readlinkSync(path) };
  if (stat.isFile()) return { type: "file", bytes: readFileSync(path), mode: stat.mode & 0o7777 };
  return { type: stat.isDirectory() ? "dir" : "other" };
}

function kind(rel, entry) {
  if (nativePath(rel)) return "native";
  const source = entry.type === "file" && isSkillDoc(rel) ? header(entry.bytes.toString("utf8")) : null;
  if (source === null) return "owner";
  return /fidelity:\s*verbatim/.test(source[1]) ? "native" : "mixed";
}

// A mixed file with its native regions blanked: the BB-SOURCE header and the
// native: and native-quote: fields of each BB-DIVERGE comment.
function ownerView(text) {
  return text
    .replace(/<!-- BB-SOURCE[\s\S]*?-->/, "<!-- BB-SOURCE -->")
    .replace(/<!-- BB-DIVERGE[\s\S]*?-->/g, (block) => block.replace(/(\n\s*native(?:-quote)?:)[\s\S]*?(?=\n\s*[a-z-]+:\s|-->)/g, "$1"));
}

function same(was, now, mixed = false) {
  if (was === null || now === null) return was === now;
  if (was.type !== now.type) return false;
  if (was.type === "link") return was.target === now.target;
  if (was.type !== "file") return true;
  if (was.mode !== now.mode) return false;
  return mixed ? ownerView(now.bytes.toString("utf8")) === ownerView(was.bytes.toString("utf8")) : now.bytes.equals(was.bytes);
}

function hostFiles() {
  return manifest.host.flatMap((file) => {
    if (file.startsWith("~/")) return [join(process.env.HOME ?? homedir(), file.slice(2))];
    if (file.startsWith("$FM_HOME/")) return process.env.FM_HOME ? [join(process.env.FM_HOME, file.slice("$FM_HOME/".length))] : [];
    return [file];
  });
}

const ancestors = (path) => { const out = []; for (let d = dirname(path); d !== dirname(d); d = dirname(d)) out.unshift(d); return out; };

function record() {
  const { entries, dirs } = walk();
  const repo = new Map(entries.map((rel) => { const entry = entryAt(rel); return [rel, { ...entry, kind: kind(rel, entry) }]; }));
  const host = new Map();
  for (const path of hostFiles()) for (const p of [...ancestors(path), path]) host.set(p, entryAt(p));
  return { repo, dirs: new Set(dirs), host };
}

function remove(path) {
  const now = entryAt(path);
  if (now !== null) rmSync(path, { recursive: now.type === "dir", force: true });
}

function put(path, entry) {
  remove(path);
  if (entry.type === "link") symlinkSync(entry.target, path);
  else if (entry.type === "dir") mkdirSync(path);
  else if (entry.type === "file") { writeFileSync(path, entry.bytes); chmodSync(path, entry.mode); }
}

// Every protected entry that differs from the record, in restore order.
function differences(before, after) {
  const out = [];
  for (const [rel, was] of before.repo) {
    if (was.kind !== "native" && !same(was, after.repo.get(rel) ?? null, was.kind === "mixed")) out.push({ line: `OWNER_BYTES_CHANGED: ${rel}${after.repo.has(rel) ? "" : " (deleted)"}`, path: rel, was });
  }
  for (const [rel, now] of after.repo) {
    if (!before.repo.has(rel) && now.kind !== "native") out.unshift({ line: `OWNER_BYTES_CHANGED: ${rel} (added)`, path: rel, was: null });
  }
  for (const [path, was] of before.host) {
    if (!same(was, after.host.get(path) ?? null)) out.push({ line: `HOST_FILE_CHANGED: ${path}`, path, was, host: true });
  }
  return out;
}

function restore(change) {
  if (change.was === null) return remove(change.path);
  if (!change.host) {
    for (const dir of ancestors(change.path).filter((d) => d !== ".")) {
      if (entryAt(dir)?.type !== "dir") put(dir, { type: "dir" });
    }
  }
  put(change.path, change.was);
}

const before = record();
const writer = process.env.REPIN_WRITER ?? "scripts/vendor-native-pin.mjs";
const wrote = spawnSync(process.execPath, [writer, native, sha], { stdio: "inherit" });
const changed = differences(before, record());

const refuse = (lines, why) => {
  for (const line of lines) console.log(line);
  console.log(`PIN REFUSED: ${sha} ${why}`);
  process.exit(1);
};
if (changed.length > 0) {
  for (const change of changed) restore(change);
  const added = [...walk().dirs].filter((dir) => !before.dirs.has(dir) && !nativePath(`${dir}/`)).sort((x, y) => y.length - x.length);
  for (const dir of added) if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true });
  const left = differences(before, record());
  refuse([...changed.map((c) => c.line), ...left.map((c) => `RESTORE FAILED: ${c.line}`)], left.length === 0
    ? "changed owner-owned entries. Each one above is restored and checked; the native files it wrote stay for review."
    : "changed owner-owned entries, and some could not be restored. Restore the RESTORE FAILED entries by hand.");
}
if (wrote.status !== 0) process.exit(wrote.status ?? 1);
const owned = [...before.repo.values()];
console.log(`ownership ok: ${owned.filter((f) => f.kind === "owner").length} owner files, ${owned.filter((f) => f.kind === "mixed").length} mixed files, ${hostFiles().length} host files unchanged`);

const differs = [];
const after = record();
for (const [rel, now] of after.repo) {
  const source = now.type === "file" && isSkillDoc(rel) ? header(now.bytes.toString("utf8")) : null;
  if (source === null) continue;
  const snapshot = /snapshot:\s*(\S+)/.exec(source[1])[1];
  let pinned = execFileSync("git", ["-C", native, "show", `${sha}:${/native:\s*(\S+)/.exec(source[1])[1]}`]);
  if (snapshot.endsWith("/AGENTS.section-9.md")) {
    const agents = pinned.toString("utf8");
    const end = agents.indexOf("\n## 10.");
    pinned = Buffer.from(agents.slice(agents.indexOf("## 9."), end === -1 ? undefined : end));
  }
  if (!existsSync(snapshot) || !readFileSync(snapshot).equals(pinned)) differs.push(`NATIVE_COPY_DIFFERS: ${snapshot} is not ${sha.slice(0, 8)}'s file`);
}
if (differs.length > 0) refuse([...new Set(differs)], "wrote native copies that differ from the pin.");

const fidelity = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/skill-fidelity.ts"], { encoding: "utf8" });
process.stdout.write(fidelity.stdout);
process.stderr.write(fidelity.stderr);
if (fidelity.status !== 0) refuse([], "leaves native text that differs outside a BB marker. Fix the skills listed above, or discard this re-pin with git checkout and git clean.");
console.log(`Re-pinned to ${sha}. Run strict overlay install and backend source proof before accepting this pin.`);
