#!/usr/bin/env node
// Owner-layer guard. Every rule in owner/rules.json must appear, word for word,
// in the file that applies it. A plugin rule may not live in a file that
// scripts/refresh-native-pin.mjs rewrites, so a re-pin cannot drop it.
//
//   node scripts/owner-layer-check.mjs [--root <repo>] [--host] [--map]
//
// --map prints the owner-layer map (rule, old place, new place) as a table.
// --host also checks the rules held in host files (~/..., $FM_HOME/...).
// Exit 0: every checked rule is present. Exit 1: a rule is missing or misplaced.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const arg = (name) => { const i = process.argv.indexOf(name); return i === -1 ? undefined : process.argv[i + 1]; };
const root = resolve(arg("--root") ?? join(import.meta.dirname, ".."));
const host = process.argv.includes("--host");
const { rules } = JSON.parse(readFileSync(join(root, "owner/rules.json"), "utf8"));

if (process.argv.includes("--map")) {
  console.log("| Rule | Owner rule | Old place | New place |\n|---|---|---|---|");
  for (const rule of rules) console.log(`| \`${rule.id}\` | ${rule.rule} | \`${rule.old}\` | \`${rule.file}\` |`);
  process.exit(0);
}

const PIN_WRITTEN = [/^native-snapshot\//, /^runtime-assets\//, /^third-party\//, /^lib\/upstream-surface\.ts$/, /^overlay\/patch-base\.txt$/];
const verbatimCopy = (text) => /<!-- BB-SOURCE[\s\S]*?fidelity:\s*verbatim[\s\S]*?-->/.test(text);

function hostPath(file) {
  if (file.startsWith("~/")) return join(process.env.HOME ?? homedir(), file.slice(2));
  if (file.startsWith("$FM_HOME/")) return process.env.FM_HOME ? join(process.env.FM_HOME, file.slice("$FM_HOME/".length)) : null;
  return file;
}

const problems = [];
const counts = { plugin: 0, host: 0 };
for (const rule of rules) {
  if (rule.layer === "host" && !host) continue;
  counts[rule.layer] += 1;
  const path = rule.layer === "plugin" ? join(root, rule.file) : hostPath(rule.file);
  const text = path !== null && existsSync(path) ? readFileSync(path, "utf8") : null;
  if (rule.layer === "plugin" && (PIN_WRITTEN.some((re) => re.test(rule.file)) || (text !== null && verbatimCopy(text)))) {
    problems.push(`OWNER_RULE_IN_NATIVE_COPY: ${rule.id} ${rule.file}: a re-pin rewrites this file; keep the rule in the owner layer`);
  } else if (text === null || !text.includes(rule.anchor)) {
    problems.push(`OWNER_RULE_MISSING: ${rule.id} ${rule.file}${text === null ? " (file missing)" : ""}: ${rule.anchor}`);
  }
}

for (const line of problems) console.log(line);
if (problems.length > 0) {
  console.log(`owner layer FAILED: ${problems.length} of ${counts.plugin + counts.host} rules. Restore each rule, or change owner/rules.json and owner/README.md in the same commit.`);
  process.exit(1);
}
console.log(`owner layer ok: ${counts.plugin} plugin rules${host ? `, ${counts.host} host rules` : ""}`);
