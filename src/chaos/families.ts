// Chaos scenario families and what each must end in (step-10 reviewer decision 7; docs/plans/step-10.md
// sections 4-5; D56). A family states its expected outcomes EXPLICITLY, and the judge checks exactly those:
// a job that ends anywhere else fails the run, whatever the oracle says.
//
//   standard          kills every 5-15 s + one 45 s `docker pause` (the realistic zombie). Every job ends
//                     succeeded (success / already_done) -- or failed because kills alone used up its
//                     attempts (lease_expired: T6.2; not_committed_attempts_exhausted: a verify [0, 0] on the
//                     last attempt). ANY job left for a human fails it, a reconcile's duplicate_suspected /
//                     unrecorded_commit_suspected included.
//   bank-fault-only   no kills, no pause; the bank down 30 s and slow 60 s (seeded). Retries back off (D49),
//                     verifies and reconciles defer (D44): every job succeeds. 0 failed, 0 needs_human.
//   bank-fault-kills  everything at once: the standard kills and pause plus the bank events. The reviewer
//                     requires the same as bank-fault-only: 0 duplicates, 0 lost, 0 needs_human, 0 failed.
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
  /** The outage must have hit work (a requeue after a failure, or a verify / reconcile deferral). */
  requireFaultExercised: boolean;
}

const SUCCEEDED = ["succeeded/success", "succeeded/already_done"] as const;

export const FAMILY_SPECS: Record<ChaosFamily, FamilySpec> = {
  standard: {
    family: "standard",
    description: "kills every 5-15 s and one 45 s pause; no bank faults",
    kills: true,
    pause: true,
    bankFaults: false,
    allowedFinal: [...SUCCEEDED, "failed/lease_expired", "failed/not_committed_attempts_exhausted"],
    requireFaultExercised: false,
  },
  "bank-fault-only": {
    family: "bank-fault-only",
    description: "the bank down 30 s and slow (2 s per request) 60 s; no kills, no pause",
    kills: false,
    pause: false,
    bankFaults: true,
    allowedFinal: [...SUCCEEDED],
    requireFaultExercised: true,
  },
  "bank-fault-kills": {
    family: "bank-fault-kills",
    description: "the standard kills and pause plus the bank down 30 s and slow 60 s",
    kills: true,
    pause: true,
    bankFaults: true,
    allowedFinal: [...SUCCEEDED],
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
}

/** [] = the run passes its family; otherwise every reason it does not. */
export function judgeFamily(spec: FamilySpec, o: RunObservation): string[] {
  const problems: string[] = [];
  if (!o.oraclePass) {
    const bad = Object.entries(o.oracleBad).filter(([, n]) => n > 0);
    problems.push(`the oracle failed (${bad.map(([v, n]) => `${v} ${n}`).join(", ") || "see check.txt"})`);
  }
  for (const [final, n] of Object.entries(o.finals).sort()) {
    if (n > 0 && !spec.allowedFinal.includes(final)) problems.push(`${n} job(s) ended ${final}, which the ${spec.family} family does not allow (allowed: ${spec.allowedFinal.join(", ")})`);
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
