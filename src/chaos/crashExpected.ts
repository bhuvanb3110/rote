// What each crash point must end in, per Day-2 step (docs/plans/step-08.md section 9). The crash-point
// matrix (scripts/crash-matrix.ts) passes a point only if the fault fired there, the oracle passes, AND
// the final job matches this expectation: "oracle ok" alone is not enough after Day 2 (a needs_human job
// with 0 rows passes the oracle but is the wrong answer once verify exists).
import { TRANSFER_FAULT_POINTS } from "../worker/fault.js";

export interface CrashExpectation {
  state: "succeeded" | "needs_human";
  /** jobs.outcome, when it matters. */
  outcome?: string;
  attempt: number;
  ledgerRows: number;
  /** One line for the matrix's Expected column. */
  says: string;
}

export const EXPECTATION_PHASES = ["step-08"] as const;
export type ExpectationPhase = (typeof EXPECTATION_PHASES)[number];

const BEFORE_INTENT = /^(after-dequeue|after-step-(0[1-9]|10))$/;

/** Step 8: blind retry before the intent; the interim needs_human (T6.3) after it; never 2 rows. */
function step08(point: string): CrashExpectation {
  if (BEFORE_INTENT.test(point)) {
    return { state: "succeeded", outcome: "success", attempt: 2, ledgerRows: 1, says: "requeued (T6.1), attempt 2 succeeded, 1 row" };
  }
  switch (point) {
    case "before-submit":
      return { state: "needs_human", outcome: "commit_uncertain", attempt: 1, ledgerRows: 0, says: "needs_human (T6.3), 0 rows" };
    case "after-submit":
    case "after-step-12":
    case "before-complete":
      return { state: "needs_human", outcome: "commit_uncertain", attempt: 1, ledgerRows: 1, says: "needs_human (T6.3), 1 row" };
    case "after-complete":
      return { state: "succeeded", outcome: "success", attempt: 1, ledgerRows: 1, says: "succeeded before the kill, 1 row" };
    default:
      throw new Error(`no Step 8 expectation for crash point "${point}"`);
  }
}

export function expectedFor(point: string, phase: ExpectationPhase = "step-08"): CrashExpectation {
  switch (phase) {
    case "step-08":
      return step08(point);
  }
}

export interface CrashObserved {
  fired: boolean;
  oracleVerdict: string;
  state: string;
  outcome: string | null;
  attempt: number;
  ledgerRows: number;
}

/** null = the point passes; otherwise why it does not. */
export function judgePoint(observed: CrashObserved, expected: CrashExpectation): string | null {
  if (!observed.fired) return "FAULT_NOT_FIRED";
  if (observed.oracleVerdict !== "ok") return observed.oracleVerdict;
  const wrong: string[] = [];
  if (observed.state !== expected.state) wrong.push(`state ${observed.state} (expected ${expected.state})`);
  if (expected.outcome !== undefined && observed.outcome !== expected.outcome) wrong.push(`outcome ${observed.outcome} (expected ${expected.outcome})`);
  if (observed.attempt !== expected.attempt) wrong.push(`attempt ${observed.attempt} (expected ${expected.attempt})`);
  if (observed.ledgerRows !== expected.ledgerRows) wrong.push(`rows ${observed.ledgerRows} (expected ${expected.ledgerRows})`);
  return wrong.length === 0 ? null : `UNEXPECTED: ${wrong.join(", ")}`;
}

/** Every transfer point has an expectation (checked by the unit test). */
export const ALL_POINTS: readonly string[] = TRANSFER_FAULT_POINTS;
