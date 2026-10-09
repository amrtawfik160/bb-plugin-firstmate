#!/usr/bin/env node
// Real-transport integration check for firstmate host file writes.
//
// This is NOT part of `npm test` (it needs a live BB host and the `bb` CLI, so it
// is skipped in CI). Run it manually to prove the writeHostBytes mechanism against
// the actual BB terminal transport, on scratch paths under /tmp only.
//
//   node scripts/live-host-transport-check.mjs --host <hostIdOrName> [--scratch /tmp/fm-transport-check] [--reproduce-old]
//
//   --host          Required. A connected host id/name (see `bb host list`).
//   --scratch       Scratch DIR under /tmp (default /tmp/fm-transport-check-<pid>).
//   --reproduce-old Also drive the OLD terminal-stdin path to show it hangs
//                   (~15s timeout) — the bug this script's fix replaces.
//
// It mirrors server.ts exactly: wrapHostCommand + a poll loop over
// `bb terminal create|output|close`, and writeHostBytes (chunked base64 append +
// atomic decode/rename). Proves, byte-exact via sha256 on the host:
//   10B, 10KB, 200KB, and unicode/quote/heredoc-delimiter-collision content, plus
//   a forced-failure write that must leave the previous file intact (no truncation).
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";

const args = process.argv.slice(2);
function flag(name) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; }
const HOST = flag("--host");
if (!HOST) { console.error("error: --host <hostIdOrName> is required (see `bb host list`)"); process.exit(2); }
const SCRATCH = (flag("--scratch") ?? `/tmp/fm-transport-check-${process.pid}`).replace(/\/+$/, "");
if (!SCRATCH.startsWith("/tmp/")) { console.error("error: --scratch must be under /tmp/"); process.exit(2); }
const REPRODUCE_OLD = args.includes("--reproduce-old");

const HOST_RC_MARKER = "__FM_HOST_RC";
const HOST_STDIN_READY = "__FM_HOST_STDIN_READY";
const HOST_COMMAND_MAX = 10000;
function shQuote(t) { return `'${t.replace(/'/g, `'\\''`)}'`; }
function stripAnsi(t) { return t.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, ""); }
function bbTerm(a, input) {
  const r = spawnSync("bb", ["terminal", ...a], { input, encoding: "utf8", maxBuffer: 1 << 26 });
  if (r.status !== 0) throw new Error(`bb terminal ${a.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}
function wrap(command) {
  const script = `__fm_cmd=${shQuote(command)}; set +e; "\${SHELL:-/bin/bash}" -lc "$__fm_cmd"; __fm_ec=$?; printf '\\n${HOST_RC_MARKER}:%s\\n' "$__fm_ec"; sleep 86400`;
  if (script.length > HOST_COMMAND_MAX) throw new Error(`Host command too long (${script.length} > ${HOST_COMMAND_MAX}).`);
  return script;
}
// OLD (buggy) wrapper: pipes stdin into the command via `head -c N` — hangs on a PTY.
function wrapOld(command, stdinBytes) {
  return `__fm_cmd=${shQuote(command)}; set +e; printf '\\n${HOST_STDIN_READY}\\n'; head -c ${stdinBytes} | "\${SHELL:-/bin/bash}" -lc "$__fm_cmd"; __fm_ec=$?; printf '\\n${HOST_RC_MARKER}:%s\\n' "$__fm_ec"; sleep 86400`;
}
async function runHostCommand(command, timeoutMs = 15000) {
  const created = JSON.parse(bbTerm(["create", "--host", HOST, "--cwd", "/tmp", "--json", "--command", wrap(command)]));
  const id = created.terminalId || created.id;
  let nextSeq = 0, out = ""; const deadline = Date.now() + timeoutMs;
  try {
    for (;;) {
      if (Date.now() >= deadline) return { timedOut: true, output: stripAnsi(out) };
      const o = JSON.parse(bbTerm(["output", id, "--json", "--since-seq", String(nextSeq), "--tail-bytes", "65536"]));
      if (typeof o.nextSeq === "number") nextSeq = o.nextSeq;
      for (const c of (o.chunks || [])) out += Buffer.from(c.dataBase64, "base64").toString("utf8");
      const m = new RegExp(`(?:\\r?\\n)${HOST_RC_MARKER}:([0-9]{1,3})(?:\\r?\\n)`).exec(stripAnsi(out));
      if (m) return { exitCode: Number(m[1]), output: stripAnsi(out).replace(m[0], "") };
      if (o.status === "exited") return { exitCode: o.exitCode ?? 1, output: stripAnsi(out) };
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally { try { bbTerm(["close", id]); } catch {} }
}
// writeHostBytes: chunked base64 append + atomic decode/rename (mirror of server.ts).
// failAtomic() lets the caller force the final decode/rename to fail, to prove the
// target is left intact.
async function writeHostBytes(path, content, { failAtomic = false } = {}) {
  const dir = path.replace(/\/[^/]*$/, "") || "/";
  const nonce = randomUUID();
  const tmpB64 = `${path}.fm-b64-${nonce}`, tmpOut = `${path}.fm-out-${nonce}`;
  const qB64 = shQuote(tmpB64), qOut = shQuote(tmpOut);
  const b64 = Buffer.from(content, "utf8").toString("base64");
  const cleanup = () => runHostCommand(`rm -f ${qB64} ${qOut}`, 10000).catch(() => {});
  let res = await runHostCommand(`mkdir -p ${shQuote(dir)} && : > ${qB64}`);
  if (res.exitCode !== 0) { await cleanup(); return false; }
  const chunkSize = Math.max(1000, HOST_COMMAND_MAX - Buffer.byteLength(tmpB64, "utf8") - 300);
  for (let i = 0; i < b64.length; i += chunkSize) {
    res = await runHostCommand(`printf '%s' ${shQuote(b64.slice(i, i + chunkSize))} >> ${qB64}`);
    if (res.exitCode !== 0) { await cleanup(); return false; }
  }
  const decode = failAtomic
    ? `base64 -d /nonexistent/definitely-not-here > ${qOut} && mv -f ${qOut} ${shQuote(path)}`
    : `base64 -d ${qB64} > ${qOut} && mv -f ${qOut} ${shQuote(path)}`;
  res = await runHostCommand(decode);
  await cleanup();
  return res.exitCode === 0;
}
async function hostSha(path) {
  const r = await runHostCommand(`sha256sum ${shQuote(path)} 2>/dev/null | cut -d' ' -f1; wc -c < ${shQuote(path)} 2>/dev/null`);
  const [sha, size] = r.output.trim().split(/\s+/);
  return { sha, size: Number(size) };
}
function localSha(s) { return createHash("sha256").update(s, "utf8").digest("hex"); }

const results = [];
function record(name, ok, detail) { results.push({ name, ok, detail }); console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`); }

const cases = [
  ["10B", "y".repeat(10)],
  ["10KB", "A".repeat(10 * 1024)],
  ["200KB", Array.from({ length: 200 * 1024 }, (_, i) => String.fromCharCode(33 + (i % 90))).join("")],
  ["unicode+quotes+delimiter", "héllo 世界 🚀\n\"double\" 'single' `back` $VAR ${x}\nFM_MEM_EOF\nFM_DEC_EOF\n'; touch /tmp/fm_pwned #\n<<EOF\nlooks like a heredoc\nEOF\n"],
];

console.log(`# live-host-transport-check host=${HOST} scratch=${SCRATCH}\n`);
try {
  await runHostCommand(`mkdir -p ${shQuote(SCRATCH)}`);

  if (REPRODUCE_OLD) {
    // Show the OLD stdin path hangs even for 10 bytes.
    const b64 = Buffer.from("y".repeat(10), "utf8").toString("base64");
    const created = JSON.parse(bbTerm(["create", "--host", HOST, "--cwd", "/tmp", "--json", "--command", wrapOld(`base64 -d > ${shQuote(`${SCRATCH}/old.txt`)}`, b64.length)]));
    const id = created.terminalId || created.id;
    let nextSeq = 0, out = "", sent = false; const t0 = Date.now(); const deadline = t0 + 15000; let timedOut = false;
    for (;;) {
      if (Date.now() >= deadline) { timedOut = true; break; }
      const o = JSON.parse(bbTerm(["output", id, "--json", "--since-seq", String(nextSeq), "--tail-bytes", "65536"]));
      if (typeof o.nextSeq === "number") nextSeq = o.nextSeq;
      for (const c of (o.chunks || [])) out += Buffer.from(c.dataBase64, "base64").toString("utf8");
      if (!sent && (stripAnsi(out).includes(HOST_STDIN_READY) || Date.now() - t0 > 2000)) { bbTerm(["send", id, "--stdin"], b64); sent = true; }
      if (new RegExp(`(?:\\r?\\n)${HOST_RC_MARKER}:`).test(stripAnsi(out))) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    try { bbTerm(["close", id]); } catch {}
    record("OLD stdin path hangs on 10B (reproduce)", timedOut, timedOut ? `timed out after ~15s; PTY echoed payload=${JSON.stringify(stripAnsi(out).slice(-40))}` : "unexpectedly completed");
  }

  for (const [name, content] of cases) {
    const path = `${SCRATCH}/${name.replace(/[^a-z0-9]+/gi, "_")}.txt`;
    const ok = await writeHostBytes(path, content);
    const { sha, size } = await hostSha(path);
    const exact = ok && sha === localSha(content) && size === Buffer.byteLength(content, "utf8");
    record(`round-trip ${name}`, exact, `writeOk=${ok} size=${size}/${Buffer.byteLength(content, "utf8")} sha=${sha === localSha(content) ? "match" : "MISMATCH"}`);
  }

  // Forced-failure: an existing file must survive a failed write untouched.
  {
    const path = `${SCRATCH}/atomic.txt`;
    await writeHostBytes(path, "ORIGINAL-CONTENT");
    const pre = await hostSha(path);
    const failed = await writeHostBytes(path, "REPLACEMENT-THAT-MUST-NOT-LAND", { failAtomic: true });
    const post = await hostSha(path);
    const intact = failed === false && post.sha === pre.sha && post.sha === localSha("ORIGINAL-CONTENT");
    record("forced-failure leaves previous file intact (no truncation)", intact, `writeReturned=${failed} preserved=${post.sha === pre.sha}`);
  }
} finally {
  await runHostCommand(`rm -rf ${shQuote(SCRATCH)}`).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length === 0 ? 0 : 1);
