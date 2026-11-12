// The fleet's state machine as pure functions (docs/plans/step-08.md section 7). Every decision about
// a job's next state is made HERE; the SQL in src/worker/ (T2 heartbeat, T3 commit intent, T4
// completion, T6 recovery) executes it and repeats its guards, and nothing decides in SQL alone. The
// worker code, the unit tests, the pure-model property tests and the model-vs-real test all use these
// same functions (src/fleet/model.ts mirrors the SQL on top of them).
//
//   jobOutcomeFor     how a run's end maps to a job state (Step 6, D25; moved from src/worker/outcome.ts)
//   completionAllowed which state T4 may write from which (Step 8: requeue/fail only from `running`)
//   recoveryAction    what T6 does with an expired lease (Step 8: T6.1 requeue, T6.2 fail, T6.3 escalate)
//   (Step 9 adds verifyDecision and T6.4-T6.6.)
//
// jobOutcomeFor (docs/plans/step-06.md section 2, reviewer decisions 2-3), tested row by row. The
// load-bearing rules:
//   - a business outcome is final, never retried (D21);
//   - anything that MAY have committed (commitUncertain, or a throw after the commit intent was -- or
//     may have been -- written) is parked as needs_human / outcome "commit_uncertain", never retried,
//     until Step 9's verify reads the bank's history (a retry is the one thing that can duplicate a
//     transfer);
//   - a failure before anything irreversible is retried while attempts are left (D10), else failed;
//   - a job that can never run (unknown capability, bad params, missing override) fails at once.
import type { ReplayResult } from "../artifact/index.js";
import type { JobState } from "../queue/types.js";
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

export interface JobOutcome {
  /** "queued" = requeue for another attempt (lease cleared). */
  state: FinalJobState | "queued";
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
        state: "needs_human",
        outcome: "commit_uncertain",
        error: err(
          `commit uncertain (not retried): the run ${what} after the irreversible step started; ` +
            `verify in the bank's history by memo_key before any retry. ${describeThrown(end.error)}`,
        ),
        result: null,
        attemptOutcome,
        commitUncertain: true,
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
    // bank may have committed. Parked until Day 2's verify; never retried.
    return {
      state: "needs_human",
      outcome: "commit_uncertain",
      error: err(
        `commit uncertain (not retried): ${result.commitUncertain.detail}. Verify in the bank's history by ` +
          `memo_key before any retry.`,
      ),
      result,
      attemptOutcome: result.status,
      commitUncertain: true,
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
// T6 (recovery of an expired lease), Step 8 (docs/plans/step-08.md section 4).
//
// Every action bumps the fencing token, so "the token changed" always means "the old holder is
// fenced" (reviewer decision 3), and closes the dead holder's attempt row as `crashed`.
//
//   left in      condition                  action                 jobs becomes
//   running      attempt < max_attempts     T6.1 requeue           queued (nothing irreversible happened)
//   running      attempt >= max_attempts    T6.2 fail              failed / lease_expired (never queued, D21)
//   committing   (Step 8, interim)          T6.3 escalate          needs_human / commit_uncertain
//   verifying    (Step 8: unreachable)      T6.3 escalate          needs_human / commit_uncertain
//
// Step 9 replaces T6.3 for `committing` with T6.4 (claim to verify) and adds T6.5/T6.6 for `verifying`.
// Step 8 never writes `verifying`; a row found there (only by hand, or after a rollback from Step 9
// code) is escalated, the one answer that is safe without reading the bank.

export type RecoverableState = "running" | "committing" | "verifying";

export interface RecoveryRow {
  state: RecoverableState;
  attempt: number;
  maxAttempts: number;
}

export type RecoveryAction =
  | { kind: "requeue"; label: "T6.1"; to: "queued"; outcome: null; error: string }
  | { kind: "fail"; label: "T6.2"; to: "failed"; outcome: "lease_expired"; error: string }
  | { kind: "escalate"; label: "T6.3"; to: "needs_human"; outcome: "commit_uncertain"; error: string };

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
        kind: "escalate",
        label: "T6.3",
        to: "needs_human",
        outcome: "commit_uncertain",
        error: "lease expired after the commit intent: the Submit may have committed; check the bank's history for memo_key",
      };
    case "verifying":
      return {
        kind: "escalate",
        label: "T6.3",
        to: "needs_human",
        outcome: "commit_uncertain",
        error: "lease expired while verifying (no verifier in Step 8): the Submit may have committed; check the bank's history for memo_key",
      };
  }
}
