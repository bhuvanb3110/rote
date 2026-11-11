// The worker loop's own crash points (D34) against real Postgres, with a fake runJob (no browser):
// after-dequeue fires before runJob, before-complete after the outcome is computed but before the
// completion transaction, after-complete once it committed. The injected "kill" throws a sentinel so
// the test can see exactly what state the job was left in at that instant.
import type { Browser } from "playwright";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Capability } from "../artifact/index.js";
import { enqueue, type Pool } from "../queue/index.js";
import { createTestSchema, resetQueueTables, type TestSchema } from "../queue/testDb.js";
import { createFaultInjector } from "./fault.js";
import { Worker } from "./loop.js";
import type { RunJobResult } from "./runJob.js";

const CAP = {
  id: "cap",
  inputs: [{ name: "memberId", type: "string", required: true, redact: false, description: "m" }],
  steps: [],
} as unknown as Pick<Capability, "id" | "inputs" | "steps">;

class FaultFired extends Error {
  constructor(readonly point: string) {
    super(`fault ${point}`);
  }
}

let db: TestSchema;
let pool: Pool;

beforeAll(async () => {
  db = await createTestSchema("fault_points");
  pool = db.pool;
});
afterAll(async () => {
  await db?.drop();
});
beforeEach(async () => {
  await resetQueueTables(pool);
});

async function runWithFault(point: string) {
  const { job } = await enqueue(pool, { capability: CAP, tenantId: "tenant-a", idempotencyKey: `k-${point}`, params: { memberId: "1" } });
  let runJobCalls = 0;
  const worker = new Worker({
    pool,
    workerId: `w-${point}`,
    leaseSeconds: 300,
    getBrowser: async () => ({}) as Browser,
    redact: (s) => s,
    fault: createFaultInjector(point, {
      write: () => undefined,
      kill: () => {
        throw new FaultFired(point);
      },
    }),
    runJob: async (): Promise<RunJobResult> => {
      runJobCalls += 1;
      return { end: { kind: "result", result: { status: "success", outputs: { confirmationRef: "TXN-1" }, evidenceRef: "e" } }, irreversibleStarted: false };
    },
  });
  const error = await worker.tick().then(() => null, (err: unknown) => err);
  const row = (await pool.query("SELECT state, attempt, lease_owner FROM jobs WHERE id = $1", [job.id])).rows[0];
  return { error, row, runJobCalls };
}

describe("worker loop crash points", () => {
  it("after-dequeue: leased (running, attempt 1), runJob never called", async () => {
    const r = await runWithFault("after-dequeue");
    expect(r.error).toBeInstanceOf(FaultFired);
    expect(r.runJobCalls).toBe(0);
    expect(r.row).toMatchObject({ state: "running", attempt: 1, lease_owner: "w-after-dequeue" });
  });

  it("before-complete: the run finished but nothing was recorded (still running)", async () => {
    const r = await runWithFault("before-complete");
    expect(r.error).toBeInstanceOf(FaultFired);
    expect(r.runJobCalls).toBe(1);
    expect(r.row).toMatchObject({ state: "running", attempt: 1 });
  });

  it("after-complete: the completion committed (succeeded) before the kill", async () => {
    const r = await runWithFault("after-complete");
    expect(r.error).toBeInstanceOf(FaultFired);
    expect(r.row).toMatchObject({ state: "succeeded", lease_owner: null });
  });

  it("no fault: the same tick completes normally", async () => {
    const { job } = await enqueue(pool, { capability: CAP, tenantId: "tenant-a", idempotencyKey: "k-none", params: { memberId: "1" } });
    const worker = new Worker({
      pool,
      workerId: "w-none",
      leaseSeconds: 300,
      getBrowser: async () => ({}) as Browser,
      redact: (s) => s,
      runJob: async () => ({ end: { kind: "result", result: { status: "success", outputs: {}, evidenceRef: "e" } }, irreversibleStarted: false }),
    });
    expect(await worker.tick()).toBe("ran");
    expect((await pool.query("SELECT state FROM jobs WHERE id = $1", [job.id])).rows[0].state).toBe("succeeded");
  });
});
