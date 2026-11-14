// A pure model of the `jobs` table under the fleet's SQL (docs/plans/step-08.md section 7, reviewer
// addition R1). Each function mirrors ONE statement's guard and effect, line for line:
//
//   modelDequeue            src/queue/dequeue.ts     CLAIM_TENANT_SQL + PICK_JOB_SQL + LEASE_SQL (due jobs only: not_before)
//   modelHeartbeat          src/worker/heartbeat.ts  T2  HEARTBEAT_SQL
//   modelIntent             src/worker/intent.ts     T3  COMMIT_INTENT_SQL
//   modelComplete           src/worker/complete.ts   T4  COMPLETE_JOB_SQL (+ the jobs_queued_has_attempts_left CHECK;
//                                                        a requeue's not_before backoff, D49)
//   modelCompleteIntoVerify src/worker/verifySql.ts  T5  COMPLETE_INTO_VERIFY_SQL + its job_verifications row
//   modelVerifyResult       src/worker/verifySql.ts  T7  VERIFY_RESULT_SQL + the phase's decision
//   modelVerifyDefer        src/worker/verifySql.ts  T8  VERIFY_DEFER_SQL + the phase's decision (step-09 decision 5)
//   modelRecover            src/worker/recover.ts    T6  CLAIM_EXPIRED_SQL + VERIFY_CYCLE_SQL + the action per recoveryAction
//   modelReverify           src/worker/verifySql.ts  REVERIFY_SQL (rote jobs reverify)
//   modelVerifyCycle        src/worker/verifySql.ts  VERIFY_CYCLE_SQL (derived from the job's phases)
//   modelTick               the database clock moving forward
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
  CYCLE_STARTING_REASONS,
  DEAD_PHASE_DECISIONS,
  recoveryAction,
  REVERIFIABLE_OUTCOMES,
  type CompletionTarget,
  type PhaseDecision,
  type PriorStatus,
  type RecoverableState,
  type RecoveryAction,
  type VerifyCycle,
  type VerifyDecision,
  type VerifyReason,
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
  /** A queued job is not dequeued before this (T4's requeue backoff, D49); null = at once. */
  readonly notBefore: number | null;
  readonly commitIntentAt: number | null;
  readonly outcome: string | null;
  /** What T4 wrote (the ReplayResult); the oracle reads result.outputs.confirmationRef. */
  readonly result: unknown;
  /** The job's verify phases, oldest first (job_verifications rows). */
  readonly phases: readonly ModelPhase[];
}

/** One job_verifications row. */
export interface ModelPhase {
  readonly token: number;
  readonly owner: string;
  readonly reason: VerifyReason;
  readonly priorStatus: PriorStatus;
  /** null = open. */
  readonly decision: PhaseDecision | null;
  readonly endedAt: number | null;
  /** The lookups' counts (null = read nothing), once decided or deferred. */
  readonly lookups: ReadonlyArray<number | null> | null;
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
    notBefore: null,
    commitIntentAt: null,
    outcome: null,
    result: null,
    phases: [],
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

/** A queued job's backoff has passed: `not_before IS NULL OR not_before <= now()` (D49). */
const due = (job: ModelJob, now: number) => job.notBefore === null || job.notBefore <= now;

/**
 * dequeue(): claim the tenant whose oldest DUE queued job is oldest, among tenants with due queued work
 * and fewer active jobs than max_concurrent (an expired, unrecovered lease still counts as active); lease
 * that job: running, attempt + 1, token + 1, owner, lease = now + leaseSeconds, not_before cleared.
 */
export function modelDequeue(db: ModelDb, owner: string, leaseSeconds: number): { db: ModelDb; job: ModelJob | null } {
  const queuedOf = (tenant: string) =>
    db.jobs.filter((j) => j.tenant === tenant && j.state === "queued" && j.attempt < j.maxAttempts && due(j, db.now)).sort((a, b) => a.seq - b.seq);
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
    notBefore: null,
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

export type ModelCompleteResult = "recorded" | "fenced" | "illegal_transition" | "check_violation";

/**
 * After a fenced write matched 0 rows (src/worker/complete.ts readFence, D41): the token moved ->
 * "fenced" (lease_lost); the token is the one presented -> "illegal_transition" (a bug).
 */
const fencedOut = (job: ModelJob, ref: LeaseRef): "fenced" | "illegal_transition" =>
  job.token === ref.token ? "illegal_transition" : "fenced";

export interface ModelCompleteOptions {
  /** A requeue's backoff (T4's $8, D49): not_before = now + this; null / omitted = dequeueable at once. */
  notBeforeSeconds?: number | null;
}

/**
 * T4: the holder (token + owner) records its outcome and releases the lease. Not lease-checked: a
 * holder whose lease expired but was not yet recovered is still the only one who ran the job.
 * `check_violation` = Postgres would reject the UPDATE (a requeue with no attempt left, D21). A requeue
 * backs off (not_before = now + notBeforeSeconds); any other target leaves not_before null.
 */
export function modelComplete(
  db: ModelDb,
  ref: LeaseRef,
  to: CompletionTarget,
  outcome: string | null,
  result: unknown = null,
  options: ModelCompleteOptions = {},
): { db: ModelDb; result: ModelCompleteResult } {
  const job = find(db, ref.jobId);
  if (!(holds(job, ref) && completionAllowed(job.state, to))) return { db, result: fencedOut(job, ref) };
  if (to === "queued" && !(job.attempt < job.maxAttempts)) return { db, result: "check_violation" };
  const notBefore = to === "queued" && options.notBeforeSeconds != null ? db.now + options.notBeforeSeconds : null;
  return {
    db: replace(db, { ...job, state: to, outcome, result, notBefore, owner: null, leaseExpiresAt: null }),
    result: "recorded",
  };
}

// ------------------------------------------------------------------------------------------- verify

/**
 * VERIFY_CYCLE_SQL: the phases since the newest one that started a cycle (T5 / reverify:
 * commit_uncertain; T6.4: lease_expired_in_committing), or all of them when none did.
 */
export function modelVerifyCycle(job: ModelJob, now: number): VerifyCycle {
  let starter = -1;
  job.phases.forEach((p, i) => {
    if (CYCLE_STARTING_REASONS.includes(p.reason)) starter = i;
  });
  const cycle = job.phases.slice(Math.max(starter, 0));
  const deferredEnds = cycle.filter((p) => p.decision === "deferred").map((p) => p.endedAt!);
  return {
    phases: cycle.length,
    deadPhases: cycle.filter((p) => p.decision === null || DEAD_PHASE_DECISIONS.includes(p.decision)).length,
    deferrals: deferredEnds.length,
    deferredForSeconds: deferredEnds.length === 0 ? null : now - Math.min(...deferredEnds),
    priorStatus: starter === -1 ? null : job.phases[starter]!.priorStatus,
    lastDecision: cycle.length === 0 ? null : cycle[cycle.length - 1]!.decision,
  };
}

function closePhase(job: ModelJob, token: number, decision: PhaseDecision, now: number, lookups: ReadonlyArray<number | null> | null): ModelJob {
  return { ...job, phases: job.phases.map((p) => (p.token === token ? { ...p, decision, endedAt: now, lookups } : p)) };
}

/** A verifier fenced out of T7/T8: its own phase row says lease_lost (or illegal_transition), if still open or crashed. */
function markPhaseFencedOut(job: ModelJob, token: number, how: "fenced" | "illegal_transition", now: number): ModelJob {
  return {
    ...job,
    phases: job.phases.map((p) =>
      p.token === token && (p.decision === null || (how === "fenced" && p.decision === "crashed"))
        ? { ...p, decision: how === "fenced" ? "lease_lost" : "illegal_transition", endedAt: p.endedAt ?? now }
        : p,
    ),
  };
}

export type ModelFencedResult = "recorded" | "fenced" | "illegal_transition" | "check_violation";

/**
 * T5: the live owner whose run may have committed moves the job into its OWN verify phase: from
 * running/committing (token + owner held, not lease-checked, like T4) to verifying, token + 1, a fresh
 * lease, outcome commit_uncertain, and a new phase row (reason commit_uncertain, starting a cycle).
 */
export function modelCompleteIntoVerify(
  db: ModelDb,
  ref: LeaseRef,
  leaseSeconds: number,
  priorStatus: PriorStatus,
  result: unknown = null,
): { db: ModelDb; result: ModelFencedResult; token: number | null } {
  const job = find(db, ref.jobId);
  if (!(holds(job, ref) && (job.state === "running" || job.state === "committing"))) {
    return { db, result: fencedOut(job, ref), token: null };
  }
  const token = job.token + 1;
  const next: ModelJob = {
    ...job,
    state: "verifying",
    outcome: "commit_uncertain",
    result,
    token,
    leaseExpiresAt: db.now + leaseSeconds,
    phases: [...job.phases, { token, owner: ref.owner, reason: "commit_uncertain", priorStatus, decision: null, endedAt: null, lookups: null }],
  };
  return { db: replace(db, next), result: "recorded", token };
}

/**
 * T7: the verifier (token + owner, state verifying; not lease-checked) writes its decision and releases
 * the job; a resubmit clears commit_intent_at. Its phase row gets the decision and the lookups.
 * `check_violation` = a requeue with no attempt left (D21; verifyDecision never asks for one).
 */
export function modelVerifyResult(
  db: ModelDb,
  ref: LeaseRef,
  decision: Exclude<VerifyDecision, { decision: "deferred" }>,
  lookups: ReadonlyArray<number | null>,
  result?: unknown,
): { db: ModelDb; result: ModelFencedResult } {
  const job = find(db, ref.jobId);
  if (!(holds(job, ref) && job.state === "verifying")) {
    const how = fencedOut(job, ref);
    return { db: replace(db, markPhaseFencedOut(job, ref.token, how, db.now)), result: how };
  }
  if (decision.to === "queued" && !(job.attempt < job.maxAttempts)) return { db, result: "check_violation" };
  const next: ModelJob = closePhase(
    {
      ...job,
      state: decision.to,
      outcome: decision.outcome,
      result: result === undefined ? job.result : result,
      commitIntentAt: decision.to === "queued" ? null : job.commitIntentAt,
      notBefore: null, // a verified resubmit is dequeueable at once (D49)
      owner: null,
      leaseExpiresAt: null,
    },
    ref.token,
    decision.decision,
    db.now,
    lookups,
  );
  return { db: replace(db, next), result: "recorded" };
}

/**
 * T8 (step-09 reviewer decision 5): the bank is unavailable; the verifier ends its phase `deferred`.
 * The job stays verifying, so jobs_active_has_owner keeps the deferring verifier as lease_owner, but
 * the token is bumped (nobody holds the new one: the verifier is fenced out of its own job) and the
 * lease is set to now + the backoff, so recovery resumes it (T6.7) once the backoff has passed.
 */
export function modelVerifyDefer(
  db: ModelDb,
  ref: LeaseRef,
  backoffSeconds: number,
  lookups: ReadonlyArray<number | null>,
): { db: ModelDb; result: ModelFencedResult; token: number | null } {
  const job = find(db, ref.jobId);
  if (!(holds(job, ref) && job.state === "verifying")) {
    const how = fencedOut(job, ref);
    return { db: replace(db, markPhaseFencedOut(job, ref.token, how, db.now)), result: how, token: null };
  }
  const next = closePhase({ ...job, token: job.token + 1, leaseExpiresAt: db.now + backoffSeconds }, ref.token, "deferred", db.now, lookups);
  return { db: replace(db, next), result: "recorded", token: next.token };
}

/**
 * rote jobs reverify: a needs_human job whose outcome says "could not tell" goes back to verifying,
 * token + 1, handed to recovery: owner = the operator's tag (jobs_active_has_owner), lease already
 * expired (now - 1 s), and a phase row that starts a cycle and is closed `handed_off` at once, so the
 * next recovery resumes it (T6.7) without counting it as dead.
 */
export function modelReverify(db: ModelDb, jobId: string, who: string): { db: ModelDb; token: number | null } {
  const job = find(db, jobId);
  if (!(job.state === "needs_human" && (REVERIFIABLE_OUTCOMES as readonly string[]).includes(job.outcome ?? ""))) return { db, token: null };
  const status = (job.result as { status?: unknown } | null)?.status;
  const priorStatus: PriorStatus = status === "business_outcome" || status === "failure" || status === "needs_human" ? status : null;
  const token = job.token + 1;
  const next: ModelJob = {
    ...job,
    state: "verifying",
    outcome: "commit_uncertain",
    token,
    owner: who,
    leaseExpiresAt: db.now - 1,
    phases: [...job.phases, { token, owner: who, reason: "commit_uncertain", priorStatus, decision: "handed_off", endedAt: db.now, lookups: null }],
  };
  return { db: replace(db, next), token };
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
 * recoveryAction to it (with the job's verify cycle), bumping the token. A claim to verify (T6.4/T6.5/
 * T6.7) makes `recoverer` the job's owner with a fresh lease, and the sweep STOPS there: that job is
 * the recoverer's work for this iteration (returned as `claimed`). (Postgres breaks expiry ties by id;
 * the model by creation order. The model-vs-real test compares recoveries as a set.)
 */
export function modelRecover(
  db: ModelDb,
  max: number,
  recoverer: { owner: string; leaseSeconds: number },
): { db: ModelDb; recovered: ModelRecovery[]; claimed: ModelRecovery | null } {
  const recovered: ModelRecovery[] = [];
  let current = db;
  while (recovered.length < max) {
    const expired = current.jobs
      .filter((j) => isActive(j.state) && leaseExpired(j, current.now))
      .sort((a, b) => a.leaseExpiresAt! - b.leaseExpiresAt! || a.seq - b.seq);
    const job = expired[0];
    if (!job) break;
    const from = job.state as RecoverableState;
    const cycle = modelVerifyCycle(job, current.now);
    const action = recoveryAction({ state: from, attempt: job.attempt, maxAttempts: job.maxAttempts, verify: from === "verifying" ? cycle : undefined });
    const token = job.token + 1;
    // The dead verifier's open phase row (if any) is closed `crashed`.
    const closed: ModelJob = {
      ...job,
      phases: job.phases.map((p) => (p.token === job.token && p.decision === null ? { ...p, decision: "crashed", endedAt: current.now } : p)),
    };
    let next: ModelJob;
    if (action.kind === "verify") {
      const priorStatus = action.reason === "lease_expired_in_committing" ? null : cycle.priorStatus;
      next = {
        ...closed,
        state: "verifying",
        outcome: action.outcome,
        token,
        owner: recoverer.owner,
        leaseExpiresAt: current.now + recoverer.leaseSeconds,
        phases: [...closed.phases, { token, owner: recoverer.owner, reason: action.reason, priorStatus, decision: null, endedAt: null, lookups: null }],
      };
    } else {
      next = {
        ...closed,
        state: action.to,
        outcome: action.to === "queued" ? job.outcome : action.outcome,
        token,
        owner: null,
        leaseExpiresAt: null,
        notBefore: null, // a crash requeue (T6.1) does not back off (D49)
      };
    }
    current = replace(current, next);
    const r: ModelRecovery = { jobId: job.id, from, action, token };
    recovered.push(r);
    if (action.kind === "verify") return { db: current, recovered, claimed: r };
  }
  return { db: current, recovered, claimed: null };
}

export function modelTick(db: ModelDb, seconds: number): ModelDb {
  if (!(seconds >= 0)) throw new RangeError(`model: time only moves forward (got ${seconds})`);
  return { ...db, now: db.now + seconds };
}

/** Seconds left on a job's lease (negative = expired), or null when it has none. */
export function leaseRemaining(job: ModelJob, now: number): number | null {
  return job.leaseExpiresAt === null ? null : job.leaseExpiresAt - now;
}

/** Seconds until a queued job's backoff has passed (negative = due), or null when it has none (D49). */
export function notBeforeRemaining(job: ModelJob, now: number): number | null {
  return job.notBefore === null ? null : job.notBefore - now;
}
