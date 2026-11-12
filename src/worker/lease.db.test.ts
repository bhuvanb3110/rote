// Day 2 leases end to end (docs/plans/step-08.md section 8, integration): a real worker, the in-process
// mock bank, Chromium and Postgres. The heartbeat aborts a run whose job was taken away.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { JobDone } from "./loop.js";
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
