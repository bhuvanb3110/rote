// T2 (the heartbeat statement) and the lease_lost attempt marking against real Postgres
// (docs/plans/step-08.md section 8, DB). Leases are expired on the DATABASE clock
// (`lease_expires_at = now() - interval '1 s'`), never by a worker's clock (D22).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Capability } from "../artifact/index.js";
import { dequeue, enqueue, type JobRow, type Pool } from "../queue/index.js";
import { createTestSchema, resetQueueTables, type TestSchema } from "../queue/testDb.js";
import { jobOutcomeFor } from "../fleet/stateMachine.js";
import { completeJob, markAttemptLeaseLost } from "./complete.js";
import { extendLease, HEARTBEAT_SQL } from "./heartbeat.js";

const CAP = {
  id: "cap",
  inputs: [{ name: "memberId", type: "string", required: true, redact: false, description: "m" }],
  steps: [],
} as unknown as Pick<Capability, "id" | "inputs" | "steps">;

let db: TestSchema;
let pool: Pool;

beforeAll(async () => {
  db = await createTestSchema("worker_heartbeat");
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

async function leased(leaseSeconds = 30): Promise<JobRow> {
  await enqueue(pool, { capability: CAP, tenantId: "tenant-a", idempotencyKey: `k-${Math.random()}`, params: { memberId: "1" } });
  const job = await dequeue(pool, { workerId: "w1", leaseSeconds });
  if (!job) throw new Error("no job");
  return job;
}

/** Seconds left on the lease, by the database's clock. */
async function remaining(id: string): Promise<number | null> {
  const { rows } = await pool.query<{ s: number | null }>(
    "SELECT EXTRACT(EPOCH FROM (lease_expires_at - now()))::float8 AS s FROM jobs WHERE id = $1",
    [id],
  );
  return rows[0]!.s;
}

const ref = (job: JobRow, over: Partial<{ fencingToken: number; workerId: string; leaseSeconds: number }> = {}) => ({
  jobId: job.id,
  fencingToken: job.fencing_token,
  workerId: "w1",
  leaseSeconds: 30,
  ...over,
});

describe("T2: the heartbeat statement", () => {
  it("extends a live lease to now() + lease on the database clock, while token and owner match", async () => {
    const job = await leased(5);
    expect(await remaining(job.id)).toBeLessThanOrEqual(5);
    expect(await extendLease(pool, ref(job))).toBe(true);
    const left = (await remaining(job.id))!;
    expect(left).toBeGreaterThan(28);
    expect(left).toBeLessThanOrEqual(30);
  });

  it("works in every active state (running, committing, verifying) and in none other", async () => {
    const job = await leased();
    for (const state of ["committing", "verifying"]) {
      await pool.query("UPDATE jobs SET state = $2, commit_intent_at = now() WHERE id = $1", [job.id, state]);
      expect(await extendLease(pool, ref(job)), state).toBe(true);
    }
    await pool.query("UPDATE jobs SET state = 'needs_human' WHERE id = $1", [job.id]);
    expect(await extendLease(pool, ref(job))).toBe(false);
  });

  it("0 rows after the token was bumped (recovery) or for another owner", async () => {
    const job = await leased();
    expect(await extendLease(pool, ref(job, { workerId: "someone-else" }))).toBe(false);
    await pool.query("UPDATE jobs SET fencing_token = fencing_token + 1 WHERE id = $1", [job.id]);
    expect(await extendLease(pool, ref(job))).toBe(false);
  });

  it("NEVER revives an expired lease, even with the right token and owner (reviewer decision 2)", async () => {
    const job = await leased();
    await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job.id]);
    expect(await extendLease(pool, ref(job))).toBe(false);
    expect(await remaining(job.id)).toBeLessThan(0); // untouched: recovery's to take
  });

  it("D22: a worker whose clock is an hour off gets exactly the same lease (no timestamp is ever sent)", async () => {
    const job = await leased();
    vi.useFakeTimers({ now: Date.now() + 3_600_000, toFake: ["Date"] });
    expect(await extendLease(pool, ref(job))).toBe(true);
    const left = (await remaining(job.id))!;
    expect(left).toBeGreaterThan(28);
    expect(left).toBeLessThanOrEqual(30);
    expect(HEARTBEAT_SQL).toMatch(/now\(\) \+ make_interval\(secs => \$4\)/);
    expect(HEARTBEAT_SQL).toMatch(/lease_expires_at > now\(\)/);
  });
});

describe("lease_lost on the attempt row (the worker writes nothing to jobs)", () => {
  it("markAttemptLeaseLost: ended, lease_lost, and the job row untouched", async () => {
    const job = await leased();
    const before = (await pool.query("SELECT * FROM jobs WHERE id = $1", [job.id])).rows[0];
    await markAttemptLeaseLost(pool, { jobId: job.id, fencingToken: job.fencing_token, detail: "lease lost during the run", commitUncertain: false });
    const [a] = (await pool.query("SELECT * FROM job_attempts WHERE job_id = $1", [job.id])).rows;
    expect(a).toMatchObject({ outcome: "lease_lost", error: "lease lost during the run", commit_uncertain: false });
    expect(a.ended_at).toBeInstanceOf(Date);
    expect((await pool.query("SELECT * FROM jobs WHERE id = $1", [job.id])).rows[0]).toEqual(before);
  });

  it("keeps the note recovery wrote first ('crashed'), after the worker's own text, and ORs commit_uncertain", async () => {
    const job = await leased();
    await pool.query(
      "UPDATE job_attempts SET ended_at = now(), outcome = 'crashed', error = 'lease expired in committing; recovered by w9 (T6.3 escalate)' WHERE job_id = $1",
      [job.id],
    );
    await markAttemptLeaseLost(pool, { jobId: job.id, fencingToken: job.fencing_token, detail: "lease lost during the run", commitUncertain: true });
    const [a] = (await pool.query("SELECT * FROM job_attempts WHERE job_id = $1", [job.id])).rows;
    expect(a.outcome).toBe("lease_lost");
    expect(a.commit_uncertain).toBe(true);
    expect(a.error).toBe("lease lost during the run [recovery had recorded: lease expired in committing; recovered by w9 (T6.3 escalate)]");
  });

  it("a fenced-out completion (T4, 0 rows) marks the attempt the same way", async () => {
    const job = await leased();
    await pool.query("UPDATE job_attempts SET error = 'lease expired in running; recovered by w9 (T6.1 requeue)', outcome = 'crashed', ended_at = now()");
    await pool.query("UPDATE jobs SET fencing_token = fencing_token + 1, state = 'queued', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1", [job.id]);
    const outcome = jobOutcomeFor(
      { kind: "result", result: { status: "success", outputs: { confirmationRef: "TXN-000001" }, evidenceRef: "e" } },
      { attempt: 1, maxAttempts: 3, irreversibleStarted: false },
    );
    expect(await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome })).toMatchObject({
      recorded: false,
      reason: "lease_lost",
    });
    const [a] = (await pool.query("SELECT * FROM job_attempts WHERE job_id = $1", [job.id])).rows;
    expect(a.outcome).toBe("lease_lost");
    expect(a.error).toMatch(/^lease lost before completion; .*NOT recorded on the job \[recovery had recorded: lease expired in running; recovered by w9 \(T6\.1 requeue\)\]$/);
  });
});
