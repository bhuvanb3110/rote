// What each crash point must end in, per Day-2 step (docs/plans/step-08.md section 9; Step 9 in
// docs/plans/step-09.md). The crash-point matrix (scripts/crash-matrix.ts) passes a point only if the
// fault fired there (both faults, for a two-fault scenario), the oracle says what it should, AND the
// final job matches this expectation: "oracle ok" alone is not enough after Day 2 (a needs_human job
// with 0 rows passes the oracle but is the wrong answer once verify exists).
import { TRANSFER_FAULT_POINTS } from "../worker/fault.js";

export interface CrashExpectation {
  state: "succeeded" | "needs_human";
  /** jobs.outcome, when it matters. */
  outcome?: string;
  attempt: number;
  ledgerRows: number;
  /** The oracle's verdict for the job; default "ok". */
  oracle?: string;
  /** One line for the matrix's Expected column. */
  says: string;
}

export const EXPECTATION_PHASES = ["step-08", "step-09"] as const;
export type ExpectationPhase = (typeof EXPECTATION_PHASES)[number];

const BEFORE_INTENT = /^(after-dequeue|after-step-(0[1-9]|10))$/;
const RETRIED: CrashExpectation = { state: "succeeded", outcome: "success", attempt: 2, ledgerRows: 1, says: "requeued (T6.1), attempt 2 succeeded, 1 row" };
const DONE_BEFORE_KILL: CrashExpectation = { state: "succeeded", outcome: "success", attempt: 1, ledgerRows: 1, says: "succeeded before the kill, 1 row" };

/** Step 8: blind retry before the intent; the interim needs_human (T6.3) after it; never 2 rows. */
function step08(point: string): CrashExpectation {
  if (BEFORE_INTENT.test(point)) return RETRIED;
  switch (point) {
    case "before-submit":
      return { state: "needs_human", outcome: "commit_uncertain", attempt: 1, ledgerRows: 0, says: "needs_human (T6.3), 0 rows" };
    case "after-submit":
    case "after-step-12":
    case "before-complete":
      return { state: "needs_human", outcome: "commit_uncertain", attempt: 1, ledgerRows: 1, says: "needs_human (T6.3), 1 row" };
    case "after-complete":
      return DONE_BEFORE_KILL;
    default:
      throw new Error(`no Step 8 expectation for crash point "${point}"`);
  }
}

/** The intent was written but nothing reached the bank: verify [0, 0] resubmits; attempt 2 transfers. */
const RESUBMITTED: CrashExpectation = { state: "succeeded", outcome: "success", attempt: 2, ledgerRows: 1, says: "verified [0, 0] -> resubmitted -> attempt 2 succeeded, 1 row" };
/** The bank committed: verify [1] -> already_done on attempt 1, confirmationRef = the row. */
const ALREADY_DONE: CrashExpectation = { state: "succeeded", outcome: "already_done", attempt: 1, ledgerRows: 1, says: "verified [1] -> succeeded / already_done, attempt 1, 1 row" };

/** Step 9: after the intent, every point is verified (step-08 section 9's right-hand column). */
function step09(point: string): CrashExpectation {
  if (BEFORE_INTENT.test(point)) return RETRIED;
  switch (point) {
    case "before-submit":
      return { ...RESUBMITTED, says: "T6.4 verify [0, 0] -> resubmitted -> attempt 2 succeeded, 1 row" };
    case "after-submit":
    case "after-step-12":
    case "before-complete":
      return { ...ALREADY_DONE, says: "T6.4 verify [1] -> succeeded / already_done, attempt 1, 1 row" };
    case "after-complete":
      return DONE_BEFORE_KILL;
    default:
      throw new Error(`no Step 9 expectation for crash point "${point}"`);
  }
}

export function expectedFor(point: string, phase: ExpectationPhase = "step-08"): CrashExpectation {
  switch (phase) {
    case "step-08":
      return step08(point);
    case "step-09":
      return step09(point);
  }
}

/**
 * A crash scenario: the first worker dies at `first`; for a two-fault scenario the worker that then
 * RECOVERS the job dies at `second` (a recovery-internal point); a clean worker finishes.
 */
export interface CrashScenario {
  name: string;
  first: string;
  second?: string;
  expected: CrashExpectation;
}

/** step-08 section 9's second table (reviewer decision B4 of Step 7), built in Step 9. */
export const RECOVERY_SCENARIOS: readonly CrashScenario[] = [
  { name: "after-submit>verify-after-login", first: "after-submit", second: "verify-after-login", expected: { ...ALREADY_DONE, says: "re-verify (T6.5) [1] -> succeeded / already_done, 1 row" } },
  { name: "after-submit>verify-after-count", first: "after-submit", second: "verify-after-count", expected: { ...ALREADY_DONE, says: "re-verify (T6.5) [1] -> succeeded / already_done, 1 row" } },
  { name: "after-submit>verify-before-result", first: "after-submit", second: "verify-before-result", expected: { ...ALREADY_DONE, says: "re-verify (T6.5) [1] -> succeeded / already_done, 1 row" } },
  { name: "before-submit>verify-after-count", first: "before-submit", second: "verify-after-count", expected: { ...RESUBMITTED, says: "re-verify (T6.5) [0, 0] -> requeued -> attempt 2 succeeded, 1 row" } },
  { name: "before-submit>verify-before-requeue", first: "before-submit", second: "verify-before-requeue", expected: { ...RESUBMITTED, says: "re-verify (T6.5) -> requeued -> attempt 2 succeeded, 1 row" } },
  { name: "before-submit>verify-after-requeue", first: "before-submit", second: "verify-after-requeue", expected: { ...RESUBMITTED, says: "already requeued; dequeued normally -> attempt 2 succeeded, 1 row" } },
  { name: "after-dequeue>recover-in-transaction", first: "after-dequeue", second: "recover-in-transaction", expected: { ...RETRIED, says: "rollback releases the lock; another recoverer requeues (T6.1) -> attempt 2 succeeded, 1 row" } },
];

/** Every scenario a phase judges: the transfer's 16 single points, plus Step 9's two-fault scenarios. */
export function scenariosFor(phase: ExpectationPhase): CrashScenario[] {
  const single = TRANSFER_FAULT_POINTS.map((point) => ({ name: point, first: point, expected: expectedFor(point, phase) }));
  return phase === "step-09" ? [...single, ...RECOVERY_SCENARIOS] : single;
}

export interface CrashObserved {
  fired: boolean;
  /** The second fault of a two-fault scenario fired too (undefined for a single point). */
  secondFired?: boolean;
  oracleVerdict: string;
  state: string;
  outcome: string | null;
  attempt: number;
  ledgerRows: number;
}

/** null = the point passes; otherwise why it does not. */
export function judgePoint(observed: CrashObserved, expected: CrashExpectation): string | null {
  if (!observed.fired) return "FAULT_NOT_FIRED";
  if (observed.secondFired === false) return "SECOND_FAULT_NOT_FIRED";
  if (observed.oracleVerdict !== (expected.oracle ?? "ok")) return observed.oracleVerdict === "ok" ? `ORACLE_OK (expected ${expected.oracle})` : observed.oracleVerdict;
  const wrong: string[] = [];
  if (observed.state !== expected.state) wrong.push(`state ${observed.state} (expected ${expected.state})`);
  if (expected.outcome !== undefined && observed.outcome !== expected.outcome) wrong.push(`outcome ${observed.outcome} (expected ${expected.outcome})`);
  if (observed.attempt !== expected.attempt) wrong.push(`attempt ${observed.attempt} (expected ${expected.attempt})`);
  if (observed.ledgerRows !== expected.ledgerRows) wrong.push(`rows ${observed.ledgerRows} (expected ${expected.ledgerRows})`);
  return wrong.length === 0 ? null : `UNEXPECTED: ${wrong.join(", ")}`;
}

/** Every transfer point has an expectation (checked by the unit test). */
export const ALL_POINTS: readonly string[] = TRANSFER_FAULT_POINTS;
