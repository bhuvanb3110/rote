// Where the worker's Day-3 metrics are counted (docs/plans/step-13a.md section 3; step-13.md section 5), in one
// place so each call site is one line. Every function here only CALLS telemetry (never awaited, never throws:
// the Telemetry contract) and returns nothing: no decision reads anything from it (rule 8).
//
//   recordTerminal        rote_jobs_completed_total{outcome} + rote_job_duration_seconds (created_at -> now)
//   recordRequeue         rote_job_retries_total (T4's requeue after a failed attempt, T6.1)
//   recordRecovery        a T6.x the sweep won: worker_crashes_total{kind} for a death, T6.1 a retry, T6.2 / T6.6
//                         terminal, T6.6 an escalated recovery
//   recordVerifyDecision  a recorded verify decision: recoveries_total{result} (the brief's three) and, when the
//                         decision ends the job, recordTerminal
//   recordReconcileClaim  a reconcile claim that closed a dead reconciler: worker_crashes_total{kind="reconciler"}
import type { VerifyDecision } from "../fleet/stateMachine.js";
import type { Telemetry } from "../telemetry/index.js";
import type { RecoveredJob } from "./recover.js";

const CRASH_KIND: Record<string, string> = { running: "before_intent", committing: "committing", verifying: "verifier" };

export function recordTerminal(telemetry: Telemetry, outcome: string | null | undefined, state: string, createdAt?: Date): void {
  telemetry.count("rote_jobs_completed_total", { outcome: outcome ?? state });
  if (createdAt instanceof Date) telemetry.observe("rote_job_duration_seconds", Math.max(0, (Date.now() - createdAt.getTime()) / 1000));
}

export function recordRequeue(telemetry: Telemetry): void {
  telemetry.count("rote_job_retries_total");
}

export function recordRecovery(telemetry: Telemetry, r: RecoveredJob): void {
  if (r.action.crash) telemetry.count("rote_worker_crashes_total", { kind: CRASH_KIND[r.from] ?? "other" });
  if (r.action.kind === "requeue") recordRequeue(telemetry);
  if (r.action.kind === "fail" || r.action.kind === "escalate") recordTerminal(telemetry, r.action.outcome, r.action.to, r.createdAt);
  if (r.action.kind === "escalate") telemetry.count("rote_recoveries_total", { result: "escalated" });
}

const RECOVERY_RESULT: Partial<Record<VerifyDecision["decision"], string>> = {
  already_done: "already_done",
  resubmitted: "resubmitted",
  escalated: "escalated",
};

const TERMINAL_TO = new Set(["succeeded", "failed", "business_outcome", "needs_human"]);

export function recordVerifyDecision(telemetry: Telemetry, decision: VerifyDecision, createdAt?: Date): void {
  const result = RECOVERY_RESULT[decision.decision];
  if (result) telemetry.count("rote_recoveries_total", { result });
  if (TERMINAL_TO.has(decision.to)) recordTerminal(telemetry, decision.outcome, decision.to, createdAt);
}

export function recordReconcileClaim(telemetry: Telemetry, claim: { deadReconciler?: boolean }): void {
  if (claim.deadReconciler) telemetry.count("rote_worker_crashes_total", { kind: "reconciler" });
}
