// One test per row of the oracle's verdict table (src/oracle/ledger.ts, D32) plus the orphan check,
// built from synthetic jobs and ledger rows.
import { describe, expect, it } from "vitest";
import { checkLedger, type LedgerRow, type OracleJob } from "./ledger.js";

let seq = 0;
function job(over: Partial<OracleJob> = {}): OracleJob {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`;
  return { id, tenant_id: "tenant-a", state: "succeeded", memo_key: `rote-${id}`, result: null, lease_owner: null, attempt: 1, outcome: null, ...over };
}
let txn = 0;
function row(memo: string, over: Partial<LedgerRow> = {}): LedgerRow {
  txn += 1;
  return { id: `TXN-${String(txn).padStart(6, "0")}`, tenantId: "tenant-a", fromMemberId: "10001", toMemberId: "10002", amount: 1, memo, ...over };
}
function succeededWith(r: LedgerRow, over: Partial<OracleJob> = {}): OracleJob {
  const j = job(over);
  r.memo = j.memo_key;
  return { ...j, result: { status: "success", outputs: { confirmationRef: r.id } } };
}
function only(jobs: OracleJob[], ledger: LedgerRow[], drainTimedOut = true) {
  const report = checkLedger({ jobs, ledger, drainTimedOut });
  return { report, f: report.findings[0]! };
}

describe("checkLedger: one verdict per row of the table", () => {
  it("succeeded + exactly 1 row + matching confirmationRef -> ok; the run passes", () => {
    const r = row("x");
    const { report, f } = only([succeededWith(r)], [r]);
    expect(f.verdict).toBe("ok");
    expect(report.pass).toBe(true);
    expect(report.text.split("\n").at(-1)).toBe("RESULT: PASS");
  });

  it("any state + 2 rows -> DUPLICATE (and DUPLICATE dominates LOST)", () => {
    for (const state of ["succeeded", "failed", "needs_human", "business_outcome", "running", "queued"] as const) {
      const j = job({ state });
      const { report, f } = only([j], [row(j.memo_key), row(j.memo_key)]);
      expect(f.verdict, state).toBe("DUPLICATE");
      expect(f.rows).toBe(2);
      expect(report.pass).toBe(false);
    }
  });

  it("succeeded + 1 row but confirmationRef differs -> MISMATCH", () => {
    const r = row("x");
    const j = succeededWith(r);
    j.result = { status: "success", outputs: { confirmationRef: "TXN-999999" } };
    expect(only([j], [r]).f.verdict).toBe("MISMATCH");
  });

  it("any job with 1 row of ANOTHER tenant -> MISMATCH", () => {
    const r = row("x", { tenantId: "tenant-b" });
    expect(only([succeededWith(r)], [r]).f).toMatchObject({ verdict: "MISMATCH", detail: expect.stringContaining("belongs to tenant-b") });
    const nh = job({ state: "needs_human" });
    expect(only([nh], [row(nh.memo_key, { tenantId: "tenant-c" })]).f.verdict).toBe("MISMATCH");
  });

  it("succeeded + 0 rows -> MISSING_COMMIT", () => {
    expect(only([job({ result: { status: "success", outputs: { confirmationRef: "TXN-1" } } })], []).f.verdict).toBe("MISSING_COMMIT");
  });

  it("failed + 0 rows -> ok; failed + 1 row -> UNRECORDED_COMMIT", () => {
    expect(only([job({ state: "failed" })], []).f.verdict).toBe("ok");
    const j = job({ state: "failed" });
    expect(only([j], [row(j.memo_key)]).f.verdict).toBe("UNRECORDED_COMMIT");
  });

  it("business_outcome + 0 rows -> ok; + 1 row -> UNRECORDED_COMMIT (a bank refusal moved money)", () => {
    expect(only([job({ state: "business_outcome" })], []).f.verdict).toBe("ok");
    const j = job({ state: "business_outcome" });
    expect(only([j], [row(j.memo_key)]).f.verdict).toBe("UNRECORDED_COMMIT");
  });

  it("needs_human + 0 or 1 row -> ok, listed in the report with its outcome and row count", () => {
    const zero = job({ state: "needs_human", outcome: "needs_human" });
    const one = job({ state: "needs_human", outcome: "commit_uncertain" });
    const r = row(one.memo_key);
    const report = checkLedger({ jobs: [zero, one], ledger: [r], drainTimedOut: false });
    expect(report.findings.map((f) => f.verdict)).toEqual(["ok", "ok"]);
    expect(report.pass).toBe(true);
    expect(report.text).toContain(`${one.id} tenant-a outcome=commit_uncertain rows=1 [${r.id}]`);
    expect(report.text).toContain(`${zero.id} tenant-a outcome=needs_human rows=0`);
  });

  it("queued/running/committing/verifying after the drain timeout -> LOST, with the row count (lost after commit)", () => {
    for (const state of ["queued", "running", "committing", "verifying"] as const) {
      expect(only([job({ state, lease_owner: "w1" })], []).f).toMatchObject({ verdict: "LOST", rows: 0 });
    }
    const j = job({ state: "running", lease_owner: "w2" });
    const { report, f } = only([j], [row(j.memo_key)]);
    expect(f).toMatchObject({ verdict: "LOST", rows: 1, detail: expect.stringContaining("lost after commit") });
    expect(report.text).toContain("lost: 1 (of which after commit: 1)");
  });

  it("a non-terminal job before the drain ended -> PENDING (also a FAIL: the oracle ran too early)", () => {
    const { report, f } = only([job({ state: "running" })], [], false);
    expect(f.verdict).toBe("PENDING");
    expect(report.pass).toBe(false);
  });

  it("a ledger row whose memo matches no job -> ORPHAN, and the run fails", () => {
    const r = row("x");
    const stray = row("rote-not-a-job-of-this-run");
    const report = checkLedger({ jobs: [succeededWith(r)], ledger: [r, stray], drainTimedOut: false });
    expect(report.findings[0]!.verdict).toBe("ok");
    expect(report.counts.ORPHAN).toBe(1);
    expect(report.orphans).toEqual([stray]);
    expect(report.pass).toBe(false);
    expect(report.text).toContain(`ORPHAN ${stray.id}`);
    expect(report.text.split("\n").at(-1)).toBe("RESULT: FAIL");
  });

  it("counts every verdict and orders findings worst first", () => {
    const dup = job({ state: "succeeded" });
    const lost = job({ state: "running" });
    const report = checkLedger({ jobs: [lost, dup], ledger: [row(dup.memo_key), row(dup.memo_key)], drainTimedOut: true });
    expect(report.counts).toMatchObject({ ok: 0, DUPLICATE: 1, LOST: 1, ORPHAN: 0 });
    const findingLines = report.text.split("\n").filter((l) => /^\s+(DUPLICATE|LOST)/.test(l));
    expect(findingLines[0]).toMatch(/^\s+DUPLICATE/);
    expect(findingLines[1]).toMatch(/^\s+LOST/);
  });
});
