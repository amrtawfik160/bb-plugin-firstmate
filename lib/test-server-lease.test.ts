import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createLeases, LEASE_TTL_MS } from "./test-server-lease.ts";

function store() {
  const db = new DatabaseSync(":memory:");
  return createLeases({ exec: (sql) => db.exec(sql), prepare: (sql) => db.prepare(sql) as never, transaction: <T>(fn: () => T) => () => { db.exec("BEGIN"); try { const out = fn(); db.exec("COMMIT"); return out; } catch (error) { db.exec("ROLLBACK"); throw error; } } });
}
const alive = (ids: string[]) => (id: string) => ids.includes(id);

test("one crew holds a shared server; the others wait in order and get it in that order", () => {
  const leases = store();
  assert.equal(leases.acquire("cyndra-dev", "a", "cap", alive(["a", "b", "c"]), 0).granted, true);
  assert.deepEqual(leases.acquire("cyndra-dev", "b", "cap", alive(["a", "b", "c"]), 1), { granted: false, holder: leases.holder("cyndra-dev"), position: 1 });
  assert.equal((leases.acquire("cyndra-dev", "c", "cap", alive(["a", "b", "c"]), 2) as { position: number }).position, 2);
  assert.equal((leases.acquire("cyndra-dev", "b", "cap", alive(["a", "b", "c"]), 3) as { position: number }).position, 1, "asking again keeps the place");
  assert.equal(leases.release("cyndra-dev", "a")?.crewId, "b");
  assert.equal(leases.acquire("cyndra-dev", "c", "cap", alive(["b", "c"]), 4).granted, false, "c cannot jump the queue");
  assert.equal(leases.acquire("cyndra-dev", "b", "cap", alive(["b", "c"]), 5).granted, true);
  assert.throws(() => leases.release("cyndra-dev", "c"), /Crew c does not hold the lease on cyndra-dev; crew b does/);
});

test("the lease of a crew that died, or that was not renewed in time, expires", () => {
  const leases = store();
  leases.acquire("cyndra-dev", "a", "cap", alive(["a", "b"]), 0);
  leases.acquire("cyndra-dev", "b", "cap", alive(["a", "b"]), 1);
  assert.equal(leases.expire("cyndra-dev", alive(["a", "b"]), 10), null);
  const gone = leases.expire("cyndra-dev", alive(["b"]), 20);
  assert.deepEqual([gone?.expired.crewId, gone?.next?.crewId], ["a", "b"]);
  leases.acquire("cyndra-dev", "b", "cap", alive(["b"]), 30);
  const late = leases.acquire("cyndra-dev", "c", "cap", alive(["b", "c"]), 30 + LEASE_TTL_MS);
  assert.equal(late.granted, true, "b did not renew within the lease time");
  assert.equal(late.granted && late.expired?.crewId, "b");
});
