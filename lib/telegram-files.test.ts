import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { TELEGRAM_FILE_RULES, telegramFileRefusals } from "./telegram-files.ts";

// The connector's own rule. When its source is on this host the table must match it; otherwise the values are pinned.
const CONNECTOR_OUTBOUND = "/root/github_projects/bb-plugin-telegram/src/outbound.ts";

test("the file rule matches the Telegram connector's roots and limits", () => {
  const rules = {
    secretsDir: TELEGRAM_FILE_RULES.secretsDir, anyFileRoots: [...TELEGRAM_FILE_RULES.anyFileRoots], documentRoots: [...TELEGRAM_FILE_RULES.documentRoots],
    captainDataDir: TELEGRAM_FILE_RULES.captainDataDir("thr_x"), documentExtensions: [...TELEGRAM_FILE_RULES.documentExtensions],
    maxBytes: TELEGRAM_FILE_RULES.maxBytes, maxItems: TELEGRAM_FILE_RULES.maxItems,
  };
  if (existsSync(CONNECTOR_OUTBOUND)) {
    const source = readFileSync(CONNECTOR_OUTBOUND, "utf8");
    const constant = (name: string) => new RegExp(`const ${name} = ([^;]+);`).exec(source)?.[1]?.trim();
    const literal = (name: string) => JSON.parse(constant(name)!) as string;
    assert.deepEqual(rules, {
      secretsDir: literal("SECRETS_DIR"),
      anyFileRoots: [literal("SHARED_TMP")],
      documentRoots: [literal("WORKTREES_ROOT")],
      captainDataDir: /`(\/root\/\.local\/share\/bb-firstmate\/homes\/)\$\{captainThreadId\}(\/data)`/.exec(source)!.slice(1).join("thr_x"),
      documentExtensions: JSON.parse(/DOCUMENT_IMAGE_EXTENSIONS = new Set\((\[[^\]]+\])\)/.exec(source)![1]!),
      maxBytes: constant("OUTBOUND_FILE_MAX_BYTES")!.split("*").map(Number).reduce((a, b) => a * b, 1),
      maxItems: Number(constant("OUTBOUND_FILE_MAX_ITEMS")),
    });
  }
  assert.deepEqual(rules, {
    secretsDir: "/root/.bb-server/secrets",
    anyFileRoots: ["/tmp"],
    documentRoots: ["/root/.bb-server/plugins/environment-git-worktree/host-data/worktrees"],
    captainDataDir: "/root/.local/share/bb-firstmate/homes/thr_x/data",
    documentExtensions: [".md", ".txt", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".csv", ".html"],
    maxBytes: 50 * 1024 * 1024,
    maxItems: 10,
  });
});

const where = { workspace: "/srv/captain-ws", captainThreadId: "thr_cap" };
const reasons = (files: string[], at = where) => telegramFileRefusals(files, at).map((r) => [r.file, r.reason]);

// 15 Oct 18:02 UTC: the captain attached two files from /root/tg-share and the owner got "(File not sent: ...)" for both.
test("15 Oct: a file outside the connector's roots is refused with the reason", () => {
  const files = ["/root/tg-share/jess-leads-openleads.csv", "/root/tg-share/jess-leads-openleads.md"];
  assert.deepEqual(reasons(files), files.map((file) => [file, "only files in the captain's workspace, /tmp, the captain's data folder or a BB worktree are sent."]));
});

test("a file in /tmp or the captain's workspace is sent; secrets, hidden paths and non-documents in worktrees are refused", () => {
  const dir = mkdtempSync("/tmp/fm-files-");
  const ok = join(dir, "leads.csv");
  writeFileSync(ok, "a,b\n");
  const zip = join(dir, "bundle.zip");
  writeFileSync(zip, "zip");
  assert.deepEqual(reasons([ok, zip]), [], "any visible file under /tmp");
  assert.deepEqual(reasons([join(dir, ".env")]), [[join(dir, ".env"), "hidden files, hidden folders and .env files are never sent."]]);
  assert.deepEqual(reasons(["/tmp/.cache/report.md"]), [["/tmp/.cache/report.md", "hidden files, hidden folders and .env files are never sent."]]);
  assert.deepEqual(reasons(["/srv/captain-ws/out/build.zip"]), [], "any visible file in the captain's workspace");
  assert.deepEqual(reasons(["/srv/captain-ws/out/build.zip"], { workspace: null, captainThreadId: "thr_cap" }).length, 1, "no workspace: only the fixed roots");
  assert.deepEqual(reasons(["/root/.bb-server/secrets/areliaa.env"], { workspace: "/root/.bb-server", captainThreadId: "thr_cap" }),
    [["/root/.bb-server/secrets/areliaa.env", "files in the BB secrets folder are never sent."]]);
  const worktree = `${TELEGRAM_FILE_RULES.documentRoots[0]}/thr_a-1/repo`;
  assert.deepEqual(reasons([`${worktree}/report.md`, "/root/.local/share/bb-firstmate/homes/thr_cap/data/scan.PNG"]), []);
  assert.equal(reasons([`${worktree}/dist/app.zip`])[0]?.[1], "only document and image files (.md .txt .pdf .png .jpg .jpeg .gif .webp .csv .html) are sent from the captain's data folder and BB worktrees.");
  assert.equal(reasons(["/root/.local/share/bb-firstmate/homes/thr_other/data/scan.png"]).length, 1, "another captain's data folder is not this captain's");
});

test("a link in /tmp that points outside the roots is refused, as the connector checks the file it resolves to", () => {
  const outside = mkdtempSync("/var/tmp/fm-files-outside-");
  try {
    const target = join(outside, "leads.csv");
    writeFileSync(target, "x");
    const dir = mkdtempSync("/tmp/fm-files-");
    mkdirSync(join(dir, "sub"));
    const link = join(dir, "sub", "leads.csv");
    symlinkSync(target, link);
    assert.deepEqual(reasons([link]), [[link, "only files in the captain's workspace, /tmp, the captain's data folder or a BB worktree are sent."]]);
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("more than 10 files, or more than 50 MB together, are refused", () => {
  const dir = mkdtempSync("/tmp/fm-files-");
  const files = Array.from({ length: 11 }, (_, i) => { const f = join(dir, `f${i}.txt`); writeFileSync(f, "x"); return f; });
  assert.deepEqual(reasons(files), [[files[10]!, "Telegram takes at most 10 files per reply."]]);
  const big = join(dir, "big.bin");
  writeFileSync(big, Buffer.alloc(30 * 1024 * 1024));
  const big2 = join(dir, "big2.bin");
  writeFileSync(big2, Buffer.alloc(30 * 1024 * 1024));
  assert.deepEqual(reasons([big, big2]), [[big2, "Telegram takes at most 50 MB of files per reply."]]);
});

// The connector attaches each linked path once (src/outbound.ts localFileLinks), so a repeated path counts once.
test("the same 30 MiB file attached twice is one 30 MiB upload and is sent", () => {
  const dir = mkdtempSync("/tmp/fm-files-");
  try {
    const big = join(dir, "big.bin");
    writeFileSync(big, Buffer.alloc(30 * 1024 * 1024));
    assert.deepEqual(reasons([big, big]), []);
    const small = Array.from({ length: 10 }, (_, i) => { const f = join(dir, `f${i}.txt`); writeFileSync(f, "x"); return f; });
    assert.deepEqual(reasons([...small, small[0]!]), [], "ten distinct files and a repeat are ten uploads");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
