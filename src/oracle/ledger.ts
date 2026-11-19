// The ledger oracle (docs/plans/step-07.md section 1, docs/DECISIONS.md D32): judges a fleet run ONLY
// by the bank's own ledger, matched to jobs by memo_key (D5). Pure: no I/O. Every harness (the Day-1
// exit, chaos, the crash-point matrix, the Day-3 load test) calls this one function, so "0 duplicates,
// 0 lost" means the same thing everywhere.
//
// Per job, the ledger rows whose memo equals the job's memo_key:
//   any state, 2+ rows                          -> DUPLICATE (always the worst; reported even if lost)
//   succeeded, 1 row                            -> ok, if result.outputs.confirmationRef is that row's
//                                                  id and the row is the job's tenant's; else MISMATCH
//   succeeded, 0 rows                           -> MISSING_COMMIT (claims a transfer the bank never made)
//   failed or business_outcome, 0 rows          -> ok
//   failed or business_outcome, 1 row           -> UNRECORDED_COMMIT (money moved, the job says it didn't)
//   needs_human, 0 or 1 row                     -> ok (listed with its reason and row count; a
//                                                  commit_uncertain with 1 row is what Day 2's verify
//                                                  turns into succeeded)
//   queued/running/committing/verifying, after
//   the drain timed out                         -> LOST (with the row count: 1 = "lost after commit")
//   ... before the drain ended                  -> PENDING (the oracle ran too early; also a FAIL)
//   any 1-row job whose row is another tenant's -> MISMATCH
// Reverse check: every ledger row whose memo matches no job -> ORPHAN (harnesses reset the ledger
// before a run, so every row must belong to a job of that run).
import { z } from "zod";
import { TERMINAL_STATES, type JobRow, type JobState } from "../queue/types.js";

export const LedgerRowSchema = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  fromMemberId: z.string(),
  toMemberId: z.string(),
  amount: z.number(),
  memo: z.string(),
  at: z.string().optional(),
});
export type LedgerRow = z.infer<typeof LedgerRowSchema>;

export type OracleJob = Pick<JobRow, "id" | "tenant_id" | "state" | "memo_key" | "result" | "lease_owner"> &
  Partial<Pick<JobRow, "attempt" | "outcome" | "error">>;

export const JOB_VERDICTS = ["ok", "DUPLICATE", "MISSING_COMMIT", "UNRECORDED_COMMIT", "MISMATCH", "LOST", "PENDING"] as const;
export type JobVerdict = (typeof JOB_VERDICTS)[number];
/** Every verdict but "ok" fails the run, as does any ORPHAN row. */
export const FAILING_VERDICTS: readonly JobVerdict[] = JOB_VERDICTS.filter((v) => v !== "ok");

export interface JobFinding {
  jobId: string;
  tenant: string;
  state: JobState;
  outcome: string | null;
  attempt: number | null;
  memoKey: string;
  leaseOwner: string | null;
  /** Ledger rows carrying this job's memo_key. */
  rows: number;
  rowIds: string[];
  verdict: JobVerdict;
  detail: string;
}

export interface OracleReport {
  jobs: number;
  ledgerRows: number;
  drainTimedOut: boolean;
  byState: Record<string, number>;
  counts: Record<JobVerdict | "ORPHAN", number>;
  findings: JobFinding[];
  orphans: LedgerRow[];
  pass: boolean;
  text: string;
}

const TERMINAL = new Set<string>(TERMINAL_STATES);

function confirmationRef(result: unknown): unknown {
  if (result && typeof result === "object" && "outputs" in result) {
    const outputs = (result as { outputs?: unknown }).outputs;
    if (outputs && typeof outputs === "object") return (outputs as Record<string, unknown>).confirmationRef;
  }
  return undefined;
}

function judge(job: OracleJob, rows: LedgerRow[], drainTimedOut: boolean): { verdict: JobVerdict; detail: string } {
  const n = rows.length;
  if (n >= 2) {
    return { verdict: "DUPLICATE", detail: `${n} ledger rows (${rows.map((r) => r.id).join(", ")}) for one job` };
  }
  const row = rows[0];
  if (row && row.tenantId !== job.tenant_id) {
    return { verdict: "MISMATCH", detail: `ledger row ${row.id} belongs to ${row.tenantId}, the job to ${job.tenant_id}` };
  }
  if (!TERMINAL.has(job.state)) {
    const after = n === 1 ? ` (lost after commit: ledger row ${row!.id} exists)` : " (no ledger row)";
    return drainTimedOut
      ? { verdict: "LOST", detail: `still ${job.state} after the drain timeout, lease_owner ${job.lease_owner ?? "none"}${after}` }
      : { verdict: "PENDING", detail: `still ${job.state}: the oracle ran before the drain ended${after}` };
  }
  switch (job.state) {
    case "succeeded": {
      if (n === 0) return { verdict: "MISSING_COMMIT", detail: "succeeded, but the bank has no row with its memo_key" };
      const ref = confirmationRef(job.result);
      if (ref !== row!.id) {
        return { verdict: "MISMATCH", detail: `confirmationRef ${JSON.stringify(ref)} != ledger row id ${row!.id}` };
      }
      return { verdict: "ok", detail: `1 row (${row!.id}), confirmationRef matches` };
    }
    case "failed":
    case "business_outcome":
      return n === 0
        ? { verdict: "ok", detail: "0 rows" }
        : { verdict: "UNRECORDED_COMMIT", detail: `${job.state}, but ledger row ${row!.id} exists: money moved, the job says it didn't` };
    case "needs_human":
      return { verdict: "ok", detail: `needs_human with ${n} row(s)${row ? ` (${row.id})` : ""}` };
    default:
      // Unreachable: TERMINAL_STATES is exactly the four cases above.
      throw new Error(`unhandled state ${job.state}`);
  }
}

export function checkLedger(input: { jobs: OracleJob[]; ledger: LedgerRow[]; drainTimedOut: boolean }): OracleReport {
  const { jobs, ledger, drainTimedOut } = input;
  const byMemo = new Map<string, LedgerRow[]>();
  for (const row of ledger) byMemo.set(row.memo, [...(byMemo.get(row.memo) ?? []), row]);

  const findings: JobFinding[] = jobs.map((job) => {
    const rows = byMemo.get(job.memo_key) ?? [];
    const { verdict, detail } = judge(job, rows, drainTimedOut);
    return {
      jobId: job.id,
      tenant: job.tenant_id,
      state: job.state,
      outcome: job.outcome ?? null,
      attempt: job.attempt ?? null,
      memoKey: job.memo_key,
      leaseOwner: job.lease_owner,
      rows: rows.length,
      rowIds: rows.map((r) => r.id),
      verdict,
      detail,
    };
  });
  const memos = new Set(jobs.map((j) => j.memo_key));
  const orphans = ledger.filter((row) => !memos.has(row.memo));

  const counts = Object.fromEntries([...JOB_VERDICTS, "ORPHAN"].map((v) => [v, 0])) as OracleReport["counts"];
  for (const f of findings) counts[f.verdict] += 1;
  counts.ORPHAN = orphans.length;
  const byState: Record<string, number> = {};
  for (const j of jobs) byState[j.state] = (byState[j.state] ?? 0) + 1;
  const pass = FAILING_VERDICTS.every((v) => counts[v] === 0) && orphans.length === 0;

  const report: Omit<OracleReport, "text"> = { jobs: jobs.length, ledgerRows: ledger.length, drainTimedOut, byState, counts, findings, orphans, pass };
  return { ...report, text: renderReport(report) };
}

const SEVERITY: JobVerdict[] = ["DUPLICATE", "UNRECORDED_COMMIT", "MISSING_COMMIT", "MISMATCH", "LOST", "PENDING"];

/** Fixed format; the last line is exactly "RESULT: PASS" or "RESULT: FAIL". */
export function renderReport(report: Omit<OracleReport, "text">): string {
  const lines: string[] = [];
  lines.push("Ledger oracle (docs/DECISIONS.md D32): every job judged by the bank's own ledger, matched by memo_key");
  lines.push(`jobs: ${report.jobs}; ledger rows: ${report.ledgerRows}; drain timed out: ${report.drainTimedOut ? "yes" : "no"}`);
  lines.push(`job states: ${Object.entries(report.byState).sort().map(([s, n]) => `${s}=${n}`).join(", ") || "(none)"}`);
  lines.push(`verdicts: ${[...JOB_VERDICTS, "ORPHAN" as const].map((v) => `${v}=${report.counts[v]}`).join(", ")}`);
  const lostAfterCommit = report.findings.filter((f) => (f.verdict === "LOST" || f.verdict === "PENDING") && f.rows === 1).length;
  lines.push(`duplicates: ${report.counts.DUPLICATE}; lost: ${report.counts.LOST} (of which after commit: ${lostAfterCommit}); orphan rows: ${report.counts.ORPHAN}`);

  const needsHuman = report.findings.filter((f) => f.state === "needs_human");
  if (needsHuman.length > 0) {
    lines.push(`needs_human (${needsHuman.length}), listed with outcome and ledger rows:`);
    for (const f of needsHuman) lines.push(`  ${f.jobId} ${f.tenant} outcome=${f.outcome ?? "-"} rows=${f.rows}${f.rowIds.length ? ` [${f.rowIds.join(", ")}]` : ""}`);
  }
  const bad = report.findings.filter((f) => f.verdict !== "ok").sort((a, b) => SEVERITY.indexOf(a.verdict) - SEVERITY.indexOf(b.verdict));
  if (bad.length > 0) {
    lines.push(`findings (${bad.length}):`);
    for (const f of bad) {
      lines.push(`  ${f.verdict.padEnd(17)} ${f.jobId} ${f.tenant} ${f.state} attempt=${f.attempt ?? "?"} rows=${f.rows}: ${f.detail}`);
    }
  }
  if (report.orphans.length > 0) {
    lines.push(`orphan ledger rows (${report.orphans.length}), memo matches no job:`);
    for (const r of report.orphans) lines.push(`  ORPHAN ${r.id} ${r.tenantId} memo=${JSON.stringify(r.memo)}`);
  }
  lines.push(report.pass ? "RESULT: PASS" : "RESULT: FAIL");
  return lines.join("\n");
}
