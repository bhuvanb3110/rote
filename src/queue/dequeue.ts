// Dequeue: SKIP LOCKED + lease + fencing token + per-tenant cap, in one transaction per attempt
// (docs/plans/step-05.md section 5; docs/DECISIONS.md D18).
//
// The per-tenant cap is a RECOUNT UNDER A TENANT ROW LOCK. A count alone is not safe: under READ
// COMMITTED two dequeuers can each count 1 active job for a cap-2 tenant, each SKIP-LOCKED-pick a
// different queued row, and both commit (3 running): write skew, which row locks on jobs can't
// prevent because the two never touch the same row. So dequeuers serialize per tenant on the
// tenant's row (a tenant being claimed by someone else is skipped, not waited on) and recount in a
// fresh statement after taking that lock.
//
// Tenant starvation fix (reviewer decision 6): if the claimed tenant yields no job (its queued rows
// are briefly locked by another transaction, or it is at its cap on recount), that attempt is rolled
// back and the claim is retried EXCLUDING that tenant. Each retry excludes one more tenant, so the
// loop is bounded by the number of tenants, and dequeue never returns null while an unexcluded,
// unlocked tenant still has dequeueable work. (The schema guarantees every queued job has an attempt
// left: CHECK (state <> 'queued' OR attempt < max_attempts).)
//
// Clock rule (reviewer decision 7, D22): lease expiry is computed by the DATABASE (now()), never
// from a worker's clock. No timestamp computed in TypeScript is ever sent.
//
// Requeue backoff (Step 10, D49): a queued job whose not_before is still in the future is not
// dequeueable. Every "queued work" test below repeats `(not_before IS NULL OR not_before <= now())`:
// the tenant claim's EXISTS and its ORDER BY, and the pick. Otherwise a tenant whose only queued jobs
// are not yet due would be claimed, yield nothing and be excluded on every single dequeue.
import type { Pool, PoolClient } from "./db.js";
import { JobRowSchema, type JobRow } from "./types.js";

export const DEFAULT_LEASE_SECONDS = 30;

export interface DequeueOptions {
  /** The worker taking the lease; recorded as lease_owner and job_attempts.worker_id. */
  workerId: string;
  /** Lease length; default 30 s (the brief). Expiry = the database's now() + this. */
  leaseSeconds?: number;
}

/**
 * (1) Claim one tenant with queued work and (probably) a free slot, oldest waiting job first
 * (fairness). Tenants another dequeuer is claiming right now are skipped, not waited on. $1 = the
 * tenants already excluded by this dequeue call.
 */
export const CLAIM_TENANT_SQL = `
SELECT t.id, t.max_concurrent
FROM tenants t
WHERE t.id <> ALL ($1::text[])
  AND EXISTS (SELECT 1 FROM jobs q WHERE q.tenant_id = t.id AND q.state = 'queued'
              AND (q.not_before IS NULL OR q.not_before <= now()))
  AND (SELECT count(*) FROM jobs a
       WHERE a.tenant_id = t.id AND a.state IN ('running', 'committing', 'verifying')) < t.max_concurrent
ORDER BY (SELECT min(q.created_at) FROM jobs q WHERE q.tenant_id = t.id AND q.state = 'queued'
          AND (q.not_before IS NULL OR q.not_before <= now())), t.id
LIMIT 1
FOR UPDATE OF t SKIP LOCKED`;

/**
 * (2) Recount in a NEW statement: under READ COMMITTED it takes a fresh snapshot, so it sees any job
 * that went active (and committed) after (1)'s snapshot. Nothing can raise this count while we hold
 * the tenant row lock: every transition INTO an active state from 'queued' happens here.
 */
export const COUNT_ACTIVE_SQL = `
SELECT count(*) AS n FROM jobs
WHERE tenant_id = $1 AND state IN ('running', 'committing', 'verifying')`;

/** (3) The tenant's oldest due queued job; SKIP LOCKED still guards against any other row locker. */
export const PICK_JOB_SQL = `
SELECT id FROM jobs
WHERE tenant_id = $1 AND state = 'queued' AND attempt < max_attempts
  AND (not_before IS NULL OR not_before <= now())
ORDER BY created_at, id
LIMIT 1
FOR UPDATE SKIP LOCKED`;

/**
 * (4) Lease it: owner, expiry (database clock), attempt + 1 and fencing_token + 1 together. The backoff
 * is spent: not_before is cleared (jobs_not_before_only_queued, 0004).
 */
export const LEASE_SQL = `
UPDATE jobs
SET state = 'running',
    attempt = attempt + 1,
    fencing_token = fencing_token + 1,
    lease_owner = $2,
    lease_expires_at = now() + make_interval(secs => $3),
    not_before = NULL,
    updated_at = now()
WHERE id = $1
RETURNING *`;

/** (5) One attempt row, in the same transaction: a lease without an attempt row cannot exist. */
export const INSERT_ATTEMPT_SQL = `
INSERT INTO job_attempts (job_id, attempt, worker_id, fencing_token, trace_id)
VALUES ($1, $2, $3, $4, $5)`;

type AttemptOutcome = { kind: "leased"; job: JobRow } | { kind: "no-tenant" } | { kind: "exclude"; tenantId: string };

async function attemptOnce(
  client: PoolClient,
  excluded: string[],
  workerId: string,
  leaseSeconds: number,
): Promise<AttemptOutcome> {
  const claimed = await client.query<{ id: string; max_concurrent: number }>(CLAIM_TENANT_SQL, [excluded]);
  const tenant = claimed.rows[0];
  if (!tenant) return { kind: "no-tenant" };

  const active = (await client.query<{ n: number }>(COUNT_ACTIVE_SQL, [tenant.id])).rows[0]!.n;
  if (active >= tenant.max_concurrent) return { kind: "exclude", tenantId: tenant.id };

  const picked = (await client.query<{ id: string }>(PICK_JOB_SQL, [tenant.id])).rows[0];
  if (!picked) return { kind: "exclude", tenantId: tenant.id };

  const leased = JobRowSchema.parse((await client.query(LEASE_SQL, [picked.id, workerId, leaseSeconds])).rows[0]);
  await client.query(INSERT_ATTEMPT_SQL, [leased.id, leased.attempt, workerId, leased.fencing_token, leased.trace_id]);
  return { kind: "leased", job: leased };
}

/**
 * Leases the next job (Zod-parsed row: state 'running', attempt and fencing_token incremented, an
 * attempt row inserted) or returns null when no unlocked tenant has dequeueable work within its cap.
 */
export async function dequeue(pool: Pool, options: DequeueOptions): Promise<JobRow | null> {
  const leaseSeconds = options.leaseSeconds ?? DEFAULT_LEASE_SECONDS;
  if (!options.workerId) throw new Error("dequeue: workerId is required");
  if (!(Number.isInteger(leaseSeconds) && leaseSeconds >= 1 && leaseSeconds <= 3600)) {
    throw new RangeError(`dequeue: leaseSeconds must be an integer in 1..3600 (got ${leaseSeconds})`);
  }

  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    const excluded: string[] = [];
    for (;;) {
      await client.query("BEGIN");
      let outcome: AttemptOutcome;
      try {
        outcome = await attemptOnce(client, excluded, options.workerId, leaseSeconds);
      } catch (err) {
        await client.query("ROLLBACK").catch((rollbackErr: Error) => {
          broken = rollbackErr;
        });
        throw err;
      }
      if (outcome.kind === "leased") {
        await client.query("COMMIT");
        return outcome.job;
      }
      // Nothing was written: roll back, which also releases the tenant row lock.
      await client.query("ROLLBACK");
      if (outcome.kind === "no-tenant") return null;
      // Bounded: CLAIM_TENANT_SQL never returns an excluded tenant, so each pass excludes a new one.
      excluded.push(outcome.tenantId);
    }
  } finally {
    client.release(broken);
  }
}
