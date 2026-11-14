// Worker fault handling (step-06 section 8): a failure before Submit is retried -- after a backoff
// (Step 10, D49), so the brief's 30 s bank outage fails no job --, a write-then-error is verified in the
// bank's history and never retried blindly (Step 9; Steps 6-8 parked it), graceful shutdown finishes or
// aborts the in-flight job, and a Postgres blip never kills the worker.
import net from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool } from "../queue/index.js";
import { testDatabaseUrl } from "../queue/testDb.js";
import { createWorkerTestEnv, type WorkerTestEnv } from "./testEnv.js";

let env: WorkerTestEnv;

beforeAll(async () => {
  env = await createWorkerTestEnv("worker_faults");
}, 60_000);
afterAll(async () => {
  await env?.close();
});
beforeEach(async () => {
  await env.reset();
});

async function attempts(jobId: string) {
  return (await env.pool.query("SELECT * FROM job_attempts WHERE job_id = $1 ORDER BY attempt", [jobId])).rows;
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number, what: string) {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("worker faults", () => {
  it("failure BEFORE Submit (bank errors/on) -> requeued with a backoff (not_before 8-12 s out, D49), not dequeued before it; attempt 2 succeeds; exactly 1 row", async () => {
    const [job] = await env.enqueueTransfers(1);
    const worker = env.newWorker();
    await env.control("errors/on");
    expect(await worker.tick()).toBe("ran");
    const [afterFirst] = await env.jobs();
    expect(afterFirst).toMatchObject({ state: "queued", attempt: 1, lease_owner: null, outcome: null });
    expect(afterFirst!.error).toMatch(/attempt 1\/3 \(retrying\)/);
    const backoff = (await env.pool.query("SELECT EXTRACT(EPOCH FROM not_before - now())::float8 AS s FROM jobs WHERE id = $1", [job!.id])).rows[0].s;
    expect(backoff).toBeGreaterThan(6); // 10 s x [0.8, 1.2), minus the time since T4
    expect(backoff).toBeLessThan(12);
    expect(await env.ledger()).toHaveLength(0);

    await env.control("errors/off");
    expect(await worker.tick()).toBe("idle"); // held back by its not_before
    await env.pool.query("UPDATE jobs SET not_before = now() WHERE id = $1", [job!.id]); // the backoff has passed
    expect(await worker.tick()).toBe("ran");
    const [afterSecond] = await env.jobs();
    expect(afterSecond).toMatchObject({ id: job!.id, state: "succeeded", attempt: 2 });
    expect((await attempts(job!.id)).map((a) => a.outcome)).toEqual(["failure", "success"]);
    expect(await env.ledger()).toHaveLength(1);
  }, 60_000);

  it("Step 10 (D49): the brief's 30 s bank outage (errors/on) starting with attempt 1 -> attempts back off (about +10 s, +40 s) and the job is not failed: the outage ends, the next attempt succeeds; exactly 1 row", async () => {
    const [job] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
    const worker = env.newWorker();
    const log: Array<{ t: number; state: string; attempt: number }> = [];
    await env.control("errors/on");
    const outageStart = Date.now();
    const running = worker.run();
    const restore = setTimeout(() => void env.control("errors/off"), 30_000);
    try {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const [row] = await env.jobs();
        const last = log.at(-1);
        if (!last || last.state !== row!.state || last.attempt !== row!.attempt) log.push({ t: Date.now() - outageStart, state: row!.state, attempt: row!.attempt });
        if (["succeeded", "failed", "needs_human", "business_outcome"].includes(row!.state)) break;
        if (Date.now() > deadline) throw new Error(`not terminal after 120 s: ${JSON.stringify(log)}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } finally {
      clearTimeout(restore);
      await env.control("errors/off");
      worker.stop();
      await running;
    }
    const [final] = await env.jobs();
    const outcomes = (await attempts(job!.id)).map((a) => a.outcome);
    expect(final, JSON.stringify(log)).toMatchObject({ id: job!.id, state: "succeeded", outcome: "success" });
    // Each failed attempt was inside the outage; the last one, after it.
    expect(outcomes.slice(0, -1).every((o) => o === "failure"), JSON.stringify(outcomes)).toBe(true);
    expect(outcomes.at(-1)).toBe("success");
    expect(final!.attempt).toBeLessThanOrEqual(3);
    const starts = (await env.pool.query<{ s: number }>("SELECT EXTRACT(EPOCH FROM started_at)::float8 * 1000 AS s FROM job_attempts WHERE job_id = $1 ORDER BY attempt", [job!.id])).rows.map((r) => r.s);
    for (let i = 1; i < starts.length; i += 1) expect(starts[i]! - starts[i - 1]!, `attempt ${i + 1} came ${starts[i]! - starts[i - 1]!} ms after attempt ${i}`).toBeGreaterThanOrEqual(8_000);
    expect(starts.at(-1)! - outageStart).toBeGreaterThanOrEqual(30_000); // the successful attempt began after the outage
    expect(await env.ledger()).toHaveLength(1);
  }, 180_000);

  it("Step 9: errors/after-write (bank commits, then errors) -> commit uncertain -> verify (T5) [1] -> succeeded / already_done on attempt 1; confirmationRef = the row's id; exactly 1 row; never retried", async () => {
    const [job] = await env.enqueueTransfers(1);
    const worker = env.newWorker();
    await env.control("errors/after-write");
    expect(await worker.tick()).toBe("ran"); // the run, T5, and the verify, in one tick
    await env.control("errors/off");
    expect(await worker.tick()).toBe("idle"); // nothing to retry

    const [row] = await env.jobs();
    const ledger = await env.ledger();
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.memo).toBe(job!.memo_key);
    expect(row).toMatchObject({ id: job!.id, state: "succeeded", outcome: "already_done", attempt: 1 });
    expect(row!.result).toMatchObject({ status: "success", outputs: { confirmationRef: ledger[0]!.id }, recoveredBy: "verify" });
    expect((await attempts(job!.id))[0]).toMatchObject({ outcome: "failure", commit_uncertain: true });
    const phases = (await env.pool.query("SELECT reason, prior_status, decision, lookups FROM job_verifications WHERE job_id = $1", [job!.id])).rows;
    expect(phases).toEqual([{ reason: "commit_uncertain", prior_status: "failure", decision: "already_done", lookups: [1] }]);
  }, 60_000);

  it("graceful stop during a slow job: the job finishes and is recorded", async () => {
    const [job] = await env.enqueueTransfers(1);
    await env.control("latency/400");
    const worker = env.newWorker({ shutdownGraceMs: 60_000 });
    const running = worker.run();
    await waitFor(async () => (await env.jobs())[0]!.state === "running", 10_000, "job running");
    worker.stop();
    await running;
    const [row] = await env.jobs();
    expect(row).toMatchObject({ id: job!.id, state: "succeeded", attempt: 1 });
    expect(await env.ledger()).toHaveLength(1);
  }, 90_000);

  it("graceful stop with a tiny grace: aborted before Submit -> requeued (attempt counted, 'aborted'), 0 rows", async () => {
    const [job] = await env.enqueueTransfers(1);
    await env.control("latency/1500");
    const worker = env.newWorker({ shutdownGraceMs: 300 });
    const running = worker.run();
    await waitFor(async () => (await env.jobs())[0]!.state === "running", 10_000, "job running");
    worker.stop();
    await running;
    const [row] = await env.jobs();
    expect(row).toMatchObject({ id: job!.id, state: "queued", attempt: 1, lease_owner: null });
    expect(row!.error).toMatch(/aborted before anything irreversible/);
    expect((await attempts(job!.id))[0]).toMatchObject({ outcome: "aborted", commit_uncertain: false });
    expect(await env.ledger()).toHaveLength(0);
    expect(env.browser.contexts()).toHaveLength(0); // replay closed its context on abort
  }, 60_000);

  it("Postgres blip: with the connection cut the worker backs off without exiting; restored, the queued job completes", async () => {
    // An in-process TCP proxy in front of Postgres that the test can cut. Never stops the shared
    // Compose Postgres, which other test files are using.
    const target = new URL(testDatabaseUrl());
    let cut = false;
    const open = new Set<net.Socket>();
    const proxy = net.createServer((client) => {
      if (cut) {
        client.destroy();
        return;
      }
      const upstream = net.connect(Number(target.port || 5432), target.hostname);
      open.add(client);
      open.add(upstream);
      const done = () => {
        client.destroy();
        upstream.destroy();
        open.delete(client);
        open.delete(upstream);
      };
      client.on("error", done).on("close", done);
      upstream.on("error", done).on("close", done);
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const proxied = new URL(testDatabaseUrl());
    proxied.hostname = "127.0.0.1";
    proxied.port = String((proxy.address() as net.AddressInfo).port);
    const workerPool = createPool({ connectionString: proxied.toString(), searchPath: env.db.schema, max: 2, connectionTimeoutMillis: 1000 });

    const warnings: string[] = [];
    const worker = env.newWorker({
      pool: workerPool,
      log: { info() {}, error() {}, warn: (_o, msg) => warnings.push(msg) },
    });
    try {
      cut = true;
      const [job] = await env.enqueueTransfers(1); // through the direct pool
      let settled = false;
      const running = worker.run().finally(() => {
        settled = true;
      });
      await waitFor(async () => warnings.length >= 2, 15_000, "two transient-error backoffs");
      expect(settled).toBe(false); // still looping, not exited
      expect((await env.jobs())[0]!.state).toBe("queued");
      expect(warnings.every((w) => /Postgres unavailable/.test(w))).toBe(true);

      cut = false;
      await env.waitForTerminal([job!.id], 60_000);
      expect((await env.jobs())[0]).toMatchObject({ state: "succeeded", attempt: 1 });
      worker.stop();
      await running;
      expect(await env.ledger()).toHaveLength(1);
    } finally {
      worker.stop();
      for (const s of open) s.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await workerPool.end().catch(() => undefined);
    }
  }, 90_000);
});
