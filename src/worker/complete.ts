// Recording a job's outcome, FENCED (docs/plans/step-06.md section 3). One transaction:
//   1. UPDATE jobs ... WHERE id AND fencing_token AND lease_owner AND state = 'running'
//   2. UPDATE job_attempts for this (job, fencing_token): ended_at, outcome, commit_uncertain, error
// If (1) matches 0 rows this worker no longer holds the job (Day 2: its lease expired and someone
// else took it): NOTHING is written to jobs, and the attempt is marked lease_lost. A completion from a
// worker that lost the job can never overwrite the new owner's state.
//
// A requeue is the same statement with state = 'queued'; the jobs_queued_has_attempts_left CHECK
// makes it impossible once attempts are exhausted (D21).
import { withTransaction, type Pool } from "../queue/index.js";
import { createBackoff, sleep } from "./backoff.js";
import { isTransientDbError } from "../queue/index.js";
import type { JobOutcome } from "../fleet/stateMachine.js";

export const COMPLETE_JOB_SQL = `
UPDATE jobs
SET state = $4, outcome = $5, error = $6, result = $7::jsonb,
    lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND state = 'running'
RETURNING id`;

export const END_ATTEMPT_SQL = `
UPDATE job_attempts
SET ended_at = now(), outcome = $3, commit_uncertain = $4, error = $5
WHERE job_id = $1 AND fencing_token = $2`;

/**
 * This worker lost the job (its completion was fenced out, or its heartbeat found the lease gone).
 * Recovery may already have closed this attempt row as `crashed`; the worker was alive, so `lease_lost`
 * is the truer label, and recovery's note is kept after the worker's own text.
 */
export const MARK_LEASE_LOST_SQL = `
UPDATE job_attempts
SET ended_at = now(), outcome = 'lease_lost', commit_uncertain = commit_uncertain OR $4,
    error = $3 || COALESCE(' [recovery had recorded: ' || error || ']', '')
WHERE job_id = $1 AND fencing_token = $2`;

export interface CompleteInput {
  jobId: string;
  fencingToken: number;
  workerId: string;
  outcome: JobOutcome;
}

/** recorded: false -> the lease was lost; jobs untouched, the attempt is lease_lost. */
export async function completeJob(pool: Pool, input: CompleteInput): Promise<{ recorded: boolean }> {
  const { outcome } = input;
  return withTransaction(pool, async (client) => {
    const updated = await client.query(COMPLETE_JOB_SQL, [
      input.jobId,
      input.fencingToken,
      input.workerId,
      outcome.state,
      outcome.outcome,
      outcome.error,
      outcome.result === null ? null : JSON.stringify(outcome.result),
    ]);
    const recorded = updated.rowCount === 1;
    if (recorded) {
      await client.query(END_ATTEMPT_SQL, [input.jobId, input.fencingToken, outcome.attemptOutcome, outcome.commitUncertain, outcome.error]);
    } else {
      await client.query(MARK_LEASE_LOST_SQL, [
        input.jobId,
        input.fencingToken,
        `lease lost before completion; this worker's outcome (${outcome.state}/${outcome.outcome ?? "requeue"}) was NOT recorded on the job`,
        outcome.commitUncertain,
      ]);
    }
    return { recorded };
  });
}

/**
 * The heartbeat aborted the run with a LeaseLostError: nothing is written to `jobs` (the job is
 * recovery's now); only this worker's attempt row says what happened.
 */
export async function markAttemptLeaseLost(
  pool: Pool,
  input: { jobId: string; fencingToken: number; detail: string; commitUncertain: boolean },
): Promise<void> {
  await pool.query(MARK_LEASE_LOST_SQL, [input.jobId, input.fencingToken, input.detail, input.commitUncertain]);
}

export interface CompleteRetryOptions {
  /** Stop retrying (the worker is shutting down hard). The job then stays running for Day-2 recovery. */
  signal?: AbortSignal;
  onTransientError?: (err: unknown, attempt: number) => void;
  random?: () => number;
}

/**
 * completeJob, retried with backoff (100 ms .. 5 s, full jitter) while Postgres is TRANSIENTLY
 * unreachable. The outcome is held in memory meanwhile; the job is never re-run to "recover". A fatal
 * error is rethrown. Returns null if `signal` aborted first.
 */
export async function completeJobWithRetry(
  pool: Pool,
  input: CompleteInput,
  options: CompleteRetryOptions = {},
): Promise<{ recorded: boolean } | null> {
  return retryTransient(() => completeJob(pool, input), options);
}

/** `fn`, retried with backoff (100 ms .. 5 s, full jitter) on transient DB errors; null if `signal` aborted first. */
export async function retryTransient<T>(fn: () => Promise<T>, options: CompleteRetryOptions = {}): Promise<T | null> {
  const backoff = createBackoff({ baseMs: 100, capMs: 5000, random: options.random });
  for (let attempt = 1; ; attempt += 1) {
    if (options.signal?.aborted) return null;
    try {
      return await fn();
    } catch (err) {
      if (!isTransientDbError(err)) throw err;
      options.onTransientError?.(err, attempt);
      await sleep(backoff.next(), options.signal);
    }
  }
}
