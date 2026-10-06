import { createHash } from "node:crypto";

// Below Grok's observed 19.5KB MCP preview, including headers and continuation.
// This bounds bytes, not JS characters. Native text is never rewritten.
export const CONTRACT_PAGE_BYTES = 8_000;
export function contractPages(text: string): string[] {
  const pages: string[] = [];
  let page = "", bytes = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (bytes + size > CONTRACT_PAGE_BYTES) { pages.push(page); page = ""; bytes = 0; }
    page += character; bytes += size;
  }
  pages.push(page);
  return pages;
}

export function contractCursorSection(cursor: string): string | undefined {
  return decodeCursor(cursor).section;
}
function decodeCursor(cursor: string): { snapshot: string; page: number; section?: string } {
  if (!/^[A-Za-z0-9_-]{1,1200}$/.test(cursor)) throw new Error("Invalid contract cursor; restart firstmate_contract without cursor.");
  let value;
  try { value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); }
  catch { throw new Error("Invalid contract cursor; restart firstmate_contract without cursor."); }
  if (!value || !/^[a-f0-9]{64}$/.test(value.snapshot) || !Number.isSafeInteger(value.page) || value.page < 1 ||
      (value.section !== undefined && (typeof value.section !== "string" || value.section.length > 200))) {
    throw new Error("Invalid contract cursor; restart firstmate_contract without cursor.");
  }
  return value;
}

export function contractPage(text: string, scope: string, section?: string, cursor?: string): string {
  if (section !== undefined && section.length > 200) throw new Error("Contract section exceeds 200 characters; use a section number or shorter title.");
  const snapshot = createHash("sha256").update(JSON.stringify([scope, section ?? null, text])).digest("hex");
  const pages = contractPages(text), requested = cursor ? decodeCursor(cursor) : undefined;
  if (requested && (requested.snapshot !== snapshot || requested.section !== section)) {
    throw new Error("Contract cursor belongs to another captain/home or changed selected-runtime bytes. Restart the complete read without cursor; do not combine snapshots.");
  }
  const index = requested?.page ?? 0;
  if (index >= pages.length) throw new Error("Contract cursor page is outside this snapshot; restart the complete read.");
  const next = index + 1 < pages.length
    ? Buffer.from(JSON.stringify({ snapshot, page: index + 1, ...(section !== undefined ? { section } : {}) })).toString("base64url") : undefined;
  const instruction = next
    ? `Continue with firstmate_contract {"cursor":"${next}"} or bb firstmate contract --cursor ${next}.`
    : "END OF CONTRACT TRANSPORT: all pages must have been read in order, including the selected-runtime trigger catalog and BB adaptations. Delivery of this page alone does not establish a complete read.";
  return `FIRSTMATE_CONTRACT_PAGE ${index + 1}/${pages.length} snapshot=${snapshot}\n${instruction}\nRead every page before orchestration; a preview or saved remainder is not a complete read.\nBEGIN_PAGE\n${pages[index]}\nEND_PAGE\n`;
}
