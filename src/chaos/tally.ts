// Chaos at scale (step-10 reviewer decisions 1 and 8; docs/plans/step-10.md section 5; D56): what one chaos
// run reports about itself (SeedSummary, written by scripts/chaos.ts as summary.json), the recovery kinds
// counted from its job_attempts / job_verifications rows, and the batch tally that scripts/chaos-seeds.ts
// rebuilds after every seed. Pure: no I/O.
import type { ChaosFamily } from "./families.js";

/**
 * Each recovery kind (decision 8), counted from the rows, so the tally shows whether chaos exercised each
 * path at all -- the resubmit path above all.
 */
export interface RecoveryKinds {
  /** T6.1: a dead worker's job (before its intent) requeued at once. */
  requeuedAfterCrash: number;
  /** T4: an attempt that failed before its intent, requeued with a backoff (D49). */
  requeuedAfterFailure: number;
  /** T6.2: the last attempt's worker died before its intent: failed / lease_expired. */
  failedByRecovery: number;
  /** T6.4: an expired commit claimed to verify. */
  claimedToVerify: number;
  /** T6.5: a dead verifier's job re-claimed. */
  reclaimedVerify: number;
  /** T6.7: a deferred (or handed-off) verify resumed. */
  resumedVerify: number;
  /** T6.6: three dead verify phases: needs_human / verify_exhausted. */
  escalatedByRecovery: number;
  /** T5: the live owner verified its own uncertain run. */
  ownVerify: number;
  // The verify decisions (job_verifications, verify phases).
  already_done: number;
  resubmitted: number;
  exhausted: number;
  not_committed_final: number;
  deferred: number;
  escalated: number;
  // The reconcile decisions (reason 'reconcile'; D50, D55).
  reconciled: number;
  duplicate_suspected: number;
  unrecorded_commit_suspected: number;
  reconcile_unreadable: number;
  reconcile_deferred: number;
}

export const RECOVERY_KIND_LABELS: Record<keyof RecoveryKinds, string> = {
  requeuedAfterCrash: "requeued after a crash (T6.1)",
  requeuedAfterFailure: "requeued after a failure, with a backoff (T4, D49)",
  failedByRecovery: "failed by recovery (T6.2: attempts used up by kills)",
  claimedToVerify: "expired commit claimed to verify (T6.4)",
  reclaimedVerify: "dead verifier re-claimed (T6.5)",
  resumedVerify: "deferred verify resumed (T6.7)",
  escalatedByRecovery: "verify exhausted by dead phases (T6.6)",
  ownVerify: "own uncertain run verified (T5)",
  already_done: "verify: already_done",
  resubmitted: "verify: resubmitted",
  exhausted: "verify: exhausted",
  not_committed_final: "verify: not_committed_final",
  deferred: "verify: deferred (bank unavailable)",
  escalated: "verify: escalated (needs_human)",
  reconciled: "reconcile: reconciled",
  duplicate_suspected: "reconcile: duplicate_suspected",
  unrecorded_commit_suspected: "reconcile: unrecorded_commit_suspected",
  reconcile_unreadable: "reconcile: reconcile_unreadable",
  reconcile_deferred: "reconcile: reconcile_deferred",
};

export const EMPTY_RECOVERY_KINDS: RecoveryKinds = Object.fromEntries(Object.keys(RECOVERY_KIND_LABELS).map((k) => [k, 0])) as unknown as RecoveryKinds;

export interface AttemptRowLike {
  outcome: string | null;
  error: string | null;
}
export interface PhaseRowLike {
  reason: string;
  decision: string | null;
  error: string | null;
}

/** Counts every recovery kind in one run's rows. */
export function recoveryKinds(attempts: readonly AttemptRowLike[], phases: readonly PhaseRowLike[]): RecoveryKinds {
  const k: RecoveryKinds = { ...EMPTY_RECOVERY_KINDS };
  for (const a of attempts) {
    // recover.ts closes the dead holder's attempt "... (T6.x kind)"; jobOutcomeFor's requeue says "(retrying)".
    if (a.outcome === "crashed" && a.error?.includes("(T6.1 requeue)")) k.requeuedAfterCrash += 1;
    if (a.outcome === "crashed" && a.error?.includes("(T6.2 fail)")) k.failedByRecovery += 1;
    if ((a.outcome === "failure" || a.outcome === "aborted") && a.error?.includes("(retrying)")) k.requeuedAfterFailure += 1;
  }
  for (const p of phases) {
    if (p.decision === "crashed" && p.error?.includes("(T6.6 escalate)")) k.escalatedByRecovery += 1;
    if (p.reason === "reconcile") {
      if (p.decision && p.decision in k && p.decision !== "crashed") k[p.decision as keyof RecoveryKinds] += 1;
      continue;
    }
    if (p.reason === "lease_expired_in_committing") k.claimedToVerify += 1;
    else if (p.reason === "lease_expired_in_verifying") k.reclaimedVerify += 1;
    else if (p.reason === "resumed") k.resumedVerify += 1;
    else if (p.reason === "commit_uncertain" && p.decision !== "handed_off") k.ownVerify += 1;
    if (p.decision && ["already_done", "resubmitted", "exhausted", "not_committed_final", "deferred", "escalated"].includes(p.decision)) {
      k[p.decision as keyof RecoveryKinds] += 1;
    }
  }
  return k;
}

/** What scripts/chaos.ts writes as summary.json: everything the tally needs, nothing it must re-derive. */
export interface SeedSummary {
  version: 1;
  /** false: the run threw before it finished (check.txt has the stack). */
  completed: boolean;
  error?: string;
  seed: number;
  family: ChaosFamily;
  jobs: number;
  workers: number;
  durationMs: number;
  pauseMs: number;
  drainTimeoutMs: number;
  /** git rev-parse --short HEAD, with "+dirty" if the tree had changes. */
  commit: string;
  startedAt: string;
  wallMs: number;
  /** From the first enqueue to the last job settled. */
  workMs: number | null;
  drainMs: number | null;
  drainTimedOut: boolean;
  kills: number;
  restarts: number;
  actionErrors: number;
  pause: { replica: number; fromMs: number; toMs: number } | null;
  bank: { outage: { fromMs: number; toMs: number }; slow: { fromMs: number; toMs: number; latencyMs: number } } | null;
  bankControlsApplied: number;
  oracle: { pass: boolean; counts: Record<string, number>; ledgerRows: number };
  finals: Record<string, number>;
  needsHuman: Array<{ id: string; outcome: string | null }>;
  failed: Array<{ id: string; outcome: string | null; attempts: string[] }>;
  notSettled: number;
  recoveries: RecoveryKinds;
  workerProtections: Record<string, number>;
  leaks: string[];
  oom: string[];
  problems: string[];
  pass: boolean;
}

export interface TallyInput {
  outDir: string;
  /** Every seed the batch draws, in order (index 1 = seeds[0]). */
  seeds: readonly number[];
  config: { jobs: number; workers: number; durationMs: number; drainTimeoutMs: number; family: ChaosFamily };
  /** By 1-based index; null = not run yet. */
  summaries: ReadonlyMap<number, SeedSummary | null>;
  /** Runs that were interrupted and re-run (their partial evidence was set aside). */
  interruptions: ReadonlyArray<{ index: number; seed: number; movedTo: string; at: string }>;
  generatedAt: string;
}

export interface Tally {
  markdown: string;
  totals: RecoveryKinds;
  finished: number;
  passed: number;
  result: "PASS" | "FAIL" | "INCOMPLETE";
}

const sec = (ms: number | null) => (ms === null ? "-" : `${Math.round(ms / 1000)} s`);
const okJobs = (s: SeedSummary) => s.oracle.counts.ok ?? 0;

export function buildTally(input: TallyInput): Tally {
  const done = input.seeds.map((seed, i) => ({ index: i + 1, seed, s: input.summaries.get(i + 1) ?? null }));
  const finished = done.filter((d) => d.s !== null);
  const passed = finished.filter((d) => d.s!.pass).length;
  const totals: RecoveryKinds = { ...EMPTY_RECOVERY_KINDS };
  const seedsWith: Record<string, number> = {};
  for (const d of finished) {
    for (const key of Object.keys(totals) as Array<keyof RecoveryKinds>) {
      const n = d.s!.recoveries[key] ?? 0;
      totals[key] += n;
      if (n > 0) seedsWith[key] = (seedsWith[key] ?? 0) + 1;
    }
  }
  const failedSeeds = finished.filter((d) => !d.s!.pass);
  const result: Tally["result"] = failedSeeds.length > 0 ? "FAIL" : finished.length < input.seeds.length ? "INCOMPLETE" : "PASS";
  const c = input.config;
  const lines: string[] = [];
  lines.push("# Day-2 exit: chaos at scale -- the tally");
  lines.push("");
  lines.push(`Generated by \`scripts/chaos-seeds.ts\` at ${input.generatedAt}, in \`${input.outDir}\`. **${finished.length} of ${input.seeds.length} seeds finished.**`);
  lines.push("");
  lines.push(
    `Every seed: family \`${c.family}\`, ${c.jobs} jobs, ${c.workers} workers, a ${c.durationMs / 1000} s schedule (a kill every 5-15 s, one 45 s ` +
      `\`docker pause\`), drained until every job is settled (timeout ${c.drainTimeoutMs / 1000} s), then the ledger oracle (D32) and the ` +
      "family judge (D56). The seeds were drawn once, up front, and saved in `seeds.json`; none is ever re-drawn or dropped.",
  );
  lines.push("");
  lines.push("| # | seed | commit | kills | ok | DUPLICATE | LOST | needs_human | failed | not settled | T6.1 | T6.4 | already_done | resubmitted | reconciled | flagged by reconcile | work | wall | result |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const d of done) {
    const s = d.s;
    if (!s) {
      lines.push(`| ${d.index} | ${d.seed} | | | | | | | | | | | | | | | | | not run yet |`);
      continue;
    }
    if (!s.completed) {
      lines.push(`| ${d.index} | [${d.seed}](${dirName(d.index, d.seed)}/check.txt) | ${s.commit} | | | | | | | | | | | | | | | ${sec(s.wallMs)} | **FAIL**: the run did not complete (${s.error ?? "?"}) |`);
      continue;
    }
    const r = s.recoveries;
    const flagged = r.duplicate_suspected + r.unrecorded_commit_suspected + r.reconcile_unreadable;
    lines.push(
      `| ${d.index} | [${d.seed}](${dirName(d.index, d.seed)}/check.txt) | ${s.commit} | ${s.kills} | ${okJobs(s)} | ${s.oracle.counts.DUPLICATE ?? 0} | ${s.oracle.counts.LOST ?? 0} | ` +
        `${s.needsHuman.length} | ${s.failed.length} | ${s.notSettled} | ${r.requeuedAfterCrash} | ${r.claimedToVerify} | ${r.already_done} | ${r.resubmitted} | ${r.reconciled} | ${flagged} | ` +
        `${sec(s.workMs)} | ${sec(s.wallMs)} | ${s.pass ? "PASS" : `**FAIL**: ${s.problems.join("; ")}`} |`,
    );
  }
  lines.push("");
  lines.push("## Recovery kinds across all finished seeds (reviewer decision 8)");
  lines.push("");
  lines.push("| kind | total | seeds with it |");
  lines.push("| --- | --- | --- |");
  for (const key of Object.keys(RECOVERY_KIND_LABELS) as Array<keyof RecoveryKinds>) {
    lines.push(`| ${RECOVERY_KIND_LABELS[key]} | ${totals[key]} | ${seedsWith[key] ?? 0} of ${finished.length} |`);
  }
  lines.push("");
  lines.push(
    totals.resubmitted > 0
      ? `**The resubmit path was exercised**: ${totals.resubmitted} verify decision(s) \`resubmitted\` in ${seedsWith.resubmitted ?? 0} seed(s), each followed by its reconcile.`
      : "**The resubmit path was NOT exercised by these seeds**: no verify read `[0, 0]` (a kill must land between a worker's commit intent and its " +
          "Submit, a window of milliseconds). It is covered elsewhere: the crash matrix's `before-submit` scenarios (`evidence/crash-matrix/`), " +
          "`src/worker/crashSubmit.db.test.ts` in `npm test` and CI, and `verify-scenarios` (`evidence/zombie-window-limit/`, `evidence/verify-bank-outage-30s/`).",
  );
  if (input.interruptions.length > 0) {
    lines.push("");
    lines.push("## Interrupted runs (re-run with the same seed; the partial evidence was set aside, not deleted)");
    lines.push("");
    for (const x of input.interruptions) lines.push(`- seed ${x.index} (${x.seed}): interrupted, moved to \`${x.movedTo}\` at ${x.at}`);
  }
  lines.push("");
  lines.push(
    result === "PASS"
      ? `RESULT: PASS (${passed}/${input.seeds.length} seeds passed their family judge: 0 DUPLICATE, 0 LOST, 0 needs_human, every job settled)`
      : result === "INCOMPLETE"
        ? `RESULT: INCOMPLETE (${finished.length} of ${input.seeds.length} seeds finished, all passed so far; resume with the same command)`
        : `RESULT: FAIL (${failedSeeds.length} of ${finished.length} finished seeds failed: ${failedSeeds.map((d) => `#${d.index} seed ${d.seed}`).join(", ")}; each stays in this tally and is investigated)`,
  );
  return { markdown: lines.join("\n") + "\n", totals, finished: finished.length, passed, result };
}

/** A seed's evidence folder name inside the batch's out dir. */
export function dirName(index: number, seed: number): string {
  return `seed-${String(index).padStart(2, "0")}-${seed}`;
}
