import { existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const APPROVAL_CONNECTOR_SKIP = "set APPROVAL_TELEGRAM_CHECKOUT to a copied connector checkout";

export function approvalTelegramRoot(): string | undefined {
  const raw = process.env.APPROVAL_TELEGRAM_CHECKOUT;
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  return resolve(raw.trim());
}

export function approvalConnectorSkip(): string | false {
  const root = approvalTelegramRoot();
  if (root === undefined || !existsSync(join(root, "test/support.ts")) || !existsSync(join(root, "test/register.mjs"))) {
    return APPROVAL_CONNECTOR_SKIP;
  }
  return false;
}

export async function loadApprovalConnectorSupport() {
  const root = approvalTelegramRoot();
  if (root === undefined) throw new Error(APPROVAL_CONNECTOR_SKIP);
  await import(pathToFileURL(join(root, "test/register.mjs")).href);
  return import(pathToFileURL(join(root, "test/support.ts")).href);
}

export function testEvidenceDir(): string {
  const configured = process.env.FM_TEST_EVIDENCE_DIR?.trim();
  if (configured !== undefined && configured !== "") {
    const dir = resolve(configured);
    mkdirSync(dir, { recursive: true });
    return dir.endsWith("/") ? dir : `${dir}/`;
  }
  const dir = mkdtempSync(join(tmpdir(), "fm-test-evidence-"));
  return dir.endsWith("/") ? dir : `${dir}/`;
}
