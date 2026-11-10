// How a run's end maps to a job state (docs/plans/step-06.md section 2, reviewer decisions 2-3).
// One pure function, tested row by row. The load-bearing rules:
//   - a business outcome is final, never retried (D21);
//   - anything that MAY have committed (commitUncertain, or a throw after the irreversible step
//     started) is parked as needs_human / outcome "commit_uncertain", never retried, until Day 2's
//     verify reads the bank's history (a retry is the one thing that can duplicate a transfer);
//   - a failure before anything irreversible is retried while attempts are left (D10), else failed;
//   - a job that can never run (unknown capability, bad params, missing override) fails at once.
import type { ReplayResult } from "../artifact/index.js";
import type { Redactor } from "./credentials.js";

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
  /** onIrreversible.before ran in this attempt: the Submit may have been clicked. */
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
