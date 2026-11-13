// T4: recording a job's outcome, FENCED (docs/plans/step-06.md section 3; widened in
// docs/plans/step-08.md section 3). One transaction:
//   1. UPDATE jobs ... WHERE id AND fencing_token AND lease_owner AND the state guard
//   2. UPDATE job_attempts for this (job, fencing_token): ended_at, outcome, commit_uncertain, error
// If (1) matches 0 rows this worker no longer holds the job (its lease expired and recovery moved it
// on, bumping the token): NOTHING is written to jobs, and the attempt is marked lease_lost. A completion
// from a worker that lost the job can never overwrite the new owner's state.
//
// The state guard is completionAllowed (src/fleet/stateMachine.ts) in SQL: a live owner is `running`
// (before its commit intent) or `committing` (after it). From `running` anything; from `committing`
// only succeeded or needs_human, so not even a buggy caller can requeue or fail a job past its intent.
// T4 does not check the lease's expiry: a holder whose lease ran out but whom nobody recovered is still
// the only one who ran the job, and its outcome is the truth.
//
// A requeue is the same statement with state = 'queued'; the jobs_queued_has_attempts_left CHECK
// makes it impossible once attempts are exhausted (D21).
//
// 0 rows has two causes, told apart by re-reading the job's fencing token in the same transaction
// (step-09 reviewer decision A1, D41):
//   token CHANGED    the lease was lost (recovery moved the job on): `lease_lost`, as before.
//   token UNCHANGED  nobody fenced this worker out, so its own request was refused by the state guard
//                    (completionAllowed): a BUG in the caller, e.g. a requeue past the commit intent.
//                    `illegal_transition` on the attempt row, an error-level log and a counter in the
//                    worker. The job is untouched; its lease expires and recovery handles it.
// Under READ COMMITTED the re-read sees the latest committed row, so a recovery that commits between
// the UPDATE and the re-read is reported as lease_lost: the benign label, in a race that is itself
// harmless (the job is recovery's either way).
import { withTransaction, type Pool, type Queryable } from "../queue/index.js";
import { createBackoff, sleep } from "./backoff.js";
import { isTransientDbError } from "../queue/index.js";
import type { JobOutcome } from "../fleet/stateMachine.js";

export const COMPLETE_JOB_SQL = `
UPDATE jobs
SET state = $4, outcome = $5, error = $6, result = $7::jsonb,
    lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3
  AND (state = 'running' OR (state = 'committing' AND $4 IN ('succeeded', 'needs_human')))
  AND $4 IN ('succeeded', 'business_outcome', 'failed', 'needs_human', 'queued')
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

/** The re-read after a fenced write matched 0 rows: is the token still the one this worker presented? */
export const READ_FENCE_SQL = `SELECT fencing_token, lease_owner, state FROM jobs WHERE id = $1`;

/**
 * The token did not move: this worker's own request was refused by the state guard (a bug). Only an
 * attempt row that is still open is closed; a row the worker already closed (a second completion of
 * the same lease) keeps what was first recorded -- the log line and the counter still fire.
 */
export const MARK_ILLEGAL_TRANSITION_SQL = `
UPDATE job_attempts
SET ended_at = now(), outcome = 'illegal_transition', commit_uncertain = commit_uncertain OR $4, error = $3
WHERE job_id = $1 AND fencing_token = $2 AND ended_at IS NULL`;

export type FencedOutReason = "lease_lost" | "illegal_transition";

export interface FenceReading {
  reason: FencedOutReason;
  /** What the job looked like at the re-read (for the log line and the attempt's error text). */
  current: { fencingToken: number; leaseOwner: string | null; state: string } | null;
}

/** After a fenced write matched 0 rows: lease_lost if the token moved (or the job is gone), else illegal_transition. */
export async function readFence(db: Queryable, jobId: string, presentedToken: number): Promise<FenceReading> {
  const row = (await db.query<{ fencing_token: number; lease_owner: string | null; state: string }>(READ_FENCE_SQL, [jobId])).rows[0];
  if (!row) return { reason: "lease_lost", current: null };
  const current = { fencingToken: row.fencing_token, leaseOwner: row.lease_owner, state: row.state };
  return { reason: row.fencing_token === presentedToken ? "illegal_transition" : "lease_lost", current };
}

export function describeFence(f: FenceReading): string {
  return f.current
    ? `the job is ${f.current.state} with token ${f.current.fencingToken}, owner ${f.current.leaseOwner ?? "none"}`
    : "the job no longer exists";
}

export interface CompleteInput {
  jobId: string;
  fencingToken: number;
  workerId: string;
  outcome: JobOutcome;
}

export type CompletionResult =
  | { recorded: true }
  /** jobs untouched. lease_lost: the attempt is lease_lost. illegal_transition: a bug; the attempt says so. */
  | { recorded: false; reason: FencedOutReason; detail: string };

export async function completeJob(pool: Pool, input: CompleteInput): Promise<CompletionResult> {
  const { outcome } = input;
  // A run that may have committed is moved into verify by T5 (src/worker/verifySql.ts), never by T4.
  if (outcome.state === "verifying") throw new Error("completeJob (T4) never writes verifying: use completeIntoVerify (T5)");
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
    if (updated.rowCount === 1) {
      await client.query(END_ATTEMPT_SQL, [input.jobId, input.fencingToken, outcome.attemptOutcome, outcome.commitUncertain, outcome.error]);
      return { recorded: true };
    }
    const fence = await readFence(client, input.jobId, input.fencingToken);
    const wanted = `${outcome.state}/${outcome.outcome ?? "requeue"}`;
    if (fence.reason === "illegal_transition") {
      const detail =
        `illegal_transition: T4 refused ${wanted} although the fencing token ${input.fencingToken} is unchanged ` +
        `(${describeFence(fence)}): the state guard forbids it; nothing recorded on the job, recovery will handle it after the lease expires`;
      await client.query(MARK_ILLEGAL_TRANSITION_SQL, [input.jobId, input.fencingToken, detail, outcome.commitUncertain]);
      return { recorded: false, reason: "illegal_transition", detail };
    }
    const stored = `lease lost before completion; this worker's outcome (${wanted}) was NOT recorded on the job`;
    await client.query(MARK_LEASE_LOST_SQL, [input.jobId, input.fencingToken, stored, outcome.commitUncertain]);
    return { recorded: false, reason: "lease_lost", detail: `${stored} (${describeFence(fence)})` };
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
): Promise<CompletionResult | null> {
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
