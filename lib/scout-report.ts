import type { BbPluginApi } from '@get-bb/plugin-sdk';
type Database = ReturnType<BbPluginApi['storage']['database']>;
/** Complete promotion evidence, independent of worker retention and KV limits. */
export function scoutReports(db:Database) {
  db.exec('CREATE TABLE IF NOT EXISTS scout_reports (project TEXT NOT NULL, owner TEXT NOT NULL, task TEXT NOT NULL, report TEXT NOT NULL, PRIMARY KEY(project,owner,task))');
  function put(project:string,owner:string,task:string,report:string) {
    if (!report.trim()) throw new Error('Scout durable report is missing or unreadable.');
    db.prepare('INSERT INTO scout_reports VALUES (?,?,?,?) ON CONFLICT(project,owner,task) DO UPDATE SET report=excluded.report').run(project,owner,task,report);
  }
  function get(project:string,owner:string,task:string) {
    return (db.prepare('SELECT report FROM scout_reports WHERE project=? AND owner=? AND task=?').get(project,owner,task) as {report:string}|undefined)?.report;
  }
  return {put,get};
}
