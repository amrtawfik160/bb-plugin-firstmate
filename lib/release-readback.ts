/** A crew's read-back of a released app build: where the build is, read from App Store
 * Connect or EAS, never assumed (owner decision Q5, 17 Oct). */
export type ReleaseSource = "app-store-connect" | "eas";
export type ReleaseReadback = {
  task: string;
  captain: string;
  crewId: string;
  project: string;
  build: string;
  group: string;
  source: ReleaseSource;
  seen: string;
  at: number;
  /** The commit the build was built from, as the crew read it. */
  commit?: string;
  /** When the build was made, as App Store Connect or EAS showed it. */
  builtAt?: number;
};

type Database = {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
};

export function createReleaseReadbacks(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS release_readback (
    task TEXT NOT NULL, captain TEXT NOT NULL, at INTEGER NOT NULL, record TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS release_readback_task ON release_readback(captain, task);`);
  return {
    record(readback: ReleaseReadback): ReleaseReadback {
      db.prepare("INSERT INTO release_readback VALUES (?,?,?,?)").run(readback.task, readback.captain, readback.at, JSON.stringify(readback));
      return readback;
    },
    forTask(captain: string, task: string): ReleaseReadback[] {
      return (db.prepare("SELECT record FROM release_readback WHERE captain=? AND task=? ORDER BY at").all(captain, task) as { record: string }[])
        .map((row) => JSON.parse(row.record) as ReleaseReadback);
    },
  };
}
