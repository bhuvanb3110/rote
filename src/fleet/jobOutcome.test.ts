// jobOutcomeFor: one case per row of docs/plans/step-06.md section 2's table.
import { describe, expect, it } from "vitest";
import type { ReplayResult } from "../artifact/index.js";
import { jobOutcomeFor, MAX_ERROR_LENGTH, type OutcomeContext } from "./stateMachine.js";

const CU = { irreversibleStepId: "step-11", detail: "Attempted the irreversible step, then the run ended in failure" };
const first: OutcomeContext = { attempt: 1, maxAttempts: 3, irreversibleStarted: false };
const last: OutcomeContext = { attempt: 3, maxAttempts: 3, irreversibleStarted: false };

const success: ReplayResult = { status: "success", outputs: { confirmationRef: "TXN-000001" }, evidenceRef: "evidence://x" };
const business: ReplayResult = { status: "business_outcome", code: "NO_SUCH_RECIPIENT", detail: "No such member", evidenceRef: "e" };
const failure: ReplayResult = {
  status: "failure",
  atStepId: "step-06",
  expected: "Transfer button",
  observed: "System unavailable",
  category: "unexpected-state",
  evidenceRef: "e",
};
const needsHuman: ReplayResult = { status: "needs_human", reason: "approved for 1.0.0, artifact is 1.1.0", atStepId: "step-01", contextRef: "c" };

describe("jobOutcomeFor (step-06 section 2)", () => {
  it("success -> succeeded / success", () => {
    expect(jobOutcomeFor({ kind: "result", result: success }, first)).toEqual({
      state: "succeeded",
      outcome: "success",
      error: null,
      result: success,
      attemptOutcome: "success",
      commitUncertain: false,
    });
  });

  it("business_outcome without commitUncertain -> business_outcome, never retried (even on attempt 1)", () => {
    const o = jobOutcomeFor({ kind: "result", result: business }, first);
    expect(o).toMatchObject({ state: "business_outcome", outcome: "business_outcome", attemptOutcome: "business_outcome", commitUncertain: false });
    expect(o.error).toContain("NO_SUCH_RECIPIENT");
  });

  it("Step 9: business_outcome WITH commitUncertain -> verifying (T5), prior_status business_outcome, never retried blindly", () => {
    const o = jobOutcomeFor({ kind: "result", result: { ...business, commitUncertain: CU } }, first);
    expect(o).toMatchObject({ state: "verifying", outcome: "commit_uncertain", attemptOutcome: "business_outcome", commitUncertain: true, priorStatus: "business_outcome" });
    expect(o.error).toMatch(/commit uncertain \(not retried blindly\): .*Verifying in the bank's history by memo_key \(T5\)/);
  });

  it("Step 9: failure WITH commitUncertain -> verifying (T5), never retried blindly, even with attempts left", () => {
    const o = jobOutcomeFor({ kind: "result", result: { ...failure, commitUncertain: CU } }, first);
    expect(o).toMatchObject({ state: "verifying", outcome: "commit_uncertain", attemptOutcome: "failure", commitUncertain: true, priorStatus: "failure" });
    expect(o.result).toMatchObject({ commitUncertain: CU });
  });

  it("needs_human (e.g. the approval gate refused) -> needs_human / needs_human", () => {
    const o = jobOutcomeFor({ kind: "result", result: needsHuman }, first);
    expect(o).toMatchObject({ state: "needs_human", outcome: "needs_human", attemptOutcome: "needs_human", commitUncertain: false });
  });

  it("needs_human carrying commitUncertain (defensive) -> verifying (T5) too", () => {
    const o = jobOutcomeFor({ kind: "result", result: { ...needsHuman, commitUncertain: CU } }, first);
    expect(o).toMatchObject({ state: "verifying", outcome: "commit_uncertain", commitUncertain: true, priorStatus: "needs_human" });
  });

  it("failure without commitUncertain, attempts left -> queued (retry), no terminal outcome", () => {
    const o = jobOutcomeFor({ kind: "result", result: failure }, first);
    expect(o).toMatchObject({ state: "queued", outcome: null, attemptOutcome: "failure", commitUncertain: false });
    expect(o.error).toMatch(/attempt 1\/3 \(retrying\)/);
  });

  it("failure without commitUncertain, attempts exhausted -> failed / failure", () => {
    const o = jobOutcomeFor({ kind: "result", result: failure }, last);
    expect(o).toMatchObject({ state: "failed", outcome: "failure", attemptOutcome: "failure" });
    expect(o.error).toMatch(/attempt 3\/3 \(attempts exhausted\)/);
  });

  it("invalid job (preflight refused) -> failed / invalid_job, never retried", () => {
    const o = jobOutcomeFor({ kind: "invalid", error: new Error('No capability with id "nope".') }, first);
    expect(o).toMatchObject({ state: "failed", outcome: "invalid_job", attemptOutcome: "failure", result: null });
    expect(o.error).toContain('No capability with id "nope"');
  });

  it("threw before the irreversible step: retry while attempts are left, then failed", () => {
    const thrown = { kind: "thrown" as const, error: new Error("Target page, context or browser has been closed"), aborted: false };
    expect(jobOutcomeFor(thrown, first)).toMatchObject({ state: "queued", outcome: null, attemptOutcome: "failure", commitUncertain: false });
    expect(jobOutcomeFor(thrown, last)).toMatchObject({ state: "failed", outcome: "failure" });
  });

  it("threw AFTER the irreversible step started -> verifying (T5), prior_status null, never retried blindly", () => {
    const thrown = { kind: "thrown" as const, error: new Error("browser crashed"), aborted: false };
    const o = jobOutcomeFor(thrown, { ...first, irreversibleStarted: true });
    expect(o).toMatchObject({ state: "verifying", outcome: "commit_uncertain", attemptOutcome: "failure", commitUncertain: true, priorStatus: null });
  });

  it("aborted by shutdown: before the irreversible step -> requeue (attempt counted) / failed 'aborted' when exhausted", () => {
    const aborted = { kind: "thrown" as const, error: new DOMException("shutdown", "AbortError"), aborted: true };
    expect(jobOutcomeFor(aborted, first)).toMatchObject({ state: "queued", outcome: null, attemptOutcome: "aborted" });
    expect(jobOutcomeFor(aborted, last)).toMatchObject({ state: "failed", outcome: "aborted", attemptOutcome: "aborted" });
  });

  it("aborted by shutdown AFTER the irreversible step started -> verifying (T5)", () => {
    const aborted = { kind: "thrown" as const, error: new DOMException("shutdown", "AbortError"), aborted: true };
    expect(jobOutcomeFor(aborted, { ...first, irreversibleStarted: true })).toMatchObject({
      state: "verifying",
      outcome: "commit_uncertain",
      attemptOutcome: "aborted",
      commitUncertain: true,
    });
  });

  it("every error string goes through the redactor and is clipped", () => {
    const redact = (s: string) => s.replaceAll("hunter22", "[REDACTED]");
    const o = jobOutcomeFor({ kind: "thrown", error: new Error(`login hunter22 failed ${"x".repeat(5000)}`), aborted: false }, { ...first, redact });
    expect(o.error).not.toContain("hunter22");
    expect(o.error).toContain("[REDACTED]");
    expect(o.error!.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
  });
});
