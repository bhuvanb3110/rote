// The fleet's state machine as pure functions (docs/plans/step-08.md section 7). Every decision about
// a job's next state is made HERE; the SQL in src/worker/ (T2 heartbeat, T3 commit intent, T4
// completion, T6 recovery) executes it and repeats its guards, and nothing decides in SQL alone. The
// worker code, the unit tests, the pure-model property tests and the model-vs-real test all use these
// same functions (src/fleet/model.ts mirrors the SQL on top of them).
//
//   jobOutcomeFor     how a run's end maps to a job state (Step 6, D25; moved from src/worker/outcome.ts)
//   completionAllowed which state T4 may write from which (Step 8: requeue/fail only from `running`)
//   requeueBackoffSeconds  how long T4's requeue after a failure waits before the job may be dequeued
//                     again (Step 10, D49: retries back off)
//   recoveryAction    what T6 does with an expired lease (T6.1 requeue, T6.2 fail at the crash cap; Step 9:
//                     T6.4 claim a `committing` job to verify, T6.5 re-claim a dead verifier's job, T6.6
//                     escalate at the crash cap after the intent (D58), T6.7 resume a deferred or handed-off
//                     verify); every death counts against the job's one crash budget (D58)
//   ownAttempts       the job's own attempts: its leases minus its deaths before the intent (Step 10b, D57,
//                     D58: two budgets)
//   classifyLookup    what one history lookup said: a count, the bank unavailable, transient, unreadable
//   verifyDecision    what a verify phase concludes from its lookups (Step 9, docs/plans/step-08.md
//                     section 5, plus step-09 reviewer decisions 4-5: deferral)
//   reconcileDecision what the reconcile pass concludes from its one lookup (Step 10, D50), and
//                     jobSettled: terminal with no automatic reconcile still to run (GET /jobs/:id `settled`)
//   reconcileClaimAction  what a reconcile claim does with the job's reconciler deaths: lease it (R1), or, in
//                     the workers' pass at the cap, abandon its reconcile (R3) (Step 10b, D59)
//   reconcileStatus   none / pending / reconciled / flagged / abandoned (GET /jobs/:id `reconcile`, D59)
//
// jobOutcomeFor (docs/plans/step-06.md section 2, reviewer decisions 2-3), tested row by row. The
// load-bearing rules:
//   - a business outcome is final, never retried (D21);
//   - anything that MAY have committed (commitUncertain, or a throw after the commit intent was -- or
//     may have been -- written) is never retried blindly: the live owner moves it straight into its own
//     verify phase (T5, Step 9), which reads the bank's history (a retry is the one thing that can
//     duplicate a transfer);
//   - a failure before anything irreversible is retried while attempts are left (D10), else failed --
//     counting the job's OWN attempts: a worker's death before the intent is a crash, not an attempt (D57);
//   - a job that can never run (unknown capability, bad params, missing override) fails at once.
import type { ReplayResult } from "../artifact/index.js";
import { DEFAULT_MAX_CRASHES, TERMINAL_STATES, type JobState } from "../queue/types.js";
import type { Redactor } from "../worker/credentials.js";

export type RunEnd =
  /** runReplay returned a result. */
  | { kind: "result"; result: ReplayResult }
  /** runReplay (or invokeCapability, after preflight) threw or rejected. `aborted`: our signal fired. */
  | { kind: "thrown"; error: unknown; aborted: boolean }
  /** Preflight refused the job before any replay: deterministic, retrying cannot help. */
  | { kind: "invalid"; error: unknown };

export interface OutcomeContext {
  /** This attempt's number (job.attempt after the dequeue that leased it). */
  attempt: number;
  maxAttempts: number;
  /**
   * The job's lease crashes when this attempt was leased (jobs.lease_crashes on the dequeued row, D57, D58):
   * earlier leases that died before their intent (T6.1). They do not use an attempt, so the attempts left are
   * counted on ownAttempts(attempt, leaseCrashes). Default 0.
   */
  leaseCrashes?: number;
  /**
   * The Submit may have been clicked in this attempt: the commit intent (T3) was written, or its
   * COMMIT failed with an unknown result (Step 8). Without a commit intent (a runJob caller that passes
   * none), onIrreversible.before ran. A FencingError (T3 matched 0 rows: definitely not written, no
   * click) leaves it false, so that run is retried like any failure before the irreversible step.
   */
  irreversibleStarted: boolean;
  /** Applied to every error string (credential values -> [REDACTED]). */
  redact?: Redactor;
}

export type FinalJobState = "succeeded" | "business_outcome" | "needs_human" | "failed";

/** The ReplayResult status a transfer attempt ended with, when it ended at all (job_verifications.prior_status). */
export type PriorStatus = "business_outcome" | "failure" | "needs_human" | null;

export interface JobOutcome {
  /**
   * "queued" = requeue for another attempt (lease cleared). "verifying" = the run may have committed:
   * T5 moves the job into this worker's own verify phase (Step 9), never T4.
   */
  state: FinalJobState | "queued" | "verifying";
  /** Short terminal label for jobs.outcome; null on a requeue (the job is not finished). */
  outcome: "success" | "business_outcome" | "needs_human" | "commit_uncertain" | "failure" | "invalid_job" | "aborted" | null;
  /** Redacted, human-readable; null on success. */
  error: string | null;
  /** The ReplayResult as returned (replay already redacted it), or null when replay threw. */
  result: ReplayResult | null;
  /** job_attempts.outcome for this attempt. */
  attemptOutcome: "success" | "business_outcome" | "needs_human" | "failure" | "aborted";
  /** job_attempts.commit_uncertain. */
  commitUncertain: boolean;
  /** state "verifying" only: what the attempt ended with (decides what two 0-match lookups mean). */
  priorStatus?: PriorStatus;
}

export const MAX_ERROR_LENGTH = 2000;

// ---------------------------------------------------------------------------------------------------
// The two budgets (Step 10b: docs/plans/step-10.md, the reviewer decisions during 10b; D57, D58).
//
//   attempts  the job's OWN failures (max_attempts, default 3): a run that failed before its intent (T4),
//             or an attempt that reached its intent and was verified not committed (T7 resubmitted /
//             exhausted). These are about the job and the bank: what a retry with a backoff is for.
//   crashes   EVERY worker death on the job (max_crashes, default 5; one budget, D58): a lease that expired in
//             `running` (T6.1), in `committing` (T6.4), or in a verify phase that died (T6.5). They say nothing
//             about the job, so they never use an attempt (the first bank-fault+kills run failed two jobs whose
//             attempts kills had used up). Capped, so a poison job -- one that kills every worker that runs or
//             verifies it -- ends visibly: `failed` / `crash_limit` before any intent (T6.2), `needs_human` /
//             `crash_limit` after one (T6.6: the Submit may have committed, so never `failed`).
//
// jobs.attempt still counts every lease (job_attempts.attempt is its number). The deaths BEFORE the intent are
// also counted apart (jobs.lease_crashes): those leases are not the job's own attempts, so own = attempt -
// lease_crashes. A death after the intent counts against the crash budget, but that attempt is an own one
// (verify decides whether it is retried). A reconciler's death on a terminal job is not counted.

/** The crash cap's default (jobs.max_crashes, 0006): the 5th worker death on a job fails or escalates it. */
export { DEFAULT_MAX_CRASHES };

/** The job's own attempts so far (the current lease included while it runs): its leases minus its lease crashes. */
export function ownAttempts(attempt: number, leaseCrashes: number): number {
  if (!(Number.isInteger(attempt) && Number.isInteger(leaseCrashes) && leaseCrashes >= 0 && leaseCrashes <= attempt)) {
    throw new RangeError(`ownAttempts: need integers 0 <= leaseCrashes <= attempt (got attempt ${attempt}, leaseCrashes ${leaseCrashes})`);
  }
  return attempt - leaseCrashes;
}

function clip(text: string): string {
  return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

function describeResult(result: Exclude<ReplayResult, { status: "success" }>): string {
  switch (result.status) {
    case "business_outcome":
      return `business_outcome ${result.code}: ${result.detail}`;
    case "needs_human":
      return `needs_human at ${result.atStepId}: ${result.reason}`;
    case "failure":
      return `failure (${result.category}) at ${result.atStepId}: expected ${result.expected}; observed ${result.observed}`;
  }
}

function describeThrown(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  return String(error);
}

export function jobOutcomeFor(end: RunEnd, ctx: OutcomeContext): JobOutcome {
  const redact = ctx.redact ?? ((s: string) => s);
  const err = (text: string) => clip(redact(text));
  // The job's own attempts (D57): a crash requeue before the intent is not one of them.
  const own = ownAttempts(ctx.attempt, ctx.leaseCrashes ?? 0);
  const attemptsLeft = own < ctx.maxAttempts;

  if (end.kind === "invalid") {
    return {
      state: "failed",
      outcome: "invalid_job",
      error: err(`invalid job (not retried): ${describeThrown(end.error)}`),
      result: null,
      attemptOutcome: "failure",
      commitUncertain: false,
    };
  }

  if (end.kind === "thrown") {
    const attemptOutcome = end.aborted ? "aborted" : "failure";
    const what = end.aborted ? "aborted" : "threw";
    if (ctx.irreversibleStarted) {
      return {
        state: "verifying",
        outcome: "commit_uncertain",
        error: err(
          `commit uncertain (not retried blindly): the run ${what} after the irreversible step started; ` +
            `verifying in the bank's history by memo_key (T5). ${describeThrown(end.error)}`,
        ),
        result: null,
        attemptOutcome,
        commitUncertain: true,
        priorStatus: null,
      };
    }
    return {
      state: attemptsLeft ? "queued" : "failed",
      outcome: attemptsLeft ? null : end.aborted ? "aborted" : "failure",
      error: err(
        `attempt ${own}/${ctx.maxAttempts} ${what} before anything irreversible` +
          `${attemptsLeft ? " (retrying)" : " (attempts exhausted)"}: ${describeThrown(end.error)}`,
      ),
      result: null,
      attemptOutcome,
      commitUncertain: false,
    };
  }

  const { result } = end;
  if (result.status === "success") {
    return { state: "succeeded", outcome: "success", error: null, result, attemptOutcome: "success", commitUncertain: false };
  }

  if (result.commitUncertain) {
    // Business outcome, failure, or (defensively) needs_human after the irreversible attempt: the
    // bank may have committed. Verified (T5, then the history lookup); never retried blindly. A
    // refusal shown after Submit stands only if the history agrees (two 0-match lookups).
    return {
      state: "verifying",
      outcome: "commit_uncertain",
      error: err(`commit uncertain (not retried blindly): ${result.commitUncertain.detail}. Verifying in the bank's history by memo_key (T5).`),
      result,
      attemptOutcome: result.status,
      commitUncertain: true,
      priorStatus: result.status,
    };
  }

  switch (result.status) {
    case "business_outcome":
      return {
        state: "business_outcome",
        outcome: "business_outcome",
        error: err(describeResult(result)),
        result,
        attemptOutcome: "business_outcome",
        commitUncertain: false,
      };
    case "needs_human":
      return {
        state: "needs_human",
        outcome: "needs_human",
        error: err(describeResult(result)),
        result,
        attemptOutcome: "needs_human",
        commitUncertain: false,
      };
    case "failure":
      return {
        state: attemptsLeft ? "queued" : "failed",
        outcome: attemptsLeft ? null : "failure",
        error: err(
          `attempt ${own}/${ctx.maxAttempts}${attemptsLeft ? " (retrying)" : " (attempts exhausted)"}: ` +
            describeResult(result),
        ),
        result,
        attemptOutcome: "failure",
        commitUncertain: false,
      };
  }
}

// ---------------------------------------------------------------------------------------------------
// T4 (completion) state guard, Step 8 (docs/plans/step-08.md section 3).
//
// A live owner is in `running` (before its commit intent) or `committing` (after it). From `running`
// any final state, or a requeue, may be written. From `committing` only `succeeded` (the bank
// confirmed) or `needs_human` (it may have committed): a requeue or `failed` after the intent would say
// "it didn't happen" without anyone having looked, and `business_outcome` cannot arise there (a refusal
// seen after Submit carries commitUncertain, so jobOutcomeFor parks it). T4's SQL repeats this guard
// (COMPLETE_JOB_SQL) so a bug in a caller can never requeue a job past its intent.

export type CompletionTarget = FinalJobState | "queued";

export function completionAllowed(from: JobState, to: CompletionTarget): boolean {
  if (from === "running") return true;
  if (from === "committing") return to === "succeeded" || to === "needs_human";
  return false;
}

// ---------------------------------------------------------------------------------------------------
// Requeue backoff (Step 10: docs/plans/step-10.md section 1; reviewer decision 2, option B; D49).
//
// A failure BEFORE the commit intent is requeued by T4 (jobOutcomeFor's "queued"). Without a backoff the
// next worker picks it up at once, so during a 30 s bank outage every attempt fails in about a second
// and a job burns all of its attempts. T4 therefore sets `not_before = now() + requeueBackoffSeconds(..)`
// (database clock, D22) and the dequeue skips a queued job until then. Each retry still consumes an
// attempt (D21 unchanged). Only T4's requeue backs off: a crash requeue (T6.1) and a verified resubmit
// (T7) were not the bank's doing and are picked up at once. The backoff is keyed on the job's OWN attempt
// that failed (ownAttempts, D57): crashes before it do not lengthen it.
//
//   own attempt that failed   1      2      3      4+
//   backoff (no jitter)   10 s   30 s   90 s   120 s (the cap)
//
// The jitter (x [0.8, 1.2], to the millisecond) spreads a fleet's retries after a shared outage. With
// max_attempts 3 the retries come at about +10 s and +40 s; the earliest the third attempt can run is
// 0.8 x (10 + 30) = 32 s after the first failure, so an outage shorter than that fails no job (the
// property test). Longer outages are Day 4's circuit breaker.

export interface RequeueBackoffConfig {
  baseSeconds: number;
  factor: number;
  capSeconds: number;
  /** The backoff is multiplied by a factor drawn uniformly from [1 - jitter, 1 + jitter) (then rounded to the ms). */
  jitter: number;
}

export const DEFAULT_REQUEUE_BACKOFF: RequeueBackoffConfig = { baseSeconds: 10, factor: 3, capSeconds: 120, jitter: 0.2 };

/** The un-jittered backoff after attempt `attempt` (1-based) failed: min(cap, base * factor^(attempt - 1)). */
export function requeueBackoffBaseSeconds(attempt: number, config: RequeueBackoffConfig = DEFAULT_REQUEUE_BACKOFF): number {
  if (!(Number.isInteger(attempt) && attempt >= 1)) throw new RangeError(`requeue backoff: attempt must be a positive integer (got ${attempt})`);
  return Math.min(config.capSeconds, config.baseSeconds * config.factor ** Math.min(attempt - 1, 30));
}

/**
 * Seconds until a requeued job may be dequeued again, after attempt `attempt` failed before its intent.
 * `random` (in [0, 1)) picks the jitter: Math.random in the worker, fixed in tests. Millisecond precision.
 */
export function requeueBackoffSeconds(attempt: number, random: () => number = Math.random, config: RequeueBackoffConfig = DEFAULT_REQUEUE_BACKOFF): number {
  const r = random();
  if (!(r >= 0 && r < 1)) throw new RangeError(`requeue backoff: random() must be in [0, 1) (got ${r})`);
  const factor = 1 - config.jitter + 2 * config.jitter * r;
  return Math.round(requeueBackoffBaseSeconds(attempt, config) * factor * 1000) / 1000;
}

/**
 * The shortest possible time from a job's first failure to its last attempt: the backoffs after attempts
 * 1 .. maxAttempts - 1 at the smallest jitter. A bank outage shorter than this cannot fail every attempt
 * (32 s for 3 attempts with the defaults).
 */
export function minRequeueScheduleSeconds(maxAttempts: number, config: RequeueBackoffConfig = DEFAULT_REQUEUE_BACKOFF): number {
  let sum = 0;
  for (let a = 1; a < maxAttempts; a += 1) sum += requeueBackoffBaseSeconds(a, config) * (1 - config.jitter);
  return sum;
}

// ---------------------------------------------------------------------------------------------------
// T6 (recovery of an expired lease): Step 8 (docs/plans/step-08.md section 4), Step 9 (verify).
//
// Every action bumps the fencing token, so "the token changed" always means "the old holder is
// fenced" (reviewer decision 3), and closes the dead holder's attempt row (and, for a verifier, its
// open job_verifications row) as `crashed`.
//
// Every expired lease is a worker DEATH and counts one crash (D58: one budget), except a deferred or
// handed-off verify, which ended on purpose (T6.7). `c` = crashes + 1, the death being recovered:
//
//   left in      condition                                   action                     jobs becomes
//   running      c < max_crashes                             T6.1 requeue               queued (nothing irreversible happened;
//                                                                                       no attempt used: a lease crash, D57)
//   running      c >= max_crashes                            T6.2 fail                  failed / crash_limit (a poison job, D57)
//   committing   c < max_crashes (the intent was written)    T6.4 claim to verify       verifying, owned by the recoverer
//   verifying    the newest phase was deferred / handed off  T6.7 resume (no death)     verifying, owned by the recoverer
//   verifying    c < max_crashes (the verifier died)         T6.5 re-claim              verifying, owned by the recoverer
//   committing / c >= max_crashes                            T6.6 escalate              needs_human / crash_limit (the Submit may
//   verifying                                                                           have committed: never failed, D58)
//
// A lease that expires in `running` is a LEASE crash too (jobs.lease_crashes + 1): that lease is not one of
// the job's own attempts (D57; Step 8's T6.1/T6.2 used `attempt < max_attempts`, else failed / lease_expired,
// and the first bank-fault+kills chaos run failed two jobs that way). A death after the intent is not: that
// attempt reached its intent and verify decides it. Step 9's separate cap of 3 dead verify phases (T6.6,
// verify_exhausted) is gone (D58): at chaos's kill rate three dead verifiers in a row are ~1% of verify cycles,
// bad luck rather than a poison job.
//
// Step 8's T6.3 (committing -> needs_human) is gone: an expired commit is verified, never parked. A
// "dead" phase is one that ended without a decision: still open when its lease expired, closed
// `crashed` by recovery, `lease_lost` by its own heartbeat, or `illegal_transition` (a bug). Deferred and
// handed-off phases are not dead (they ended on purpose) and are never counted as deaths (step-09
// reviewer decision 5).

export type RecoverableState = "running" | "committing" | "verifying";

/** Why a verify phase started (job_verifications.reason). The first two start a new verify cycle. */
export type VerifyReason = "commit_uncertain" | "lease_expired_in_committing" | "lease_expired_in_verifying" | "resumed";
/** A job_verifications row's reason: a verify phase's, or a reconcile run's (Step 10, D50; never part of a verify cycle). */
export type PhaseReason = VerifyReason | "reconcile";
export const CYCLE_STARTING_REASONS: readonly VerifyReason[] = ["commit_uncertain", "lease_expired_in_committing"];

/** How a verify phase ended (job_verifications.decision); null = still open. */
export type PhaseDecision =
  | "already_done"
  | "resubmitted"
  | "not_committed_final"
  | "escalated"
  | "exhausted"
  | "deferred"
  | "handed_off"
  | "lease_lost"
  | "crashed"
  | "illegal_transition"
  // A reconcile run's decisions (Step 10, D50; unrecorded_commit_suspected: D55).
  | "reconciled"
  | "duplicate_suspected"
  | "unrecorded_commit_suspected"
  | "reconcile_unreadable"
  | "reconcile_deferred";
/** Phases that ended without a decision (the verifier died, or a bug): VerifyCycle.deadPhases counts them. */
export const DEAD_PHASE_DECISIONS: readonly PhaseDecision[] = ["crashed", "lease_lost", "illegal_transition"];

/**
 * The job's current verify cycle (the phases since the newest one that started a cycle), as
 * VERIFY_CYCLE_SQL (src/worker/verifyCycle.ts) derives it from job_verifications and the model does
 * from its phases.
 */
export interface VerifyCycle {
  /** Phases in the cycle. */
  phases: number;
  /** Dead phases (open ones included: an expired open phase is dying now). */
  deadPhases: number;
  deferrals: number;
  /** Database-clock seconds since the cycle's first deferral ended; null = no deferral yet. */
  deferredForSeconds: number | null;
  /** The cycle's starting phase's prior_status. */
  priorStatus: PriorStatus;
  /** How the newest phase ended; null when it is still open, or there is none. */
  lastDecision: PhaseDecision | null;
}

export const EMPTY_VERIFY_CYCLE: VerifyCycle = { phases: 0, deadPhases: 0, deferrals: 0, deferredForSeconds: null, priorStatus: null, lastDecision: null };

export interface RecoveryRow {
  state: RecoverableState;
  attempt: number;
  maxAttempts: number;
  /** jobs.crashes / jobs.max_crashes (0006, D58): every worker death so far, and the one budget's cap. */
  crashes: number;
  maxCrashes: number;
  /** jobs.lease_crashes (0007): the deaths before the intent, the leases that are not own attempts (messages only). */
  leaseCrashes: number;
  /** Required for `verifying` (what the cycle's phases say). */
  verify?: VerifyCycle;
}

/**
 * `crash`: this recovery counts one worker death (jobs.crashes + 1; RECOVER_JOB_SQL's $8, CLAIM_TO_VERIFY_SQL's
 * $7): every action but T6.7 (D58). `leaseCrash`: the death was before the intent, so that lease is not one of
 * the job's attempts (jobs.lease_crashes + 1, RECOVER_JOB_SQL's $9): T6.1 and T6.2 only (D57).
 */
export type RecoveryAction =
  | { kind: "requeue"; label: "T6.1"; to: "queued"; outcome: null; crash: boolean; leaseCrash: boolean; error: string }
  | { kind: "fail"; label: "T6.2"; to: "failed"; outcome: "crash_limit"; crash: boolean; leaseCrash: boolean; error: string }
  /** T6.4/T6.5/T6.7: the recoverer takes the job (token + 1, its own lease) and verifies it at once. */
  | {
      kind: "verify";
      label: "T6.4" | "T6.5" | "T6.7";
      to: "verifying";
      outcome: "commit_uncertain";
      reason: Exclude<VerifyReason, "commit_uncertain">;
      crash: boolean;
      leaseCrash: false;
      error: string;
    }
  | { kind: "escalate"; label: "T6.6"; to: "needs_human"; outcome: "crash_limit"; crash: boolean; leaseCrash: false; error: string };

/** T6.6: the crash cap reached after the intent (D58). The Submit may have committed: a human, never `failed`. */
function crashLimitAfterIntent(row: RecoveryRow, crash: number, where: string): RecoveryAction {
  return {
    kind: "escalate",
    label: "T6.6",
    to: "needs_human",
    outcome: "crash_limit",
    crash: true,
    leaseCrash: false,
    error:
      `crash limit after the commit intent: the lease expired ${where} (crash ${crash}/${row.maxCrashes}: every worker death on this job counts); ` +
      "the Submit may have committed; check the bank's history for memo_key",
  };
}

export function recoveryAction(row: RecoveryRow): RecoveryAction {
  // The death being recovered (D58: one budget). T6.7 is the one recovery that is not a death.
  const crash = row.crashes + 1;
  switch (row.state) {
    case "running": {
      // Before the intent: a lease crash too (D57), so it uses no attempt.
      const own = ownAttempts(row.attempt, row.leaseCrashes);
      return crash < row.maxCrashes
        ? {
            kind: "requeue",
            label: "T6.1",
            to: "queued",
            outcome: null,
            crash: true,
            leaseCrash: true,
            error:
              `lease expired while running, before any commit intent: crash ${crash}/${row.maxCrashes}, not one of the job's ` +
              `attempts (own attempts used ${own - 1}/${row.maxAttempts}); requeued`,
          }
        : {
            kind: "fail",
            label: "T6.2",
            to: "failed",
            outcome: "crash_limit",
            crash: true,
            leaseCrash: true,
            error:
              `crash limit: the lease expired while running, before any commit intent, once too often (crash ${crash}/${row.maxCrashes}): ` +
              "a job that keeps killing its workers (a poison job?); nothing irreversible happened",
          };
    }
    case "committing":
      if (crash >= row.maxCrashes) return crashLimitAfterIntent(row, crash, "in committing");
      return {
        kind: "verify",
        label: "T6.4",
        to: "verifying",
        outcome: "commit_uncertain",
        reason: "lease_expired_in_committing",
        crash: true,
        leaseCrash: false,
        error:
          `lease expired after the commit intent (crash ${crash}/${row.maxCrashes}): the Submit may have committed; ` +
          "verifying in the bank's history by memo_key (T6.4)",
      };
    case "verifying": {
      const cycle = row.verify;
      if (!cycle) throw new Error("recoveryAction: a verifying row needs its verify cycle");
      if (cycle.lastDecision === "deferred" || cycle.lastDecision === "handed_off") {
        return {
          kind: "verify",
          label: "T6.7",
          to: "verifying",
          outcome: "commit_uncertain",
          reason: "resumed",
          crash: false,
          leaseCrash: false,
          error:
            cycle.lastDecision === "deferred"
              ? `resuming a deferred verify (deferral ${cycle.deferrals}; the bank was unavailable) (T6.7)`
              : "resuming a verify handed over by rote jobs reverify (T6.7)",
        };
      }
      if (crash >= row.maxCrashes) return crashLimitAfterIntent(row, crash, `in verifying (dead verify phases in this cycle: ${cycle.deadPhases})`);
      return {
        kind: "verify",
        label: "T6.5",
        to: "verifying",
        outcome: "commit_uncertain",
        reason: "lease_expired_in_verifying",
        crash: true,
        leaseCrash: false,
        error: `a verifier's lease expired (crash ${crash}/${row.maxCrashes}; dead verify phases in this cycle: ${cycle.deadPhases}); re-verifying (T6.5)`,
      };
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Verify (Step 9: docs/plans/step-08.md section 5; step-09 reviewer decisions 4 and 5).
//
// One verify PHASE = one holder of the job in `verifying`: lookup #1; if it counts 0, wait the settle
// period and lookup #2; decide; write the decision (T7) or defer (T8). The lookup is the read-only
// transfer-history-lookup (1.2.0), searching the member's history for the job's memo_key.

/** What one history lookup said, as verify understands it. */
export type LookupReading =
  /** The history page was read: n matching transfers, the first one's Reference. */
  | { kind: "count"; n: number; firstMatchRef: string | null; evidenceRef: string | null; detail?: string }
  /** The bank said it is unavailable (its 503 page), or a transient condition persisted after the one retry. */
  | { kind: "unavailable"; detail: string; evidenceRef: string | null }
  /** Session timeout, interstitials exhausted, or a network-level throw: retried once, then `unavailable`. */
  | { kind: "transient"; detail: string; evidenceRef: string | null }
  /** A page that loads but cannot be understood (a count that is not a number, an unknown page...). */
  | { kind: "unreadable"; detail: string; evidenceRef: string | null };

export type LookupEnd = { kind: "result"; result: ReplayResult } | { kind: "thrown"; error: unknown };

/** The replay message for an exhausted recoverable rule (src/replay/replay.ts): a transient that would not clear. */
export const RECOVERABLE_EXHAUSTED_RE = /^Recoverable rule \(/;
/** A throw from the browser or the network (the bank unreachable, a timeout, a dropped context). */
export const NETWORK_THROW_RE = /net::ERR_|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|socket hang up|Timeout \d+ms exceeded|has been closed|has disconnected/i;
/** The lookup's known outcome for the bank's 503 page (artifacts/transfer-history-lookup.json 1.2.0). */
export const BANK_UNAVAILABLE_CODE = "BANK_UNAVAILABLE";

function evidenceOf(result: ReplayResult): string | null {
  return result.status === "needs_human" ? result.contextRef : result.evidenceRef;
}

export function classifyLookup(end: LookupEnd): LookupReading {
  if (end.kind === "thrown") {
    const detail = describeThrown(end.error);
    return NETWORK_THROW_RE.test(detail)
      ? { kind: "transient", detail: `the lookup threw (network/browser): ${detail}`, evidenceRef: null }
      : { kind: "unreadable", detail: `the lookup threw: ${detail}`, evidenceRef: null };
  }
  const { result } = end;
  const evidenceRef = evidenceOf(result);
  switch (result.status) {
    case "success": {
      const raw = result.outputs.matchingCount;
      const text = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
      if (!/^\d+$/.test(text)) {
        return { kind: "unreadable", detail: `the history page loaded but its count is not a number: ${JSON.stringify(raw)}`, evidenceRef };
      }
      const ref = result.outputs.firstMatchRef;
      const firstMatchRef = typeof ref === "string" && ref.trim() !== "" ? ref.trim() : null;
      return { kind: "count", n: Number(text), firstMatchRef, evidenceRef };
    }
    case "business_outcome":
      return result.code === BANK_UNAVAILABLE_CODE
        ? { kind: "unavailable", detail: `the bank is unavailable (${result.code}: ${result.detail})`, evidenceRef }
        : { kind: "unreadable", detail: `the lookup ended in a business outcome: ${result.code}: ${result.detail}`, evidenceRef };
    case "failure":
      return result.category === "session-timeout"
        ? { kind: "transient", detail: `session timeout at ${result.atStepId}: ${result.observed}`, evidenceRef }
        : { kind: "unreadable", detail: `the page could not be understood at ${result.atStepId} (${result.category}): ${result.observed}`, evidenceRef };
    case "needs_human":
      return RECOVERABLE_EXHAUSTED_RE.test(result.reason)
        ? { kind: "transient", detail: result.reason, evidenceRef }
        : { kind: "unreadable", detail: `the lookup needs a human at ${result.atStepId}: ${result.reason}`, evidenceRef };
  }
}

/** After the one retry: a transient that is still there means the bank is unavailable. */
export function afterRetry(reading: LookupReading): LookupReading {
  return reading.kind === "transient"
    ? { kind: "unavailable", detail: `still failing after one retry: ${reading.detail}`, evidenceRef: reading.evidenceRef }
    : reading;
}

/** The readings are enough to decide: one non-zero count or one non-count; else two readings. */
export function readingsComplete(readings: readonly LookupReading[]): boolean {
  const first = readings[0];
  if (!first) return false;
  if (first.kind !== "count" || first.n !== 0) return true;
  return readings.length >= 2;
}

/** job_verifications.lookups: the count of each lookup, NULL where it read nothing. */
export function lookupsColumn(readings: readonly LookupReading[]): Array<number | null> {
  return readings.map((r) => (r.kind === "count" ? r.n : null));
}

export interface DeferConfig {
  /** Deferrals stop after this long (database clock) from the first one; then needs_human / verify_unavailable. */
  budgetSeconds: number;
  /** Backoff before the n-th resume: min(cap, base * 2^n) seconds. */
  backoffBaseSeconds: number;
  backoffCapSeconds: number;
}

export const DEFAULT_DEFER_CONFIG: DeferConfig = { budgetSeconds: 600, backoffBaseSeconds: 5, backoffCapSeconds: 60 };

export function deferBackoffSeconds(deferralsSoFar: number, config: DeferConfig): number {
  return Math.min(config.backoffCapSeconds, config.backoffBaseSeconds * 2 ** Math.min(deferralsSoFar, 20));
}

export interface VerifyInput {
  readings: readonly LookupReading[];
  priorStatus: PriorStatus;
  attempt: number;
  maxAttempts: number;
  /**
   * The job's lease crashes (jobs.lease_crashes, D57, D58). The attempt being verified reached its intent, so it
   * is one of the job's own; the leases that died before their intent are not: [0, 0] resubmits while
   * ownAttempts(attempt, leaseCrashes) < maxAttempts. Verifier deaths never matter here. Default 0.
   */
  leaseCrashes?: number;
  /** From the job's verify cycle, read at decision time (database clock). */
  deferrals: number;
  deferredForSeconds: number | null;
  defer: DeferConfig;
}

export type VerifyDecision =
  | { decision: "already_done"; to: "succeeded"; outcome: "already_done"; confirmationRef: string; evidenceRef: string | null; error: null }
  | { decision: "resubmitted"; to: "queued"; outcome: null; error: string }
  | { decision: "exhausted"; to: "failed"; outcome: "not_committed_attempts_exhausted"; error: string }
  | { decision: "not_committed_final"; to: "business_outcome"; outcome: "business_outcome"; error: string }
  | { decision: "escalated"; to: "needs_human"; outcome: "ambiguous" | "unreadable" | "verify_unavailable"; error: string }
  | { decision: "deferred"; to: "verifying"; outcome: "commit_uncertain"; backoffSeconds: number; error: string };

const fmt = (readings: readonly LookupReading[]) => JSON.stringify(lookupsColumn(readings));

/**
 * One row per line of docs/plans/step-08.md section 5's table, plus the deferral (reviewer decision 5):
 *
 *   lookups          prior_status        decision               job
 *   [1] / [0, 1]     any                 already_done           succeeded / already_done, confirmationRef = firstMatchRef
 *   [0, 0]           not business_out.   resubmitted            queued (own attempts left, D57)  -- the ONLY retry after an intent
 *   [0, 0]           not business_out.   exhausted              failed / not_committed_attempts_exhausted
 *   [0, 0]           business_outcome    not_committed_final    business_outcome (the refusal stands), never retried
 *   [2+] / [0, 2+]   any                 escalated              needs_human / ambiguous
 *   unreadable       any                 escalated              needs_human / unreadable
 *   unavailable      within the budget   deferred               verifying, resumed after a backoff (T8, T6.7)
 *   unavailable      budget exhausted    escalated              needs_human / verify_unavailable
 */
export function verifyDecision(input: VerifyInput): VerifyDecision {
  const { readings } = input;
  if (!readingsComplete(readings)) throw new Error(`verifyDecision: incomplete lookups ${fmt(readings)}`);
  const last = readings[readings.length - 1]!;
  if (last.kind === "unreadable") {
    return { decision: "escalated", to: "needs_human", outcome: "unreadable", error: `verify could not read the history (lookups ${fmt(readings)}): ${last.detail}` };
  }
  if (last.kind === "unavailable" || last.kind === "transient") {
    if (input.deferredForSeconds !== null && input.deferredForSeconds >= input.defer.budgetSeconds) {
      return {
        decision: "escalated",
        to: "needs_human",
        outcome: "verify_unavailable",
        error:
          `verify gave up: the bank has been unavailable for ${Math.round(input.deferredForSeconds)} s since the first deferral ` +
          `(budget ${input.defer.budgetSeconds} s, ${input.deferrals} deferrals): ${last.detail}`,
      };
    }
    const backoffSeconds = deferBackoffSeconds(input.deferrals, input.defer);
    return {
      decision: "deferred",
      to: "verifying",
      outcome: "commit_uncertain",
      backoffSeconds,
      error: `verify deferred ${backoffSeconds} s (deferral ${input.deferrals + 1}; the bank is unavailable): ${last.detail}`,
    };
  }
  // Every reading is a count from here on.
  const counts = readings as ReadonlyArray<Extract<LookupReading, { kind: "count" }>>;
  const decisive = counts.find((r) => r.n !== 0);
  if (decisive && decisive.n >= 2) {
    return {
      decision: "escalated",
      to: "needs_human",
      outcome: "ambiguous",
      error: `verify found ${decisive.n} transfers with this memo_key (lookups ${fmt(readings)}; first ${decisive.firstMatchRef ?? "?"}): a duplicate? A human must check`,
    };
  }
  if (decisive) {
    if (!decisive.firstMatchRef) {
      return { decision: "escalated", to: "needs_human", outcome: "unreadable", error: `verify found 1 match but could not read its Reference (lookups ${fmt(readings)})` };
    }
    return { decision: "already_done", to: "succeeded", outcome: "already_done", confirmationRef: decisive.firstMatchRef, evidenceRef: decisive.evidenceRef, error: null };
  }
  // [0, 0]: the transfer did not happen.
  if (input.priorStatus === "business_outcome") {
    return {
      decision: "not_committed_final",
      to: "business_outcome",
      outcome: "business_outcome",
      error: `verified not committed (lookups ${fmt(readings)}): the bank's refusal after Submit stands; never retried`,
    };
  }
  // The job's own attempts (D57): leases that died before their intent did not use one.
  const own = ownAttempts(input.attempt, input.leaseCrashes ?? 0);
  if (own < input.maxAttempts) {
    return {
      decision: "resubmitted",
      to: "queued",
      outcome: null,
      error: `verified not committed (lookups ${fmt(readings)}): resubmitting as attempt ${own + 1}/${input.maxAttempts}`,
    };
  }
  return {
    decision: "exhausted",
    to: "failed",
    outcome: "not_committed_attempts_exhausted",
    error: `verified not committed (lookups ${fmt(readings)}) on the last attempt (${own}/${input.maxAttempts}): failed, nothing moved`,
  };
}

/** What T7 stores as jobs.result for already_done: the oracle reads outputs.confirmationRef (D32). */
export function alreadyDoneResult(d: Extract<VerifyDecision, { decision: "already_done" }>): Record<string, unknown> {
  return { status: "success", outputs: { confirmationRef: d.confirmationRef }, evidenceRef: d.evidenceRef ?? "verify", recoveredBy: "verify" };
}

/**
 * `rote jobs reverify` accepts needs_human jobs with these outcomes: the "could not tell" ones. Never `ambiguous`.
 * `crash_limit` (D58) took over `verify_exhausted`'s role (a needs_human crash_limit is always past its intent);
 * `verify_exhausted` stays for the jobs Step 9-10a escalated.
 */
export const REVERIFIABLE_OUTCOMES = ["commit_uncertain", "unreadable", "verify_unavailable", "verify_exhausted", "crash_limit"] as const;

// ---------------------------------------------------------------------------------------------------
// The reconcile pass (Step 10: docs/plans/step-10.md section 2; reviewer decisions 3 and 5; D50; widened by
// the reviewer decisions on 10a, decision 2: D55).
//
// Verify + resubmit reopens the zombie window (docs/plans/step-08.md section 6): a worker frozen after its
// intent can click after another worker verified [0, 0] and decided, and the bank has no lease to check.
// The window is not closed; it is made LOUD. A job can carry such a late click when a verify once read
// [0, 0] on it -- the decision `resubmitted`, `exhausted` or `not_committed_final` (RECONCILE_TRIGGERS) --
// whatever terminal state it then reached. So every TERMINAL transition to succeeded, failed or
// business_outcome (T4, T6.2, T7) of such a job marks it: reconcile_after = now() + reconcileDueSeconds
// (lease + settle + margin: by then a zombie frozen across its lease has had a full settle period, and the
// margin, to click). R1 claims a due job under a reconcile lease, one history lookup (the same lookup as
// verify, one retry if transient) reads it, and R2 writes reconcileDecision. The count the job's own state
// promises: 1 row for succeeded, 0 for failed / business_outcome (reconcileExpectedMatches):
//
//   job state            lookup                      decision                      job
//   succeeded            1 match                     reconciled                    stays succeeded (reconciled_at = now)
//   succeeded            2+ matches                  duplicate_suspected           needs_human; duplicates_detected_total + 1; an error log line
//   succeeded            0 matches                   reconcile_unreadable          needs_human (a succeeded job the history cannot show is an alarm)
//   failed / bus. out.   0 matches                   reconciled                    stays failed / business_outcome
//   failed / bus. out.   1+ matches                  unrecorded_commit_suspected   needs_human; unrecorded_commits_detected_total + 1; an error log line
//   any                  unreadable                  reconcile_unreadable          needs_human
//   any                  unavailable, within budget  reconcile_deferred            stays as it is, reconcile_after = now + backoff (D44's)
//   any                  unavailable, budget spent   reconcile_unreadable          needs_human
//
// The one exception to "terminal states are final": a reconcile's flag, succeeded / failed / business_outcome
// -> needs_human (reviewer decision 3; 10a decision 2). A job is SETTLED (GET /jobs/:id `settled`) once it
// is terminal and no automatic reconcile is still to run: it never had a reconcile_after, the reconcile
// decided (reconciled_at), or the workers' pass abandoned it (reconcile_abandoned_at, D59). Until then a
// terminal job can still become needs_human. GET /jobs/:id `reconcile` says which (reconcileStatus).
//
// The honest limit (reviewer decision 5): a zombie frozen longer than the delay that also beats its own
// overdue heartbeat on waking clicks AFTER the reconcile read, and that row is silent again. The end-of-day
// batch `rote reconcile --since <duration>` re-reads every such job in a window, regardless of
// reconciled_at, and flags it exactly like R2.

/** The reconcile margin's default (ROTE_RECONCILE_MARGIN_SECONDS): production delay 30 + 5 + 25 = 60 s. */
export const DEFAULT_RECONCILE_MARGIN_SECONDS = 25;

/** lease + settle (rounded up to whole seconds) + margin. */
export function reconcileDueSeconds(leaseSeconds: number, settleMs: number, marginSeconds: number = DEFAULT_RECONCILE_MARGIN_SECONDS): number {
  if (!(leaseSeconds >= 0 && settleMs >= 0 && marginSeconds >= 0)) throw new RangeError("reconcileDueSeconds: every part must be >= 0");
  return leaseSeconds + Math.ceil(settleMs / 1000) + marginSeconds;
}

/** The terminal states a reconcile re-reads (and leaves a job in when the history agrees). needs_human is a human's already. */
export type ReconcilableState = "succeeded" | "failed" | "business_outcome";
export const RECONCILABLE_STATES: readonly ReconcilableState[] = ["succeeded", "failed", "business_outcome"];
export const isReconcilable = (state: string): state is ReconcilableState => (RECONCILABLE_STATES as readonly string[]).includes(state);

/**
 * The verify decisions that read [0, 0] ("not committed") while the attempt's clicker may still be alive
 * (a zombie): a job with one of them is reconciled once it is terminal (D55). `resubmitted` is the
 * reviewer's rule (10a decision 2); `exhausted` and `not_committed_final` are the same [0, 0] read ending the
 * job at once (a T6.4 verify on the last attempt reads [0, 0] while that attempt's frozen worker can still
 * click; and with a history lag over the settle period, D47, [0, 0] can simply be wrong).
 */
export const RECONCILE_TRIGGERS: readonly PhaseDecision[] = ["resubmitted", "exhausted", "not_committed_final"];

/** How many rows the job's own terminal state promises: 1 for succeeded, 0 for failed / business_outcome. */
export function reconcileExpectedMatches(state: ReconcilableState): 0 | 1 {
  return state === "succeeded" ? 1 : 0;
}

export type ReconcileDecisionName = "reconciled" | "duplicate_suspected" | "unrecorded_commit_suspected" | "reconcile_unreadable" | "reconcile_deferred";
/** The reconcile decisions that move the job to needs_human (a flag). */
export const RECONCILE_FLAGS: readonly ReconcileDecisionName[] = ["duplicate_suspected", "unrecorded_commit_suspected", "reconcile_unreadable"];

export type ReconcileDecision =
  | { decision: "reconciled"; to: ReconcilableState; outcome: null; matches: 0 | 1; firstMatchRef: string | null; error: null }
  | { decision: "duplicate_suspected"; to: "needs_human"; outcome: "duplicate_suspected"; matches: number; firstMatchRef: string | null; error: string }
  | { decision: "unrecorded_commit_suspected"; to: "needs_human"; outcome: "unrecorded_commit_suspected"; matches: number; firstMatchRef: string | null; error: string }
  | { decision: "reconcile_unreadable"; to: "needs_human"; outcome: "reconcile_unreadable"; matches: number | null; firstMatchRef: null; error: string }
  | { decision: "reconcile_deferred"; to: ReconcilableState; outcome: null; backoffSeconds: number; error: string };

export interface ReconcileInput {
  /** The job's terminal state when the reconcile claimed it: what the history must agree with. */
  jobState: ReconcilableState;
  /** The one lookup, after its one retry (afterRetry). */
  reading: LookupReading;
  /** The job's reconcile deferrals so far and seconds since the first one ended (database clock). */
  deferrals: number;
  deferredForSeconds: number | null;
  defer: DeferConfig;
}

export function reconcileDecision(input: ReconcileInput): ReconcileDecision {
  const { reading, jobState } = input;
  if (!isReconcilable(jobState)) throw new Error(`reconcileDecision: a ${String(jobState)} job is never reconciled`);
  switch (reading.kind) {
    case "count":
      if (reading.n === reconcileExpectedMatches(jobState)) {
        return { decision: "reconciled", to: jobState, outcome: null, matches: reconcileExpectedMatches(jobState), firstMatchRef: reading.n > 0 ? reading.firstMatchRef : null, error: null };
      }
      if (jobState !== "succeeded") {
        return {
          decision: "unrecorded_commit_suspected",
          to: "needs_human",
          outcome: "unrecorded_commit_suspected",
          matches: reading.n,
          firstMatchRef: reading.firstMatchRef,
          error:
            `reconcile found ${reading.n} transfer(s) with this memo_key although the job ended ${jobState} after a [0, 0] verify ` +
            `(first ${reading.firstMatchRef ?? "?"}): money may have moved that the job says did not (a zombie's late click?). A human must check`,
        };
      }
      if (reading.n >= 2) {
        return {
          decision: "duplicate_suspected",
          to: "needs_human",
          outcome: "duplicate_suspected",
          matches: reading.n,
          firstMatchRef: reading.firstMatchRef,
          error:
            `reconcile found ${reading.n} transfers with this memo_key after the job succeeded on a resubmit ` +
            `(first ${reading.firstMatchRef ?? "?"}): a duplicate is suspected (a zombie's late click?). A human must check`,
        };
      }
      return {
        decision: "reconcile_unreadable",
        to: "needs_human",
        outcome: "reconcile_unreadable",
        matches: 0,
        firstMatchRef: null,
        error: "reconcile found NO transfer with this memo_key, although the job succeeded: the history cannot show it. A human must check",
      };
    case "unreadable":
      return { decision: "reconcile_unreadable", to: "needs_human", outcome: "reconcile_unreadable", matches: null, firstMatchRef: null, error: `reconcile could not read the history: ${reading.detail}` };
    case "unavailable":
    case "transient": {
      if (input.deferredForSeconds !== null && input.deferredForSeconds >= input.defer.budgetSeconds) {
        return {
          decision: "reconcile_unreadable",
          to: "needs_human",
          outcome: "reconcile_unreadable",
          matches: null,
          firstMatchRef: null,
          error:
            `reconcile gave up: the bank has been unavailable for ${Math.round(input.deferredForSeconds)} s since the first deferral ` +
            `(budget ${input.defer.budgetSeconds} s, ${input.deferrals} deferrals): ${reading.detail}`,
        };
      }
      const backoffSeconds = deferBackoffSeconds(input.deferrals, input.defer);
      return { decision: "reconcile_deferred", to: jobState, outcome: null, backoffSeconds, error: `reconcile deferred ${backoffSeconds} s (deferral ${input.deferrals + 1}; the bank is unavailable): ${reading.detail}` };
    }
  }
}

/** What R2 adds to jobs.result under `reconcile` for a needs_human decision (the job's own result is kept). */
export function reconcileResultPatch(d: ReconcileDecision, evidenceRef: string | null, confirmationRef: unknown): Record<string, unknown> {
  return {
    decision: d.decision,
    matches: "matches" in d ? d.matches : null,
    firstMatchRef: "firstMatchRef" in d ? d.firstMatchRef : null,
    jobConfirmationRef: typeof confirmationRef === "string" ? confirmationRef : null,
    evidenceRef,
  };
}

/** The reconcile columns of a job row (0004, 0008), as jobSettled and reconcileStatus read them. */
export interface ReconcileColumns {
  state: string;
  outcome?: string | null;
  reconcile_after: Date | null | undefined;
  reconciled_at: Date | null | undefined;
  /** 0008 (D59): the workers' pass gave up on this job's reconcile; absent on rows read before 0008. */
  reconcile_abandoned_at?: Date | null;
}

/**
 * Settled (GET /jobs/:id): terminal, and no AUTOMATIC reconcile is still to run -- the job never had one
 * (reconcile_after NULL), the reconcile pass decided (reconciled_at set), or the pass abandoned it after
 * max_crashes dead reconcilers (reconcile_abandoned_at, D59; only `rote reconcile --since` re-reads it now).
 * Until then a succeeded, failed or business_outcome job can still change to needs_human (reviewer decision 3;
 * D55). `settled` alone does not say the job was confirmed: reconcileStatus does.
 */
export function jobSettled(job: ReconcileColumns): boolean {
  if (!(TERMINAL_STATES as readonly string[]).includes(job.state)) return false;
  return job.reconcile_after == null || job.reconciled_at != null || job.reconcile_abandoned_at != null;
}

/**
 * GET /jobs/:id `reconcile` (D59, the reviewer's addition): which kind of settled a job is.
 *   none        the job was never marked (no verify ever read [0, 0] on it): nothing to re-read
 *   pending     marked, and the pass has not decided yet (not settled)
 *   reconciled  a reconcile decided and the history agreed with the job's state (the pass or the batch)
 *   flagged     a reconcile moved it to needs_human (duplicate_suspected, unrecorded_commit_suspected,
 *               reconcile_unreadable)
 *   abandoned   the workers' pass gave up after max_crashes dead reconcilers and nothing decided since:
 *               settled WITHOUT being confirmed; no automatic check runs again, `rote reconcile --since` still can
 * A decision by the batch after an abandonment wins (reconciled / flagged).
 */
export type ReconcileStatus = "none" | "pending" | "reconciled" | "flagged" | "abandoned";
export function reconcileStatus(job: ReconcileColumns): ReconcileStatus {
  if (job.reconcile_after == null) return "none";
  if (job.state === "needs_human" && (RECONCILE_FLAGS as readonly string[]).includes(job.outcome ?? "")) return "flagged";
  if (job.reconciled_at != null) return "reconciled";
  if (job.reconcile_abandoned_at != null) return "abandoned";
  return "pending";
}

// ---------------------------------------------------------------------------------------------------
// A reconciler's deaths (Step 10b; the reviewer's confirmation of the D58 readings, reading 2: D59).
//
// A reconcile run that dies leaves its phase open with its reconcile lease expired; the next claim closes it
// `crashed`. That death is NOT one of the job's crashes (jobs.crashes, D58): the job's own work is over, and a
// reconcile only reads the history. It is counted apart (jobs.reconcile_crashes, 0008) by whichever claim
// closes the dead phase: the workers' pass (R1) or the end-of-day batch's claim by id. At the job's crash cap
// (max_crashes: the same number, counted apart) the workers' pass stops reconciling the job (R3): no lease;
// reconcile_abandoned_at = now(), token + 1 (a paused reconciler's late R2 is then lease_lost), the lease
// released, the job's state / outcome / result / error kept; an error-level log line and
// reconcile_abandoned_total. The pass never claims it again. The batch never abandons: it still re-reads it.
//
//   claimer   reconcile_crashes (+ the death this claim closes)   action
//   pass      < max_crashes                                         R1 lease it, reconcile_crashes recorded
//   pass      >= max_crashes                                        R3 abandon
//   batch     any                                                   R1 lease it, reconcile_crashes recorded

export type ReconcileClaimer = "pass" | "batch";

export type ReconcileClaimAction =
  | { kind: "reconcile"; label: "R1"; reconcileCrashes: number }
  | { kind: "abandon"; label: "R3"; reconcileCrashes: number; error: string };

export function reconcileClaimAction(input: {
  state: ReconcilableState;
  /** jobs.reconcile_crashes before this claim. */
  reconcileCrashes: number;
  /** This claim found (and closes) a dead reconciler's open phase. */
  deadReconciler: boolean;
  maxCrashes: number;
  by: ReconcileClaimer;
}): ReconcileClaimAction {
  if (!(Number.isInteger(input.reconcileCrashes) && input.reconcileCrashes >= 0)) throw new RangeError(`reconcileClaimAction: reconcileCrashes must be an integer >= 0 (got ${input.reconcileCrashes})`);
  if (!(Number.isInteger(input.maxCrashes) && input.maxCrashes >= 1)) throw new RangeError(`reconcileClaimAction: maxCrashes must be an integer >= 1 (got ${input.maxCrashes})`);
  const deaths = input.reconcileCrashes + (input.deadReconciler ? 1 : 0);
  if (input.by === "batch" || deaths < input.maxCrashes) return { kind: "reconcile", label: "R1", reconcileCrashes: deaths };
  return {
    kind: "abandon",
    label: "R3",
    reconcileCrashes: deaths,
    error:
      `reconcile abandoned: ${deaths} reconciler(s) died on this job (cap ${input.maxCrashes}, counted apart from the job's own crash budget); ` +
      `the job stays ${input.state}; the workers' reconcile pass will not claim it again; \`rote reconcile --since\` still re-reads it`,
  };
}
