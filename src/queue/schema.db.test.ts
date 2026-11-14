// The schema's constraints, each shown to reject what it exists to reject (asserting the constraint
// NAME, not just "some error"), plus the generated memo_key and the Zod row schemas.
import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sqlState, type Pool } from "./db.js";
import { createTestSchema, resetQueueTables, type TestSchema } from "./testDb.js";
import { AttemptRowSchema, JobRowSchema } from "./types.js";

let db: TestSchema;
let pool: Pool;

beforeAll(async () => {
  db = await createTestSchema("schema");
  pool = db.pool;
});
afterAll(async () => {
  await db?.drop();
});
beforeEach(async () => {
  await resetQueueTables(pool);
});

const hex = (bytes: number) => randomBytes(bytes).toString("hex");

/** Inserts a job with valid defaults; `cols` overrides/extends columns. Returns the row. */
async function insertJob(cols: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const row: Record<string, unknown> = {
    idempotency_key: `key-${randomUUID()}`,
    request_hash: hex(32),
    tenant_id: "tenant-a",
    capability_id: "transfer",
    params: { memberId: "10001" },
    trace_id: hex(16),
    ...cols,
  };
  const names = Object.keys(row);
  const { rows } = await pool.query(
    `INSERT INTO jobs (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
    names.map((n) => row[n]),
  );
  return rows[0];
}

async function rejection(promise: Promise<unknown>): Promise<{ code?: string; constraint?: string }> {
  try {
    await promise;
  } catch (err) {
    return { code: sqlState(err), constraint: (err as { constraint?: string }).constraint };
  }
  throw new Error("expected the statement to be rejected");
}

describe("jobs constraints", () => {
  it("memo_key is generated as 'rote-' || id, 41 characters, and cannot be written", async () => {
    const job = await insertJob();
    expect(job.memo_key).toBe(`rote-${job.id}`);
    expect((job.memo_key as string).length).toBe(41);
    expect((await rejection(insertJob({ memo_key: "rote-forged" }))).code).toBe("428C9");
    expect((await rejection(pool.query("UPDATE jobs SET memo_key = 'x' WHERE id = $1", [job.id])) ).code).toBe("428C9");
  });

  it("a lease is both owner and expiry, or neither (jobs_lease_pair)", async () => {
    expect(await rejection(insertJob({ lease_owner: "w1" }))).toEqual({ code: "23514", constraint: "jobs_lease_pair" });
    expect(await rejection(insertJob({ lease_expires_at: new Date() }))).toEqual({
      code: "23514",
      constraint: "jobs_lease_pair",
    });
  });

  it("an active job always has an owner (jobs_active_has_owner)", async () => {
    for (const state of ["running", "committing", "verifying"]) {
      const extra = state === "committing" ? { commit_intent_at: new Date() } : {};
      expect(await rejection(insertJob({ state, ...extra, attempt: 1 }))).toEqual({
        code: "23514",
        constraint: "jobs_active_has_owner",
      });
    }
  });

  it("committing requires a commit intent (jobs_committing_has_intent)", async () => {
    expect(
      await rejection(insertJob({ state: "committing", attempt: 1, lease_owner: "w1", lease_expires_at: new Date() })),
    ).toEqual({ code: "23514", constraint: "jobs_committing_has_intent" });
  });

  it("reviewer decision 6: an exhausted job cannot be queued -- not on insert, not by an UPDATE (Day-2 recovery must use 'failed')", async () => {
    expect(await rejection(insertJob({ attempt: 3, max_attempts: 3 }))).toEqual({
      code: "23514",
      constraint: "jobs_queued_has_attempts_left",
    });
    const job = await insertJob({ state: "failed", attempt: 3, max_attempts: 3 });
    expect(await rejection(pool.query("UPDATE jobs SET state = 'queued' WHERE id = $1", [job.id]))).toEqual({
      code: "23514",
      constraint: "jobs_queued_has_attempts_left",
    });
    // With an attempt left, requeueing is allowed.
    const retry = await insertJob({ state: "failed", attempt: 2, max_attempts: 3 });
    await pool.query("UPDATE jobs SET state = 'queued' WHERE id = $1", [retry.id]);
  });

  it("an unknown state is rejected; business_outcome is a valid state", async () => {
    expect((await rejection(insertJob({ state: "done" }))).code).toBe("23514");
    const job = await insertJob({ state: "business_outcome", attempt: 1 });
    expect(job.state).toBe("business_outcome");
  });

  it("a job for an unknown tenant fails at the foreign key", async () => {
    expect(await rejection(insertJob({ tenant_id: "tenant-z" }))).toEqual({ code: "23503", constraint: "jobs_tenant_id_fkey" });
  });

  it("reviewer decision 3: idempotency keys are unique PER TENANT", async () => {
    await insertJob({ tenant_id: "tenant-a", idempotency_key: "same-key" });
    await insertJob({ tenant_id: "tenant-b", idempotency_key: "same-key" }); // another tenant: fine
    expect(await rejection(insertJob({ tenant_id: "tenant-a", idempotency_key: "same-key" }))).toEqual({
      code: "23505",
      constraint: "jobs_tenant_idempotency_key_key",
    });
  });

  it("format checks: key length, request_hash, trace_id, params must be an object", async () => {
    expect((await rejection(insertJob({ idempotency_key: "" }))).code).toBe("23514");
    expect((await rejection(insertJob({ idempotency_key: "k".repeat(256) }))).code).toBe("23514");
    expect((await rejection(insertJob({ request_hash: "not-a-hash" }))).code).toBe("23514");
    expect((await rejection(insertJob({ trace_id: "XYZ" }))).code).toBe("23514");
    expect((await rejection(insertJob({ trace_id: null }))).code).toBe("23502");
    expect((await rejection(insertJob({ params: JSON.stringify([1, 2]) }))).code).toBe("23514");
  });

  it("a tenant's max_concurrent stays within 1..100", async () => {
    expect((await rejection(pool.query("UPDATE tenants SET max_concurrent = 0 WHERE id = 'tenant-a'"))).code).toBe("23514");
    expect((await rejection(pool.query("INSERT INTO tenants (id, max_concurrent) VALUES ('Bad Id', 1)"))).code).toBe("23514");
  });
});

describe("job_attempts and breakers constraints", () => {
  it("each attempt and each fencing token is recorded once per job", async () => {
    const job = await insertJob();
    const ins = (attempt: number, token: number) =>
      pool.query("INSERT INTO job_attempts (job_id, attempt, worker_id, fencing_token) VALUES ($1, $2, 'w', $3)", [
        job.id,
        attempt,
        token,
      ]);
    await ins(1, 1);
    expect(await rejection(ins(1, 2))).toEqual({ code: "23505", constraint: "job_attempts_job_attempt_key" });
    expect(await rejection(ins(2, 1))).toEqual({ code: "23505", constraint: "job_attempts_job_token_key" });
  });

  it("an open breaker needs opened_at", async () => {
    expect(await rejection(pool.query("INSERT INTO breakers (capability_id, state) VALUES ('transfer', 'open')"))).toEqual({
      code: "23514",
      constraint: "breakers_open_has_opened_at",
    });
  });
});

describe("0002_day2: the recovery index, job_attempts.commit_intent_at, job_verifications", () => {
  it("jobs_lease_expiry is a partial index on (lease_expires_at, id) over the active states only", async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE schemaname = current_schema() AND indexname = 'jobs_lease_expiry'",
    );
    expect(rows).toHaveLength(1);
    const def = rows[0]!.indexdef;
    expect(def).toMatch(/ON \S*jobs USING btree \(lease_expires_at, id\)/);
    expect(def).toMatch(/WHERE \(state = ANY \(ARRAY\['running'::text, 'committing'::text, 'verifying'::text\]\)\)/);
  });

  it("job_attempts.commit_intent_at is a nullable timestamptz, null by default", async () => {
    const job = await insertJob();
    await pool.query("INSERT INTO job_attempts (job_id, attempt, worker_id, fencing_token) VALUES ($1, 1, 'w', 1)", [job.id]);
    const row = AttemptRowSchema.parse((await pool.query("SELECT * FROM job_attempts")).rows[0]);
    expect(row.commit_intent_at).toBeNull();
    await pool.query("UPDATE job_attempts SET commit_intent_at = now()");
    expect(AttemptRowSchema.parse((await pool.query("SELECT * FROM job_attempts")).rows[0]).commit_intent_at).toBeInstanceOf(Date);
  });

  const insertVerification = (cols: Record<string, unknown>) => {
    const row = { fencing_token: 2, worker_id: "w", reason: "lease_expired_in_committing", ...cols };
    const names = Object.keys(row);
    return pool.query(
      `INSERT INTO job_verifications (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      names.map((n) => (row as Record<string, unknown>)[n]),
    );
  };

  it("job_verifications accepts a full row (lookups as int[] with a NULL entry for unreadable)", async () => {
    const job = await insertJob();
    const { rows } = await insertVerification({
      job_id: job.id,
      prior_status: "failure",
      lookups: [0, null],
      decision: "escalated",
      ended_at: new Date(Date.now() + 1000),
    });
    expect(rows[0].lookups).toEqual([0, null]);
    expect(rows[0].started_at).toBeInstanceOf(Date);
  });

  it("job_verifications rejects an unknown reason, prior_status or decision, a token < 1, and ended before started", async () => {
    const job = await insertJob();
    expect((await rejection(insertVerification({ job_id: job.id, reason: "because" }))).code).toBe("23514");
    expect((await rejection(insertVerification({ job_id: job.id, prior_status: "success" }))).code).toBe("23514");
    expect((await rejection(insertVerification({ job_id: job.id, decision: "maybe" }))).code).toBe("23514");
    expect((await rejection(insertVerification({ job_id: job.id, fencing_token: 0 }))).code).toBe("23514");
    expect(
      (await rejection(insertVerification({ job_id: job.id, started_at: new Date(), ended_at: new Date(Date.now() - 60_000) }))).code,
    ).toBe("23514");
  });

  it("one verification per (job, fencing token); a job id must exist; deleting the job deletes its verifications", async () => {
    const job = await insertJob();
    await insertVerification({ job_id: job.id });
    expect(await rejection(insertVerification({ job_id: job.id }))).toEqual({
      code: "23505",
      constraint: "job_verifications_job_token_key",
    });
    expect((await rejection(insertVerification({ job_id: randomUUID() }))).code).toBe("23503");
    await pool.query("DELETE FROM jobs WHERE id = $1", [job.id]);
    expect((await pool.query("SELECT count(*)::int AS n FROM job_verifications")).rows[0].n).toBe(0);
  });

  it("resetQueueTables empties job_verifications too (TRUNCATE ... CASCADE)", async () => {
    const job = await insertJob();
    await insertVerification({ job_id: job.id });
    await resetQueueTables(pool);
    expect((await pool.query("SELECT count(*)::int AS n FROM job_verifications")).rows[0].n).toBe(0);
  });
});

describe("0003_verify: the Step 9 values and the open/ended rule on job_verifications", () => {
  const insert = (jobId: unknown, cols: Record<string, unknown>) => {
    const row = { job_id: jobId, fencing_token: 3, worker_id: "w", reason: "lease_expired_in_committing", ...cols };
    const names = Object.keys(row);
    return pool.query(
      `INSERT INTO job_verifications (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      names.map((n) => (row as Record<string, unknown>)[n]),
    );
  };

  it("accepts reason 'resumed' and decisions 'deferred', 'handed_off', 'illegal_transition' (each ended)", async () => {
    const job = await insertJob();
    let token = 1;
    for (const decision of ["deferred", "handed_off", "illegal_transition"]) {
      const reason = decision === "handed_off" ? "commit_uncertain" : "resumed";
      const { rows } = await insert(job.id, { fencing_token: token++, reason, decision, ended_at: new Date(Date.now() + 1000), lookups: [null] });
      expect(rows[0]).toMatchObject({ reason, decision });
    }
  });

  it("job_verifications_decided_has_end: a decision needs an end, an end needs a decision", async () => {
    const job = await insertJob();
    expect(await rejection(insert(job.id, { decision: "deferred" }))).toEqual({ code: "23514", constraint: "job_verifications_decided_has_end" });
    expect(await rejection(insert(job.id, { fencing_token: 4, ended_at: new Date(Date.now() + 1000) }))).toEqual({
      code: "23514",
      constraint: "job_verifications_decided_has_end",
    });
    await insert(job.id, { fencing_token: 5 }); // open: neither
  });
});

describe("0004_day2_exit: the requeue backoff and the reconcile pass (D49, D50)", () => {
  const insert = (jobId: unknown, cols: Record<string, unknown>) => {
    const row = { job_id: jobId, fencing_token: 3, worker_id: "w", reason: "reconcile", ...cols };
    const names = Object.keys(row);
    return pool.query(
      `INSERT INTO job_verifications (${names.join(", ")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(", ")}) RETURNING *`,
      names.map((n) => (row as Record<string, unknown>)[n]),
    );
  };
  const later = () => new Date(Date.now() + 1000);

  it("jobs_not_before_only_queued: only a queued job may carry not_before", async () => {
    const queued = await insertJob({ not_before: later() });
    expect(queued.not_before).toBeInstanceOf(Date);
    expect(await rejection(insertJob({ state: "failed", not_before: later() }))).toEqual({ code: "23514", constraint: "jobs_not_before_only_queued" });
    expect(await rejection(pool.query("UPDATE jobs SET state = 'running', lease_owner = 'w', lease_expires_at = now() WHERE id = $1", [queued.id]))).toEqual({
      code: "23514",
      constraint: "jobs_not_before_only_queued",
    });
  });

  it("a succeeded job may hold a reconcile lease (jobs_lease_pair still holds) and carry reconcile_after / reconciled_at", async () => {
    const job = await insertJob({ state: "succeeded", reconcile_after: new Date(), lease_owner: "reconciler", lease_expires_at: later() });
    expect(job).toMatchObject({ state: "succeeded", lease_owner: "reconciler", reconciled_at: null });
    expect(await rejection(insertJob({ state: "succeeded", lease_owner: "reconciler" }))).toEqual({ code: "23514", constraint: "jobs_lease_pair" });
  });

  it("job_verifications: reason 'reconcile' and its four decisions", async () => {
    const job = await insertJob({ state: "succeeded" });
    let token = 1;
    for (const decision of ["reconciled", "duplicate_suspected", "reconcile_unreadable", "reconcile_deferred", "crashed", "lease_lost"]) {
      const { rows } = await insert(job.id, { fencing_token: token++, decision, ended_at: later(), lookups: [2] });
      expect(rows[0]).toMatchObject({ reason: "reconcile", decision });
    }
    await insert(job.id, { fencing_token: token++ }); // open
  });

  it("job_verifications_reconcile_decisions: a reconcile decision only on a reconcile row, and a reconcile row never ends like a verify", async () => {
    const job = await insertJob({ state: "succeeded" });
    expect(await rejection(insert(job.id, { reason: "lease_expired_in_committing", decision: "reconciled", ended_at: later() }))).toEqual({
      code: "23514",
      constraint: "job_verifications_reconcile_decisions",
    });
    expect(await rejection(insert(job.id, { fencing_token: 4, decision: "resubmitted", ended_at: later() }))).toEqual({
      code: "23514",
      constraint: "job_verifications_reconcile_decisions",
    });
    expect((await rejection(insert(job.id, { fencing_token: 5, decision: "reconciled_maybe", ended_at: later() }))).constraint).toBe("job_verifications_decision_check");
  });
});

describe("Zod row schemas parse real rows", () => {
  it("JobRowSchema and AttemptRowSchema accept rows straight from SELECT *", async () => {
    const job = await insertJob();
    const parsed = JobRowSchema.parse((await pool.query("SELECT * FROM jobs WHERE id = $1", [job.id])).rows[0]);
    expect(parsed.fencing_token).toBe(0); // int8 parsed to a number
    expect(parsed.created_at).toBeInstanceOf(Date);
    expect(parsed).toMatchObject({ not_before: null, reconcile_after: null, reconciled_at: null }); // 0004
    await pool.query("INSERT INTO job_attempts (job_id, attempt, worker_id, fencing_token) VALUES ($1, 1, 'w', 1)", [job.id]);
    const attempt = AttemptRowSchema.parse((await pool.query("SELECT * FROM job_attempts")).rows[0]);
    expect(attempt.id).toBe(1);
  });
});
