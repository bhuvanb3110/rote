// The verify transactions (Step 9: docs/plans/step-08.md section 5; step-09 reviewer decisions 4-5;
// D43-D46). The decisions are made by the pure functions in src/fleet/stateMachine.ts
// (jobOutcomeFor -> T5, verifyDecision -> T7/T8, recoveryAction -> T6.4-T6.7); these statements execute
// them and repeat their guards, exactly like T2-T4 and T6 (D39). src/fleet/model.ts mirrors each one.
//
//   T5  COMPLETE_INTO_VERIFY_SQL  the live owner whose run may have committed moves the job into its own
//                                 verify phase: running/committing -> verifying, token + 1, a fresh lease,
//                                 its attempt row closed, a job_verifications row (starts a verify cycle)
//   T7  VERIFY_RESULT_SQL         the verifier writes its decision and releases the job (a resubmit
//                                 clears commit_intent_at, and is dequeueable at once: not_before NULL,
//                                 D49); its phase row gets the decision and lookups
//   T8  VERIFY_DEFER_SQL          the bank is unavailable: the job STAYS verifying, token + 1 (the
//                                 deferring verifier is fenced out of its own job), the lease set to
//                                 now + the backoff, lease_owner kept (jobs_active_has_owner); recovery
//                                 resumes it (T6.7) once the backoff has passed. Not a dead phase.
//   VERIFY_CYCLE_SQL              the job's current verify cycle, derived from job_verifications
//   REVERIFY_SQL                  rote jobs reverify: a needs_human job that "could not tell" is handed
//                                 to recovery (verifying, lease already expired, a `handed_off` row)
//
// Every write is fenced on (id, fencing_token, lease_owner, state). 0 rows -> readFence (D41): the token
// moved = lease_lost; unchanged = illegal_transition (a bug). Times are the database's (D22): backoffs
// and leases are durations the SQL adds to now(); the cycle's "deferred for" is computed by the SQL.
import { withTransaction, type Pool, type Queryable } from "../queue/index.js";
import {
  REVERIFIABLE_OUTCOMES,
  type JobOutcome,
  type PhaseDecision,
  type PriorStatus,
  type VerifyCycle,
  type VerifyDecision,
} from "../fleet/stateMachine.js";
import { END_ATTEMPT_SQL, MARK_ILLEGAL_TRANSITION_SQL, MARK_LEASE_LOST_SQL, describeFence, readFence, type FencedOutReason } from "./complete.js";

// ------------------------------------------------------------------------------------------- cycle

/**
 * The phases since the newest one whose reason starts a cycle (commit_uncertain: T5 or reverify;
 * lease_expired_in_committing: T6.4), or all of them when none does. Dead = still open, crashed,
 * lease_lost or illegal_transition. "Deferred for" = now() - the end of the cycle's first deferral.
 */
export const VERIFY_CYCLE_SQL = `
WITH start AS (
  SELECT COALESCE(max(id), 0) AS id FROM job_verifications
  WHERE job_id = $1 AND reason IN ('commit_uncertain', 'lease_expired_in_committing')
), cycle AS (
  SELECT v.id, v.decision, v.ended_at FROM job_verifications v, start WHERE v.job_id = $1 AND v.id >= start.id
)
SELECT
  (SELECT count(*) FROM cycle)::int AS phases,
  (SELECT count(*) FROM cycle WHERE decision IS NULL OR decision IN ('crashed', 'lease_lost', 'illegal_transition'))::int AS dead_phases,
  (SELECT count(*) FROM cycle WHERE decision = 'deferred')::int AS deferrals,
  (SELECT EXTRACT(EPOCH FROM now() - min(ended_at))::float8 FROM cycle WHERE decision = 'deferred') AS deferred_for_seconds,
  (SELECT v.prior_status FROM job_verifications v, start WHERE v.id = start.id) AS prior_status,
  (SELECT decision FROM cycle ORDER BY id DESC LIMIT 1) AS last_decision`;

export async function readVerifyCycle(db: Queryable, jobId: string): Promise<VerifyCycle> {
  const row = (
    await db.query<{
      phases: number;
      dead_phases: number;
      deferrals: number;
      deferred_for_seconds: number | null;
      prior_status: PriorStatus;
      last_decision: PhaseDecision | null;
    }>(VERIFY_CYCLE_SQL, [jobId])
  ).rows[0]!;
  return {
    phases: row.phases,
    deadPhases: row.dead_phases,
    deferrals: row.deferrals,
    deferredForSeconds: row.deferred_for_seconds,
    priorStatus: row.prior_status,
    lastDecision: row.last_decision,
  };
}

/** A verifier fenced out of its own phase: its row says lease_lost (keeping recovery's note) or illegal_transition. */
export const MARK_PHASE_FENCED_OUT_SQL = `
UPDATE job_verifications
SET decision = $3, ended_at = COALESCE(ended_at, now()),
    error = $4 || COALESCE(' [recovery had recorded: ' || error || ']', '')
WHERE job_id = $1 AND fencing_token = $2 AND (decision IS NULL OR ($3 = 'lease_lost' AND decision = 'crashed'))`;

export async function markPhaseFencedOut(
  db: Queryable,
  input: { jobId: string; fencingToken: number; how: FencedOutReason; detail: string },
): Promise<void> {
  await db.query(MARK_PHASE_FENCED_OUT_SQL, [input.jobId, input.fencingToken, input.how, input.detail]);
}

// ---------------------------------------------------------------------------------------------- T5

export const COMPLETE_INTO_VERIFY_SQL = `
UPDATE jobs
SET state = 'verifying', outcome = 'commit_uncertain', error = $5, result = $6::jsonb,
    fencing_token = fencing_token + 1, lease_expires_at = now() + make_interval(secs => $4), updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND state IN ('running', 'committing')
RETURNING fencing_token`;

export const INSERT_PHASE_SQL = `
INSERT INTO job_verifications (job_id, fencing_token, worker_id, reason, prior_status)
VALUES ($1, $2, $3, $4, $5)`;

export type FencedWrite<T> = ({ recorded: true } & T) | { recorded: false; reason: FencedOutReason; detail: string };

/** T5. recorded: the job is now this worker's to verify, under `fencingToken`. */
export async function completeIntoVerify(
  pool: Pool,
  input: { jobId: string; fencingToken: number; workerId: string; leaseSeconds: number; outcome: JobOutcome },
): Promise<FencedWrite<{ fencingToken: number }>> {
  const { outcome } = input;
  if (outcome.state !== "verifying") throw new Error(`T5 is only for a verifying outcome (got ${outcome.state})`);
  return withTransaction(pool, async (client) => {
    const updated = await client.query<{ fencing_token: number }>(COMPLETE_INTO_VERIFY_SQL, [
      input.jobId,
      input.fencingToken,
      input.workerId,
      input.leaseSeconds,
      outcome.error,
      outcome.result === null ? null : JSON.stringify(outcome.result),
    ]);
    if (updated.rowCount === 1) {
      const token = updated.rows[0]!.fencing_token;
      await client.query(END_ATTEMPT_SQL, [input.jobId, input.fencingToken, outcome.attemptOutcome, true, outcome.error]);
      await client.query(INSERT_PHASE_SQL, [input.jobId, token, input.workerId, "commit_uncertain", outcome.priorStatus ?? null]);
      return { recorded: true, fencingToken: token };
    }
    const fence = await readFence(client, input.jobId, input.fencingToken);
    if (fence.reason === "illegal_transition") {
      const detail = `illegal_transition: T5 (into verify) refused although the fencing token ${input.fencingToken} is unchanged (${describeFence(fence)})`;
      await client.query(MARK_ILLEGAL_TRANSITION_SQL, [input.jobId, input.fencingToken, detail, true]);
      return { recorded: false, reason: "illegal_transition", detail };
    }
    const stored = "lease lost before completion; this worker's outcome (verifying/commit_uncertain) was NOT recorded on the job";
    await client.query(MARK_LEASE_LOST_SQL, [input.jobId, input.fencingToken, stored, true]);
    return { recorded: false, reason: "lease_lost", detail: `${stored} (${describeFence(fence)})` };
  });
}

// ---------------------------------------------------------------------------------------------- T7

export const VERIFY_RESULT_SQL = `
UPDATE jobs
SET state = $4, outcome = $5, error = $6,
    result = CASE WHEN $4 = 'succeeded' THEN $7::jsonb
                  ELSE COALESCE(result, '{}'::jsonb) || jsonb_build_object('verify', $8::jsonb) END,
    commit_intent_at = CASE WHEN $4 = 'queued' THEN NULL ELSE commit_intent_at END,
    not_before = NULL,
    lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND state = 'verifying'
  AND $4 IN ('succeeded', 'queued', 'failed', 'business_outcome', 'needs_human')
RETURNING id`;

export const END_PHASE_SQL = `
UPDATE job_verifications SET ended_at = now(), lookups = $3::int[], decision = $4, error = $5
WHERE job_id = $1 AND fencing_token = $2`;

export interface VerifyWriteInput {
  jobId: string;
  fencingToken: number;
  workerId: string;
  lookups: Array<number | null>;
  /** Evidence of each lookup, kept on the job for anyone who has to look (ambiguous, unreadable...). */
  evidenceRefs: Array<string | null>;
}

async function fencedOutPhase(
  client: Queryable,
  input: VerifyWriteInput,
  what: string,
): Promise<{ recorded: false; reason: FencedOutReason; detail: string }> {
  const fence = await readFence(client, input.jobId, input.fencingToken);
  const detail =
    fence.reason === "illegal_transition"
      ? `illegal_transition: ${what} refused although the fencing token ${input.fencingToken} is unchanged (${describeFence(fence)})`
      : `lease lost before ${what}; this verifier's decision was NOT recorded on the job (${describeFence(fence)})`;
  await markPhaseFencedOut(client, { jobId: input.jobId, fencingToken: input.fencingToken, how: fence.reason, detail });
  return { recorded: false, reason: fence.reason, detail };
}

/** T7. The decision must not be `deferred` (that is T8). */
export async function writeVerifyResult(
  pool: Pool,
  input: VerifyWriteInput & { decision: Exclude<VerifyDecision, { decision: "deferred" }>; result: unknown },
): Promise<FencedWrite<object>> {
  const d = input.decision;
  return withTransaction(pool, async (client) => {
    const updated = await client.query(VERIFY_RESULT_SQL, [
      input.jobId,
      input.fencingToken,
      input.workerId,
      d.to,
      d.outcome,
      d.error,
      d.to === "succeeded" ? JSON.stringify(input.result) : null,
      JSON.stringify({ decision: d.decision, lookups: input.lookups, evidenceRefs: input.evidenceRefs, phaseToken: input.fencingToken }),
    ]);
    if (updated.rowCount === 1) {
      await client.query(END_PHASE_SQL, [input.jobId, input.fencingToken, input.lookups, d.decision, d.error]);
      return { recorded: true };
    }
    return fencedOutPhase(client, input, `T7 (${d.decision})`);
  });
}

// ---------------------------------------------------------------------------------------------- T8

export const VERIFY_DEFER_SQL = `
UPDATE jobs
SET fencing_token = fencing_token + 1, lease_expires_at = now() + make_interval(secs => $4), error = $5, updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND state = 'verifying'
RETURNING fencing_token`;

/** T8: end this phase `deferred`; the job stays verifying and is resumed (T6.7) after `backoffSeconds`. */
export async function deferVerify(
  pool: Pool,
  input: VerifyWriteInput & { decision: Extract<VerifyDecision, { decision: "deferred" }> },
): Promise<FencedWrite<{ fencingToken: number }>> {
  const d = input.decision;
  return withTransaction(pool, async (client) => {
    const updated = await client.query<{ fencing_token: number }>(VERIFY_DEFER_SQL, [
      input.jobId,
      input.fencingToken,
      input.workerId,
      d.backoffSeconds,
      d.error,
    ]);
    if (updated.rowCount === 1) {
      await client.query(END_PHASE_SQL, [input.jobId, input.fencingToken, input.lookups, "deferred", d.error]);
      return { recorded: true, fencingToken: updated.rows[0]!.fencing_token };
    }
    return fencedOutPhase(client, input, "T8 (deferred)");
  });
}

// ------------------------------------------------------------------------------------------ reverify

export const REVERIFY_SQL = `
UPDATE jobs
SET state = 'verifying', outcome = 'commit_uncertain', fencing_token = fencing_token + 1,
    lease_owner = $3, lease_expires_at = now() - interval '1 second', error = $4, updated_at = now()
WHERE id = $1 AND ($2::text IS NULL OR tenant_id = $2) AND state = 'needs_human' AND outcome = ANY($5::text[])
RETURNING fencing_token, result->>'status' AS prior`;

export const INSERT_HANDED_OFF_PHASE_SQL = `
INSERT INTO job_verifications (job_id, fencing_token, worker_id, reason, prior_status, ended_at, decision, error)
VALUES ($1, $2, $3, 'commit_uncertain', $4, now(), 'handed_off', $5)`;

export type ReverifyResult =
  | { moved: true; fencingToken: number; priorStatus: PriorStatus }
  | { moved: false; why: "not_found" | "not_reverifiable"; state?: string; outcome?: string | null };

/**
 * rote jobs reverify <id>: one needs_human job whose outcome is one of REVERIFIABLE_OUTCOMES is handed to
 * recovery, fenced on its state. Never automatic (a person may already be looking at the job).
 */
export async function reverifyJob(pool: Pool, input: { jobId: string; tenant?: string; who: string }): Promise<ReverifyResult> {
  return withTransaction(pool, async (client) => {
    const note = `reverify requested by ${input.who}: handed to recovery, which verifies it in the bank's history (T6.7)`;
    const updated = await client.query<{ fencing_token: number; prior: string | null }>(REVERIFY_SQL, [
      input.jobId,
      input.tenant ?? null,
      input.who,
      note,
      [...REVERIFIABLE_OUTCOMES],
    ]);
    if (updated.rowCount === 1) {
      const { fencing_token: token, prior } = updated.rows[0]!;
      const priorStatus: PriorStatus = prior === "business_outcome" || prior === "failure" || prior === "needs_human" ? prior : null;
      await client.query(INSERT_HANDED_OFF_PHASE_SQL, [input.jobId, token, input.who, priorStatus, note]);
      return { moved: true, fencingToken: token, priorStatus };
    }
    const row = (
      await client.query<{ state: string; outcome: string | null }>(
        "SELECT state, outcome FROM jobs WHERE id = $1 AND ($2::text IS NULL OR tenant_id = $2)",
        [input.jobId, input.tenant ?? null],
      )
    ).rows[0];
    return row ? { moved: false, why: "not_reverifiable", state: row.state, outcome: row.outcome } : { moved: false, why: "not_found" };
  });
}
