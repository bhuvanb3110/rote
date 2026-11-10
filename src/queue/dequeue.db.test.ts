// Dequeue against real Postgres: no job handed out twice, the per-tenant cap under concurrency, the
// write skew the tenant lock prevents (forced), fairness, atomic lease + token + attempt row,
// re-lease increments the token, the tenant-starvation fix, and the database-clock rule.
import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Pool } from "./db.js";
import {
  CLAIM_TENANT_SQL,
  COUNT_ACTIVE_SQL,
  INSERT_ATTEMPT_SQL,
  LEASE_SQL,
  PICK_JOB_SQL,
  dequeue,
} from "./dequeue.js";
import { createTestSchema, resetQueueTables, type TestSchema } from "./testDb.js";

let db: TestSchema;
let pool: Pool;

beforeAll(async () => {
  db = await createTestSchema("dequeue", { max: 24 });
  pool = db.pool;
});
afterAll(async () => {
  await db?.drop();
});
beforeEach(async () => {
  await resetQueueTables(pool);
});
afterEach(() => {
  vi.useRealTimers();
});

/**
 * Inserts queued jobs directly (enqueue's own behavior is tested in enqueue.db.test.ts). created_at
 * is spaced 1 ms apart in insertion order, so "oldest first" is deterministic.
 */
async function seed(tenantId: string, n: number, opts: { ageSeconds?: number; maxAttempts?: number } = {}): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO jobs (idempotency_key, request_hash, tenant_id, capability_id, params, trace_id, max_attempts, created_at)
     SELECT 'k-' || gen_random_uuid(), $2, $1, 'transfer', '{}', $3, $5,
            now() - make_interval(secs => $4) + (g * interval '1 millisecond')
     FROM generate_series(1, $6) AS g
     ORDER BY g
     RETURNING id`,
    [tenantId, randomBytes(32).toString("hex"), randomBytes(16).toString("hex"), opts.ageSeconds ?? 0, opts.maxAttempts ?? 3, n],
  );
  return rows.map((r) => r.id);
}

const activeCount = async (tenantId: string) =>
  (await pool.query<{ n: number }>(COUNT_ACTIVE_SQL, [tenantId])).rows[0]!.n;

const setCap = (tenantId: string, cap: number) =>
  pool.query("UPDATE tenants SET max_concurrent = $2 WHERE id = $1", [tenantId, cap]);

const complete = (id: string) =>
  pool.query("UPDATE jobs SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL, updated_at = now() WHERE id = $1", [id]);

describe("dequeue", () => {
  it("16 concurrent dequeuers over 300 jobs: every job handed out exactly once, token 1, attempt 1, one attempt row each", async () => {
    for (const t of ["tenant-a", "tenant-b", "tenant-c"]) {
      await setCap(t, 100);
      await seed(t, 100);
    }
    const seen: string[] = [];
    await Promise.all(
      Array.from({ length: 16 }, async (_, w) => {
        for (;;) {
          const job = await dequeue(pool, { workerId: `w${w}` });
          if (!job) return;
          seen.push(job.id);
          await complete(job.id);
        }
      }),
    );
    expect(seen).toHaveLength(300);
    expect(new Set(seen).size).toBe(300);
    const jobs = await pool.query("SELECT state, fencing_token, attempt, count(*)::int AS n FROM jobs GROUP BY 1, 2, 3");
    expect(jobs.rows).toEqual([{ state: "succeeded", fencing_token: 1, attempt: 1, n: 300 }]);
    const attempts = await pool.query("SELECT count(*)::int AS n, count(DISTINCT job_id)::int AS jobs FROM job_attempts");
    expect(attempts.rows[0]).toEqual({ n: 300, jobs: 300 });
  }, 60_000);

  it("the cap holds under concurrency: 8 dequeuers, cap 2 -> never more than 2 active (sampled), and exactly 2 once drained", async () => {
    const ROUNDS = 10;
    await seed("tenant-a", ROUNDS * 2);
    let sampling = true;
    let maxSeen = 0;
    const sampler = (async () => {
      while (sampling) {
        maxSeen = Math.max(maxSeen, await activeCount("tenant-a"));
      }
    })();
    try {
      for (let round = 0; round < ROUNDS; round += 1) {
        const got = (await Promise.all(Array.from({ length: 8 }, (_, w) => dequeue(pool, { workerId: `w${w}` })))).filter(Boolean);
        // A dequeuer that finds the tenant row locked by another skips it and may return null even
        // while a slot is free, so a concurrent burst leases 1 or 2 -- never more.
        expect(got.length).toBeGreaterThanOrEqual(1);
        expect(got.length).toBeLessThanOrEqual(2);
        expect(await activeCount("tenant-a")).toBeLessThanOrEqual(2);
        // Drain: sequential dequeues fill the remaining slot, then return null.
        while (await dequeue(pool, { workerId: "drain" })) {
          /* keep going */
        }
        expect(await activeCount("tenant-a")).toBe(2);
        // Free both slots for the next round.
        await pool.query("UPDATE jobs SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL WHERE state = 'running'");
      }
    } finally {
      sampling = false;
      await sampler;
    }
    expect(maxSeen).toBe(2);
  }, 60_000);

  it("the write skew, forced: the count-only variant lets 3 run under cap 2; the real dequeue keeps 2", async () => {
    // tenant-a: cap 2, one job already running, three queued.
    const [running] = await seed("tenant-a", 1, { ageSeconds: 100 });
    await pool.query("UPDATE jobs SET state = 'running', attempt = 1, lease_owner = 'w0', lease_expires_at = now() + interval '30 s' WHERE id = $1", [running]);
    await seed("tenant-a", 3);

    // Count-only variant, interleaved by hand: both count 1 (< 2), both pick, both commit.
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("BEGIN");
      await b.query("BEGIN");
      expect((await a.query(COUNT_ACTIVE_SQL, ["tenant-a"])).rows[0].n).toBe(1);
      expect((await b.query(COUNT_ACTIVE_SQL, ["tenant-a"])).rows[0].n).toBe(1);
      const ja = (await a.query(PICK_JOB_SQL, ["tenant-a"])).rows[0].id;
      const jb = (await b.query(PICK_JOB_SQL, ["tenant-a"])).rows[0].id;
      expect(ja).not.toBe(jb);
      await a.query(LEASE_SQL, [ja, "wa", 30]);
      await b.query(LEASE_SQL, [jb, "wb", 30]);
      await a.query("COMMIT");
      await b.query("COMMIT");
      expect(await activeCount("tenant-a")).toBe(3); // the cap is broken

      // Reset to 1 running, then the same race with the real protocol: A holds the tenant claim
      // (real CLAIM_TENANT_SQL) when B's real dequeue() runs.
      await pool.query("UPDATE jobs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL, attempt = 0 WHERE id = ANY($1)", [[ja, jb]]);
      await a.query("BEGIN");
      const claim = await a.query(CLAIM_TENANT_SQL, [[]]);
      expect(claim.rows[0].id).toBe("tenant-a");
      expect(await dequeue(pool, { workerId: "wb" })).toBeNull(); // tenant row locked by A: skipped
      expect((await a.query(COUNT_ACTIVE_SQL, ["tenant-a"])).rows[0].n).toBe(1);
      const pick = (await a.query(PICK_JOB_SQL, ["tenant-a"])).rows[0].id;
      const leased = (await a.query(LEASE_SQL, [pick, "wa", 30])).rows[0];
      await a.query(INSERT_ATTEMPT_SQL, [pick, leased.attempt, "wa", leased.fencing_token, leased.trace_id]);
      await a.query("COMMIT");
      expect(await dequeue(pool, { workerId: "wb" })).toBeNull(); // recount says 2 >= 2
      expect(await activeCount("tenant-a")).toBe(2);
    } finally {
      a.release();
      b.release();
    }
  });

  it("fairness: the tenant with the oldest waiting job goes first; a tenant at its cap is skipped for one with room", async () => {
    await seed("tenant-b", 1, { ageSeconds: 10 });
    const [oldestA] = await seed("tenant-a", 3, { ageSeconds: 20 });
    const first = await dequeue(pool, { workerId: "w1" });
    expect(first!.id).toBe(oldestA);

    await setCap("tenant-a", 1); // tenant-a now at its cap (1 running), though it has older jobs
    const second = await dequeue(pool, { workerId: "w2" });
    expect(second!.tenant_id).toBe("tenant-b");
    expect(await dequeue(pool, { workerId: "w3" })).toBeNull();
  });

  it("verifying (and committing) count toward max_concurrent (reviewer decision 4)", async () => {
    const [j1, j2] = await seed("tenant-a", 3);
    await pool.query(
      `UPDATE jobs SET state = 'verifying', attempt = 1, lease_owner = 'w', lease_expires_at = now() + interval '30 s' WHERE id = $1`,
      [j1],
    );
    await pool.query(
      `UPDATE jobs SET state = 'committing', commit_intent_at = now(), attempt = 1, lease_owner = 'w', lease_expires_at = now() + interval '30 s' WHERE id = $1`,
      [j2],
    );
    expect(await dequeue(pool, { workerId: "w" })).toBeNull();
  });

  it("lease, token and attempt row are written together, expiry from the database clock", async () => {
    const [id] = await seed("tenant-a", 1);
    const job = await dequeue(pool, { workerId: "worker-7", leaseSeconds: 30 });
    expect(job).toMatchObject({ id, state: "running", attempt: 1, fencing_token: 1, lease_owner: "worker-7" });
    const { rows } = await pool.query(
      "SELECT extract(epoch FROM lease_expires_at - now())::float AS secs FROM jobs WHERE id = $1",
      [id],
    );
    expect(rows[0].secs).toBeGreaterThan(28);
    expect(rows[0].secs).toBeLessThanOrEqual(30);
    const attempts = await pool.query("SELECT job_id, attempt, worker_id, fencing_token, trace_id FROM job_attempts");
    expect(attempts.rows).toEqual([{ job_id: id, attempt: 1, worker_id: "worker-7", fencing_token: 1, trace_id: job!.trace_id }]);
  });

  it("a failure between the lease (4) and the attempt row (5) rolls back both: job queued, token 0, no attempt row", async () => {
    const [id] = await seed("tenant-a", 1);
    // Test-only constraint makes step (5) fail for this worker id, after step (4) has run.
    await pool.query("ALTER TABLE job_attempts ADD CONSTRAINT test_fail_step5 CHECK (worker_id <> 'doomed')");
    try {
      await expect(dequeue(pool, { workerId: "doomed" })).rejects.toThrow(/test_fail_step5/);
    } finally {
      await pool.query("ALTER TABLE job_attempts DROP CONSTRAINT test_fail_step5");
    }
    const job = (await pool.query("SELECT state, fencing_token, attempt, lease_owner FROM jobs WHERE id = $1", [id])).rows[0];
    expect(job).toEqual({ state: "queued", fencing_token: 0, attempt: 0, lease_owner: null });
    expect((await pool.query("SELECT count(*)::int AS n FROM job_attempts")).rows[0].n).toBe(0);
    // The pool connection is healthy and the job is still dequeueable.
    expect((await dequeue(pool, { workerId: "fine" }))!.id).toBe(id);
  });

  it("re-dequeue after a requeue (standing in for Day-2 recovery) -> fencing_token 2, attempt 2, a second attempt row", async () => {
    const [id] = await seed("tenant-a", 1);
    await dequeue(pool, { workerId: "w1" });
    await pool.query("UPDATE jobs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1", [id]);
    const again = await dequeue(pool, { workerId: "w2" });
    expect(again).toMatchObject({ id, fencing_token: 2, attempt: 2, lease_owner: "w2" });
    const attempts = await pool.query("SELECT attempt, worker_id, fencing_token FROM job_attempts ORDER BY attempt");
    expect(attempts.rows).toEqual([
      { attempt: 1, worker_id: "w1", fencing_token: 1 },
      { attempt: 2, worker_id: "w2", fencing_token: 2 },
    ]);
  });
});

describe("reviewer decision 6: tenant starvation", () => {
  it("tenant-a's queued job row locked by another open transaction: dequeue still returns tenant-b's job", async () => {
    const [aJob] = await seed("tenant-a", 1, { ageSeconds: 60 }); // oldest: the claim picks tenant-a first
    const [bJob] = await seed("tenant-b", 1);
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT id FROM jobs WHERE id = $1 FOR UPDATE", [aJob]);
      const got = await dequeue(pool, { workerId: "w1" });
      expect(got!.id).toBe(bJob);
      // tenant-a's claim was rolled back: no lease, no attempt row for it.
      expect((await pool.query("SELECT state, fencing_token FROM jobs WHERE id = $1", [aJob])).rows[0]).toEqual({
        state: "queued",
        fencing_token: 0,
      });
      // Only tenant-a has work left and its row is still locked: null, promptly, no hang.
      expect(await dequeue(pool, { workerId: "w2" })).toBeNull();
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
    expect((await dequeue(pool, { workerId: "w3" }))!.id).toBe(aJob);
  });

  it("an exhausted job can never sit in 'queued', so it can't make a tenant look like it has work", async () => {
    const [id] = await seed("tenant-a", 1, { maxAttempts: 1 });
    await dequeue(pool, { workerId: "w1" }); // attempt 1 of 1
    await expect(
      pool.query("UPDATE jobs SET state = 'queued', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1", [id]),
    ).rejects.toThrow(/jobs_queued_has_attempts_left/);
    await pool.query("UPDATE jobs SET state = 'failed', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1", [id]);
    const [bJob] = await seed("tenant-b", 1);
    expect((await dequeue(pool, { workerId: "w2" }))!.id).toBe(bJob);
  });

  it("several tenants each blocked (row locked / at cap): dequeue walks past all of them to the one with work", async () => {
    const [aJob] = await seed("tenant-a", 1, { ageSeconds: 60 });
    const [bRunning] = await seed("tenant-b", 1, { ageSeconds: 50 });
    await seed("tenant-b", 1, { ageSeconds: 40 });
    const [cJob] = await seed("tenant-c", 1);
    await setCap("tenant-b", 1);
    await pool.query("UPDATE jobs SET state = 'running', attempt = 1, lease_owner = 'w', lease_expires_at = now() + interval '30 s' WHERE id = $1", [bRunning]);
    const locker = await pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("SELECT 1 FROM jobs WHERE id = $1 FOR UPDATE", [aJob]);
      expect((await dequeue(pool, { workerId: "w" }))!.id).toBe(cJob);
    } finally {
      await locker.query("ROLLBACK");
      locker.release();
    }
  });
});

describe("reviewer decision 7: the database clock, never the worker's", () => {
  it("a worker whose clock is an hour ahead still gets a lease of ~30 s by the database's now()", async () => {
    await seed("tenant-a", 1);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 3_600_000));
    const job = await dequeue(pool, { workerId: "skewed" });
    vi.useRealTimers();
    const { rows } = await pool.query("SELECT extract(epoch FROM lease_expires_at - now())::float AS secs FROM jobs WHERE id = $1", [
      job!.id,
    ]);
    expect(rows[0].secs).toBeGreaterThan(28);
    expect(rows[0].secs).toBeLessThanOrEqual(30);
  });

  it("no dequeue statement takes a timestamp parameter: expiry is now() + an interval", () => {
    expect(LEASE_SQL).toMatch(/lease_expires_at = now\(\) \+ make_interval\(secs => \$3\)/);
    for (const sql of [CLAIM_TENANT_SQL, COUNT_ACTIVE_SQL, PICK_JOB_SQL, LEASE_SQL, INSERT_ATTEMPT_SQL]) {
      expect(sql).not.toMatch(/::timestamptz|to_timestamp/);
    }
  });
});

describe("argument checks", () => {
  it("rejects a missing worker id and an out-of-range lease", async () => {
    await expect(dequeue(pool, { workerId: "" })).rejects.toThrow(/workerId/);
    await expect(dequeue(pool, { workerId: "w", leaseSeconds: 0 })).rejects.toThrow(RangeError);
    await expect(dequeue(pool, { workerId: "w", leaseSeconds: 1.5 })).rejects.toThrow(RangeError);
  });
});
