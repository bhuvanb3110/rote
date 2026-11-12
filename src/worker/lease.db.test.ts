// Day 2 leases end to end (docs/plans/step-08.md section 8, integration): a real worker, the in-process
// mock bank, Chromium and Postgres. The heartbeat aborts a run whose job was taken away; the fenced
// commit intent stops a Submit by a worker that no longer holds a live lease; the next worker's loop
// recovers a dead worker's job.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dequeue, type JobRow } from "../queue/index.js";
import { writeCommitIntent } from "./intent.js";
import type { JobDone } from "./loop.js";
import { runJob, type RunJobOptions } from "./runJob.js";
import { createWorkerTestEnv, type WorkerTestEnv } from "./testEnv.js";

let env: WorkerTestEnv;

beforeAll(async () => {
  env = await createWorkerTestEnv("worker_lease");
}, 60_000);
afterAll(async () => {
  await env?.close();
});
beforeEach(async () => {
  await env.reset();
});

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function attempts(jobId: string) {
  return (await env.pool.query("SELECT * FROM job_attempts WHERE job_id = $1 ORDER BY attempt", [jobId])).rows;
}

describe("the heartbeat (T2) in a running worker", () => {
  it("keeps a slow job's 5 s lease alive across a 1.5 s-per-request bank (a run far longer than the lease), then completes normally", async () => {
    const [job] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
    await env.control("latency/1500");
    const worker = env.newWorker({ leaseSeconds: 5, heartbeatSeconds: 2 });
    expect(await worker.tick()).toBe("ran");
    const [row] = await env.jobs();
    expect(row).toMatchObject({ id: job!.id, state: "succeeded", attempt: 1 });
    expect(await env.ledger()).toHaveLength(1);
  }, 90_000);

  it("token bumped under a running job (bank latency 3 s): the context closes within one beat; nothing recorded on jobs; 0 rows; attempt lease_lost", async () => {
    const [job] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
    await env.control("latency/3000");
    const done: JobDone[] = [];
    const worker = env.newWorker({ leaseSeconds: 5, heartbeatSeconds: 1, onJobDone: (d) => done.push(d) });
    const tick = worker.tick();
    await waitFor(async () => (await env.jobs())[0]!.state === "running", 20_000, "the job to be leased");
    // Stand-in for recovery: the job is taken away (token bumped) while the worker waits on the bank.
    await env.pool.query(
      "UPDATE jobs SET fencing_token = fencing_token + 1, state = 'needs_human', outcome = 'taken-by-test', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1",
      [job!.id],
    );
    const before = (await env.jobs())[0];
    const bumpedAt = Date.now();
    expect(await tick).toBe("ran");
    const abortMs = Date.now() - bumpedAt;
    expect(abortMs).toBeLessThan(1000 /* one beat */ + 3000 /* one in-flight page at 3 s latency, closed with the context */);

    expect(done).toHaveLength(1);
    expect(done[0]!.recorded).toBe(false);
    expect((await env.jobs())[0]).toEqual(before); // nothing written to jobs
    await env.control("latency/0");
    expect(await env.ledger()).toHaveLength(0);
    const [a] = await attempts(job!.id);
    expect(a).toMatchObject({ outcome: "lease_lost", commit_uncertain: false });
    expect(a.error).toMatch(/lease lost during the run \(heartbeat\); nothing recorded on the job\. lease lost: the heartbeat matched 0 rows/);
  }, 90_000);
});

describe("the fenced commit intent (T3) in a running worker", () => {
  /** A worker whose commit intent first runs `meddle` (the test's stand-in for a concurrent event). */
  const workerMeddlingBeforeIntent = (meddle: (job: JobRow) => Promise<void>, done: JobDone[]) =>
    env.newWorker({
      onJobDone: (d) => done.push(d),
      runJob: (job: JobRow, options: RunJobOptions) =>
        runJob(env.ctx, job, {
          ...options,
          commitIntent: async () => {
            await meddle(job);
            await options.commitIntent!();
          },
        }),
    });

  it("a normal run goes running -> committing -> succeeded; the attempt row records when its intent was written", async () => {
    const [job] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
    const seen: string[] = [];
    const done: JobDone[] = [];
    const worker = workerMeddlingBeforeIntent(async (j) => {
      seen.push((await env.pool.query("SELECT state FROM jobs WHERE id = $1", [j.id])).rows[0].state);
    }, done);
    expect(await worker.tick()).toBe("ran");
    expect(seen).toEqual(["running"]);
    const [row] = await env.jobs();
    expect(row).toMatchObject({ id: job!.id, state: "succeeded", attempt: 1 });
    expect(row!.commit_intent_at).toBeInstanceOf(Date);
    const [a] = await attempts(job!.id);
    expect(a.commit_intent_at).toEqual(row!.commit_intent_at);
    expect(await env.ledger()).toHaveLength(1);
  }, 60_000);

  it("token bumped right before Submit (recovered): FencingError, the Submit is NEVER clicked, 0 rows; the stale requeue is fenced too", async () => {
    const [job] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
    const done: JobDone[] = [];
    const worker = workerMeddlingBeforeIntent(async (j) => {
      await env.pool.query(
        "UPDATE jobs SET fencing_token = fencing_token + 1, state = 'needs_human', outcome = 'taken-by-test', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1",
        [j.id],
      );
    }, done);
    expect(await worker.tick()).toBe("ran");
    expect(done[0]!.recorded).toBe(false);
    expect(done[0]!.outcome.state).toBe("queued"); // no intent written: retry rule, but fenced out
    expect(await env.ledger()).toHaveLength(0);
    expect((await env.jobs())[0]).toMatchObject({ state: "needs_human", outcome: "taken-by-test", commit_intent_at: null });
    const [a] = await attempts(job!.id);
    expect(a).toMatchObject({ outcome: "lease_lost", commit_uncertain: false, commit_intent_at: null });
  }, 60_000);

  it("T3 fails with anything but a FencingError (COMMIT result unknown): no click, 0 rows, and the attempt is treated as 'may have committed' (needs_human, interim)", async () => {
    const [job] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
    const done: JobDone[] = [];
    const worker = workerMeddlingBeforeIntent(async () => {
      throw new Error("Connection terminated unexpectedly"); // what pg says when the link drops mid-COMMIT
    }, done);
    expect(await worker.tick()).toBe("ran");
    expect(done[0]!.recorded).toBe(true);
    expect((await env.jobs())[0]).toMatchObject({ id: job!.id, state: "needs_human", outcome: "commit_uncertain", attempt: 1 });
    expect(await env.ledger()).toHaveLength(0);
    expect(await worker.tick()).toBe("idle"); // never retried blindly
  }, 60_000);

  it("lease expired before Submit but nobody recovered it: T3 refuses (no click); the worker's own requeue is recorded; attempt 2 succeeds; exactly 1 row", async () => {
    const [job] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
    const done: JobDone[] = [];
    let first = true;
    const worker = workerMeddlingBeforeIntent(async (j) => {
      if (!first) return;
      first = false;
      await env.pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [j.id]);
    }, done);
    expect(await worker.tick()).toBe("ran");
    expect(done[0]!.recorded).toBe(true);
    expect((await env.jobs())[0]).toMatchObject({ state: "queued", attempt: 1, lease_owner: null });
    expect((await env.jobs())[0]!.error).toMatch(/FencingError: commit intent refused/);
    expect(await env.ledger()).toHaveLength(0);

    expect(await worker.tick()).toBe("ran");
    expect((await env.jobs())[0]).toMatchObject({ id: job!.id, state: "succeeded", attempt: 2 });
    expect((await attempts(job!.id)).map((a) => a.outcome)).toEqual(["failure", "success"]);
    expect(await env.ledger()).toHaveLength(1);
  }, 90_000);
});

describe("recovery (T6) in a running worker's loop", () => {
  it("a dead worker's expired `running` job is requeued by the next worker's loop (T6.1) and finished: attempt 2, exactly 1 row", async () => {
    const [job] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
    const dead = await dequeue(env.pool, { workerId: "dead-worker", leaseSeconds: 30 });
    expect(dead!.id).toBe(job!.id);
    await env.pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job!.id]);
    const worker = env.newWorker();
    expect(await worker.tick()).toBe("ran"); // recovery, then this same iteration's dequeue takes it
    const [row] = await env.jobs();
    expect(row).toMatchObject({ id: job!.id, state: "succeeded", attempt: 2, fencing_token: 3 });
    expect((await attempts(job!.id)).map((a) => [a.worker_id, a.outcome])).toEqual([
      ["dead-worker", "crashed"],
      [expect.stringMatching(/^test-worker-/), "success"],
    ]);
    expect(await env.ledger()).toHaveLength(1);
  }, 60_000);

  it("a dead worker's expired `committing` job is escalated (T6.3, Step 8 interim) and never re-run: needs_human, 0 rows, nothing to dequeue", async () => {
    const [job] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
    const dead = await dequeue(env.pool, { workerId: "dead-worker", leaseSeconds: 30 });
    await writeCommitIntent(env.pool, { jobId: dead!.id, fencingToken: dead!.fencing_token, workerId: "dead-worker", leaseSeconds: 30 });
    await env.pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job!.id]);
    const worker = env.newWorker();
    expect(await worker.tick()).toBe("idle");
    expect((await env.jobs())[0]).toMatchObject({ id: job!.id, state: "needs_human", outcome: "commit_uncertain", attempt: 1, fencing_token: 2 });
    expect(await env.ledger()).toHaveLength(0);
  }, 60_000);
});
