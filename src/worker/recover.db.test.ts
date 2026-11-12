// T6 (recovery of expired leases) against real Postgres (docs/plans/step-08.md section 8, DB): every row
// of section 4's table, the token bump, the dead holder's attempt row, the database clock, and 8
// concurrent recoverers over 50 expired jobs recovering each exactly once.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Capability } from "../artifact/index.js";
import { createPool, dequeue, enqueue, type JobRow, type Pool } from "../queue/index.js";
import { createTestSchema, resetQueueTables, testDatabaseUrl, type TestSchema } from "../queue/testDb.js";
import { writeCommitIntent } from "./intent.js";
import { CLAIM_EXPIRED_SQL, createRecoverySweep, recoverExpired, recoverOne, RECOVER_JOB_SQL } from "./recover.js";

const CAP = {
  id: "cap",
  inputs: [{ name: "memberId", type: "string", required: true, redact: false, description: "m" }],
  steps: [],
} as unknown as Pick<Capability, "id" | "inputs" | "steps">;

let db: TestSchema;
let pool: Pool;

beforeAll(async () => {
  db = await createTestSchema("worker_recover");
  pool = db.pool;
});
afterAll(async () => {
  await db?.drop();
});
beforeEach(async () => {
  await resetQueueTables(pool);
  await pool.query("UPDATE tenants SET max_concurrent = 100");
});

async function enqueueN(n: number, maxAttempts = 3): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await enqueue(pool, { capability: CAP, tenantId: "tenant-a", idempotencyKey: `k-${i}-${Math.random()}`, params: { memberId: "1" }, maxAttempts });
  }
}

async function leased(maxAttempts = 3, workerId = "dead-worker"): Promise<JobRow> {
  await enqueueN(1, maxAttempts);
  const job = await dequeue(pool, { workerId, leaseSeconds: 30 });
  if (!job) throw new Error("no job");
  return job;
}

/** Expire leases on the DATABASE clock (D22). */
const expire = (id?: string) =>
  id
    ? pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [id])
    : pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE lease_expires_at IS NOT NULL");
const row = async (id: string) => (await pool.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0];
const attemptRows = async (id: string) => (await pool.query("SELECT * FROM job_attempts WHERE job_id = $1 ORDER BY attempt", [id])).rows;

describe("T6: one row per line of section 4's table", () => {
  it("running, attempts left -> T6.1 requeue: queued, token + 1, lease cleared, the dead attempt 'crashed'; the next dequeue is attempt 2", async () => {
    const job = await leased();
    await expire(job.id);
    const r = await recoverOne(pool, { workerId: "rescuer" });
    expect(r).toMatchObject({ jobId: job.id, from: "running", action: { kind: "requeue", label: "T6.1" }, previousToken: 1, fencingToken: 2, deadOwner: "dead-worker" });
    const after = await row(job.id);
    expect(after).toMatchObject({ state: "queued", fencing_token: 2, lease_owner: null, lease_expires_at: null, outcome: null, attempt: 1 });
    expect(after.error).toMatch(/lease expired while running \(attempt 1\/3\), before any commit intent; requeued \(T6\.1: the lease of dead-worker expired; recovered by rescuer\)/);
    const [a] = await attemptRows(job.id);
    expect(a).toMatchObject({ outcome: "crashed", fencing_token: 1 });
    expect(a.ended_at).toBeInstanceOf(Date);
    expect(a.error).toBe("lease expired in running; recovered by rescuer (T6.1 requeue)");
    const again = await dequeue(pool, { workerId: "w2", leaseSeconds: 30 });
    expect(again).toMatchObject({ id: job.id, attempt: 2, fencing_token: 3 }); // dequeue bumps it again
  });

  it("running on the last attempt -> T6.2 fail / lease_expired, never queued (D21)", async () => {
    const job = await leased(1);
    await expire(job.id);
    const r = await recoverOne(pool, { workerId: "rescuer" });
    expect(r!.action).toMatchObject({ kind: "fail", label: "T6.2" });
    expect(await row(job.id)).toMatchObject({ state: "failed", outcome: "lease_expired", fencing_token: 2, lease_owner: null });
  });

  it("committing -> T6.3 escalate: needs_human / commit_uncertain (Step 8 interim), never requeued", async () => {
    const job = await leased();
    await writeCommitIntent(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "dead-worker", leaseSeconds: 30 });
    await expire(job.id);
    const r = await recoverOne(pool, { workerId: "rescuer" });
    expect(r!.action).toMatchObject({ kind: "escalate", label: "T6.3" });
    const after = await row(job.id);
    expect(after).toMatchObject({ state: "needs_human", outcome: "commit_uncertain", fencing_token: 2, lease_owner: null });
    expect(after.commit_intent_at).toBeInstanceOf(Date); // kept: evidence that an intent was written
    expect(after.error).toMatch(/the Submit may have committed; check the bank's history for memo_key/);
    expect((await attemptRows(job.id))[0]).toMatchObject({ outcome: "crashed" });
  });

  it("verifying (unreachable in Step 8) is escalated too", async () => {
    const job = await leased();
    await pool.query("UPDATE jobs SET state = 'verifying' WHERE id = $1", [job.id]);
    await expire(job.id);
    expect((await recoverOne(pool, { workerId: "rescuer" }))!.action.kind).toBe("escalate");
    expect((await row(job.id)).state).toBe("needs_human");
  });
});

describe("T6: what it never touches", () => {
  it("a live lease (database clock), a queued job, a terminal job", async () => {
    const live = await leased();
    await enqueueN(1); // queued
    const done = await leased();
    await pool.query("UPDATE jobs SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1", [done.id]);
    const before = (await pool.query("SELECT * FROM jobs ORDER BY id")).rows;
    expect(await recoverExpired(pool, { workerId: "rescuer" })).toEqual([]);
    expect((await pool.query("SELECT * FROM jobs ORDER BY id")).rows).toEqual(before);
    expect((await row(live.id)).state).toBe("running");
  });

  it("an expired lease whose attempt row the worker already closed: the job is recovered, the closed attempt row is left as the worker wrote it", async () => {
    const job = await leased();
    await pool.query("UPDATE job_attempts SET ended_at = now(), outcome = 'lease_lost', error = 'mine' WHERE job_id = $1", [job.id]);
    await expire(job.id);
    await recoverOne(pool, { workerId: "rescuer" });
    expect((await attemptRows(job.id))[0]).toMatchObject({ outcome: "lease_lost", error: "mine" });
  });

  it("recovers oldest expiry first, at most `max` per call, and reports each", async () => {
    await enqueueN(5);
    for (let i = 0; i < 5; i += 1) await dequeue(pool, { workerId: `dead-${i}`, leaseSeconds: 30 });
    await pool.query(
      "UPDATE jobs SET lease_expires_at = now() - make_interval(secs => 100 - (SELECT count(*) FROM jobs j2 WHERE j2.created_at < jobs.created_at))",
    );
    const seen: string[] = [];
    const first = await recoverExpired(pool, { workerId: "rescuer", max: 3, onRecovered: (r) => seen.push(r.jobId) });
    expect(first).toHaveLength(3);
    expect(seen).toEqual(first.map((r) => r.jobId));
    const order = (await pool.query("SELECT id FROM jobs ORDER BY created_at")).rows.map((r) => r.id);
    expect(seen).toEqual(order.slice(0, 3)); // the oldest-created got the earliest expiry above
    expect(await recoverExpired(pool, { workerId: "rescuer", max: 10 })).toHaveLength(2);
  });

  it("the claim uses the database clock and the partial index's order; the update re-checks expiry", () => {
    expect(CLAIM_EXPIRED_SQL).toMatch(/lease_expires_at < now\(\)/);
    expect(CLAIM_EXPIRED_SQL).toMatch(/ORDER BY lease_expires_at, id/);
    expect(CLAIM_EXPIRED_SQL).toMatch(/FOR UPDATE SKIP LOCKED/);
    expect(RECOVER_JOB_SQL).toMatch(/fencing_token = fencing_token \+ 1/);
    expect(RECOVER_JOB_SQL).toMatch(/AND lease_expires_at < now\(\)/);
  });
});

describe("T6 under concurrency", () => {
  it("8 concurrent recoverers over 50 expired jobs: each job recovered exactly once (token + 1 exactly once)", async () => {
    await enqueueN(50);
    for (let i = 0; i < 50; i += 1) await dequeue(pool, { workerId: `dead-${i}`, leaseSeconds: 30 });
    await expire();
    const pools = Array.from({ length: 8 }, () => createPool({ connectionString: testDatabaseUrl(), searchPath: db.schema, max: 1 }));
    try {
      const results = await Promise.all(pools.map((p, i) => recoverExpired(p, { workerId: `rescuer-${i}`, max: 50 })));
      const ids = results.flat().map((r) => r.jobId);
      expect(ids).toHaveLength(50);
      expect(new Set(ids).size).toBe(50);
      const rows = (await pool.query("SELECT state, fencing_token FROM jobs")).rows;
      expect(rows.every((r) => r.state === "queued" && r.fencing_token === 2)).toBe(true);
      const crashed = (await pool.query("SELECT count(*)::int AS n FROM job_attempts WHERE outcome = 'crashed'")).rows[0].n;
      expect(crashed).toBe(50);
      expect(results.filter((r) => r.length > 0).length).toBeGreaterThan(1); // the work really was shared
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });
});

describe("createRecoverySweep (the worker's beforeDequeue)", () => {
  it("logs each recovery; a transient DB error is logged and swallowed; any other error propagates", async () => {
    const job = await leased();
    await expire(job.id);
    const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const log = { info() {}, error() {}, warn: (obj: Record<string, unknown>, msg: string) => warnings.push({ obj, msg }) };
    await createRecoverySweep({ pool, workerId: "rescuer", log })();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ msg: "worker: recovered an expired lease", obj: { jobId: job.id, from: "running", label: "T6.1", to: "queued" } });

    const transient = { connect: async () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })) } as unknown as Pool;
    await createRecoverySweep({ pool: transient, workerId: "rescuer", log })();
    expect(warnings.at(-1)!.msg).toMatch(/Postgres unavailable during recovery/);

    const fatal = { connect: async () => Promise.reject(Object.assign(new Error("syntax error"), { code: "42601" })) } as unknown as Pool;
    await expect(createRecoverySweep({ pool: fatal, workerId: "rescuer", log })()).rejects.toThrow("syntax error");
  });
});
