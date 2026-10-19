// One-time repair: cancel open question cards that have no options (status records
// stored as cards) and copy their text onto the bound task. Never open the live
// database: copy it first, for example
//   node -e 'new (require("node:sqlite").DatabaseSync)(process.argv[1],{readOnly:true}).prepare("VACUUM INTO ?").run(process.argv[2])' <data.db> /tmp/fm-copy.db
// then: node --experimental-strip-types scripts/repair-status-question-cards.ts /tmp/fm-copy.db
import { realpathSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { repairStatusQuestionCards } from "../lib/repair-status-question-cards.ts";

const path = process.argv[2];
if (!path) throw new Error("usage: repair-status-question-cards.ts <copy of data.db>");
const real = realpathSync(path);
if (/\/\.bb-server\/(bb\.db|plugins\/)/.test(real)) throw new Error(`Refusing ${real}: repair a copy, never a live database.`);

const raw = new DatabaseSync(real);
const db = Object.assign(raw, {
  transaction<T>(fn: () => T) {
    return () => { raw.exec("BEGIN"); try { const out = fn(); raw.exec("COMMIT"); return out; } catch (error) { raw.exec("ROLLBACK"); throw error; } };
  },
});
const repaired = repairStatusQuestionCards(db);
console.log(`Repaired ${repaired.length} status question card(s).`);
for (const row of repaired) {
  console.log(`  ${row.id} captain=${row.captain}${row.task ? ` task=${row.task}` : ""} cancelled=${row.cancelled} noted=${row.noted}`);
}
