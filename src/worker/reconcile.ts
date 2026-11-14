// The reconcile pass (Step 10: docs/plans/step-10.md section 2; reviewer decisions 3 and 5; D50, D51).
// Verify + resubmit reopens the zombie window: a worker frozen after its intent can click after another
// worker verified [0, 0] and resubmitted. The window is not closed; it is made LOUD. A job that SUCCEEDED
// AFTER A RESUBMIT is marked by T4 / T7 (reconcile_after = now() + lease + settle + margin), and once it is
// due, one worker re-reads the bank's history for its memo_key:
//
//   R1  claim (RECONCILE_CLAIM_SQL, in the worker's beforeDequeue after the recovery sweep, at most one
//       per loop iteration): the job STAYS succeeded; the reconcile lease lives in lease_owner /
//       lease_expires_at (jobs_lease_pair holds; jobs_active_has_owner does not apply to succeeded);
//       token + 1; a job_verifications row with reason 'reconcile'. A dead reconciler's open row is closed
//       `crashed`, and its expired lease is simply claimable again here (T6 only looks at active states).
//   one lookup (the verify lookup, 1.2.0; one retry if transient). No heartbeat: a lookup takes about a
//       second against the lease, and a reconciler whose lease expired is fenced out by the next claim's
//       token bump and simply runs again (it is read-only).
//   decide with the pure reconcileDecision (src/fleet/stateMachine.ts)
//   R2  write it (RECONCILE_RESULT_SQL), fenced on (id, token, owner, state succeeded): reconciled (stays
//       succeeded), duplicate_suspected / reconcile_unreadable (needs_human, result.reconcile kept), or
//       reconcile_deferred (reconcile_after moves by D44's backoff). 0 rows -> readFence (D41).
//
// The end-of-day batch (reviewer decision 5, D51): `rote reconcile --since <duration>` runs the same phase
// for every succeeded-after-resubmit job in the window, regardless of reconciled_at (RECONCILE_CLAIM_JOB_SQL
// claims one job by id), so a zombie that clicked after the pass ran is still found. Read-only toward the
// bank: only the lookup, never approveRisky.
import type { JobRow, Pool, Queryable } from "../queue/index.js";
import { withTransaction } from "../queue/index.js";
import {
  DEFAULT_DEFER_CONFIG,
  lookupsColumn,
  reconcileDecision,
  reconcileResultPatch,
  type LookupReading,
  type ReconcileDecision,
} from "../fleet/stateMachine.js";
import { retryTransient, type FencedOutReason } from "./complete.js";
import { NO_METRICS } from "./metrics.js";
import { createLookup, type VerifyContext } from "./verify.js";
import { END_PHASE_SQL, fencedOutPhase, type FencedWrite } from "./verifySql.js";

/** R1, the worker's claim: the due job with the earliest reconcile_after that nobody holds. */
export const RECONCILE_CLAIM_SQL = `
SELECT id, fencing_token, tenant_id, params, memo_key, attempt, max_attempts, result
FROM jobs
WHERE state = 'succeeded' AND reconciled_at IS NULL AND reconcile_after <= now()
  AND (lease_expires_at IS NULL OR lease_expires_at < now())
ORDER BY reconcile_after, id
LIMIT 1
FOR UPDATE SKIP LOCKED`;

/** The batch's claim of one job (rote reconcile --since): regardless of reconciled_at. */
export const RECONCILE_CLAIM_JOB_SQL = `
SELECT id, fencing_token, tenant_id, params, memo_key, attempt, max_attempts, result
FROM jobs
WHERE id = $1 AND state = 'succeeded' AND reconcile_after IS NOT NULL
  AND (lease_expires_at IS NULL OR lease_expires_at < now())
FOR UPDATE SKIP LOCKED`;

/** A dead reconciler's phase (its lease expired with the row still open). */
export const CLOSE_DEAD_RECONCILE_SQL = `
UPDATE job_verifications SET ended_at = now(), decision = 'crashed', error = $3
WHERE job_id = $1 AND fencing_token = $2 AND ended_at IS NULL`;

export const RECONCILE_LEASE_SQL = `
UPDATE jobs SET fencing_token = fencing_token + 1, lease_owner = $3,
       lease_expires_at = now() + make_interval(secs => $4), updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND state = 'succeeded'
RETURNING fencing_token`;

export const INSERT_RECONCILE_PHASE_SQL = `
INSERT INTO job_verifications (job_id, fencing_token, worker_id, reason) VALUES ($1, $2, $3, 'reconcile')`;

/**
 * R2. $4 = the job's state (succeeded | needs_human), $5 outcome, $6 error, $7 the result.reconcile patch,
 * $8 the decision, $9 the deferral's backoff in seconds (reconcile_deferred only).
 */
export const RECONCILE_RESULT_SQL = `
UPDATE jobs
SET state = $4,
    outcome = CASE WHEN $4 = 'needs_human' THEN $5 ELSE outcome END,
    error = CASE WHEN $4 = 'needs_human' THEN $6 ELSE error END,
    result = CASE WHEN $4 = 'needs_human' THEN COALESCE(result, '{}'::jsonb) || jsonb_build_object('reconcile', $7::jsonb) ELSE result END,
    reconciled_at = CASE WHEN $8 = 'reconcile_deferred' THEN reconciled_at ELSE now() END,
    reconcile_after = CASE WHEN $8 = 'reconcile_deferred' THEN now() + make_interval(secs => $9) ELSE reconcile_after END,
    lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND state = 'succeeded'
  AND $4 IN ('succeeded', 'needs_human')
RETURNING id`;

/** The job's reconcile deferrals: how many, and seconds since the first one ended (database clock). */
export const RECONCILE_CYCLE_SQL = `
SELECT count(*) FILTER (WHERE decision = 'reconcile_deferred')::int AS deferrals,
       EXTRACT(EPOCH FROM now() - min(ended_at) FILTER (WHERE decision = 'reconcile_deferred'))::float8 AS deferred_for_seconds
FROM job_verifications WHERE job_id = $1 AND reason = 'reconcile'`;

export interface ReconcileClaim {
  label: "R1";
  job: Pick<JobRow, "id" | "tenant_id" | "params" | "memo_key" | "attempt" | "max_attempts">;
  /** This run's token (the new one). */
  fencingToken: number;
  /** The job's own result.outputs.confirmationRef, for the record. */
  confirmationRef: string | null;
}

type ClaimRow = {
  id: string;
  fencing_token: number;
  tenant_id: string;
  params: Record<string, unknown>;
  memo_key: string;
  attempt: number;
  max_attempts: number;
  result: unknown;
};

function confirmationRefOf(result: unknown): string | null {
  const ref = (result as { outputs?: { confirmationRef?: unknown } } | null)?.outputs?.confirmationRef;
  return typeof ref === "string" ? ref : null;
}

async function leaseFor(client: Queryable, row: ClaimRow, workerId: string, leaseSeconds: number): Promise<ReconcileClaim> {
  await client.query(CLOSE_DEAD_RECONCILE_SQL, [row.id, row.fencing_token, `reconcile lease expired; re-claimed by ${workerId}`]);
  const updated = await client.query<{ fencing_token: number }>(RECONCILE_LEASE_SQL, [row.id, row.fencing_token, workerId, leaseSeconds]);
  if (updated.rowCount !== 1) throw new Error(`reconcile: job ${row.id} changed under its row lock (token ${row.fencing_token})`);
  const token = updated.rows[0]!.fencing_token;
  await client.query(INSERT_RECONCILE_PHASE_SQL, [row.id, token, workerId]);
  return {
    label: "R1",
    job: { id: row.id, tenant_id: row.tenant_id, params: row.params, memo_key: row.memo_key, attempt: row.attempt, max_attempts: row.max_attempts },
    fencingToken: token,
    confirmationRef: confirmationRefOf(row.result),
  };
}

/** R1: claims the earliest due job nobody holds; null when none is due. */
export async function claimReconcile(pool: Pool, input: { workerId: string; leaseSeconds: number }): Promise<ReconcileClaim | null> {
  return withTransaction(pool, async (client) => {
    const row = (await client.query<ClaimRow>(RECONCILE_CLAIM_SQL)).rows[0];
    return row ? leaseFor(client, row, input.workerId, input.leaseSeconds) : null;
  });
}

/** The batch's claim of ONE job by id, regardless of reconciled_at; null if it is not succeeded or someone holds it. */
export async function claimReconcileJob(pool: Pool, input: { jobId: string; workerId: string; leaseSeconds: number }): Promise<ReconcileClaim | null> {
  return withTransaction(pool, async (client) => {
    const row = (await client.query<ClaimRow>(RECONCILE_CLAIM_JOB_SQL, [input.jobId])).rows[0];
    return row ? leaseFor(client, row, input.workerId, input.leaseSeconds) : null;
  });
}

export async function readReconcileCycle(db: Queryable, jobId: string): Promise<{ deferrals: number; deferredForSeconds: number | null }> {
  const row = (await db.query<{ deferrals: number; deferred_for_seconds: number | null }>(RECONCILE_CYCLE_SQL, [jobId])).rows[0]!;
  return { deferrals: row.deferrals, deferredForSeconds: row.deferred_for_seconds };
}

/** R2 + the phase row. */
export async function writeReconcileResult(
  pool: Pool,
  input: { jobId: string; fencingToken: number; workerId: string; decision: ReconcileDecision; lookups: Array<number | null>; evidenceRefs: Array<string | null>; patch: Record<string, unknown> },
): Promise<FencedWrite<object>> {
  const d = input.decision;
  return withTransaction(pool, async (client) => {
    const updated = await client.query(RECONCILE_RESULT_SQL, [
      input.jobId,
      input.fencingToken,
      input.workerId,
      d.to,
      d.outcome,
      d.error,
      JSON.stringify({ ...input.patch, lookups: input.lookups, evidenceRefs: input.evidenceRefs, phaseToken: input.fencingToken }),
      d.decision,
      d.decision === "reconcile_deferred" ? d.backoffSeconds : null,
    ]);
    if (updated.rowCount === 1) {
      await client.query(END_PHASE_SQL, [input.jobId, input.fencingToken, input.lookups, d.decision, d.error]);
      return { recorded: true };
    }
    return fencedOutPhase(client, { jobId: input.jobId, fencingToken: input.fencingToken, workerId: input.workerId, lookups: input.lookups, evidenceRefs: input.evidenceRefs }, `R2 (${d.decision})`);
  });
}

export interface ReconcilePhaseOutcome {
  claim: ReconcileClaim;
  reading: LookupReading | null;
  decision: ReconcileDecision | null;
  recorded: boolean;
  fencedOut?: FencedOutReason;
  durationMs: number;
}

// ------------------------------------------------------------------------------- the end-of-day batch

/**
 * The batch's window (rote reconcile --since): every job that succeeded after a resubmit (reconcile_after
 * set) and is still succeeded, whose reconcile_after is inside the window. reconcile_after is the success
 * moment + the reconcile delay (moved later by a deferral), so the window reaches back `since` plus one
 * delay: a few more jobs than strictly "succeeded in the window", never fewer (it is read-only).
 */
export const RECONCILE_WINDOW_SQL = `
SELECT id, tenant_id, reconcile_after, reconciled_at, (reconciled_at IS NULL AND reconcile_after > now()) AS not_due
FROM jobs
WHERE state = 'succeeded' AND reconcile_after IS NOT NULL
  AND reconcile_after > now() - make_interval(secs => $1)
  AND ($2::text IS NULL OR tenant_id = $2)
ORDER BY reconcile_after, id`;

/** "90s", "30m", "24h", "2d" (or a bare number of seconds) -> seconds. */
export function parseDurationSeconds(value: string): number {
  const m = /^(\d+(?:\.\d+)?)(s|m|h|d)?$/.exec(value.trim());
  if (!m) throw new RangeError(`not a duration: "${value}" (use e.g. 90s, 30m, 24h, 2d)`);
  const seconds = Number(m[1]) * { s: 1, m: 60, h: 3600, d: 86_400 }[(m[2] ?? "s") as "s" | "m" | "h" | "d"];
  if (!(seconds > 0)) throw new RangeError(`the duration must be positive (got "${value}")`);
  return seconds;
}

export type BatchRowResult = ReconcileDecision["decision"] | "not_due" | "busy" | "not_recorded";

export interface BatchRow {
  jobId: string;
  tenant: string;
  /** The decision R2 recorded; not_due (the workers' pass has not run yet, skipped); busy (someone holds it); not_recorded (fenced out / stopped). */
  result: BatchRowResult;
  wasReconciledAt: Date | null;
  matches: number | null;
  detail: string | null;
}

export interface BatchReport {
  sinceSeconds: number;
  rows: BatchRow[];
  /** duplicate_suspected + reconcile_unreadable: jobs moved to needs_human by this run. */
  flagged: number;
  /** reconcile_deferred + busy + not_recorded: jobs this run could not decide (run it again). */
  undecided: number;
}

/**
 * `rote reconcile --since <duration>` (reviewer decision 5, D51): runs the reconcile phase (claim by id,
 * one lookup, R2) on every job in the window that succeeded after a resubmit, REGARDLESS of reconciled_at,
 * one at a time. A job the workers' pass has not reached yet (not due) is left to it.
 */
export async function reconcileWindow(ctx: VerifyContext, input: { sinceSeconds: number; tenant?: string }): Promise<BatchReport> {
  const candidates = (
    await ctx.pool.query<{ id: string; tenant_id: string; reconciled_at: Date | null; not_due: boolean }>(RECONCILE_WINDOW_SQL, [input.sinceSeconds, input.tenant ?? null])
  ).rows;
  const rows: BatchRow[] = [];
  for (const c of candidates) {
    const base = { jobId: c.id, tenant: c.tenant_id, wasReconciledAt: c.reconciled_at };
    if (c.not_due) {
      rows.push({ ...base, result: "not_due", matches: null, detail: "the workers' reconcile pass is not due yet; left to it" });
      continue;
    }
    const claim = await claimReconcileJob(ctx.pool, { jobId: c.id, workerId: ctx.workerId, leaseSeconds: ctx.leaseSeconds });
    if (!claim) {
      rows.push({ ...base, result: "busy", matches: null, detail: "held by another reconciler, or no longer succeeded" });
      continue;
    }
    const done = await runReconcilePhase(ctx, claim);
    const d = done.decision;
    rows.push({
      ...base,
      result: done.recorded && d ? d.decision : "not_recorded",
      matches: d && "matches" in d ? d.matches : null,
      detail: d?.error ?? (done.recorded ? null : done.fencedOut ?? "stopped"),
    });
  }
  return {
    sinceSeconds: input.sinceSeconds,
    rows,
    flagged: rows.filter((r) => r.result === "duplicate_suspected" || r.result === "reconcile_unreadable").length,
    undecided: rows.filter((r) => r.result === "reconcile_deferred" || r.result === "busy" || r.result === "not_recorded").length,
  };
}

/** One reconcile run on a job this worker (or the batch) claimed. */
export async function runReconcilePhase(
  ctx: VerifyContext,
  claim: ReconcileClaim,
  controller: AbortController = new AbortController(),
  hardSignal?: AbortSignal,
): Promise<ReconcilePhaseOutcome> {
  const started = Date.now();
  const metrics = ctx.metrics ?? NO_METRICS;
  const log = { workerId: ctx.workerId, jobId: claim.job.id, tenant: claim.job.tenant_id, label: claim.label, fencingToken: claim.fencingToken };
  const done = (rest: Omit<ReconcilePhaseOutcome, "claim" | "durationMs">): ReconcilePhaseOutcome => ({ claim, durationMs: Date.now() - started, ...rest });
  ctx.log?.info(log, "reconcile: started");
  let reading: LookupReading | null = null;
  try {
    reading = await createLookup(ctx, claim, controller).withRetry();
    const cycle = await retryTransient(() => readReconcileCycle(ctx.pool, claim.job.id), { signal: hardSignal });
    if (cycle === null) return done({ reading, decision: null, recorded: false });
    const decision = reconcileDecision({ reading, deferrals: cycle.deferrals, deferredForSeconds: cycle.deferredForSeconds, defer: ctx.defer ?? DEFAULT_DEFER_CONFIG });
    controller.signal.throwIfAborted();
    const lookups = lookupsColumn([reading]);
    const written = await retryTransient(
      () =>
        writeReconcileResult(ctx.pool, {
          jobId: claim.job.id,
          fencingToken: claim.fencingToken,
          workerId: ctx.workerId,
          decision,
          lookups,
          evidenceRefs: [reading!.evidenceRef],
          patch: reconcileResultPatch(decision, reading!.evidenceRef, claim.confirmationRef),
        }),
      { signal: hardSignal },
    );
    if (written === null) return done({ reading, decision, recorded: false });
    if (!written.recorded) {
      if (written.reason === "illegal_transition") {
        metrics.inc("illegal_transitions_total");
        ctx.log?.error({ ...log, illegal_transition: true, detail: written.detail }, "reconcile: illegal_transition: R2 refused (a bug)");
      } else ctx.log?.warn({ ...log, decision: decision.decision, detail: written.detail }, "reconcile: lease lost; decision NOT recorded");
      return done({ reading, decision, recorded: false, fencedOut: written.reason });
    }
    metrics.inc("reconcile_decisions_total", { decision: decision.decision });
    const fields = { ...log, decision: decision.decision, lookups, ms: Date.now() - started };
    if (decision.decision === "duplicate_suspected") {
      metrics.inc("duplicates_detected_total");
      ctx.log?.error(
        { ...fields, matches: decision.matches, firstMatchRef: decision.firstMatchRef, jobConfirmationRef: claim.confirmationRef, duplicates_detected_total: metrics.value?.("duplicates_detected_total") ?? null, error: decision.error },
        "reconcile: DUPLICATE SUSPECTED: the job is needs_human / duplicate_suspected",
      );
    } else if (decision.decision === "reconcile_unreadable") ctx.log?.warn({ ...fields, error: decision.error }, "reconcile: escalated to a human (reconcile_unreadable)");
    else ctx.log?.info(fields, decision.decision === "reconciled" ? "reconcile: reconciled (1 match)" : `reconcile: deferred ${decision.backoffSeconds} s (bank unavailable)`);
    return done({ reading, decision, recorded: true });
  } catch (err) {
    if (controller.signal.aborted) {
      ctx.log?.warn({ ...log, err: String((controller.signal.reason as Error)?.message ?? controller.signal.reason) }, "reconcile: stopped; the next claim after the lease expires runs it again");
      return done({ reading, decision: null, recorded: false });
    }
    throw err;
  }
}
