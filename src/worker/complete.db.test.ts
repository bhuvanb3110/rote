// The fenced completion (docs/plans/step-06.md section 3) against real Postgres.
import type { Browser } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Capability } from "../artifact/index.js";
import { dequeue, enqueue, type Pool } from "../queue/index.js";
import { createTestSchema, resetQueueTables, type TestSchema } from "../queue/testDb.js";
import { completeJob, completeJobWithRetry } from "./complete.js";
import { jobOutcomeFor } from "../fleet/stateMachine.js";
import { writeCommitIntent } from "./intent.js";
import { recoverOne } from "./recover.js";
import { Worker, type JobDone } from "./loop.js";
import { InMemoryCounters } from "./metrics.js";

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

  it("a requeue with a backoff (D49): not_before = now() + the seconds, by the DATABASE clock; no dequeue before it; then attempt 2 with not_before cleared", async () => {
    const job = await leasedJob();
    const outcome = jobOutcomeFor({ kind: "result", result: failure }, { attempt: 1, maxAttempts: 3, irreversibleStarted: false });
    expect(await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome, requeueAfterSeconds: 10.5 })).toEqual({ recorded: true });
    const { rows } = await pool.query("SELECT state, EXTRACT(EPOCH FROM not_before - now())::float8 AS secs FROM jobs WHERE id = $1", [job.id]);
    expect(rows[0].state).toBe("queued");
    expect(rows[0].secs).toBeGreaterThan(9.5);
    expect(rows[0].secs).toBeLessThanOrEqual(10.5);
    expect(await dequeue(pool, { workerId: "w2", leaseSeconds: 300 })).toBeNull();
    await pool.query("UPDATE jobs SET not_before = now() - interval '1 millisecond' WHERE id = $1", [job.id]); // the backoff has passed
    expect(await dequeue(pool, { workerId: "w2", leaseSeconds: 300 })).toMatchObject({ id: job.id, attempt: 2, not_before: null });
  });

  it("a backoff is only ever a requeue's: every other target leaves not_before NULL, even if one is passed", async () => {
    for (const result of [success, { ...failure }] as const) {
      const job = await leasedJob(1); // max 1 attempt: the failure is final (failed), not a requeue
      const outcome = jobOutcomeFor({ kind: "result", result }, { attempt: 1, maxAttempts: 1, irreversibleStarted: false });
      expect(outcome.state).not.toBe("queued");
      expect(await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome, requeueAfterSeconds: 30 })).toEqual({ recorded: true });
      expect(await row(job.id)).toMatchObject({ state: outcome.state, not_before: null });
    }
  });

  it("stale completion: the fencing token moved under the worker -> 0 rows on jobs, attempt marked lease_lost", async () => {
    const job = await leasedJob();
    // Stand-in for Day-2 recovery having re-leased the job to someone else.
    await pool.query("UPDATE jobs SET fencing_token = fencing_token + 1, lease_owner = 'w-new' WHERE id = $1", [job.id]);
    const before = await row(job.id);
    const outcome = jobOutcomeFor({ kind: "result", result: success }, { attempt: 1, maxAttempts: 3, irreversibleStarted: false });
    expect(await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome })).toMatchObject({
      recorded: false,
      reason: "lease_lost",
    });
    expect(await row(job.id)).toEqual(before);
    const [a] = await attempts(job.id);
    expect(a.outcome).toBe("lease_lost");
    expect(a.error).toMatch(/NOT recorded on the job/);
  });

  it("a different lease_owner with the SAME token is refused too, and is a bug (token unchanged): illegal_transition, job untouched", async () => {
    const job = await leasedJob();
    const before = await row(job.id);
    const outcome = jobOutcomeFor({ kind: "result", result: success }, { attempt: 1, maxAttempts: 3, irreversibleStarted: false });
    expect(await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "someone-else", outcome })).toMatchObject({
      recorded: false,
      reason: "illegal_transition",
    });
    expect(await row(job.id)).toEqual(before);
  });

  it("D41: a forbidden transition with the token UNCHANGED (requeue past the commit intent) -> illegal_transition: attempt says so, job untouched, recovery takes it after expiry", async () => {
    const job = await leasedJob();
    await writeCommitIntent(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", leaseSeconds: 300 });
    const before = await row(job.id);
    expect(before.state).toBe("committing");
    // A buggy caller asks for a requeue after the intent; completionAllowed (in T4's SQL) refuses it.
    const requeue = jobOutcomeFor({ kind: "result", result: failure }, { attempt: 1, maxAttempts: 3, irreversibleStarted: false });
    expect(requeue.state).toBe("queued");
    const res = await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome: requeue });
    expect(res).toMatchObject({ recorded: false, reason: "illegal_transition" });
    expect(res.recorded === false && res.detail).toMatch(/token 1 is unchanged .*committing with token 1, owner w1/);
    expect(await row(job.id)).toEqual(before); // untouched: still committing, lease and owner kept
    const [a] = await attempts(job.id);
    expect(a).toMatchObject({ outcome: "illegal_transition" });
    expect(a.ended_at).toBeInstanceOf(Date);
    expect(a.error).toMatch(/^illegal_transition: T4 refused queued\/requeue/);
    // Its lease expires and recovery handles it (the next transition bumps the token).
    await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job.id]);
    const recovered = await recoverOne(pool, { workerId: "w2", leaseSeconds: 300 });
    // Step 9: an expired commit is claimed to verify (T6.4), never parked.
    expect(recovered).toMatchObject({ jobId: job.id, from: "committing", previousToken: 1, fencingToken: 2, action: { label: "T6.4" } });
    // The attempt row keeps the bug's label (recovery closes only open attempt rows).
    expect((await attempts(job.id))[0].outcome).toBe("illegal_transition");
  });

  it("a second completion of the same lease (token unchanged, owner already cleared) is illegal_transition and keeps the first record", async () => {
    const job = await leasedJob();
    const outcome = jobOutcomeFor({ kind: "result", result: success }, { attempt: 1, maxAttempts: 3, irreversibleStarted: false });
    expect(await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome })).toEqual({ recorded: true });
    const after = await row(job.id);
    expect(await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome })).toMatchObject({
      recorded: false,
      reason: "illegal_transition",
    });
    expect(await row(job.id)).toEqual(after);
    expect((await attempts(job.id))[0]).toMatchObject({ outcome: "success" });
  });

  it("D41 in a running worker: a runJob bug that hides its commit intent -> the worker logs illegal_transition at error level and counts it; nothing recorded", async () => {
    await enqueue(pool, { capability: CAP, tenantId: "tenant-a", idempotencyKey: `k-${Math.random()}`, params: { memberId: "1" } });
    const errors: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const metrics = new InMemoryCounters();
    const done: JobDone[] = [];
    const worker = new Worker({
      pool,
      workerId: "w-buggy",
      leaseSeconds: 300,
      getBrowser: async () => ({}) as Browser,
      redact: (s) => s,
      metrics,
      log: { info() {}, warn() {}, error: (obj, msg) => errors.push({ obj, msg }) },
      onJobDone: (d) => done.push(d),
      // The bug: writes the intent (committing), then reports a plain failure with irreversibleStarted
      // false, so jobOutcomeFor asks for a requeue that completionAllowed forbids.
      runJob: async (_job, options) => {
        await options.commitIntent!();
        return { end: { kind: "result", result: failure }, irreversibleStarted: false };
      },
    });
    expect(await worker.tick()).toBe("ran");
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ recorded: false, fencedOut: "illegal_transition" });
    expect(metrics.get("illegal_transitions_total")).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.msg).toMatch(/illegal_transition/);
    expect(errors[0]!.obj).toMatchObject({ illegal_transition: true, state: "queued" });
    const [j] = (await pool.query("SELECT state, lease_owner FROM jobs")).rows;
    expect(j).toEqual({ state: "committing", lease_owner: "w-buggy" });
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

  it("Step 9: a commit_uncertain outcome is T5's (into verify), never T4's: completeJob refuses it before touching the database", async () => {
    const job = await leasedJob();
    const cu = { ...failure, commitUncertain: { irreversibleStepId: "step-11", detail: "write-then-error" } };
    const outcome = jobOutcomeFor({ kind: "result", result: cu }, { attempt: 1, maxAttempts: 3, irreversibleStarted: true });
    expect(outcome.state).toBe("verifying");
    await expect(completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome })).rejects.toThrow(/never writes verifying/);
    expect(await row(job.id)).toMatchObject({ state: "running", lease_owner: "w1" });
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
