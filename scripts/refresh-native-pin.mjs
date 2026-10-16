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
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const [native, sha] = process.argv.slice(2);
if (!native || !/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Usage: node scripts/refresh-native-pin.mjs <native clone> <audited SHA>");
const manifest = JSON.parse(readFileSync("owner/ownership.json", "utf8"));

function files(dir = ".") {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (manifest.skip.some((skip) => `${rel}/`.startsWith(skip))) return [];
    return entry.isDirectory() ? files(rel) : [rel];
  });
}

const header = (text) => /<!-- BB-SOURCE\s+([\s\S]*?)-->/.exec(text);
const isSkillDoc = (rel) => /^(?:entry-skills|skills)\/.*\.md$/.test(rel);

function kind(rel, text) {
  if (manifest.native.paths.some((path) => rel === path || rel.startsWith(path))) return "native";
  const source = isSkillDoc(rel) ? header(text) : null;
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

function hostFiles() {
  return manifest.host.flatMap((file) => {
    if (file.startsWith("~/")) return [join(process.env.HOME ?? homedir(), file.slice(2))];
    if (file.startsWith("$FM_HOME/")) return process.env.FM_HOME ? [join(process.env.FM_HOME, file.slice("$FM_HOME/".length))] : [];
    return [file];
  });
}

function record() {
  const repo = new Map();
  for (const rel of files()) {
    const bytes = readFileSync(rel);
    repo.set(rel, { bytes, kind: kind(rel, bytes.toString("utf8")) });
  }
  const host = new Map(hostFiles().map((path) => [path, existsSync(path) ? readFileSync(path) : null]));
  return { repo, host };
}

const before = record();
const writer = process.env.REPIN_WRITER ?? "scripts/vendor-native-pin.mjs";
const wrote = spawnSync(process.execPath, [writer, native, sha], { stdio: "inherit" });
const after = record();

const changed = [];
for (const [rel, was] of before.repo) {
  if (was.kind === "native") continue;
  const now = after.repo.get(rel);
  const same = now !== undefined && (was.kind === "owner" ? now.bytes.equals(was.bytes) : ownerView(now.bytes.toString("utf8")) === ownerView(was.bytes.toString("utf8")));
  if (same) continue;
  changed.push(`OWNER_BYTES_CHANGED: ${rel}${now === undefined ? " (deleted)" : ""}`);
  writeFileSync(rel, was.bytes);
}
for (const [rel, now] of after.repo) {
  if (before.repo.has(rel) || now.kind === "native") continue;
  changed.push(`OWNER_BYTES_CHANGED: ${rel} (added)`);
  rmSync(rel);
}
for (const [path, was] of before.host) {
  const now = after.host.get(path);
  if (was === null ? now === null : now !== null && now.equals(was)) continue;
  changed.push(`HOST_FILE_CHANGED: ${path}`);
  if (was === null) rmSync(path, { force: true });
  else writeFileSync(path, was);
}

const refuse = (lines, why) => {
  for (const line of lines) console.log(line);
  console.log(`PIN REFUSED: ${sha} ${why}`);
  process.exit(1);
};
if (changed.length > 0) refuse(changed, "changed owner-owned bytes. Each file above is restored; the native files it wrote stay for review.");
if (wrote.status !== 0) process.exit(wrote.status ?? 1);
const owned = [...before.repo.values()];
console.log(`ownership ok: ${owned.filter((f) => f.kind === "owner").length} owner files, ${owned.filter((f) => f.kind === "mixed").length} mixed files, ${before.host.size} host files unchanged`);

const differs = [];
for (const [rel, now] of after.repo) {
  const source = isSkillDoc(rel) ? header(now.bytes.toString("utf8")) : null;
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
