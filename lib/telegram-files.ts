import { realpathSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Which local files the Telegram connector uploads with a reply. It mirrors the connector's rule
 * (bb-plugin-telegram src/outbound.ts allowedOutboundPath and its limits), so firstmate_reply can
 * refuse a file the connector would drop with "(File not sent: ...)" before anything is sent.
 */
export const TELEGRAM_FILE_RULES = {
  /** Never sent, even when an allowed root contains it. */
  secretsDir: "/root/.bb-server/secrets",
  /** Any visible file under these roots is sent. The captain's workspace is one too. */
  anyFileRoots: ["/tmp"],
  /** Only document and image files are sent from these roots. The captain's data dir is one too. */
  documentRoots: ["/root/.bb-server/plugins/environment-git-worktree/host-data/worktrees"],
  captainDataDir: (captainThreadId: string) => `/root/.local/share/bb-firstmate/homes/${captainThreadId}/data`,
  documentExtensions: [".md", ".txt", ".pdf", ".png", ".jpg", ".jpeg", ".gif", ".webp", ".csv", ".html"],
  /** All files of one reply together. */
  maxBytes: 50 * 1024 * 1024,
  maxItems: 10,
} as const;

export type TelegramFileRefusal = { file: string; reason: string };

/** Each file the connector would refuse, with its reason. The workspace is the captain thread's environment path. */
export function telegramFileRefusals(files: readonly string[], where: { workspace: string | null; captainThreadId: string }): TelegramFileRefusal[] {
  const rules = TELEGRAM_FILE_RULES;
  const anyRoots = [...(where.workspace ? [resolve(where.workspace)] : []), ...rules.anyFileRoots];
  const documentRoots = [rules.captainDataDir(where.captainThreadId), ...rules.documentRoots];
  const refusals: TelegramFileRefusal[] = [];
  // The connector attaches each linked path once, in order of first mention, so limits apply to that list.
  const unique = [...new Set(files)];
  if (unique.length > rules.maxItems) refusals.push({ file: unique.slice(rules.maxItems).join(", "), reason: `Telegram takes at most ${rules.maxItems} files per reply.` });
  let total = 0;
  for (const file of unique.slice(0, rules.maxItems)) {
    // Both the named path and the file it resolves to through links must pass, as in the connector.
    let reason = refusal(resolve(file), anyRoots, rules.secretsDir, documentRoots);
    if (reason === null) {
      const real = realOrSelf(file);
      reason = refusal(real, anyRoots.map(realOrSelf), realOrSelf(rules.secretsDir), documentRoots.map(realOrSelf));
    }
    if (reason === null) {
      total += statSync(file, { throwIfNoEntry: false })?.size ?? 0;
      if (total > rules.maxBytes) reason = `Telegram takes at most ${rules.maxBytes / 1024 / 1024} MB of files per reply.`;
    }
    if (reason !== null) refusals.push({ file, reason });
  }
  return refusals;
}

function refusal(target: string, anyRoots: string[], secretsDir: string, documentRoots: string[]): string | null {
  if (within(secretsDir, target)) return "files in the BB secrets folder are never sent.";
  const unrestricted = anyRoots.find((root) => within(root, target) && root !== target);
  const root = unrestricted ?? documentRoots.find((candidate) => within(candidate, target) && candidate !== target);
  if (!root) return "only files in the captain's workspace, /tmp, the captain's data folder or a BB worktree are sent.";
  if (relative(root, target).split(sep).some((segment) => segment.startsWith("."))) return "hidden files, hidden folders and .env files are never sent.";
  if (!unrestricted && !(TELEGRAM_FILE_RULES.documentExtensions as readonly string[]).includes(extname(target).toLowerCase())) {
    return `only document and image files (${TELEGRAM_FILE_RULES.documentExtensions.join(" ")}) are sent from the captain's data folder and BB worktrees.`;
  }
  return null;
}

function realOrSelf(target: string): string {
  try { return realpathSync(target); } catch { return target; }
}

function within(root: string, target: string): boolean {
  return isAbsolute(target) && (target === root || target.startsWith(root.endsWith(sep) ? root : root + sep));
}
