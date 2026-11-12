// A pure model of the `jobs` table under the fleet's SQL (docs/plans/step-08.md section 7, reviewer
// addition R1). Each function mirrors ONE statement's guard and effect, line for line:
//
//   modelDequeue    src/queue/dequeue.ts     CLAIM_TENANT_SQL + PICK_JOB_SQL + LEASE_SQL
//   modelHeartbeat  src/worker/heartbeat.ts  T2  HEARTBEAT_SQL
//   modelIntent     src/worker/intent.ts     T3  COMMIT_INTENT_SQL
//   modelComplete   src/worker/complete.ts   T4  COMPLETE_JOB_SQL (+ the jobs_queued_has_attempts_left CHECK)
//   modelRecover    src/worker/recover.ts    T6  CLAIM_EXPIRED_SQL + the action UPDATE per recoveryAction
//   modelTick       the database clock moving forward
//
// The decisions come from src/fleet/stateMachine.ts (completionAllowed, recoveryAction), the same
// functions the worker calls, so the model can only disagree with the database where the SQL does.
// Two tests use it: the pure property tests (stateMachine.property.test.ts) drive it with simulated
// workers and a bank; the model-vs-real test (modelVsReal.db.test.ts) runs the same commands against the
// real SQL on a test schema and compares state, token, owner and lease after every command, which is
// what catches model/SQL drift.
//
// Time is a number of seconds on ONE clock, the database's (D22): every lease comparison is
// `leaseExpiresAt` against `now`, exactly as the SQL compares lease_expires_at with now(). No function
// here takes a worker's clock.
//
// Pure: every function returns a new ModelDb and never mutates its input.
import type { JobState } from "../queue/types.js";
import {
  completionAllowed,
  recoveryAction,
  type CompletionTarget,
  type RecoverableState,
  type RecoveryAction,
} from "./stateMachine.js";

export const MODEL_ACTIVE_STATES: readonly JobState[] = ["running", "committing", "verifying"];
export const MODEL_TERMINAL_STATES: readonly JobState[] = ["succeeded", "business_outcome", "failed", "needs_human"];

export interface ModelJob {
  readonly id: string;
  readonly tenant: string;
  /** Creation order: the SQL orders queued work by (created_at, id). */
  readonly seq: number;
  readonly state: JobState;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly token: number;
  readonly owner: string | null;
  /** Seconds on the database clock; null = no lease. */
  readonly leaseExpiresAt: number | null;
  readonly commitIntentAt: number | null;
  readonly outcome: string | null;
  /** What T4 wrote (the ReplayResult); the oracle reads result.outputs.confirmationRef. */
  readonly result: unknown;
}

export interface ModelDb {
  /** The database clock, in seconds. */
  readonly now: number;
  readonly jobs: readonly ModelJob[];
  /** tenants.max_concurrent, per tenant. */
  readonly caps: Readonly<Record<string, number>>;
}

/** Who claims to hold a job: the (job, token, owner) triple every fenced statement checks. */
export interface LeaseRef {
  jobId: string;
  token: number;
  owner: string;
}

export const isActive = (state: JobState): boolean => MODEL_ACTIVE_STATES.includes(state);
export const isTerminal = (state: JobState): boolean => MODEL_TERMINAL_STATES.includes(state);

export function newJob(fields: { id: string; tenant: string; seq: number; maxAttempts: number }): ModelJob {
  return {
    ...fields,
    state: "queued",
    attempt: 0,
    token: 0,
    owner: null,
    leaseExpiresAt: null,
    commitIntentAt: null,
    outcome: null,
    result: null,
  };
}

function replace(db: ModelDb, job: ModelJob): ModelDb {
  return { ...db, jobs: db.jobs.map((j) => (j.id === job.id ? job : j)) };
}

function find(db: ModelDb, id: string): ModelJob {
  const job = db.jobs.find((j) => j.id === id);
  if (!job) throw new Error(`model: no job ${id}`);
  return job;
}

/** The lease is alive: `lease_expires_at > now()`. */
const leaseAlive = (job: ModelJob, now: number) => job.leaseExpiresAt !== null && job.leaseExpiresAt > now;
/** The lease is expired: `lease_expires_at < now()` (equal is neither, in SQL as here). */
const leaseExpired = (job: ModelJob, now: number) => job.leaseExpiresAt !== null && job.leaseExpiresAt < now;
const holds = (job: ModelJob, ref: LeaseRef) => job.token === ref.token && job.owner === ref.owner;

/**
 * dequeue(): claim the tenant whose oldest queued job is oldest, among tenants with queued work and
 * fewer active jobs than max_concurrent (an expired, unrecovered lease still counts as active); lease
 * its oldest queued job: running, attempt + 1, token + 1, owner, lease = now + leaseSeconds.
 */
export function modelDequeue(db: ModelDb, owner: string, leaseSeconds: number): { db: ModelDb; job: ModelJob | null } {
  const queuedOf = (tenant: string) =>
    db.jobs.filter((j) => j.tenant === tenant && j.state === "queued" && j.attempt < j.maxAttempts).sort((a, b) => a.seq - b.seq);
  const active = (tenant: string) => db.jobs.filter((j) => j.tenant === tenant && isActive(j.state)).length;
  const tenants = [...new Set(db.jobs.map((j) => j.tenant))]
    .filter((t) => queuedOf(t).length > 0 && active(t) < (db.caps[t] ?? 0))
    .sort((a, b) => queuedOf(a)[0]!.seq - queuedOf(b)[0]!.seq || (a < b ? -1 : a > b ? 1 : 0));
  const tenant = tenants[0];
  if (tenant === undefined) return { db, job: null };
  const picked = queuedOf(tenant)[0]!;
  const leased: ModelJob = {
    ...picked,
    state: "running",
    attempt: picked.attempt + 1,
    token: picked.token + 1,
    owner,
    leaseExpiresAt: db.now + leaseSeconds,
  };
  return { db: replace(db, leased), job: leased };
}

/** T2: extend only a live lease this owner holds with this token, in an active state. Never revives. */
export function modelHeartbeat(db: ModelDb, ref: LeaseRef, leaseSeconds: number): { db: ModelDb; extended: boolean } {
  const job = find(db, ref.jobId);
  if (!(holds(job, ref) && isActive(job.state) && leaseAlive(job, db.now))) return { db, extended: false };
  return { db: replace(db, { ...job, leaseExpiresAt: db.now + leaseSeconds }), extended: true };
}

/** T3: running -> committing, commit_intent_at = now, a full lease; only for the live holder. */
export function modelIntent(db: ModelDb, ref: LeaseRef, leaseSeconds: number): { db: ModelDb; written: boolean } {
  const job = find(db, ref.jobId);
  if (!(holds(job, ref) && job.state === "running" && leaseAlive(job, db.now))) return { db, written: false };
  return {
    db: replace(db, { ...job, state: "committing", commitIntentAt: db.now, leaseExpiresAt: db.now + leaseSeconds }),
    written: true,
  };
}

export type ModelCompleteResult = "recorded" | "fenced" | "check_violation";

/**
 * T4: the holder (token + owner) records its outcome and releases the lease. Not lease-checked: a
 * holder whose lease expired but was not yet recovered is still the only one who ran the job.
 * `check_violation` = Postgres would reject the UPDATE (a requeue with no attempt left, D21).
 */
export function modelComplete(
  db: ModelDb,
  ref: LeaseRef,
  to: CompletionTarget,
  outcome: string | null,
  result: unknown = null,
): { db: ModelDb; result: ModelCompleteResult } {
  const job = find(db, ref.jobId);
  if (!(holds(job, ref) && completionAllowed(job.state, to))) return { db, result: "fenced" };
  if (to === "queued" && !(job.attempt < job.maxAttempts)) return { db, result: "check_violation" };
  return {
    db: replace(db, { ...job, state: to, outcome, result, owner: null, leaseExpiresAt: null }),
    result: "recorded",
  };
}

export interface ModelRecovery {
  jobId: string;
  from: RecoverableState;
  action: RecoveryAction;
  /** The bumped fencing token. */
  token: number;
}

/**
 * T6, repeated up to `max` times: claim the expired active lease with the earliest expiry and apply
 * recoveryAction to it, bumping the token. (Postgres breaks expiry ties by id; the model by creation
 * order. The model-vs-real test recovers every expired job in one call and compares them as a set.)
 */
export function modelRecover(db: ModelDb, max: number): { db: ModelDb; recovered: ModelRecovery[] } {
  const recovered: ModelRecovery[] = [];
  let current = db;
  while (recovered.length < max) {
    const expired = current.jobs
      .filter((j) => isActive(j.state) && leaseExpired(j, current.now))
      .sort((a, b) => a.leaseExpiresAt! - b.leaseExpiresAt! || a.seq - b.seq);
    const job = expired[0];
    if (!job) break;
    const from = job.state as RecoverableState;
    const action = recoveryAction({ state: from, attempt: job.attempt, maxAttempts: job.maxAttempts });
    const next: ModelJob = {
      ...job,
      state: action.to,
      outcome: action.to === "queued" ? job.outcome : action.outcome,
      token: job.token + 1,
      owner: null,
      leaseExpiresAt: null,
    };
    current = replace(current, next);
    recovered.push({ jobId: job.id, from, action, token: next.token });
  }
  return { db: current, recovered };
}

export function modelTick(db: ModelDb, seconds: number): ModelDb {
  if (!(seconds >= 0)) throw new RangeError(`model: time only moves forward (got ${seconds})`);
  return { ...db, now: db.now + seconds };
}

/** Seconds left on a job's lease (negative = expired), or null when it has none. */
export function leaseRemaining(job: ModelJob, now: number): number | null {
  return job.leaseExpiresAt === null ? null : job.leaseExpiresAt - now;
}
