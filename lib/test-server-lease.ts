// Owner decision Q11 (17 Oct): a shared test server (owner/projects.json sharedServers) serves one crew
// at a time. Nine reports were blocked on the shared Cyndra dev server, and one crew's schema check
// failed on another crew's change. A crew acquires the lease, uses the server, resets it to main and
// releases it; the others wait in order. A lease whose crew is gone, or that was not renewed, expires.

export const LEASE_TTL_MS = 2 * 60 * 60_000;

export type Lease = { server: string; crewId: string; captain: string; acquiredAt: number; renewedAt: number };
export type Waiter = { server: string; crewId: string; captain: string; at: number };
export type AcquireResult = { granted: true; lease: Lease; expired?: Lease } | { granted: false; holder: Lease; position: number };

type Database = {
  exec(sql: string): unknown;
  prepare(sql: string): { run(...params: unknown[]): unknown; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  transaction<T>(fn: () => T): () => T;
};

export function createLeases(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS test_server_lease (server TEXT PRIMARY KEY, record TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS test_server_wait (server TEXT NOT NULL, crew TEXT NOT NULL, at INTEGER NOT NULL, record TEXT NOT NULL, PRIMARY KEY(server, crew));`);
  const holder = (server: string): Lease | undefined => {
    const row = db.prepare("SELECT record FROM test_server_lease WHERE server=?").get(server) as { record: string } | undefined;
    return row ? JSON.parse(row.record) as Lease : undefined;
  };
  const queue = (server: string): Waiter[] => (db.prepare("SELECT record FROM test_server_wait WHERE server=? ORDER BY at, crew").all(server) as { record: string }[]).map((row) => JSON.parse(row.record) as Waiter);
  const grant = (server: string, crewId: string, captain: string, now: number): Lease => {
    const lease: Lease = { server, crewId, captain, acquiredAt: now, renewedAt: now };
    db.prepare("INSERT INTO test_server_lease VALUES (?,?) ON CONFLICT(server) DO UPDATE SET record=excluded.record").run(server, JSON.stringify(lease));
    db.prepare("DELETE FROM test_server_wait WHERE server=? AND crew=?").run(server, crewId);
    return lease;
  };
  const stale = (lease: Lease, alive: (crewId: string) => boolean, now: number) => !alive(lease.crewId) || now - lease.renewedAt >= LEASE_TTL_MS;
  return {
    holder,
    queue,
    /** Grant the lease when it is free, already held by this crew, or stale; else queue the crew once. The head of the queue goes first. */
    acquire(server: string, crewId: string, captain: string, alive: (crewId: string) => boolean, now: number): AcquireResult {
      return db.transaction((): AcquireResult => {
        const current = holder(server);
        if (current?.crewId === crewId) {
          const lease = { ...current, renewedAt: now };
          db.prepare("UPDATE test_server_lease SET record=? WHERE server=?").run(JSON.stringify(lease), server);
          return { granted: true, lease };
        }
        for (const waiter of queue(server)) if (!alive(waiter.crewId)) db.prepare("DELETE FROM test_server_wait WHERE server=? AND crew=?").run(server, waiter.crewId);
        const waiting = queue(server);
        const first = waiting[0];
        if (current === undefined || stale(current, alive, now)) {
          if (first === undefined || first.crewId === crewId) {
            const lease = grant(server, crewId, captain, now);
            return current === undefined ? { granted: true, lease } : { granted: true, lease, expired: current };
          }
        }
        if (!waiting.some((waiter) => waiter.crewId === crewId)) {
          db.prepare("INSERT INTO test_server_wait VALUES (?,?,?,?)").run(server, crewId, now, JSON.stringify({ server, crewId, captain, at: now }));
        }
        const position = queue(server).findIndex((waiter) => waiter.crewId === crewId) + 1;
        return { granted: false, holder: current ?? { server, crewId: first!.crewId, captain: first!.captain, acquiredAt: first!.at, renewedAt: first!.at }, position };
      })();
    },
    /** Release a lease this crew holds. Returns the next crew in line, which the caller tells. */
    release(server: string, crewId: string): Waiter | undefined {
      return db.transaction(() => {
        const current = holder(server);
        if (current?.crewId !== crewId) throw new Error(`Crew ${crewId} does not hold the lease on ${server}${current ? `; crew ${current.crewId} does` : ""}.`);
        db.prepare("DELETE FROM test_server_lease WHERE server=?").run(server);
        return queue(server)[0];
      })();
    },
    /** Drop the lease of a crew that is gone or did not renew. Returns the expired lease and the next crew in line. */
    expire(server: string, alive: (crewId: string) => boolean, now: number): { expired: Lease; next: Waiter | undefined } | null {
      return db.transaction(() => {
        const current = holder(server);
        if (current === undefined || !stale(current, alive, now)) return null;
        db.prepare("DELETE FROM test_server_lease WHERE server=?").run(server);
        for (const waiter of queue(server)) if (!alive(waiter.crewId)) db.prepare("DELETE FROM test_server_wait WHERE server=? AND crew=?").run(server, waiter.crewId);
        return { expired: current, next: queue(server)[0] };
      })();
    },
    servers(): string[] {
      return (db.prepare("SELECT server FROM test_server_lease UNION SELECT server FROM test_server_wait").all() as { server: string }[]).map((row) => row.server);
    },
  };
}
