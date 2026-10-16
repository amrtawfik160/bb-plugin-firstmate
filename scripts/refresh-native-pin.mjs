#!/usr/bin/env node
// Guarded re-pin: node scripts/refresh-native-pin.mjs <native clone> <audited SHA>
//
// The writer (scripts/vendor-native-pin.mjs) runs in a fresh git worktree on a
// new branch native-pin/<sha8>, with an empty HOME and no FM_HOME. It never
// runs in this checkout. The guard then reads what git recorded on that branch
// against its base, and refuses the pin (PIN REFUSED, exit 1) when:
//   - a path or region that owner/ownership.json marks owner-owned changed,
//   - a native copy differs from the pinned commit,
//   - a host file, or the target of a host-file link, changed,
//   - this checkout changed, or the writer failed.
// It refuses to start unless this checkout is clean (no uncommitted or untracked paths).
// A refused branch is deleted and never used. The guard restores nothing.
// When only skill fidelity fails, the branch stays so a sync can fix the skills.
import { createHash } from "node:crypto";
import { lstatSync, mkdtempSync, readFileSync, readlinkSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const [native, sha] = process.argv.slice(2);
if (!native || !/^[a-f0-9]{40}$/.test(sha ?? "")) throw new Error("Usage: node scripts/refresh-native-pin.mjs <native clone> <audited SHA>");
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });
const git = (dir, ...args) => run("git", ["-C", dir, ...args]);
const text = (dir, ...args) => git(dir, ...args).toString("utf8");

const live = text(".", "rev-parse", "--show-toplevel").trim();
const base = text(live, "rev-parse", "HEAD").trim();
const manifest = JSON.parse(text(live, "show", `${base}:owner/ownership.json`));
const branch = `native-pin/${sha.slice(0, 8)}`;

const nativePath = (path) => manifest.native.paths.some((entry) => (entry.endsWith("/") ? path.startsWith(entry) : path === entry));
const isSkillDoc = (path) => /^(?:entry-skills|skills)\/.*\.md$/.test(path);
const header = (body) => /<!-- BB-SOURCE\s+([\s\S]*?)-->/.exec(body);
const blob = (rev, path) => { try { return git(live, "show", `${rev}:${path}`); } catch { return null; } };

// A mixed file with its native regions blanked: the BB-SOURCE header and the
// native: and native-quote: fields of each BB-DIVERGE comment.
function ownerView(body) {
  return body
    .replace(/<!-- BB-SOURCE[\s\S]*?-->/, "<!-- BB-SOURCE -->")
    .replace(/<!-- BB-DIVERGE[\s\S]*?-->/g, (block) => block.replace(/(\n\s*native(?:-quote)?:)[\s\S]*?(?=\n\s*[a-z-]+:\s|-->)/g, "$1"));
}

// What the base commit says a path is. An added path is native only by path.
function kind(path, existed) {
  if (nativePath(path)) return "native";
  const body = existed && isSkillDoc(path) ? blob(base, path)?.toString("utf8") : undefined;
  const source = body === undefined ? null : header(body);
  if (source === null) return "owner";
  return /fidelity:\s*verbatim/.test(source[1]) ? "native" : "mixed";
}

function hostFiles() {
  return manifest.host.flatMap((file) => {
    if (file.startsWith("~/")) return [join(process.env.HOME ?? homedir(), file.slice(2))];
    if (file.startsWith("$FM_HOME/")) return process.env.FM_HOME ? [join(process.env.FM_HOME, file.slice("$FM_HOME/".length))] : [];
    return [file];
  });
}

// A host file as the captain reads it: the link (if any) and the content behind it.
function hostState(path) {
  let link = null;
  try { if (lstatSync(path).isSymbolicLink()) link = readlinkSync(path); } catch { return { link: null, content: "missing" }; }
  let content;
  try { content = createHash("sha256").update(readFileSync(path)).digest("hex"); } catch (error) { content = `unreadable ${error.code}`; }
  return { link, content };
}

// The checkout as the writer could reach it: HEAD, status, tracked changes, and
// each untracked entry's content or link target.
function liveState() {
  const hash = createHash("sha256").update(text(live, "rev-parse", "HEAD")).update(git(live, "status", "--porcelain", "-z", "--untracked-files=all")).update(git(live, "diff", "HEAD", "--binary"));
  for (const path of text(live, "ls-files", "-z", "--others", "--exclude-standard").split("\0").filter(Boolean)) {
    const full = join(live, path);
    try { hash.update(path).update(lstatSync(full).isSymbolicLink() ? `link ${readlinkSync(full)}` : readFileSync(full)); } catch (error) { hash.update(`${path} ${error.code}`); }
  }
  return hash.digest("hex");
}

const dirty = text(live, "status", "--porcelain", "--untracked-files=all").split("\n").filter(Boolean);
if (dirty.length > 0) {
  console.log(`LIVE_CHECKOUT_DIRTY: ${dirty.length} uncommitted or untracked paths: ${dirty.map((line) => line.slice(3)).join(", ")}`);
  console.log(`PIN REFUSED: ${sha} needs a clean checkout. Commit or remove those paths first. No sync branch was made; the pin is not used.`);
  process.exit(1);
}

const problems = [];
const hostBefore = new Map(hostFiles().map((path) => [path, hostState(path)]));
const liveBefore = liveState();
const dir = mkdtempSync(join(tmpdir(), "native-pin-"));
const emptyHome = mkdtempSync(join(tmpdir(), "native-pin-home-"));
git(live, "worktree", "add", "-q", "-b", branch, dir, base);

const writer = process.env.REPIN_WRITER ? resolve(process.env.REPIN_WRITER) : join(dir, "scripts/vendor-native-pin.mjs");
const env = { ...process.env, HOME: emptyHome };
delete env.FM_HOME;
const wrote = spawnSync(process.execPath, [writer, isAbsolute(native) ? native : resolve(native), sha], { cwd: dir, env, stdio: "inherit" });
if (wrote.status !== 0) problems.push(`WRITER_FAILED: exit ${wrote.status ?? wrote.signal}`);

let head = base;
try {
  git(dir, "add", "-A");
  git(dir, "-c", "user.name=Firstmate re-pin", "-c", "user.email=native-pin@localhost", "commit", "-q", "--allow-empty", "--no-verify", "-m", `Re-pin native Firstmate to ${sha}`);
  head = text(dir, "rev-parse", "HEAD").trim();
} catch (error) {
  problems.push(`WRITER_RESULT_UNREADABLE: git could not record the sync worktree: ${String(error.stderr ?? error.message).trim().split("\n")[0]}`);
}

const raw = text(live, "diff", "--raw", "-z", "--no-renames", base, head).split("\0");
let changedNative = 0;
for (let i = 0; i + 1 < raw.length; i += 2) {
  const [oldMode, newMode, , , status] = raw[i].slice(1).split(" ");
  const path = raw[i + 1];
  const what = { A: "added", D: "deleted", T: "type" }[status] ?? (oldMode !== newMode ? "mode" : "content");
  const k = kind(path, status !== "A");
  if (k === "native") { changedNative += 1; continue; }
  const sameRegions = k === "mixed" && status === "M" && oldMode === newMode
    && ownerView(blob(base, path).toString("utf8")) === ownerView(blob(head, path).toString("utf8"));
  if (sameRegions) changedNative += 1;
  else problems.push(`OWNER_CHANGED: ${path} (${k === "mixed" ? `owner region, ${what}` : what})`);
}

for (const path of text(live, "ls-tree", "-r", "--name-only", head, "--", "skills", "entry-skills").split("\n").filter(isSkillDoc)) {
  const source = header(blob(head, path)?.toString("utf8") ?? "");
  if (source === null) continue;
  const snapshot = /snapshot:\s*(\S+)/.exec(source[1])[1];
  let pinned;
  try { pinned = git(native, "show", `${sha}:${/native:\s*(\S+)/.exec(source[1])[1]}`); } catch { pinned = null; }
  if (pinned !== null && snapshot.endsWith("/AGENTS.section-9.md")) {
    const agents = pinned.toString("utf8");
    const end = agents.indexOf("\n## 10.");
    pinned = Buffer.from(agents.slice(agents.indexOf("## 9."), end === -1 ? undefined : end));
  }
  const copy = blob(head, snapshot);
  if (pinned === null || copy === null || !copy.equals(pinned)) problems.push(`NATIVE_COPY_DIFFERS: ${snapshot} is not ${sha.slice(0, 8)}'s file`);
}

for (const [path, was] of hostBefore) {
  const now = hostState(path);
  if (now.link !== was.link) problems.push(`HOST_FILE_CHANGED: ${path} (link)`);
  else if (now.content !== was.content) problems.push(`HOST_FILE_CHANGED: ${path} (content)`);
}
if (liveState() !== liveBefore) problems.push(`LIVE_CHECKOUT_CHANGED: ${live}`);
rmSync(emptyHome, { recursive: true, force: true });

function discard() {
  try {
    git(live, "worktree", "remove", "--force", "--force", dir);
    git(live, "branch", "-q", "-D", branch);
    return "The sync branch is not used and was deleted.";
  } catch (error) {
    return `The sync branch is not used; remove ${branch} and ${dir} by hand (${String(error.stderr ?? error.message).trim().split("\n")[0]}).`;
  }
}

const unique = [...new Set(problems)];
if (unique.length > 0) {
  for (const line of unique) console.log(line);
  console.log(`PIN REFUSED: ${sha} breaks the owner layer or the pin. ${discard()}`);
  process.exit(1);
}
console.log(`ownership ok: ${changedNative} changed paths are native-owned; ${hostBefore.size} host files unchanged`);

const fidelity = spawnSync(process.execPath, ["--experimental-strip-types", "scripts/skill-fidelity.ts"], { cwd: dir, encoding: "utf8" });
process.stdout.write(fidelity.stdout);
process.stderr.write(fidelity.stderr);
if (fidelity.status !== 0) {
  console.log(`PIN REFUSED: ${sha} leaves native text that differs outside a BB marker; fix the skills on branch ${branch} at ${dir}. It is not used until fidelity passes.`);
  process.exit(1);
}
console.log(`Re-pinned to ${sha} on branch ${branch} at ${dir}. Run strict overlay install and backend source proof, then merge the branch.`);
