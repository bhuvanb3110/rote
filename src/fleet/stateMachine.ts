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
//   recoveryAction    what T6 does with an expired lease (T6.1 requeue, T6.2 fail; Step 9: T6.4 claim a
//                     `committing` job to verify, T6.5 re-claim a dead verifier's job, T6.6 escalate after
//                     3 dead verify phases, T6.7 resume a deferred or handed-off verify)
//   classifyLookup    what one history lookup said: a count, the bank unavailable, transient, unreadable
//   verifyDecision    what a verify phase concludes from its lookups (Step 9, docs/plans/step-08.md
//                     section 5, plus step-09 reviewer decisions 4-5: deferral)
//   reconcileDecision what the reconcile pass concludes from its one lookup (Step 10, D50), and
//                     jobSettled: terminal with no reconcile due (GET /jobs/:id `settled`)
//
// jobOutcomeFor (docs/plans/step-06.md section 2, reviewer decisions 2-3), tested row by row. The
// load-bearing rules:
//   - a business outcome is final, never retried (D21);
//   - anything that MAY have committed (commitUncertain, or a throw after the commit intent was -- or
//     may have been -- written) is never retried blindly: the live owner moves it straight into its own
//     verify phase (T5, Step 9), which reads the bank's history (a retry is the one thing that can
//     duplicate a transfer);
//   - a failure before anything irreversible is retried while attempts are left (D10), else failed;
//   - a job that can never run (unknown capability, bad params, missing override) fails at once.
import type { ReplayResult } from "../artifact/index.js";
import { TERMINAL_STATES, type JobState } from "../queue/types.js";
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
  const attemptsLeft = ctx.attempt < ctx.maxAttempts;

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
        `attempt ${ctx.attempt}/${ctx.maxAttempts} ${what} before anything irreversible` +
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
          `attempt ${ctx.attempt}/${ctx.maxAttempts}${attemptsLeft ? " (retrying)" : " (attempts exhausted)"}: ` +
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
// (T7) were not the bank's doing and are picked up at once.
//
//   attempt that failed   1      2      3      4+
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
//   left in      condition                                   action                     jobs becomes
//   running      attempt < max_attempts                      T6.1 requeue               queued (nothing irreversible happened)
//   running      attempt >= max_attempts                     T6.2 fail                  failed / lease_expired (never queued, D21)
//   committing   (the intent was written)                    T6.4 claim to verify       verifying, owned by the recoverer
//   verifying    the newest phase was deferred / handed off  T6.7 resume                verifying, owned by the recoverer
//   verifying    fewer than 3 dead phases in this cycle       T6.5 re-claim              verifying, owned by the recoverer
//   verifying    3 dead phases (the verifier keeps dying)     T6.6 escalate              needs_human / verify_exhausted
//
// Step 8's T6.3 (committing -> needs_human) is gone: an expired commit is verified, never parked. A
// "dead" phase is one that ended without a decision: still open when its lease expired, closed
// `crashed` by recovery, `lease_lost` by its own heartbeat, or `illegal_transition` (a bug). Deferred and
// handed-off phases are not dead (they ended on purpose) and never count toward the cap (step-09
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
  // A reconcile run's decisions (Step 10, D50).
  | "reconciled"
  | "duplicate_suspected"
  | "reconcile_unreadable"
  | "reconcile_deferred";
/** Phases that ended without a decision: they count toward the 3-phase cap (T6.6). */
export const DEAD_PHASE_DECISIONS: readonly PhaseDecision[] = ["crashed", "lease_lost", "illegal_transition"];

export const MAX_VERIFY_PHASES = 3;

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
  /** Required for `verifying` (what the cycle's phases say). */
  verify?: VerifyCycle;
}

export type RecoveryAction =
  | { kind: "requeue"; label: "T6.1"; to: "queued"; outcome: null; error: string }
  | { kind: "fail"; label: "T6.2"; to: "failed"; outcome: "lease_expired"; error: string }
  /** T6.4/T6.5/T6.7: the recoverer takes the job (token + 1, its own lease) and verifies it at once. */
  | {
      kind: "verify";
      label: "T6.4" | "T6.5" | "T6.7";
      to: "verifying";
      outcome: "commit_uncertain";
      reason: Exclude<VerifyReason, "commit_uncertain">;
      error: string;
    }
  | { kind: "escalate"; label: "T6.6"; to: "needs_human"; outcome: "verify_exhausted"; error: string };

export function recoveryAction(row: RecoveryRow): RecoveryAction {
  switch (row.state) {
    case "running":
      return row.attempt < row.maxAttempts
        ? {
            kind: "requeue",
            label: "T6.1",
            to: "queued",
            outcome: null,
            error: `lease expired while running (attempt ${row.attempt}/${row.maxAttempts}), before any commit intent; requeued`,
          }
        : {
            kind: "fail",
            label: "T6.2",
            to: "failed",
            outcome: "lease_expired",
            error:
              `lease expired on the last attempt (${row.attempt}/${row.maxAttempts}); ` +
              "no commit intent, so nothing irreversible happened",
          };
    case "committing":
      return {
        kind: "verify",
        label: "T6.4",
        to: "verifying",
        outcome: "commit_uncertain",
        reason: "lease_expired_in_committing",
        error: "lease expired after the commit intent: the Submit may have committed; verifying in the bank's history by memo_key (T6.4)",
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
          error:
            cycle.lastDecision === "deferred"
              ? `resuming a deferred verify (deferral ${cycle.deferrals}; the bank was unavailable) (T6.7)`
              : "resuming a verify handed over by rote jobs reverify (T6.7)",
        };
      }
      if (cycle.deadPhases >= MAX_VERIFY_PHASES) {
        return {
          kind: "escalate",
          label: "T6.6",
          to: "needs_human",
          outcome: "verify_exhausted",
          error:
            `verify exhausted: ${cycle.deadPhases} verify phases died without a decision (crash or lost lease); ` +
            "the Submit may have committed; check the bank's history for memo_key",
        };
      }
      return {
        kind: "verify",
        label: "T6.5",
        to: "verifying",
        outcome: "commit_uncertain",
        reason: "lease_expired_in_verifying",
        error: `a verifier's lease expired (dead verify phases in this cycle: ${cycle.deadPhases}/${MAX_VERIFY_PHASES}); re-verifying (T6.5)`,
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
 *   [0, 0]           not business_out.   resubmitted            queued (attempts left)  -- the ONLY retry after an intent
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
  if (input.attempt < input.maxAttempts) {
    return {
      decision: "resubmitted",
      to: "queued",
      outcome: null,
      error: `verified not committed (lookups ${fmt(readings)}): resubmitting as attempt ${input.attempt + 1}/${input.maxAttempts}`,
    };
  }
  return {
    decision: "exhausted",
    to: "failed",
    outcome: "not_committed_attempts_exhausted",
    error: `verified not committed (lookups ${fmt(readings)}) on the last attempt (${input.attempt}/${input.maxAttempts}): failed, nothing moved`,
  };
}

/** What T7 stores as jobs.result for already_done: the oracle reads outputs.confirmationRef (D32). */
export function alreadyDoneResult(d: Extract<VerifyDecision, { decision: "already_done" }>): Record<string, unknown> {
  return { status: "success", outputs: { confirmationRef: d.confirmationRef }, evidenceRef: d.evidenceRef ?? "verify", recoveredBy: "verify" };
}

/** `rote jobs reverify` accepts needs_human jobs with these outcomes: the "could not tell" ones. Never `ambiguous`. */
export const REVERIFIABLE_OUTCOMES = ["commit_uncertain", "unreadable", "verify_unavailable", "verify_exhausted"] as const;

// ---------------------------------------------------------------------------------------------------
// The reconcile pass (Step 10: docs/plans/step-10.md section 2; reviewer decisions 3 and 5; D50).
//
// Verify + resubmit reopens the zombie window (docs/plans/step-08.md section 6): a worker frozen after its
// intent can click after another worker verified [0, 0] and resubmitted, and the bank has no lease to
// check. The window is not closed; it is made LOUD. Only a job that SUCCEEDED AFTER A RESUBMIT can carry
// such a late second transfer, so T4 (succeeded) and T7 (already_done) mark it: reconcile_after = now() +
// reconcileDueSeconds (lease + settle + margin: by then a zombie frozen across its lease has had a full
// settle period, and the margin, to click). R1 claims a due job under a reconcile lease, one history
// lookup (the same lookup as verify, one retry if transient) reads it, and R2 writes reconcileDecision:
//
//   lookup                      decision               job
//   1 match                     reconciled             stays succeeded (reconciled_at = now)
//   2+ matches                  duplicate_suspected    needs_human; duplicates_detected_total + 1; an error log line
//   0 matches / unreadable      reconcile_unreadable   needs_human (a succeeded job the history cannot show is an alarm)
//   unavailable, within budget  reconcile_deferred     stays succeeded, reconcile_after = now + backoff (D44's)
//   unavailable, budget spent   reconcile_unreadable   needs_human
//
// The one exception to "terminal states are final": succeeded -> needs_human (reviewer decision 3). A job
// is SETTLED (GET /jobs/:id `settled`) once it is terminal and no reconcile is due: it never had a
// reconcile_after, or the reconcile decided (reconciled_at). Until then a succeeded job can still become
// needs_human.
//
// The honest limit (reviewer decision 5): a zombie frozen longer than the delay that also beats its own
// overdue heartbeat on waking clicks AFTER the reconcile read, and that duplicate is silent again. The
// end-of-day batch `rote reconcile --since <duration>` re-reads every such job in a window, regardless of
// reconciled_at, and flags 2+ matches exactly like R2.

/** The reconcile margin's default (ROTE_RECONCILE_MARGIN_SECONDS): production delay 30 + 5 + 25 = 60 s. */
export const DEFAULT_RECONCILE_MARGIN_SECONDS = 25;

/** lease + settle (rounded up to whole seconds) + margin. */
export function reconcileDueSeconds(leaseSeconds: number, settleMs: number, marginSeconds: number = DEFAULT_RECONCILE_MARGIN_SECONDS): number {
  if (!(leaseSeconds >= 0 && settleMs >= 0 && marginSeconds >= 0)) throw new RangeError("reconcileDueSeconds: every part must be >= 0");
  return leaseSeconds + Math.ceil(settleMs / 1000) + marginSeconds;
}

export type ReconcileDecisionName = "reconciled" | "duplicate_suspected" | "reconcile_unreadable" | "reconcile_deferred";

export type ReconcileDecision =
  | { decision: "reconciled"; to: "succeeded"; outcome: null; matches: 1; firstMatchRef: string | null; error: null }
  | { decision: "duplicate_suspected"; to: "needs_human"; outcome: "duplicate_suspected"; matches: number; firstMatchRef: string | null; error: string }
  | { decision: "reconcile_unreadable"; to: "needs_human"; outcome: "reconcile_unreadable"; matches: number | null; firstMatchRef: null; error: string }
  | { decision: "reconcile_deferred"; to: "succeeded"; outcome: null; backoffSeconds: number; error: string };

export interface ReconcileInput {
  /** The one lookup, after its one retry (afterRetry). */
  reading: LookupReading;
  /** The job's reconcile deferrals so far and seconds since the first one ended (database clock). */
  deferrals: number;
  deferredForSeconds: number | null;
  defer: DeferConfig;
}

export function reconcileDecision(input: ReconcileInput): ReconcileDecision {
  const { reading } = input;
  switch (reading.kind) {
    case "count":
      if (reading.n === 1) return { decision: "reconciled", to: "succeeded", outcome: null, matches: 1, firstMatchRef: reading.firstMatchRef, error: null };
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
      return { decision: "reconcile_deferred", to: "succeeded", outcome: null, backoffSeconds, error: `reconcile deferred ${backoffSeconds} s (deferral ${input.deferrals + 1}; the bank is unavailable): ${reading.detail}` };
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

/**
 * Settled (GET /jobs/:id): terminal, and no reconcile is due -- the job never had one (reconcile_after
 * NULL) or the reconcile pass decided (reconciled_at set). Until then a succeeded job can still change to
 * needs_human (reviewer decision 3).
 */
export function jobSettled(job: { state: string; reconcile_after: Date | null | undefined; reconciled_at: Date | null | undefined }): boolean {
  if (!(TERMINAL_STATES as readonly string[]).includes(job.state)) return false;
  return job.reconcile_after == null || job.reconciled_at != null;
}
