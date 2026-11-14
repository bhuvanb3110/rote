// T6 (recovery of expired leases) against real Postgres (docs/plans/step-08.md section 8, DB; Step 9's
// rows from docs/plans/step-09.md): every row of the recovery table, the token bump, the dead holder's
// attempt and phase rows, the verify cycle (dead phases, deferrals, hand-offs), the database clock, and
// concurrent recoverers recovering -- or claiming to verify -- each job exactly once.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Capability } from "../artifact/index.js";
import { createPool, dequeue, enqueue, type JobRow, type Pool } from "../queue/index.js";
import { createTestSchema, resetQueueTables, testDatabaseUrl, type TestSchema } from "../queue/testDb.js";
import { writeCommitIntent } from "./intent.js";
import { CLAIM_EXPIRED_SQL, CLAIM_TO_VERIFY_SQL, createRecoverySweep, recoverExpired, recoverOne, RECOVER_JOB_SQL } from "./recover.js";
import { readVerifyCycle } from "./verifySql.js";

const CAP = {
  id: "cap",
  inputs: [{ name: "memberId", type: "string", required: true, redact: false, description: "m" }],
  steps: [],
} as unknown as Pick<Capability, "id" | "inputs" | "steps">;

const LEASE = 30;
let db: TestSchema;
let pool: Pool;

beforeAll(async () => {
  db = await createTestSchema("worker_recover");
  pool = db.pool;
});
afterAll(async () => {
  await db?.drop();
});
beforeEach(async () => {
  await resetQueueTables(pool);
  await pool.query("UPDATE tenants SET max_concurrent = 100");
});

async function enqueueN(n: number, maxAttempts = 3): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    await enqueue(pool, { capability: CAP, tenantId: "tenant-a", idempotencyKey: `k-${i}-${Math.random()}`, params: { memberId: "1" }, maxAttempts });
  }
}

async function leased(maxAttempts = 3, workerId = "dead-worker"): Promise<JobRow> {
  await enqueueN(1, maxAttempts);
  const job = await dequeue(pool, { workerId, leaseSeconds: LEASE });
  if (!job) throw new Error("no job");
  return job;
}

/** A job whose dead holder wrote its commit intent (the transfer may have committed). */
async function committing(maxAttempts = 3): Promise<JobRow> {
  const job = await leased(maxAttempts);
  await writeCommitIntent(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "dead-worker", leaseSeconds: LEASE });
  return job;
}

/** Expire leases on the DATABASE clock (D22). */
const expire = (id?: string) =>
  id
    ? pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [id])
    : pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE lease_expires_at IS NOT NULL");
const row = async (id: string) => (await pool.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0];
const attemptRows = async (id: string) => (await pool.query("SELECT * FROM job_attempts WHERE job_id = $1 ORDER BY attempt", [id])).rows;
const phases = async (id: string) =>
  (await pool.query("SELECT fencing_token, worker_id, reason, prior_status, decision, ended_at, error FROM job_verifications WHERE job_id = $1 ORDER BY id", [id])).rows;
const recover = (workerId = "rescuer") => recoverOne(pool, { workerId, leaseSeconds: LEASE });

describe("T6: one row per line of the recovery table", () => {
  it("running, attempts left -> T6.1 requeue: queued, token + 1, lease cleared, the dead attempt 'crashed'; the next dequeue is attempt 2", async () => {
    const job = await leased();
    await expire(job.id);
    const r = await recover();
    expect(r).toMatchObject({ jobId: job.id, from: "running", action: { kind: "requeue", label: "T6.1" }, previousToken: 1, fencingToken: 2, deadOwner: "dead-worker" });
    expect(r!.claim).toBeUndefined();
    const after = await row(job.id);
    expect(after).toMatchObject({ state: "queued", fencing_token: 2, lease_owner: null, lease_expires_at: null, outcome: null, attempt: 1 });
    expect(after.error).toMatch(/lease expired while running \(attempt 1\/3\), before any commit intent; requeued \(T6\.1: the lease of dead-worker expired; recovered by rescuer\)/);
    const [a] = await attemptRows(job.id);
    expect(a).toMatchObject({ outcome: "crashed", fencing_token: 1 });
    expect(a.ended_at).toBeInstanceOf(Date);
    expect(a.error).toBe("lease expired in running; recovered by rescuer (T6.1 requeue)");
    const again = await dequeue(pool, { workerId: "w2", leaseSeconds: LEASE });
    expect(again).toMatchObject({ id: job.id, attempt: 2, fencing_token: 3 }); // dequeue bumps it again
  });

  it("running on the last attempt -> T6.2 fail / lease_expired, never queued (D21)", async () => {
    const job = await leased(1);
    await expire(job.id);
    const r = await recover();
    expect(r!.action).toMatchObject({ kind: "fail", label: "T6.2" });
    expect(await row(job.id)).toMatchObject({ state: "failed", outcome: "lease_expired", fencing_token: 2, lease_owner: null });
  });

  it("committing -> T6.4 claim to verify: verifying, owned by the recoverer with a fresh lease, a phase row (lease_expired_in_committing), never requeued", async () => {
    const job = await committing();
    await expire(job.id);
    const r = await recover();
    expect(r!.action).toMatchObject({ kind: "verify", label: "T6.4", reason: "lease_expired_in_committing" });
    expect(r!.claim).toMatchObject({ label: "T6.4", fencingToken: 2, priorStatus: null, job: { id: job.id, tenant_id: "tenant-a", attempt: 1, max_attempts: 3, memo_key: `rote-${job.id}` } });
    const after = await row(job.id);
    expect(after).toMatchObject({ state: "verifying", outcome: "commit_uncertain", fencing_token: 2, lease_owner: "rescuer" });
    const remaining = (await pool.query("SELECT EXTRACT(EPOCH FROM lease_expires_at - now())::float8 AS s FROM jobs WHERE id = $1", [job.id])).rows[0].s;
    expect(remaining).toBeGreaterThan(LEASE - 2);
    expect(after.commit_intent_at).toBeInstanceOf(Date); // kept: evidence that an intent was written
    expect((await attemptRows(job.id))[0]).toMatchObject({ outcome: "crashed" });
    expect(await phases(job.id)).toEqual([
      expect.objectContaining({ fencing_token: 2, worker_id: "rescuer", reason: "lease_expired_in_committing", prior_status: null, decision: null, ended_at: null }),
    ]);
  });

  it("verifying, its verifier died -> T6.5 re-claim: the dead phase 'crashed', a new phase (lease_expired_in_verifying) with the cycle's prior_status", async () => {
    const job = await committing();
    await expire(job.id);
    await recover("v1"); // T6.4: v1 verifies
    await expire(job.id); // v1 dies
    const r = await recover("v2");
    expect(r!.action).toMatchObject({ kind: "verify", label: "T6.5", reason: "lease_expired_in_verifying" });
    expect(r!.verifyCycle).toMatchObject({ deadPhases: 1, lastDecision: null });
    expect(await row(job.id)).toMatchObject({ state: "verifying", fencing_token: 3, lease_owner: "v2" });
    const p = await phases(job.id);
    expect(p.map((x) => [x.fencing_token, x.worker_id, x.reason, x.decision])).toEqual([
      [2, "v1", "lease_expired_in_committing", "crashed"],
      [3, "v2", "lease_expired_in_verifying", null],
    ]);
    expect(p[0].error).toBe("lease expired in verifying; recovered by v2 (T6.5 verify)");
  });

  it("verifying, 3 dead phases -> T6.6 escalate: needs_human / verify_exhausted, the third dead phase closed", async () => {
    const job = await committing();
    for (const v of ["v1", "v2", "v3"]) {
      await expire(job.id);
      expect((await recover(v))!.action.kind).toBe("verify");
    }
    await expire(job.id); // the third verifier dies too
    const r = await recover("v4");
    expect(r!.action).toMatchObject({ kind: "escalate", label: "T6.6", to: "needs_human", outcome: "verify_exhausted" });
    expect(r!.claim).toBeUndefined();
    expect(await row(job.id)).toMatchObject({ state: "needs_human", outcome: "verify_exhausted", fencing_token: 5, lease_owner: null, lease_expires_at: null });
    expect((await phases(job.id)).map((x) => x.decision)).toEqual(["crashed", "crashed", "crashed"]);
  });

  it("verifying, deferred (the bank was unavailable) -> T6.7 resume after the backoff; deferrals never count toward the cap", async () => {
    const job = await committing();
    await expire(job.id);
    await recover("v1");
    // Two dead phases, then three deferrals: still resumed (T6.7), never exhausted.
    await expire(job.id);
    await recover("v2");
    let token = (await row(job.id)).fencing_token as number;
    for (let i = 0; i < 3; i += 1) {
      // T8 by hand (verifySql.ts has its own tests): end the phase deferred, token + 1, owner kept.
      await pool.query("UPDATE job_verifications SET decision = 'deferred', ended_at = now(), lookups = '{NULL}' WHERE job_id = $1 AND fencing_token = $2", [job.id, token]);
      await pool.query("UPDATE jobs SET fencing_token = fencing_token + 1 WHERE id = $1", [job.id]);
      await expire(job.id);
      const r = await recover(`r${i}`);
      expect(r!.action).toMatchObject({ kind: "verify", label: "T6.7", reason: "resumed" });
      expect(r!.verifyCycle).toMatchObject({ deadPhases: 1, deferrals: i + 1, lastDecision: "deferred" });
      token = r!.fencingToken;
    }
    const cycle = await readVerifyCycle(pool, job.id);
    // v1 crashed, v2 + r0 + r1 deferred, r2 open: 5 phases; dead = v1 and the open r2 (it would be
    // dying if its lease expired now); the 3 deferrals never count.
    expect(cycle).toMatchObject({ phases: 5, deadPhases: 2, deferrals: 3, lastDecision: null });
    expect(cycle.deferredForSeconds).toBeGreaterThanOrEqual(0);
  });

  it("verifying, handed off by rote jobs reverify -> T6.7 resume (the hand-off is not a dead phase)", async () => {
    const job = await leased();
    await pool.query(
      "UPDATE jobs SET state = 'verifying', fencing_token = 7, lease_owner = 'reverify:cli', lease_expires_at = now() - interval '1 second', outcome = 'commit_uncertain' WHERE id = $1",
      [job.id],
    );
    await pool.query(
      "INSERT INTO job_verifications (job_id, fencing_token, worker_id, reason, prior_status, ended_at, decision) VALUES ($1, 7, 'reverify:cli', 'commit_uncertain', 'business_outcome', now(), 'handed_off')",
      [job.id],
    );
    const r = await recover();
    expect(r!.action).toMatchObject({ kind: "verify", label: "T6.7" });
    expect(r!.claim).toMatchObject({ fencingToken: 8, priorStatus: "business_outcome", label: "T6.7" });
    expect((await phases(job.id)).map((x) => [x.reason, x.decision, x.prior_status])).toEqual([
      ["commit_uncertain", "handed_off", "business_outcome"],
      ["resumed", null, "business_outcome"],
    ]);
  });
});

describe("T6: what it never touches, and when it stops", () => {
  it("a live lease (database clock), a queued job, a terminal job", async () => {
    const live = await leased();
    await enqueueN(1); // queued
    const done = await leased();
    await pool.query("UPDATE jobs SET state = 'succeeded', lease_owner = NULL, lease_expires_at = NULL WHERE id = $1", [done.id]);
    const before = (await pool.query("SELECT * FROM jobs ORDER BY id")).rows;
    expect(await recoverExpired(pool, { workerId: "rescuer", leaseSeconds: LEASE })).toEqual({ recovered: [], claim: null });
    expect((await pool.query("SELECT * FROM jobs ORDER BY id")).rows).toEqual(before);
    expect((await row(live.id)).state).toBe("running");
  });

  it("an expired lease whose attempt row the worker already closed: the job is recovered, the closed attempt row is left as the worker wrote it", async () => {
    const job = await leased();
    await pool.query("UPDATE job_attempts SET ended_at = now(), outcome = 'lease_lost', error = 'mine' WHERE job_id = $1", [job.id]);
    await expire(job.id);
    await recover();
    expect((await attemptRows(job.id))[0]).toMatchObject({ outcome: "lease_lost", error: "mine" });
  });

  it("recovers oldest expiry first, at most `max` per call, and reports each", async () => {
    await enqueueN(5);
    for (let i = 0; i < 5; i += 1) await dequeue(pool, { workerId: `dead-${i}`, leaseSeconds: LEASE });
    await pool.query(
      "UPDATE jobs SET lease_expires_at = now() - make_interval(secs => 100 - (SELECT count(*) FROM jobs j2 WHERE j2.created_at < jobs.created_at))",
    );
    const seen: string[] = [];
    const first = await recoverExpired(pool, { workerId: "rescuer", leaseSeconds: LEASE, max: 3, onRecovered: (r) => seen.push(r.jobId) });
    expect(first.recovered).toHaveLength(3);
    expect(seen).toEqual(first.recovered.map((r) => r.jobId));
    const order = (await pool.query("SELECT id FROM jobs ORDER BY created_at")).rows.map((r) => r.id);
    expect(seen).toEqual(order.slice(0, 3)); // the oldest-created got the earliest expiry above
    expect((await recoverExpired(pool, { workerId: "rescuer", leaseSeconds: LEASE, max: 10 })).recovered).toHaveLength(2);
  });

  it("the sweep STOPS at the first claim to verify (that job is the iteration's work); the rest wait for the next sweep", async () => {
    const a = await leased();
    const b = await committing();
    const c = await leased();
    await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '30 seconds' WHERE id = $1", [a.id]);
    await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '20 seconds' WHERE id = $1", [b.id]);
    await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '10 seconds' WHERE id = $1", [c.id]);
    const first = await recoverExpired(pool, { workerId: "rescuer", leaseSeconds: LEASE });
    expect(first.recovered.map((r) => [r.jobId, r.action.label])).toEqual([
      [a.id, "T6.1"],
      [b.id, "T6.4"],
    ]);
    expect(first.claim).toMatchObject({ job: { id: b.id }, label: "T6.4" });
    expect((await row(c.id)).state).toBe("running"); // untouched until the next sweep
    const second = await recoverExpired(pool, { workerId: "other", leaseSeconds: LEASE });
    expect(second.recovered.map((r) => r.jobId)).toEqual([c.id]);
  });

  it("the claim uses the database clock and the partial index's order; the updates re-check expiry", () => {
    expect(CLAIM_EXPIRED_SQL).toMatch(/lease_expires_at < now\(\)/);
    expect(CLAIM_EXPIRED_SQL).toMatch(/ORDER BY lease_expires_at, id/);
    expect(CLAIM_EXPIRED_SQL).toMatch(/FOR UPDATE SKIP LOCKED/);
    for (const sql of [RECOVER_JOB_SQL, CLAIM_TO_VERIFY_SQL]) {
      expect(sql).toMatch(/fencing_token = fencing_token \+ 1/);
      expect(sql).toMatch(/AND lease_expires_at < now\(\)/);
    }
    expect(CLAIM_TO_VERIFY_SQL).toMatch(/lease_expires_at = now\(\) \+ make_interval\(secs => \$5\)/);
  });
});

describe("T6 under concurrency", () => {
  it("8 concurrent recoverers over 50 expired jobs: each job recovered exactly once (token + 1 exactly once)", async () => {
    await enqueueN(50);
    for (let i = 0; i < 50; i += 1) await dequeue(pool, { workerId: `dead-${i}`, leaseSeconds: LEASE });
    await expire();
    const pools = Array.from({ length: 8 }, () => createPool({ connectionString: testDatabaseUrl(), searchPath: db.schema, max: 1 }));
    try {
      const results = await Promise.all(pools.map((p, i) => recoverExpired(p, { workerId: `rescuer-${i}`, leaseSeconds: LEASE, max: 50 })));
      const ids = results.flatMap((r) => r.recovered).map((r) => r.jobId);
      expect(ids).toHaveLength(50);
      expect(new Set(ids).size).toBe(50);
      const rows = (await pool.query("SELECT state, fencing_token FROM jobs")).rows;
      expect(rows.every((r) => r.state === "queued" && r.fencing_token === 2)).toBe(true);
      const crashed = (await pool.query("SELECT count(*)::int AS n FROM job_attempts WHERE outcome = 'crashed'")).rows[0].n;
      expect(crashed).toBe(50);
      expect(results.filter((r) => r.recovered.length > 0).length).toBeGreaterThan(1); // the work really was shared
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  }, 60_000); // correctness under concurrency; 50 jobs x 8 pools can take > 5 s on a loaded machine (evidence/step-10/flakes.md 2)

  it("8 concurrent verifiers re-claiming 16 expired verifying jobs (looping until none is left): each claimed exactly once, one open phase each", async () => {
    for (let i = 0; i < 16; i += 1) await committing();
    await expire();
    const pools = Array.from({ length: 8 }, () => createPool({ connectionString: testDatabaseUrl(), searchPath: db.schema, max: 1 }));
    try {
      // First round: T6.4 claims (each sweep stops at its claim, so each worker loops).
      const claimAll = async (p: Pool, w: string) => {
        const claims: string[] = [];
        for (;;) {
          const { claim } = await recoverExpired(p, { workerId: w, leaseSeconds: LEASE });
          if (!claim) return claims;
          claims.push(claim.job.id);
        }
      };
      const first = (await Promise.all(pools.map((p, i) => claimAll(p, `v1-${i}`)))).flat();
      expect(first).toHaveLength(16);
      expect(new Set(first).size).toBe(16);
      // Every verifier "dies": second round, T6.5 re-claims, again exactly once each.
      await expire();
      const second = (await Promise.all(pools.map((p, i) => claimAll(p, `v2-${i}`)))).flat();
      expect(second).toHaveLength(16);
      expect(new Set(second).size).toBe(16);
      const open = (await pool.query("SELECT job_id, count(*)::int AS n FROM job_verifications WHERE ended_at IS NULL GROUP BY job_id")).rows;
      expect(open).toHaveLength(16);
      expect(open.every((r) => r.n === 1)).toBe(true);
      const states = (await pool.query("SELECT DISTINCT state, fencing_token FROM jobs")).rows;
      expect(states).toEqual([{ state: "verifying", fencing_token: 3 }]);
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  }, 60_000); // correctness under concurrency; 50 jobs x 8 pools can take > 5 s on a loaded machine (evidence/step-10/flakes.md 2)
});

describe("createRecoverySweep (the worker's beforeDequeue)", () => {
  it("logs each recovery and resolves with the claim to verify; a transient DB error is logged and swallowed; any other error propagates", async () => {
    const job = await leased();
    await expire(job.id);
    const warnings: Array<{ obj: Record<string, unknown>; msg: string }> = [];
    const log = { info() {}, error() {}, warn: (obj: Record<string, unknown>, msg: string) => warnings.push({ obj, msg }) };
    expect(await createRecoverySweep({ pool, workerId: "rescuer", leaseSeconds: LEASE, log })()).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ msg: "worker: recovered an expired lease", obj: { jobId: job.id, from: "running", label: "T6.1", to: "queued" } });

    const c = await committing();
    await expire(c.id);
    expect(await createRecoverySweep({ pool, workerId: "rescuer", leaseSeconds: LEASE, log })()).toMatchObject({ job: { id: c.id }, label: "T6.4" });
    expect(warnings.at(-1)).toMatchObject({ msg: "worker: recovered an expired lease and claimed the job to verify it", obj: { label: "T6.4", to: "verifying" } });

    const transient = { connect: async () => Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" })) } as unknown as Pool;
    expect(await createRecoverySweep({ pool: transient, workerId: "rescuer", leaseSeconds: LEASE, log })()).toBeNull();
    expect(warnings.at(-1)!.msg).toMatch(/Postgres unavailable during recovery/);

    const fatal = { connect: async () => Promise.reject(Object.assign(new Error("syntax error"), { code: "42601" })) } as unknown as Pool;
    await expect(createRecoverySweep({ pool: fatal, workerId: "rescuer", leaseSeconds: LEASE, log })()).rejects.toThrow("syntax error");
  });

  it("crash point recover-in-transaction: everything written, nothing committed -- the rollback leaves the job expired for the next recoverer", async () => {
    const job = await committing();
    await expire(job.id);
    const before = await row(job.id);
    class Killed extends Error {}
    const fault = { point: "recover-in-transaction", at: (name: string) => { if (name === "recover-in-transaction") throw new Killed("simulated kill"); } };
    await expect(recoverOne(pool, { workerId: "doomed", leaseSeconds: LEASE, fault })).rejects.toBeInstanceOf(Killed);
    expect(await row(job.id)).toEqual(before);
    expect(await phases(job.id)).toEqual([]);
    expect((await recover("next"))!.action.label).toBe("T6.4");
  });
});
