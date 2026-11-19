// The worker end to end, in process: Postgres + the mock bank + one shared Chromium (step-06
// section 8, "Integration"). Every row count reads the bank's /control/ledger.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { approveCapability, approvalKey } from "../confidence/index.js";
import { enqueue } from "../queue/index.js";
import type { JobDone } from "./loop.js";
import { CREDENTIAL_VALUES, createWorkerTestEnv, dumpQueue, type WorkerTestEnv } from "./testEnv.js";
import { mkdir } from "node:fs/promises";
import path from "node:path";

let env: WorkerTestEnv;

beforeAll(async () => {
  env = await createWorkerTestEnv("worker_run");
}, 60_000);
afterAll(async () => {
  await env?.close();
});
beforeEach(async () => {
  await env.reset();
});

async function drain(worker: ReturnType<WorkerTestEnv["newWorker"]>, ids: string[], timeoutMs = 120_000) {
  const running = worker.run();
  try {
    return await env.waitForTerminal(ids, timeoutMs);
  } finally {
    worker.stop();
    await running;
  }
}

describe("worker: runs jobs through invokeCapability and records them", () => {
  it("6 jobs (2 per tenant), one worker -> all succeeded; ledger memos are exactly the memo_keys; confirmationRef = row id", async () => {
    const jobs = await env.enqueueTransfers(6);
    const done = await drain(env.newWorker(), jobs.map((j) => j.id));
    expect(done.every((j) => j.state === "succeeded" && j.outcome === "success" && j.attempt === 1)).toBe(true);

    const ledger = await env.ledger();
    expect(ledger).toHaveLength(6);
    expect(ledger.map((r) => r.memo).sort()).toEqual(jobs.map((j) => j.memo_key).sort());
    for (const job of done) {
      const row = ledger.find((r) => r.memo === job.memo_key)!;
      expect(row.tenantId).toBe(job.tenant_id);
      expect((job.result as { outputs: { confirmationRef: string } }).outputs.confirmationRef).toBe(row.id);
    }
    // Credentials are injected, never stored: not in params, result, error or any attempt row.
    const dump = await dumpQueue(env.pool);
    for (const value of CREDENTIAL_VALUES) expect(dump).not.toContain(value);
  }, 180_000);

  it("two workers, 12 jobs -> each run once (attempt 1), both workers used, per-tenant cap never exceeded", async () => {
    const jobs = await env.enqueueTransfers(12);
    let maxActive = 0;
    let sampling = true;
    const sampler = (async () => {
      while (sampling) {
        const { rows } = await env.pool.query<{ n: number }>(
          "SELECT coalesce(max(n), 0)::int AS n FROM (SELECT count(*) AS n FROM jobs WHERE state IN ('running','committing','verifying') GROUP BY tenant_id) t",
        );
        maxActive = Math.max(maxActive, rows[0]!.n);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    })();
    const a = env.newWorker();
    const b = env.newWorker();
    const runs = [a.run(), b.run()];
    try {
      const done = await env.waitForTerminal(jobs.map((j) => j.id), 180_000);
      expect(done.every((j) => j.state === "succeeded" && j.attempt === 1)).toBe(true);
    } finally {
      a.stop();
      b.stop();
      await Promise.all(runs);
      sampling = false;
      await sampler;
    }
    const attempts = (await env.pool.query("SELECT job_id, worker_id FROM job_attempts")).rows;
    expect(attempts).toHaveLength(12);
    expect(new Set(attempts.map((r) => r.job_id)).size).toBe(12);
    expect(new Set(attempts.map((r) => r.worker_id)).size).toBe(2);
    expect(maxActive).toBeLessThanOrEqual(2);
    const ledger = await env.ledger();
    expect(ledger).toHaveLength(12);
    expect(new Set(ledger.map((r) => r.memo)).size).toBe(12);
  }, 240_000);

  it("business outcome (unknown toMemberId) -> business_outcome on attempt 1, never retried, 0 rows", async () => {
    const [job] = await env.enqueueTransfers(1, { toMemberId: "99999" });
    const worker = env.newWorker();
    expect(await worker.tick()).toBe("ran");
    expect(await worker.tick()).toBe("idle");
    const [row] = await env.jobs();
    expect(row).toMatchObject({ id: job!.id, state: "business_outcome", outcome: "business_outcome", attempt: 1 });
    expect(row!.error).toMatch(/NO_SUCH_RECIPIENT/);
    expect(await env.ledger()).toHaveLength(0);
  }, 60_000);

  it("stale approval (approved for another version) -> needs_human at run time, 0 rows, nothing typed", async () => {
    const staleDir = path.join(env.workDir, "status-stale");
    await mkdir(staleDir, { recursive: true });
    await approveCapability("transfer", { ...approvalKey({ ...env.transfer, version: "9.9.9" }), statusDir: staleDir, reason: "stale" });
    await env.enqueueTransfers(1);
    const done: JobDone[] = [];
    const worker = env.newWorker({ ctx: { statusDir: staleDir }, onJobDone: (d) => done.push(d) });
    expect(await worker.tick()).toBe("ran");
    const [row] = await env.jobs();
    expect(row).toMatchObject({ state: "needs_human", outcome: "needs_human", attempt: 1 });
    expect(row!.error).toContain("approved for 9.9.9, artifact is 1.1.0; re-approve");
    expect(await env.ledger()).toHaveLength(0);
  }, 60_000);

  it("unknown capability -> failed / invalid_job at once, without retries", async () => {
    await enqueue(env.pool, {
      capability: { id: "ghost", inputs: [], steps: [] },
      tenantId: "tenant-a",
      idempotencyKey: "ghost-1",
      params: {},
    });
    const worker = env.newWorker();
    expect(await worker.tick()).toBe("ran");
    expect(await worker.tick()).toBe("idle");
    const [row] = await env.jobs();
    expect(row).toMatchObject({ state: "failed", outcome: "invalid_job", attempt: 1 });
    expect(row!.error).toContain('No capability with id "ghost"');
  }, 30_000);
});
