// T3 (the fenced commit intent) and T4 widened to `committing`, against real Postgres
// (docs/plans/step-08.md section 8, DB).
import net from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Capability } from "../artifact/index.js";
import { jobOutcomeFor } from "../fleet/stateMachine.js";
import { createPool, dequeue, enqueue, isTransientDbError, type JobRow, type Pool } from "../queue/index.js";
import { createTestSchema, resetQueueTables, testDatabaseUrl, type TestSchema } from "../queue/testDb.js";
import { completeJob } from "./complete.js";
import { COMMIT_INTENT_SQL, writeCommitIntent } from "./intent.js";
import { FencingError } from "./leaseErrors.js";

const CAP = {
  id: "cap",
  inputs: [{ name: "memberId", type: "string", required: true, redact: false, description: "m" }],
  steps: [],
} as unknown as Pick<Capability, "id" | "inputs" | "steps">;

let db: TestSchema;
let pool: Pool;

beforeAll(async () => {
  db = await createTestSchema("worker_intent");
  pool = db.pool;
});
afterAll(async () => {
  await db?.drop();
});
beforeEach(async () => {
  await resetQueueTables(pool);
});

async function leased(leaseSeconds = 30, maxAttempts = 3): Promise<JobRow> {
  await enqueue(pool, { capability: CAP, tenantId: "tenant-a", idempotencyKey: `k-${Math.random()}`, params: { memberId: "1" }, maxAttempts });
  const job = await dequeue(pool, { workerId: "w1", leaseSeconds });
  if (!job) throw new Error("no job");
  return job;
}

const row = async (id: string) => (await pool.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0];
const attempt = async (id: string) => (await pool.query("SELECT * FROM job_attempts WHERE job_id = $1 ORDER BY attempt DESC LIMIT 1", [id])).rows[0];
const args = (job: JobRow, over: Partial<{ fencingToken: number; workerId: string }> = {}) => ({
  jobId: job.id,
  fencingToken: job.fencing_token,
  workerId: "w1",
  leaseSeconds: 30,
  ...over,
});

describe("T3: the commit intent", () => {
  it("running -> committing, commit_intent_at set, a full lease on the database clock, the attempt stamped -- in one transaction", async () => {
    const job = await leased(3);
    const at = await writeCommitIntent(pool, args(job));
    expect(at).toBeInstanceOf(Date);
    const r = await row(job.id);
    expect(r).toMatchObject({ state: "committing", lease_owner: "w1", fencing_token: job.fencing_token });
    expect(r.commit_intent_at).toEqual(at);
    const left = (await pool.query("SELECT EXTRACT(EPOCH FROM (lease_expires_at - now()))::float8 AS s FROM jobs WHERE id = $1", [job.id])).rows[0].s;
    expect(left).toBeGreaterThan(28); // was a 3 s lease: T3 grants a full one for click + settle
    expect((await attempt(job.id)).commit_intent_at).toEqual(at);
    expect(COMMIT_INTENT_SQL).toMatch(/lease_expires_at > now\(\)/);
  });

  for (const [what, fence] of [
    ["the token was bumped (recovered)", "UPDATE jobs SET fencing_token = fencing_token + 1 WHERE id = $1"],
    ["the lease expired (database clock), even with nobody recovering", "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1"],
    ["another worker owns it", "UPDATE jobs SET lease_owner = 'w2' WHERE id = $1"],
    ["it is no longer running (already committing)", "UPDATE jobs SET state = 'committing', commit_intent_at = now() WHERE id = $1"],
  ] as const) {
    it(`fenced when ${what}: FencingError, nothing written (the job row and the attempt are unchanged)`, async () => {
      const job = await leased();
      await pool.query(fence, [job.id]);
      const before = await row(job.id);
      const err = await writeCommitIntent(pool, args(job)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(FencingError);
      expect((err as FencingError).details).toEqual({ jobId: job.id, fencingToken: job.fencing_token, workerId: "w1" });
      expect((err as Error).message).toMatch(/the Submit was NOT clicked/);
      expect(await row(job.id)).toEqual(before);
      expect((await attempt(job.id)).commit_intent_at).toBeNull();
    });
  }

  it("Postgres unreachable (test TCP proxy cut): throws a transient error, NOT a FencingError -- the hook throws, so no click", async () => {
    const job = await leased();
    let cut = false;
    const open = new Set<net.Socket>();
    const target = new URL(testDatabaseUrl());
    const proxy = net.createServer((client) => {
      client.on("error", () => undefined); // a reset can arrive before destroy(); it is the point of the test
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
    const cutPool = createPool({ connectionString: proxied.toString(), searchPath: db.schema, max: 1, connectionTimeoutMillis: 1000 });
    try {
      cut = true; // Postgres unreachable for this worker (the same cut as faults.db.test.ts)
      const err = await writeCommitIntent(cutPool, args(job)).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(FencingError);
      expect(isTransientDbError(err)).toBe(true);
      expect((await row(job.id)).state).toBe("running"); // the intent did not land
    } finally {
      for (const s of open) s.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
      await cutPool.end().catch(() => undefined);
    }
  });
});

describe("T4 widened: completion from committing", () => {
  const success = { status: "success" as const, outputs: { confirmationRef: "TXN-000001" }, evidenceRef: "e" };
  const cuFailure = {
    status: "failure" as const,
    atStepId: "step-12",
    expected: "x",
    observed: "y",
    category: "unknown" as const,
    evidenceRef: "e",
    commitUncertain: { irreversibleStepId: "step-11", detail: "threw after the click" },
  };

  it("the live holder records succeeded from committing", async () => {
    const job = await leased();
    await writeCommitIntent(pool, args(job));
    const outcome = jobOutcomeFor({ kind: "result", result: success }, { attempt: 1, maxAttempts: 3, irreversibleStarted: true });
    expect(await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome })).toEqual({ recorded: true });
    expect(await row(job.id)).toMatchObject({ state: "succeeded", lease_owner: null, lease_expires_at: null });
  });

  it("the live holder records needs_human / commit_uncertain from committing", async () => {
    const job = await leased();
    await writeCommitIntent(pool, args(job));
    const outcome = jobOutcomeFor({ kind: "result", result: cuFailure }, { attempt: 1, maxAttempts: 3, irreversibleStarted: true });
    expect(await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome })).toEqual({ recorded: true });
    expect(await row(job.id)).toMatchObject({ state: "needs_human", outcome: "commit_uncertain" });
    expect((await attempt(job.id)).commit_uncertain).toBe(true);
  });

  it("a requeue or failed is NEVER written past the intent, even by the live holder (completionAllowed in SQL): 0 rows", async () => {
    const job = await leased();
    await writeCommitIntent(pool, args(job));
    for (const result of [
      { status: "failure" as const, atStepId: "s", expected: "e", observed: "o", category: "unexpected-state" as const, evidenceRef: "e" },
    ]) {
      const requeue = jobOutcomeFor({ kind: "result", result }, { attempt: 1, maxAttempts: 3, irreversibleStarted: false }); // a buggy caller
      expect(requeue.state).toBe("queued");
      expect(await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome: requeue })).toEqual({ recorded: false });
      const failed = jobOutcomeFor({ kind: "result", result }, { attempt: 3, maxAttempts: 3, irreversibleStarted: false });
      expect(failed.state).toBe("failed");
      expect(await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome: failed })).toEqual({ recorded: false });
    }
    expect((await row(job.id)).state).toBe("committing");
  });

  it("a stale T4 after recovery (token bumped) writes 0 rows, from running or committing", async () => {
    const job = await leased();
    await writeCommitIntent(pool, args(job));
    await pool.query("UPDATE jobs SET fencing_token = fencing_token + 1, state = 'needs_human', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1", [job.id]);
    const before = await row(job.id);
    const outcome = jobOutcomeFor({ kind: "result", result: success }, { attempt: 1, maxAttempts: 3, irreversibleStarted: true });
    expect(await completeJob(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", outcome })).toEqual({ recorded: false });
    expect(await row(job.id)).toEqual(before);
  });
});
