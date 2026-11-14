// T6: recovery of expired leases, inside the dequeue loop (docs/plans/step-08.md section 4, seam 4).
// Every worker, on every loop iteration, before dequeue, recovers at most `max` (10) expired jobs, one
// transaction per job, so a backlog cannot starve dequeuing:
//
//   BEGIN
//   T6.0  claim the expired lease with the earliest expiry; rows another recoverer holds are SKIPPED,
//         not waited on (FOR UPDATE SKIP LOCKED): two recoverers never take the same job
//         (a `verifying` job: also read its verify cycle from job_verifications, VERIFY_CYCLE_SQL)
//   decide with the pure recoveryAction(row) (src/fleet/stateMachine.ts): T6.1 requeue, T6.2 fail,
//         T6.4 claim a `committing` job to verify, T6.5 re-claim a dead verifier's job, T6.6 escalate
//         after 3 dead verify phases, T6.7 resume a deferred / handed-off verify. The SQL only executes it.
//   UPDATE jobs: the decided state, fencing_token + 1 (EVERY recovery bumps it, reviewer decision 3,
//         so "the token changed" always means "the old holder is fenced"). T6.1/T6.2/T6.6 clear the
//         lease; T6.4/T6.5/T6.7 make THIS worker the owner with a fresh lease. Fenced on the claimed
//         token and state and re-checked expired (database clock, D22).
//   UPDATE job_attempts: the dead holder's open attempt row -> crashed
//   UPDATE job_verifications: the dead verifier's open phase row -> crashed
//   INSERT job_verifications (T6.4/T6.5/T6.7): this worker's new phase
//   COMMIT
//
// A claim to verify ends the sweep: that job is this iteration's work (the worker verifies it at once,
// under a heartbeat). A kill in the middle (crash point recover-in-transaction) rolls the transaction
// back and Postgres releases the row lock when the connection drops: the job is still expired and the
// next recoverer takes it.
//
// The tenant cap: a `running`/`committing`/`verifying` job whose lease expired still counts as active
// until it is recovered; recovery runs before every dequeue, so a slot is held at most one poll past
// expiry. A verify claim keeps the job active (never more than the cap).
import { isTransientDbError, withTransaction, type JobRow, type Pool } from "../queue/index.js";
import {
  EMPTY_VERIFY_CYCLE,
  recoveryAction,
  type PriorStatus,
  type RecoverableState,
  type RecoveryAction,
  type VerifyCycle,
} from "../fleet/stateMachine.js";
import type { WorkerLogger } from "./loop.js";
import { claimReconcile, type ReconcileClaim } from "./reconcile.js";
import { INSERT_PHASE_SQL, readVerifyCycle } from "./verifySql.js";
import { NO_FAULT, type FaultInjector } from "./fault.js";

export const DEFAULT_RECOVER_PER_ITERATION = 10;

/** T6.0: one expired lease, oldest first (served by the partial index jobs_lease_expiry). */
export const CLAIM_EXPIRED_SQL = `
SELECT id, state, attempt, max_attempts, fencing_token, lease_owner, commit_intent_at, tenant_id, params, memo_key
FROM jobs
WHERE state IN ('running', 'committing', 'verifying') AND lease_expires_at < now()
ORDER BY lease_expires_at, id
LIMIT 1
FOR UPDATE SKIP LOCKED`;

/**
 * T6.1/T6.2/T6.6: the decided state ($4) and outcome ($5; NULL keeps it, for a requeue), token + 1,
 * lease cleared. The jobs_queued_has_attempts_left CHECK still refuses a requeue with no attempt left (D21).
 * A crash requeue (T6.1) does not back off (not_before NULL, D49): the bank did nothing wrong, and the
 * lease expiry already cost a full lease.
 */
export const RECOVER_JOB_SQL = `
UPDATE jobs
SET state = $4, outcome = COALESCE($5, outcome), error = $6, not_before = NULL,
    fencing_token = fencing_token + 1, lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND state = $3 AND lease_expires_at < now()
RETURNING fencing_token`;

/**
 * T6.4/T6.5/T6.7: claim to verify. This worker becomes the owner with a fresh lease (its verify phase
 * runs under a heartbeat on the new token); outcome commit_uncertain while it verifies.
 */
export const CLAIM_TO_VERIFY_SQL = `
UPDATE jobs
SET state = 'verifying', outcome = 'commit_uncertain', error = $6,
    fencing_token = fencing_token + 1, lease_owner = $4, lease_expires_at = now() + make_interval(secs => $5), updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND state = $3 AND lease_expires_at < now()
RETURNING fencing_token`;

/** The dead holder's attempt row. */
export const CLOSE_DEAD_ATTEMPT_SQL = `
UPDATE job_attempts
SET ended_at = now(), outcome = 'crashed', error = $3
WHERE job_id = $1 AND fencing_token = $2 AND ended_at IS NULL`;

/** The dead verifier's phase row (only an open one: a deferred or handed-off phase is already closed). */
export const CLOSE_DEAD_PHASE_SQL = `
UPDATE job_verifications
SET ended_at = now(), decision = 'crashed', error = $3
WHERE job_id = $1 AND fencing_token = $2 AND ended_at IS NULL`;

/** The job a recovery claimed to verify: what the verify phase needs. */
export interface VerifyClaim {
  job: Pick<JobRow, "id" | "tenant_id" | "params" | "memo_key" | "attempt" | "max_attempts">;
  /** This phase's token (the new one). */
  fencingToken: number;
  /** How the phase began. */
  label: "T5" | "T6.4" | "T6.5" | "T6.7";
  priorStatus: PriorStatus;
}

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
  /** A verifying job's cycle as recovery read it (dead phases, deferrals...). */
  verifyCycle?: VerifyCycle;
  /** T6.4/T6.5/T6.7: this worker now holds the job to verify it. */
  claim?: VerifyClaim;
}

export interface RecoverOptions {
  workerId: string;
  /** The lease a verify claim takes (the worker's lease). */
  leaseSeconds: number;
  /** Test-only crash point recover-in-transaction: after the claim's updates, before COMMIT (D34). */
  fault?: FaultInjector;
}

/** T6 for at most one job. null = no expired lease that another recoverer is not already holding. */
export async function recoverOne(pool: Pool, options: RecoverOptions): Promise<RecoveredJob | null> {
  return withTransaction(pool, async (client) => {
    const claimed = await client.query<{
      id: string;
      state: RecoverableState;
      attempt: number;
      max_attempts: number;
      fencing_token: number;
      lease_owner: string | null;
      tenant_id: string;
      params: Record<string, unknown>;
      memo_key: string;
    }>(CLAIM_EXPIRED_SQL);
    const row = claimed.rows[0];
    if (!row) return null;
    // The row is locked; its job_verifications rows are only written by holders of its token, which
    // can no longer commit anything but their own phase's lease_lost note (dead either way).
    const cycle = row.state === "verifying" ? await readVerifyCycle(client, row.id) : EMPTY_VERIFY_CYCLE;
    const action = recoveryAction({
      state: row.state,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      verify: row.state === "verifying" ? cycle : undefined,
    });
    const note = `${action.error} (${action.label}: the lease of ${row.lease_owner ?? "?"} expired; recovered by ${options.workerId})`;
    const updated =
      action.kind === "verify"
        ? await client.query<{ fencing_token: number }>(CLAIM_TO_VERIFY_SQL, [
            row.id,
            row.fencing_token,
            row.state,
            options.workerId,
            options.leaseSeconds,
            note,
          ])
        : await client.query<{ fencing_token: number }>(RECOVER_JOB_SQL, [row.id, row.fencing_token, row.state, action.to, action.outcome, note]);
    if (updated.rowCount !== 1) {
      // Impossible while we hold the row lock; if it ever happens, roll back and say so loudly.
      throw new Error(`recovery: job ${row.id} changed under its row lock (token ${row.fencing_token}, state ${row.state})`);
    }
    const token = updated.rows[0]!.fencing_token;
    const dead = `lease expired in ${row.state}; recovered by ${options.workerId} (${action.label} ${action.kind})`;
    await client.query(CLOSE_DEAD_ATTEMPT_SQL, [row.id, row.fencing_token, dead]);
    await client.query(CLOSE_DEAD_PHASE_SQL, [row.id, row.fencing_token, dead]);
    let claim: VerifyClaim | undefined;
    if (action.kind === "verify") {
      const priorStatus = action.reason === "lease_expired_in_committing" ? null : cycle.priorStatus;
      await client.query(INSERT_PHASE_SQL, [row.id, token, options.workerId, action.reason, priorStatus]);
      claim = {
        job: { id: row.id, tenant_id: row.tenant_id, params: row.params, memo_key: row.memo_key, attempt: row.attempt, max_attempts: row.max_attempts },
        fencingToken: token,
        label: action.label,
        priorStatus,
      };
    }
    // Crash point: everything written, nothing committed. The kill drops the connection: rollback.
    (options.fault ?? NO_FAULT).at("recover-in-transaction");
    return {
      jobId: row.id,
      from: row.state,
      action,
      attempt: row.attempt,
      maxAttempts: row.max_attempts,
      deadOwner: row.lease_owner,
      previousToken: row.fencing_token,
      fencingToken: token,
      verifyCycle: row.state === "verifying" ? cycle : undefined,
      claim,
    };
  });
}

/**
 * T6 repeated until nothing is expired, `max` jobs were recovered, or one was claimed to verify (that
 * job is this iteration's work: the caller verifies it now).
 */
export async function recoverExpired(
  pool: Pool,
  options: RecoverOptions & { max?: number; onRecovered?: (r: RecoveredJob) => void },
): Promise<{ recovered: RecoveredJob[]; claim: VerifyClaim | null }> {
  const max = options.max ?? DEFAULT_RECOVER_PER_ITERATION;
  const recovered: RecoveredJob[] = [];
  while (recovered.length < max) {
    const r = await recoverOne(pool, options);
    if (!r) break;
    recovered.push(r);
    options.onRecovered?.(r);
    if (r.claim) return { recovered, claim: r.claim };
  }
  return { recovered, claim: null };
}

/**
 * The worker's beforeDequeue (seam 4): recover, log each recovery, and on a TRANSIENT database error
 * log and carry on to the dequeue (which has its own backoff). Any other error is a bug and propagates:
 * the worker exits loudly rather than loop on it. Resolves with the job claimed to verify, if any; with
 * `reconcile`, when nothing was claimed to verify, with at most ONE due reconcile (R1, Step 10, D50).
 */
export function createRecoverySweep(options: {
  pool: Pool;
  workerId: string;
  leaseSeconds: number;
  max?: number;
  log?: WorkerLogger;
  fault?: FaultInjector;
  onRecovered?: (r: RecoveredJob) => void;
  /** Also claim one due reconcile (R1) when recovery claimed nothing to verify. The entrypoint sets it. */
  reconcile?: boolean;
}): () => Promise<VerifyClaim | ReconcileClaim | null> {
  return async () => {
    try {
      const { claim } = await recoverExpired(options.pool, {
        workerId: options.workerId,
        leaseSeconds: options.leaseSeconds,
        fault: options.fault,
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
              ...(r.verifyCycle ? { deadVerifyPhases: r.verifyCycle.deadPhases, deferrals: r.verifyCycle.deferrals } : {}),
            },
            r.claim ? "worker: recovered an expired lease and claimed the job to verify it" : "worker: recovered an expired lease",
          );
          options.onRecovered?.(r);
        },
      });
      if (claim || !options.reconcile) return claim;
      const due = await claimReconcile(options.pool, { workerId: options.workerId, leaseSeconds: options.leaseSeconds });
      if (due) options.log?.info({ workerId: options.workerId, jobId: due.job.id, fencingToken: due.fencingToken }, "worker: a job that succeeded after a resubmit is due; reconciling it (R1)");
      return due;
    } catch (err) {
      if (!isTransientDbError(err)) throw err;
      options.log?.warn({ workerId: options.workerId, err: (err as Error).message }, "worker: Postgres unavailable during recovery; continuing to dequeue");
      return null;
    }
  };
}
