// The fenced completion (docs/plans/step-06.md section 3) against real Postgres.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Capability } from "../artifact/index.js";
import { dequeue, enqueue, type Pool } from "../queue/index.js";
import { createTestSchema, resetQueueTables, type TestSchema } from "../queue/testDb.js";
import { completeJob, completeJobWithRetry } from "./complete.js";
import { jobOutcomeFor } from "../fleet/stateMachine.js";

const CAP = {
  id: "cap",
  inputs: [{ name: "memberId", type: "string", required: true, redact: false, description: "m" }],
  steps: [],
} as unknown as Pick<Capability, "id" | "inputs" | "steps">;

let db: TestSchema;
let pool: Pool;

beforeAll(async () => {
  db = await createTestSchema("worker_complete");
  pool = db.pool;
});
afterAll(async () => {
  await db?.drop();
});
beforeEach(async () => {
  await resetQueueTables(pool);
});

async function leasedJob(maxAttempts = 3) {
  await enqueue(pool, { capability: CAP, tenantId: "tenant-a", idempotencyKey: `k-${Math.random()}`, params: { memberId: "1" }, maxAttempts });
  const job = await dequeue(pool, { workerId: "w1", leaseSeconds: 300 });
  if (!job) throw new Error("no job");
  return job;
}

const success = { status: "success" as const, outputs: { confirmationRef: "TXN-000001" }, evidenceRef: "evidence://x" };
const failure = { status: "failure" as const, atStepId: "s", expected: "e", observed: "o", category: "unexpected-state" as const, evidenceRef: "e" };

async function row(id: string) {
  return (await pool.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0];
}
async function attempts(id: string) {
  return (await pool.query("SELECT * FROM job_attempts WHERE job_id = $1 ORDER BY attempt", [id])).rows;
}

describe("completeJob (fenced)", () => {
  it("records a terminal state, clears the lease, ends the attempt", async () => {
    const job = await leasedJob();
    const outcome = jobOutcomeFor({ kind: "result", result: success }, { attempt: 1, maxAttempts: 3, irreversibleStarted: false });
    expect(await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome })).toEqual({ recorded: true });
    const r = await row(job.id);
    expect(r).toMatchObject({ state: "succeeded", outcome: "success", error: null, lease_owner: null, lease_expires_at: null });
    expect(r.result).toEqual(success);
    const [a] = await attempts(job.id);
    expect(a).toMatchObject({ outcome: "success", commit_uncertain: false });
    expect(a.ended_at).toBeInstanceOf(Date);
  });

  it("a requeue puts the job back to queued with its lease cleared; the next dequeue is attempt 2, token 2", async () => {
    const job = await leasedJob();
    const outcome = jobOutcomeFor({ kind: "result", result: failure }, { attempt: 1, maxAttempts: 3, irreversibleStarted: false });
    await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome });
    expect(await row(job.id)).toMatchObject({ state: "queued", outcome: null, lease_owner: null });
    const again = await dequeue(pool, { workerId: "w2", leaseSeconds: 300 });
    expect(again).toMatchObject({ id: job.id, attempt: 2, fencing_token: 2, lease_owner: "w2" });
  });

  it("stale completion: the fencing token moved under the worker -> 0 rows on jobs, attempt marked lease_lost", async () => {
    const job = await leasedJob();
    // Stand-in for Day-2 recovery having re-leased the job to someone else.
    await pool.query("UPDATE jobs SET fencing_token = fencing_token + 1, lease_owner = 'w-new' WHERE id = $1", [job.id]);
    const before = await row(job.id);
    const outcome = jobOutcomeFor({ kind: "result", result: success }, { attempt: 1, maxAttempts: 3, irreversibleStarted: false });
    expect(await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome })).toEqual({ recorded: false });
    expect(await row(job.id)).toEqual(before);
    const [a] = await attempts(job.id);
    expect(a.outcome).toBe("lease_lost");
    expect(a.error).toMatch(/NOT recorded on the job/);
  });

  it("a different lease_owner with the same token is also refused", async () => {
    const job = await leasedJob();
    const outcome = jobOutcomeFor({ kind: "result", result: success }, { attempt: 1, maxAttempts: 3, irreversibleStarted: false });
    expect(await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "someone-else", outcome })).toEqual({ recorded: false });
    expect((await row(job.id)).state).toBe("running");
  });

  it("the schema refuses a requeue once attempts are exhausted (jobs_queued_has_attempts_left)", async () => {
    const job = await leasedJob(1);
    const bogus = { ...jobOutcomeFor({ kind: "result", result: failure }, { attempt: 1, maxAttempts: 3, irreversibleStarted: false }) };
    expect(bogus.state).toBe("queued"); // computed with the wrong maxAttempts on purpose
    await expect(completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome: bogus })).rejects.toMatchObject({
      code: "23514",
    });
    expect((await row(job.id)).state).toBe("running"); // rolled back whole
    expect((await attempts(job.id))[0].ended_at).toBeNull();
  });

  it("commit_uncertain is recorded on the job and the attempt", async () => {
    const job = await leasedJob();
    const cu = { ...failure, commitUncertain: { irreversibleStepId: "step-11", detail: "write-then-error" } };
    const outcome = jobOutcomeFor({ kind: "result", result: cu }, { attempt: 1, maxAttempts: 3, irreversibleStarted: true });
    await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome });
    expect(await row(job.id)).toMatchObject({ state: "needs_human", outcome: "commit_uncertain" });
    expect((await attempts(job.id))[0]).toMatchObject({ outcome: "failure", commit_uncertain: true });
  });
});

describe("completeJobWithRetry", () => {
  it("retries transient errors, then records; a fatal error is rethrown at once", async () => {
    const job = await leasedJob();
    const outcome = jobOutcomeFor({ kind: "result", result: success }, { attempt: 1, maxAttempts: 3, irreversibleStarted: false });
    let calls = 0;
    const flaky = {
      connect: async () => {
        calls += 1;
        if (calls <= 2) throw Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:1"), { code: "ECONNREFUSED" });
        return pool.connect();
      },
    } as unknown as Pool;
    const seen: number[] = [];
    const res = await completeJobWithRetry(flaky, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome }, {
      random: () => 0,
      onTransientError: (_e, n) => seen.push(n),
    });
    expect(res).toEqual({ recorded: true });
    expect(seen).toEqual([1, 2]);

    const fatal = { connect: async () => Promise.reject(Object.assign(new Error("syntax"), { code: "42601" })) } as unknown as Pool;
    await expect(completeJobWithRetry(fatal, { jobId: job.id, fencingToken: 1, workerId: "w1", outcome })).rejects.toThrow("syntax");
  });

  it("returns null without writing when the signal is already aborted", async () => {
    const job = await leasedJob();
    const outcome = jobOutcomeFor({ kind: "result", result: success }, { attempt: 1, maxAttempts: 3, irreversibleStarted: false });
    const ac = new AbortController();
    ac.abort();
    expect(await completeJobWithRetry(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome }, { signal: ac.signal })).toBeNull();
    expect((await row(job.id)).state).toBe("running");
  });
});
