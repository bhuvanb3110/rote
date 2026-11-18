// The chaos families' explicit expectations (step-10 reviewer decision 7; D56): each family names the final
// states it allows, and the judge fails a run on anything else.
import { describe, expect, it } from "vitest";
import type { CrashLimitVerdict } from "./attribution.js";
import { acceptedEscalations, CHAOS_FAMILIES, FAMILY_SPECS, familyFromFlags, judgeFamily, type RunObservation } from "./families.js";

const clean = (over: Partial<RunObservation> = {}): RunObservation => ({
  oraclePass: true,
  oracleBad: {},
  finals: { "succeeded/success": 97, "succeeded/already_done": 3 },
  notSettled: 0,
  drainTimedOut: false,
  leaks: [],
  oom: [],
  bankControlErrors: 0,
  bankControlsApplied: 0,
  requeuedAfterFailure: 0,
  deferrals: 0,
  crashLimitEscalations: [],
  reconcileAbandoned: [],
  ...over,
});
/** A needs_human / crash_limit job's verdict (src/chaos/attribution.ts decides it; here it is given). */
const verdict = (jobId: string, attributed: boolean): CrashLimitVerdict => ({
  jobId,
  deaths: [],
  crashes: 5,
  ledgerRows: 1,
  attributed,
  reasons: attributed ? [] : ["1 death(s) match no scheduled kill or pause of their worker: verify phase 4 of x (T6.5)"],
});
const bankRun = (over: Partial<RunObservation> = {}) => clean({ bankControlsApplied: 4, requeuedAfterFailure: 12, deferrals: 2, ...over });

describe("familyFromFlags", () => {
  it("standard; --bank-fault -> bank-fault-kills; --bank-fault --no-kills -> bank-fault-only; --no-kills alone is no family", () => {
    expect(familyFromFlags({ bankFault: false, noKills: false })).toBe("standard");
    expect(familyFromFlags({ bankFault: true, noKills: false })).toBe("bank-fault-kills");
    expect(familyFromFlags({ bankFault: true, noKills: true })).toBe("bank-fault-only");
    expect(() => familyFromFlags({ bankFault: false, noKills: true })).toThrow(/only a family with --bank-fault/);
    expect(CHAOS_FAMILIES).toEqual(["standard", "bank-fault-only", "bank-fault-kills"]);
  });
});

describe("judgeFamily: the attributed escalation by the crash cap (D58; the reviewer decision during 10b, decision 3)", () => {
  const capped = (verdicts: CrashLimitVerdict[]) => ({ finals: { "succeeded/success": 100 - verdicts.length, "needs_human/crash_limit": verdicts.length }, crashLimitEscalations: verdicts });

  it("the standard family accepts needs_human / crash_limit ONLY when its verdict is attributed, and lists it as accepted", () => {
    const o = clean(capped([verdict("job-a", true)]));
    expect(judgeFamily(FAMILY_SPECS.standard, o)).toEqual([]);
    expect(acceptedEscalations(FAMILY_SPECS.standard, o).map((v) => v.jobId)).toEqual(["job-a"]);
  });

  it("an unattributed one fails the run, with its reasons; an attributed one beside it does not excuse it", () => {
    const one = judgeFamily(FAMILY_SPECS.standard, clean(capped([verdict("job-b", false)])));
    expect(one.join(";")).toMatch(/1 job\(s\) ended needs_human\/crash_limit without an attributed history \(job-b: 1 death\(s\) match no scheduled kill or pause/);
    const mixed = judgeFamily(FAMILY_SPECS.standard, clean(capped([verdict("job-a", true), verdict("job-b", false)])));
    expect(mixed).toHaveLength(1);
    expect(mixed[0]).toMatch(/^1 job\(s\) ended needs_human\/crash_limit without an attributed history \(job-b/);
    // A crash_limit job the harness found no verdict for is never accepted.
    expect(judgeFamily(FAMILY_SPECS.standard, clean({ finals: { "needs_human/crash_limit": 1 }, crashLimitEscalations: [] })).join(";")).toMatch(/no verdict recorded/);
  });

  it("any OTHER needs_human still fails the standard family, and the bank families accept no escalation at all", () => {
    expect(judgeFamily(FAMILY_SPECS.standard, clean({ finals: { "needs_human/verify_exhausted": 1 }, crashLimitEscalations: [verdict("job-a", true)] }))).toHaveLength(1);
    for (const fam of ["bank-fault-only", "bank-fault-kills"] as const) {
      const o = bankRun(capped([verdict("job-a", true)]));
      expect(judgeFamily(FAMILY_SPECS[fam], o).join(";")).toMatch(/1 job\(s\) ended needs_human\/crash_limit, which the .* family does not allow/);
      expect(acceptedEscalations(FAMILY_SPECS[fam], o)).toEqual([]);
    }
  });
});

describe("judgeFamily", () => {
  it("a clean run passes every family it fits (the bank families once their faults bit)", () => {
    expect(judgeFamily(FAMILY_SPECS.standard, clean())).toEqual([]);
    expect(judgeFamily(FAMILY_SPECS["bank-fault-only"], bankRun())).toEqual([]);
    expect(judgeFamily(FAMILY_SPECS["bank-fault-kills"], bankRun())).toEqual([]);
  });

  it("the standard family fails on ANY job left for a human -- a reconcile's flag included", () => {
    for (const outcome of ["duplicate_suspected", "unrecorded_commit_suspected", "reconcile_unreadable", "verify_exhausted", "ambiguous"]) {
      const problems = judgeFamily(FAMILY_SPECS.standard, clean({ finals: { "succeeded/success": 99, [`needs_human/${outcome}`]: 1 } }));
      expect(problems.join(";"), outcome).toMatch(new RegExp(`1 job\\(s\\) ended needs_human/${outcome}, which the standard family does not allow`));
    }
  });

  it("the standard family allows a job failed only because kills exhausted a budget (the crash cap: crash_limit, D57; or a last-own-attempt [0, 0]); any other failure fails it", () => {
    expect(judgeFamily(FAMILY_SPECS.standard, clean({ finals: { "succeeded/success": 98, "failed/crash_limit": 1, "failed/not_committed_attempts_exhausted": 1 } }))).toEqual([]);
    expect(judgeFamily(FAMILY_SPECS.standard, clean({ finals: { "failed/failure": 1 } }))).toHaveLength(1);
    expect(judgeFamily(FAMILY_SPECS.standard, clean({ finals: { "business_outcome/business_outcome": 1 } }))).toHaveLength(1);
    // Step 8's failed / lease_expired (a crash that used the last attempt) cannot happen since D57: it fails the run.
    expect(judgeFamily(FAMILY_SPECS.standard, clean({ finals: { "failed/lease_expired": 1 } })).join(";")).toMatch(/ended failed\/lease_expired/);
  });

  it("the bank-fault families allow only succeeded: 0 failed (whatever the cause, the crash cap included), 0 needs_human", () => {
    for (const fam of ["bank-fault-only", "bank-fault-kills"] as const) {
      expect(judgeFamily(FAMILY_SPECS[fam], bankRun({ finals: { "succeeded/success": 99, "failed/failure": 1 } })).join(";")).toMatch(/ended failed\/failure/);
      expect(judgeFamily(FAMILY_SPECS[fam], bankRun({ finals: { "succeeded/success": 99, "failed/lease_expired": 1 } })).join(";")).toMatch(/ended failed\/lease_expired/);
      expect(judgeFamily(FAMILY_SPECS[fam], bankRun({ finals: { "succeeded/success": 99, "failed/crash_limit": 1 } })).join(";")).toMatch(/ended failed\/crash_limit/);
      expect(judgeFamily(FAMILY_SPECS[fam], bankRun({ finals: { "needs_human/verify_unavailable": 1 } })).join(";")).toMatch(/needs_human\/verify_unavailable/);
    }
  });

  it("the bank-fault families fail as VACUOUS if the outage hit no work, and if a bank control was not applied", () => {
    expect(judgeFamily(FAMILY_SPECS["bank-fault-only"], bankRun({ requeuedAfterFailure: 0, deferrals: 0 })).join(";")).toMatch(/vacuous: the bank outage hit no work/);
    expect(judgeFamily(FAMILY_SPECS["bank-fault-only"], bankRun({ requeuedAfterFailure: 0, deferrals: 1 }))).toEqual([]);
    expect(judgeFamily(FAMILY_SPECS["bank-fault-kills"], bankRun({ bankControlsApplied: 3, bankControlErrors: 1 }))).toEqual([
      "1 bank control call(s) failed",
      "only 3 of the 4 bank controls were applied",
    ]);
    expect(judgeFamily(FAMILY_SPECS.standard, clean())).toEqual([]); // the standard family has no bank events to check
  });

  it("every family: the oracle, settled, a reconcile the pass abandoned (D59), leaks, OOM", () => {
    for (const fam of CHAOS_FAMILIES) {
      const base = fam === "standard" ? clean : bankRun;
      expect(judgeFamily(FAMILY_SPECS[fam], base({ oraclePass: false, oracleBad: { DUPLICATE: 1, LOST: 0 } }))).toEqual(["the oracle failed (DUPLICATE 1)"]);
      expect(judgeFamily(FAMILY_SPECS[fam], base({ notSettled: 2, drainTimedOut: true }))).toEqual(["2 job(s) not settled after the drain (the drain timed out)"]);
      // Settled, but its zombie check never ran: fails every family, naming the job.
      const abandoned = judgeFamily(FAMILY_SPECS[fam], base({ reconcileAbandoned: ["job-7"] }));
      expect(abandoned).toHaveLength(1);
      expect(abandoned[0]).toMatch(/^1 job\(s\) reconcile_abandoned: .*\(job-7; run `rote reconcile --since`\)$/);
      expect(judgeFamily(FAMILY_SPECS[fam], base({ leaks: ["ROTE_CRED_TENANT_A_PASSWORD"] }))[0]).toMatch(/credential values/);
      expect(judgeFamily(FAMILY_SPECS[fam], base({ oom: ["rote-worker-2"] }))[0]).toMatch(/OOM-killed/);
    }
  });
});
