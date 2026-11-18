// Chaos scenario families and what each must end in (step-10 reviewer decision 7; docs/plans/step-10.md
// sections 4-5; D56). A family states its expected outcomes EXPLICITLY, and the judge checks exactly those:
// a job that ends anywhere else fails the run, whatever the oracle says.
//
//   standard          kills every 5-15 s + one 45 s `docker pause` (the realistic zombie). Every job ends
//                     succeeded (success / already_done) -- or failed because kills alone exhausted a budget:
//                     the crash cap (crash_limit: T6.2, five deaths before the intent; D57) or its attempts
//                     (not_committed_attempts_exhausted: kills after the intent, each verified [0, 0] and
//                     resubmitted, then a [0, 0] on the last own attempt). Since D57 a kill before the intent
//                     uses no attempt, so Step 8's failed / lease_expired cannot happen and fails the run.
//                     ANY job left for a human fails it, a reconcile's duplicate_suspected /
//                     unrecorded_commit_suspected included -- with ONE exception (the reviewer decision during
//                     10b, 2026-11-18, decision 3; D58): needs_human / crash_limit (the crash cap reached after
//                     an intent) when EVERY death in its history matches a scheduled kill or pause of that worker
//                     and the ledger has at most 1 row for it (src/chaos/attribution.ts). Each such job is listed
//                     as "escalated by crash cap (attributed)" and is never counted as a plain pass.
//   bank-fault-only  no kills, no pause; the bank down 30 s and slow 60 s (seeded). Retries back off (D49),
//                     verifies and reconciles defer (D44): every job succeeds. 0 failed, 0 needs_human.
//   bank-fault-kills  everything at once: the standard kills and pause plus the bank events. The reviewer
//                     requires the same as bank-fault-only: 0 duplicates, 0 lost, 0 needs_human, 0 failed
//                     (crash_limit included). Its first run failed that (two jobs whose attempts the kills
//                     had used up); D57 made crashes stop using attempts.
//
// Every family also requires: the oracle passes (0 DUPLICATE, 0 LOST, 0 UNRECORDED_COMMIT, 0 MISMATCH, 0
// ORPHAN), every job SETTLED (terminal, and its reconcile done if one was due: D50, D55), no credential in
// any output, no worker OOM-killed. A bank-fault family also requires that the bank events were all applied
// and that the outage actually hit work (a failed attempt requeued with a backoff, or a deferral); otherwise
// the run proved nothing and fails as vacuous.
//
// The zombie WINDOW itself (a frozen worker clicking after another verified [0, 0]) is not a chaos family:
// a pause cannot be aimed between the intent and the click. It is `verify-scenarios --family zombie`
// (evidence/zombie-window-limit/, D52), whose judge states its one expected duplicate and its detection.

import type { CrashLimitVerdict } from "./attribution.js";

export const CHAOS_FAMILIES = ["standard", "bank-fault-only", "bank-fault-kills"] as const;
export type ChaosFamily = (typeof CHAOS_FAMILIES)[number];

export interface FamilySpec {
  family: ChaosFamily;
  description: string;
  kills: boolean;
  /** The 45 s docker pause. */
  pause: boolean;
  bankFaults: boolean;
  /** Every "state/outcome" a job may end in; anything else fails the run (needs_human appears only if listed). */
  allowedFinal: readonly string[];
  /**
   * needs_human / crash_limit is accepted for a job whose every death is attributed to a scheduled kill or pause
   * and that has at most 1 ledger row (D58); any other needs_human / crash_limit fails the run.
   */
  acceptAttributedCrashLimit: boolean;
  /** The outage must have hit work (a requeue after a failure, or a verify / reconcile deferral). */
  requireFaultExercised: boolean;
}

/** The one final state an attributed escalation may end in (D58). */
export const CRASH_LIMIT_ESCALATION = "needs_human/crash_limit";

const SUCCEEDED = ["succeeded/success", "succeeded/already_done"] as const;

export const FAMILY_SPECS: Record<ChaosFamily, FamilySpec> = {
  standard: {
    family: "standard",
    description: "kills every 5-15 s and one 45 s pause; no bank faults",
    kills: true,
    pause: true,
    bankFaults: false,
    allowedFinal: [...SUCCEEDED, "failed/crash_limit", "failed/not_committed_attempts_exhausted"],
    acceptAttributedCrashLimit: true,
    requireFaultExercised: false,
  },
  "bank-fault-only": {
    family: "bank-fault-only",
    description: "the bank down 30 s and slow (2 s per request) 60 s; no kills, no pause",
    kills: false,
    pause: false,
    bankFaults: true,
    allowedFinal: [...SUCCEEDED],
    acceptAttributedCrashLimit: false,
    requireFaultExercised: true,
  },
  "bank-fault-kills": {
    family: "bank-fault-kills",
    description: "the standard kills and pause plus the bank down 30 s and slow 60 s",
    kills: true,
    pause: true,
    bankFaults: true,
    allowedFinal: [...SUCCEEDED],
    acceptAttributedCrashLimit: false,
    requireFaultExercised: true,
  },
};

/** --bank-fault and --no-kills -> the family (refuses --no-kills alone: not a family). */
export function familyFromFlags(flags: { bankFault: boolean; noKills: boolean }): ChaosFamily {
  if (flags.noKills && !flags.bankFault) throw new Error("--no-kills is only a family with --bank-fault (bank-fault-only)");
  return flags.bankFault ? (flags.noKills ? "bank-fault-only" : "bank-fault-kills") : "standard";
}

/** What a run observed, for the judge. */
export interface RunObservation {
  oraclePass: boolean;
  /** The oracle's failing verdicts by name (DUPLICATE, LOST, ...), for the message. */
  oracleBad: Record<string, number>;
  /** "state/outcome" -> jobs. */
  finals: Record<string, number>;
  /** Jobs not settled after the drain (not terminal, or a reconcile still due). */
  notSettled: number;
  drainTimedOut: boolean;
  leaks: readonly string[];
  oom: readonly string[];
  /** Bank control calls that failed (a bank family only). */
  bankControlErrors: number;
  /** Bank controls applied, in order (a bank family only). */
  bankControlsApplied: number;
  /** Attempts that failed and were requeued with a backoff (D49), and verify / reconcile deferrals. */
  requeuedAfterFailure: number;
  deferrals: number;
  /** The verdict on every needs_human / crash_limit job (src/chaos/attribution.ts, D58); [] when there is none. */
  crashLimitEscalations: readonly CrashLimitVerdict[];
}

/** The needs_human / crash_limit jobs the family accepts: every death attributed, at most 1 ledger row (D58). */
export function acceptedEscalations(spec: FamilySpec, o: Pick<RunObservation, "crashLimitEscalations">): CrashLimitVerdict[] {
  return spec.acceptAttributedCrashLimit ? o.crashLimitEscalations.filter((v) => v.attributed) : [];
}

/** [] = the run passes its family; otherwise every reason it does not. */
export function judgeFamily(spec: FamilySpec, o: RunObservation): string[] {
  const problems: string[] = [];
  if (!o.oraclePass) {
    const bad = Object.entries(o.oracleBad).filter(([, n]) => n > 0);
    problems.push(`the oracle failed (${bad.map(([v, n]) => `${v} ${n}`).join(", ") || "see check.txt"})`);
  }
  const accepted = acceptedEscalations(spec, o).length;
  for (const [final, n] of Object.entries(o.finals).sort()) {
    if (n === 0 || spec.allowedFinal.includes(final)) continue;
    if (final === CRASH_LIMIT_ESCALATION && spec.acceptAttributedCrashLimit) {
      if (n > accepted) {
        const why = o.crashLimitEscalations.filter((v) => !v.attributed).map((v) => `${v.jobId}: ${v.reasons.join("; ")}`);
        problems.push(`${n - accepted} job(s) ended ${final} without an attributed history (${why.join(" | ") || "no verdict recorded"})`);
      }
      continue;
    }
    problems.push(`${n} job(s) ended ${final}, which the ${spec.family} family does not allow (allowed: ${spec.allowedFinal.join(", ")})`);
  }
  if (o.notSettled > 0) problems.push(`${o.notSettled} job(s) not settled after the drain${o.drainTimedOut ? " (the drain timed out)" : ""}`);
  if (o.leaks.length > 0) problems.push(`credential values found in the output: ${o.leaks.join(", ")}`);
  if (o.oom.length > 0) problems.push(`OOM-killed (not a chaos kill, D9): ${o.oom.join(", ")}`);
  if (spec.bankFaults) {
    if (o.bankControlErrors > 0) problems.push(`${o.bankControlErrors} bank control call(s) failed`);
    if (o.bankControlsApplied < 4) problems.push(`only ${o.bankControlsApplied} of the 4 bank controls were applied`);
  }
  if (spec.requireFaultExercised && o.requeuedAfterFailure === 0 && o.deferrals === 0) {
    problems.push("vacuous: the bank outage hit no work (no attempt requeued after a failure, no deferral)");
  }
  return problems;
}
