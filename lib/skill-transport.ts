import { createHash } from "node:crypto";
import { z } from "zod";
import { contractPages } from "./contract-transport.ts";

const requestSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,100}$/).optional(),
  list: z.literal(true).optional(),
  reference: z.string().max(1000).optional(),
  source: z.string().max(1000).optional(),
}).strict()
  .refine(request=>request.list ? !request.name && request.reference===undefined && request.source===undefined : !!request.name,"Use a native skill name or list=true, without combining inventory and resource arguments")
  // The resource travels in a restart-safe cursor printed for tool and CLI.
  // Bound UTF-8 bytes as well as characters so every emitted cursor is usable.
  .refine(request=>Buffer.byteLength(JSON.stringify(request))<=2200,"Native resource identity exceeds 2200 bytes; omit the fragment or use an operator full-document read");
export type SkillRequest = z.infer<typeof requestSchema>;
const cursorSchema = z.object({
  snapshot: z.string().regex(/^[a-f0-9]{64}$/),
  page: z.number().int().min(1),
  request: requestSchema,
}).strict();
function decode(cursor: string) {
  try {
    if (!/^[A-Za-z0-9_-]{1,4096}$/.test(cursor)) throw new Error();
    return cursorSchema.parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")));
  } catch { throw new Error("Invalid native skill cursor; restart the complete skill read without cursor."); }
}
export function skillCursorRequest(cursor: string): SkillRequest { return decode(cursor).request; }

/** Reuses the byte-bounded native contract transport; never rewrites native text. */
export function skillPage(text: string, scope: string, input: SkillRequest, cursor?: string): string {
  const request = requestSchema.parse(input);
  const snapshot = createHash("sha256").update(JSON.stringify([scope, request, text])).digest("hex");
  const pages = contractPages(text), requested = cursor ? decode(cursor) : undefined;
  if (requested && requested.snapshot !== snapshot) {
    throw new Error("Native skill cursor belongs to another captain/home, resource or changed selected-runtime bytes. Restart the complete read without cursor; do not combine snapshots.");
  }
  const index = requested?.page ?? 0;
  if (index >= pages.length) throw new Error("Native skill cursor page is outside this snapshot; restart the complete read.");
  const next = index + 1 < pages.length
    ? Buffer.from(JSON.stringify({ snapshot, page: index + 1, request })).toString("base64url") : undefined;
  const instruction = next
    ? `Continue with firstmate_skill {"cursor":"${next}"} or bb firstmate skill --cursor ${next}.`
    : "END OF NATIVE SKILL TRANSPORT: all pages must have been read in order. Delivery of this page alone does not establish a complete read.";
  return `FIRSTMATE_SKILL_PAGE ${index + 1}/${pages.length} snapshot=${snapshot}\n${instruction}\nRead every page before applying this skill or reference; a preview or saved remainder is incomplete.\nBEGIN_PAGE\n${pages[index]}\nEND_PAGE\n`;
}
