// T6: recovery of expired leases, inside the dequeue loop (docs/plans/step-08.md section 4, seam 4).
// Every worker, on every loop iteration, before dequeue, recovers at most `max` (10) expired jobs, one
// transaction per job, so a backlog cannot starve dequeuing:
//
//   BEGIN
//   T6.0  claim the expired lease with the earliest expiry; rows another recoverer holds are SKIPPED,
//         not waited on (FOR UPDATE SKIP LOCKED): two recoverers never take the same job
//   decide with the pure recoveryAction(row) (src/fleet/stateMachine.ts): T6.1 requeue, T6.2 fail,
//         T6.3 escalate. The SQL below only executes that decision.
//   UPDATE jobs: the decided state, fencing_token + 1 (EVERY recovery bumps it, reviewer decision 3,
//         so "the token changed" always means "the old holder is fenced"), lease cleared. Fenced on
//         the claimed token and state and re-checked expired (database clock, D22).
//   UPDATE job_attempts: the dead holder's open attempt row -> crashed
//   COMMIT
//
// A kill in the middle rolls the transaction back and Postgres releases the row lock when the
// connection drops: the job is still expired and the next recoverer takes it.
//
// The tenant cap: a `running`/`committing` job whose lease expired still counts as active until it is
// recovered; recovery runs before every dequeue, so a slot is held at most one poll past expiry.
import { isTransientDbError, withTransaction, type Pool } from "../queue/index.js";
import { recoveryAction, type RecoverableState, type RecoveryAction } from "../fleet/stateMachine.js";
import type { WorkerLogger } from "./loop.js";

export const DEFAULT_RECOVER_PER_ITERATION = 10;

/** T6.0: one expired lease, oldest first (served by the partial index jobs_lease_expiry). */
export const CLAIM_EXPIRED_SQL = `
SELECT id, state, attempt, max_attempts, fencing_token, lease_owner, commit_intent_at
FROM jobs
WHERE state IN ('running', 'committing', 'verifying') AND lease_expires_at < now()
ORDER BY lease_expires_at, id
LIMIT 1
FOR UPDATE SKIP LOCKED`;

/**
 * T6.1-T6.3: the decided state ($4) and outcome ($5; NULL keeps it, for a requeue), token + 1, lease
 * cleared. The jobs_queued_has_attempts_left CHECK still refuses a requeue with no attempt left (D21).
 */
export const RECOVER_JOB_SQL = `
UPDATE jobs
SET state = $4, outcome = COALESCE($5, outcome), error = $6,
    fencing_token = fencing_token + 1, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND state = $3 AND lease_expires_at < now()
RETURNING fencing_token`;

/** The dead holder's attempt row. */
export const CLOSE_DEAD_ATTEMPT_SQL = `
UPDATE job_attempts
SET ended_at = now(), outcome = 'crashed', error = $3
WHERE job_id = $1 AND fencing_token = $2 AND ended_at IS NULL`;

export interface RecoveredJob {
  jobId: string;
  from: RecoverableState;
  action: RecoveryAction;
  attempt: number;
  maxAttempts: number;
  /** The holder whose lease expired. */
  deadOwner: string | null;
  /** The token before and after (always previous + 1). */
  previousToken: number;
  fencingToken: number;
}

/** T6 for at most one job. null = no expired lease that another recoverer is not already holding. */
export async function recoverOne(pool: Pool, options: { workerId: string }): Promise<RecoveredJob | null> {
  return withTransaction(pool, async (client) => {
    const claimed = await client.query<{
      id: string;
      state: RecoverableState;
      attempt: number;
      max_attempts: number;
      fencing_token: number;
      lease_owner: string | null;
    }>(CLAIM_EXPIRED_SQL);
    const row = claimed.rows[0];
    if (!row) return null;
    const action = recoveryAction({ state: row.state, attempt: row.attempt, maxAttempts: row.max_attempts });
    const updated = await client.query<{ fencing_token: number }>(RECOVER_JOB_SQL, [
      row.id,
      row.fencing_token,
      row.state,
      action.to,
      action.outcome,
      `${action.error} (${action.label}: the lease of ${row.lease_owner ?? "?"} expired; recovered by ${options.workerId})`,
    ]);
    if (updated.rowCount !== 1) {
      // Impossible while we hold the row lock; if it ever happens, roll back and say so loudly.
      throw new Error(`recovery: job ${row.id} changed under its row lock (token ${row.fencing_token}, state ${row.state})`);
    }
    await client.query(CLOSE_DEAD_ATTEMPT_SQL, [
      row.id,
      row.fencing_token,
      `lease expired in ${row.state}; recovered by ${options.workerId} (${action.label} ${action.kind})`,
    ]);
    return {
      jobId: row.id,
      from: row.state,
      action,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      deadOwner: row.lease_owner,
      previousToken: row.fencing_token,
      fencingToken: updated.rows[0]!.fencing_token,
    };
  });
}

/** T6 repeated until nothing is expired or `max` jobs were recovered. */
export async function recoverExpired(
  pool: Pool,
  options: { workerId: string; max?: number; onRecovered?: (r: RecoveredJob) => void },
): Promise<RecoveredJob[]> {
  const max = options.max ?? DEFAULT_RECOVER_PER_ITERATION;
  const out: RecoveredJob[] = [];
  while (out.length < max) {
    const recovered = await recoverOne(pool, { workerId: options.workerId });
    if (!recovered) break;
    out.push(recovered);
    options.onRecovered?.(recovered);
  }
  return out;
}

/**
 * The worker's beforeDequeue (seam 4): recover, log each recovery, and on a TRANSIENT database error
 * log and carry on to the dequeue (which has its own backoff). Any other error is a bug and propagates:
 * the worker exits loudly rather than loop on it.
 */
export function createRecoverySweep(options: {
  pool: Pool;
  workerId: string;
  max?: number;
  log?: WorkerLogger;
  onRecovered?: (r: RecoveredJob) => void;
}): () => Promise<void> {
  return async () => {
    try {
      await recoverExpired(options.pool, {
        workerId: options.workerId,
        max: options.max,
        onRecovered: (r) => {
          options.log?.warn(
            {
              workerId: options.workerId,
              jobId: r.jobId,
              from: r.from,
              action: r.action.kind,
              label: r.action.label,
              to: r.action.to,
              attempt: r.attempt,
              deadOwner: r.deadOwner,
              fencingToken: r.fencingToken,
            },
            "worker: recovered an expired lease",
          );
          options.onRecovered?.(r);
        },
      });
    } catch (err) {
      if (!isTransientDbError(err)) throw err;
      options.log?.warn({ workerId: options.workerId, err: (err as Error).message }, "worker: Postgres unavailable during recovery; continuing to dequeue");
    }
  };
}
