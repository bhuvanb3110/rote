// recoveryAction (T6), completionAllowed (T4's guard), classifyLookup and verifyDecision (Step 9): one
// case per row of docs/plans/step-08.md sections 3, 4 and 5, plus step-09 reviewer decision 5 (the
// deferral); Step 10: the requeue backoff (D49). jobOutcomeFor's rows are in jobOutcome.test.ts.
import { describe, expect, it } from "vitest";
import type { ReplayResult } from "../artifact/index.js";
import { JOB_STATES } from "../queue/types.js";
import {
  afterRetry,
  alreadyDoneResult,
  classifyLookup,
  completionAllowed,
  DEFAULT_DEFER_CONFIG,
  DEFAULT_MAX_CRASHES,
  deferBackoffSeconds,
  EMPTY_VERIFY_CYCLE,
  DEFAULT_REQUEUE_BACKOFF,
  lookupsColumn,
  minRequeueScheduleSeconds,
  ownAttempts,
  readingsComplete,
  recoveryAction,
  jobSettled,
  RECONCILABLE_STATES,
  RECONCILE_FLAGS,
  RECONCILE_TRIGGERS,
  reconcileClaimAction,
  reconcileDecision,
  reconcileStatus,
  reconcileDueSeconds,
  reconcileExpectedMatches,
  reconcileResultPatch,
  requeueBackoffBaseSeconds,
  requeueBackoffSeconds,
  verifyDecision,
  type CompletionTarget,
  type LookupReading,
  type ReconcilableState,
  type VerifyCycle,
  type VerifyInput,
} from "./stateMachine.js";

const cycle = (over: Partial<VerifyCycle>): VerifyCycle => ({ ...EMPTY_VERIFY_CYCLE, phases: 1, deadPhases: 1, ...over });
/** The crash budget's defaults (D57, D58): no deaths yet, the cap at 5. */
const NO_CRASH = { crashes: 0, leaseCrashes: 0, maxCrashes: DEFAULT_MAX_CRASHES } as const;

describe("ownAttempts and the crash cap (D57, D58: two budgets)", () => {
  it("own attempts = leases - lease crashes (deaths before the intent); the default cap is 5", () => {
    expect(DEFAULT_MAX_CRASHES).toBe(5);
    expect(ownAttempts(1, 0)).toBe(1);
    expect(ownAttempts(3, 2)).toBe(1);
    expect(ownAttempts(7, 4)).toBe(3);
  });

  it("refuses impossible counts (more lease crashes than leases, negatives, fractions)", () => {
    expect(() => ownAttempts(1, 2)).toThrow(RangeError);
    expect(() => ownAttempts(1, -1)).toThrow(RangeError);
    expect(() => ownAttempts(1.5, 0)).toThrow(RangeError);
  });
});

describe("recoveryAction (section 4's table; Step 9 rows; D57's and D58's one crash budget)", () => {
  it("running, under the crash cap -> T6.1 requeue, counted as a CRASH and a LEASE crash, not an attempt (no intent: nothing irreversible happened)", () => {
    const a = recoveryAction({ state: "running", attempt: 1, maxAttempts: 3, ...NO_CRASH });
    expect(a).toMatchObject({ kind: "requeue", label: "T6.1", to: "queued", outcome: null, crash: true, leaseCrash: true });
    expect(a.error).toMatch(/lease expired while running, before any commit intent: crash 1\/5, not one of the job's attempts \(own attempts used 0\/3\); requeued/);
    expect(recoveryAction({ state: "running", attempt: 2, maxAttempts: 3, ...NO_CRASH }).kind).toBe("requeue");
  });

  it("running on the job's LAST own attempt -> still T6.1 requeue: a crash never uses an attempt (the bank-fault+kills failure, D57)", () => {
    // Step 8's rule failed these (attempt >= max_attempts -> T6.2 lease_expired).
    for (const [attempt, maxAttempts, leaseCrashes, crashes] of [
      [3, 3, 0, 0],
      [1, 1, 0, 0],
      [3, 3, 2, 2], // 1:crashed 2:crashed 3:<dies> -- the run's job 076e7ccd
      [5, 3, 2, 2],
      [2, 1, 1, 3], // a lease crash and two dead verifiers before (D58): still under the cap of 5
    ] as const) {
      const a = recoveryAction({ state: "running", attempt, maxAttempts, crashes, leaseCrashes, maxCrashes: 5 });
      expect(a, `attempt ${attempt}/${maxAttempts}, lease crashes ${leaseCrashes}, crashes ${crashes}`).toMatchObject({ kind: "requeue", label: "T6.1", to: "queued", crash: true });
    }
  });

  it("running, the death that reaches the cap -> T6.2 fail / crash_limit (not lease_expired), NEVER queued -- deaths during an earlier verify count too (D58)", () => {
    for (const [crashes, leaseCrashes, maxCrashes] of [
      [4, 4, 5],
      [0, 0, 1],
      [2, 2, 3],
      [4, 1, 5], // one lease crash, three dead verifiers of an earlier, resubmitted attempt
      [7, 7, 5], // defensive: never past the cap, but if so still not queued
    ] as const) {
      const a = recoveryAction({ state: "running", attempt: leaseCrashes + 1, maxAttempts: 3, crashes, leaseCrashes, maxCrashes });
      expect(a).toMatchObject({ kind: "fail", label: "T6.2", to: "failed", outcome: "crash_limit", crash: true, leaseCrash: true });
      expect(a.error).toMatch(new RegExp(`crash limit: .* \\(crash ${crashes + 1}/${maxCrashes}\\): a job that keeps killing its workers \\(a poison job\\?\\); nothing irreversible happened`));
    }
  });

  it("committing -> T6.4 claim to verify (Step 9 replaces Step 8's T6.3), whatever the attempts: a death (D58), never a lease crash", () => {
    for (const attempt of [1, 2, 3]) {
      const a = recoveryAction({ state: "committing", attempt, maxAttempts: 3, ...NO_CRASH });
      expect(a).toMatchObject({ kind: "verify", label: "T6.4", to: "verifying", outcome: "commit_uncertain", reason: "lease_expired_in_committing", crash: true, leaseCrash: false });
      expect(a.error).toMatch(/lease expired after the commit intent \(crash 1\/5\): the Submit may have committed; verifying in the bank's history by memo_key \(T6\.4\)/);
    }
  });

  it("committing at the crash cap -> T6.6 escalate needs_human / crash_limit, never failed: the Submit may have committed (D58)", () => {
    for (const [crashes, maxCrashes] of [
      [4, 5],
      [0, 1],
    ] as const) {
      const a = recoveryAction({ state: "committing", attempt: 1, maxAttempts: 3, crashes, leaseCrashes: 0, maxCrashes });
      expect(a).toMatchObject({ kind: "escalate", label: "T6.6", to: "needs_human", outcome: "crash_limit", crash: true, leaseCrash: false });
      expect(a.error).toMatch(new RegExp(`crash limit after the commit intent: the lease expired in committing \\(crash ${crashes + 1}/${maxCrashes}: every worker death on this job counts\\); the Submit may have committed`));
    }
  });

  it("verifying, a dead verifier under the crash cap -> T6.5 re-claim, a death; however many dead phases (no separate cap of 3, D58)", () => {
    for (const [deadPhases, crashes] of [
      [0, 1],
      [1, 2],
      [2, 3],
      [3, 3], // chaos seed 2080386450's job 1ba81fdf: the attempt's death + 3 dead verifiers = 4 deaths, under 5
    ] as const) {
      const a = recoveryAction({ state: "verifying", attempt: 1, maxAttempts: 3, crashes, leaseCrashes: 0, maxCrashes: 5, verify: cycle({ deadPhases }) });
      expect(a, `dead phases ${deadPhases}, crashes ${crashes}`).toMatchObject({ kind: "verify", label: "T6.5", reason: "lease_expired_in_verifying", crash: true, leaseCrash: false });
      expect(a.error).toMatch(new RegExp(`a verifier's lease expired \\(crash ${crashes + 1}/5; dead verify phases in this cycle: ${deadPhases}\\); re-verifying \\(T6\\.5\\)`));
    }
  });

  it("verifying, the death that reaches the crash cap -> T6.6 escalate needs_human / crash_limit (Step 9's verify_exhausted after 3 dead phases is gone)", () => {
    for (const [deadPhases, crashes, maxCrashes] of [
      [4, 4, 5],
      [1, 4, 5], // most deaths before this verify cycle (lease crashes, an earlier cycle): one budget
      [0, 1, 2],
    ] as const) {
      const a = recoveryAction({ state: "verifying", attempt: 1, maxAttempts: 3, crashes, leaseCrashes: 0, maxCrashes, verify: cycle({ deadPhases }) });
      expect(a).toMatchObject({ kind: "escalate", label: "T6.6", to: "needs_human", outcome: "crash_limit", crash: true });
      expect(a.error).toMatch(new RegExp(`crash limit after the commit intent: the lease expired in verifying \\(dead verify phases in this cycle: ${deadPhases}\\) \\(crash ${crashes + 1}/${maxCrashes}`));
    }
  });

  it("verifying whose newest phase was deferred or handed off -> T6.7 resume, NOT a death, even at the crash cap (deferrals never count)", () => {
    for (const lastDecision of ["deferred", "handed_off"] as const) {
      for (const [deadPhases, crashes] of [
        [0, 0],
        [3, 4],
      ] as const) {
        expect(recoveryAction({ state: "verifying", attempt: 2, maxAttempts: 3, crashes, leaseCrashes: 0, maxCrashes: 5, verify: cycle({ lastDecision, deadPhases, deferrals: 4 }) })).toMatchObject({
          kind: "verify",
          label: "T6.7",
          reason: "resumed",
          crash: false,
          leaseCrash: false,
        });
      }
    }
  });

  it("a verifying row without its cycle is a programming error", () => {
    expect(() => recoveryAction({ state: "verifying", attempt: 1, maxAttempts: 3, ...NO_CRASH })).toThrow(/needs its verify cycle/);
  });

  it("no input ever yields queued without an own attempt left or at the crash cap, or queued from past the intent; escalation and failure only at the cap; every recovery but a resume is a death, only a running one a lease crash", () => {
    for (const state of ["running", "committing", "verifying"] as const) {
      for (let maxAttempts = 1; maxAttempts <= 4; maxAttempts += 1) {
        for (let maxCrashes = 1; maxCrashes <= 5; maxCrashes += 1) {
          for (let crashes = 0; crashes < maxCrashes; crashes += 1) {
            for (let leaseCrashes = 0; leaseCrashes <= crashes; leaseCrashes += 1) {
              // A leased job was queued: an own attempt left before this lease (own - 1 < max), under the cap.
              for (let own = 1; own <= maxAttempts; own += 1) {
                const attempt = own + leaseCrashes;
                for (const verify of [cycle({}), cycle({ deadPhases: 3 }), cycle({ lastDecision: "deferred" })]) {
                  const a = recoveryAction({ state, attempt, maxAttempts, crashes, leaseCrashes, maxCrashes, verify });
                  const resume = state === "verifying" && verify.lastDecision === "deferred";
                  expect(a.crash).toBe(!resume);
                  expect(a.leaseCrash).toBe(state === "running");
                  if (a.to === "queued") {
                    expect(state).toBe("running");
                    expect(ownAttempts(attempt, leaseCrashes + 1)).toBeLessThan(maxAttempts); // jobs_queued_has_attempts_left
                    expect(crashes + 1).toBeLessThan(maxCrashes); // jobs_queued_under_crash_cap
                  }
                  if (a.to === "failed" || a.to === "needs_human") {
                    expect(a.outcome).toBe("crash_limit");
                    expect(crashes + 1).toBeGreaterThanOrEqual(maxCrashes); // property 11's unit form
                    expect(a.to).toBe(state === "running" ? "failed" : "needs_human"); // past the intent: never failed
                  }
                }
              }
            }
          }
        }
      }
    }
  });
});
describe("classifyLookup: what one history lookup said", () => {
  const ok = (outputs: Record<string, unknown>): ReplayResult => ({ status: "success", outputs, evidenceRef: "evidence://l" });

  it("success with an integer count -> a count (with the first match's Reference)", () => {
    expect(classifyLookup({ kind: "result", result: ok({ matchingCount: "1", firstMatchRef: "TXN-000007" }) })).toEqual({
      kind: "count",
      n: 1,
      firstMatchRef: "TXN-000007",
      evidenceRef: "evidence://l",
    });
    expect(classifyLookup({ kind: "result", result: ok({ matchingCount: " 0 ", firstMatchRef: "No matching transfers." }) })).toMatchObject({ kind: "count", n: 0 });
    expect(classifyLookup({ kind: "result", result: ok({ matchingCount: "2", firstMatchRef: "" }) })).toMatchObject({ kind: "count", n: 2, firstMatchRef: null });
  });

  it("a page that loads but cannot be understood -> unreadable (a non-integer count, an unknown business outcome, an unexpected page)", () => {
    for (const matchingCount of ["one", "1.5", "", null, "-1"]) {
      expect(classifyLookup({ kind: "result", result: ok({ matchingCount }) }).kind, String(matchingCount)).toBe("unreadable");
    }
    expect(classifyLookup({ kind: "result", result: { status: "business_outcome", code: "NO_SUCH_MEMBER", detail: "x", evidenceRef: "e" } }).kind).toBe("unreadable");
    expect(
      classifyLookup({ kind: "result", result: { status: "failure", atStepId: "step-09", expected: "x", observed: "y", category: "unexpected-state", evidenceRef: "e" } }).kind,
    ).toBe("unreadable");
    expect(classifyLookup({ kind: "result", result: { status: "needs_human", reason: "approved for 1.1.0, artifact is 1.2.0", atStepId: "step-01", contextRef: "c" } }).kind).toBe("unreadable");
    expect(classifyLookup({ kind: "thrown", error: new Error('Invalid params for capability "transfer-history-lookup"') }).kind).toBe("unreadable");
  });

  it("the bank's 503 (BANK_UNAVAILABLE) -> unavailable at once (reviewer decision 5)", () => {
    expect(classifyLookup({ kind: "result", result: { status: "business_outcome", code: "BANK_UNAVAILABLE", detail: "503", evidenceRef: "e" } })).toMatchObject({
      kind: "unavailable",
      evidenceRef: "e",
    });
  });

  it("session timeout, an exhausted interstitial retry, a network throw -> transient; still transient after the one retry -> unavailable", () => {
    const timeout = classifyLookup({ kind: "result", result: { status: "failure", atStepId: "step-04", expected: "x", observed: "login page", category: "session-timeout", evidenceRef: "e" } });
    const interstitial = classifyLookup({
      kind: "result",
      result: { status: "needs_human", reason: 'Recoverable rule ("retry") exhausted after 3 attempts at step "step-06".', atStepId: "step-06", contextRef: "c" },
    });
    const refused = classifyLookup({ kind: "thrown", error: new Error("page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:4100/") });
    for (const r of [timeout, interstitial, refused]) {
      expect(r.kind).toBe("transient");
      expect(afterRetry(r).kind).toBe("unavailable");
    }
    expect(afterRetry({ kind: "count", n: 1, firstMatchRef: "T", evidenceRef: null }).kind).toBe("count");
  });
});

describe("verifyDecision: one row per line of section 5's table, plus the deferral", () => {
  const count = (n: number, firstMatchRef: string | null = n > 0 ? "TXN-000001" : "No matching transfers."): LookupReading => ({ kind: "count", n, firstMatchRef, evidenceRef: `e${n}` });
  const unavailable: LookupReading = { kind: "unavailable", detail: "BANK_UNAVAILABLE", evidenceRef: null };
  const unreadable: LookupReading = { kind: "unreadable", detail: "count not a number", evidenceRef: null };
  const input = (readings: LookupReading[], over: Partial<VerifyInput> = {}): VerifyInput => ({
    readings,
    priorStatus: "failure",
    attempt: 1,
    maxAttempts: 3,
    deferrals: 0,
    deferredForSeconds: null,
    defer: DEFAULT_DEFER_CONFIG,
    ...over,
  });

  it("[1] or [0, 1], any prior status -> already_done, confirmationRef = the match's Reference", () => {
    for (const priorStatus of ["failure", "business_outcome", "needs_human", null] as const) {
      expect(verifyDecision(input([count(1, "TXN-000042")], { priorStatus }))).toMatchObject({ decision: "already_done", to: "succeeded", outcome: "already_done", confirmationRef: "TXN-000042", evidenceRef: "e1" });
      expect(verifyDecision(input([count(0), count(1, "TXN-000043")], { priorStatus }))).toMatchObject({ decision: "already_done", confirmationRef: "TXN-000043" });
    }
    const d = verifyDecision(input([count(1, "TXN-000042")]));
    if (d.decision !== "already_done") throw new Error("expected already_done");
    expect(alreadyDoneResult(d)).toEqual({ status: "success", outputs: { confirmationRef: "TXN-000042" }, evidenceRef: "e1", recoveredBy: "verify" });
  });

  it("[0, 0], not a business outcome, attempts left -> resubmitted (queued): the ONLY retry after an intent", () => {
    for (const priorStatus of ["failure", "needs_human", null] as const) {
      expect(verifyDecision(input([count(0), count(0)], { priorStatus }))).toMatchObject({ decision: "resubmitted", to: "queued", outcome: null });
    }
    expect(verifyDecision(input([count(0), count(0)], { attempt: 2 })).error).toMatch(/resubmitting as attempt 3\/3/);
  });

  it("[0, 0], attempts exhausted -> failed / not_committed_attempts_exhausted, never queued", () => {
    expect(verifyDecision(input([count(0), count(0)], { attempt: 3, maxAttempts: 3 }))).toMatchObject({ decision: "exhausted", to: "failed", outcome: "not_committed_attempts_exhausted" });
    expect(verifyDecision(input([count(0), count(0)], { attempt: 5, maxAttempts: 3, leaseCrashes: 2 })).error).toMatch(/on the last attempt \(3\/3\)/);
  });

  it("[0, 0] counts the job's OWN attempts (D57): crashes before the intent did not use one, so lease 3 after 2 crashes resubmits", () => {
    const d = verifyDecision(input([count(0), count(0)], { attempt: 3, maxAttempts: 3, leaseCrashes: 2 }));
    expect(d).toMatchObject({ decision: "resubmitted", to: "queued" });
    expect(d.error).toMatch(/resubmitting as attempt 2\/3/);
    expect(verifyDecision(input([count(0), count(0)], { attempt: 4, maxAttempts: 3, leaseCrashes: 1 }))).toMatchObject({ decision: "exhausted" });
  });

  it("[0, 0] after a refusal shown after Submit -> not_committed_final: business_outcome, never retried (even with attempts left)", () => {
    expect(verifyDecision(input([count(0), count(0)], { priorStatus: "business_outcome" }))).toMatchObject({ decision: "not_committed_final", to: "business_outcome", outcome: "business_outcome" });
  });

  it("[2+] or [0, 2+] -> escalated / ambiguous; 1 match without a Reference -> escalated / unreadable", () => {
    expect(verifyDecision(input([count(2)]))).toMatchObject({ decision: "escalated", to: "needs_human", outcome: "ambiguous" });
    expect(verifyDecision(input([count(0), count(3)]))).toMatchObject({ decision: "escalated", outcome: "ambiguous" });
    expect(verifyDecision(input([count(1, null)]))).toMatchObject({ decision: "escalated", outcome: "unreadable" });
  });

  it("unreadable at any lookup -> escalated / unreadable at once (a page that loads but cannot be understood)", () => {
    expect(verifyDecision(input([unreadable]))).toMatchObject({ decision: "escalated", outcome: "unreadable" });
    expect(verifyDecision(input([count(0), unreadable]))).toMatchObject({ decision: "escalated", outcome: "unreadable" });
  });

  it("unavailable within the budget -> deferred, backoff min(cap, base * 2^n); at or past the budget -> escalated / verify_unavailable", () => {
    expect(verifyDecision(input([unavailable]))).toMatchObject({ decision: "deferred", to: "verifying", outcome: "commit_uncertain", backoffSeconds: 5 });
    expect(verifyDecision(input([count(0), unavailable], { deferrals: 2, deferredForSeconds: 20 }))).toMatchObject({ decision: "deferred", backoffSeconds: 20 });
    expect(verifyDecision(input([unavailable], { deferrals: 9, deferredForSeconds: 599.9 }))).toMatchObject({ decision: "deferred", backoffSeconds: 60 });
    expect(verifyDecision(input([unavailable], { deferrals: 9, deferredForSeconds: 600 }))).toMatchObject({ decision: "escalated", outcome: "verify_unavailable" });
    expect([0, 1, 2, 3, 4, 5, 30].map((n) => deferBackoffSeconds(n, DEFAULT_DEFER_CONFIG))).toEqual([5, 10, 20, 40, 60, 60, 60]);
  });

  it("incomplete lookups are refused (the procedure must look twice after a 0)", () => {
    expect(readingsComplete([count(0)])).toBe(false);
    expect(readingsComplete([count(1)])).toBe(true);
    expect(readingsComplete([unavailable])).toBe(true);
    expect(() => verifyDecision(input([count(0)]))).toThrow(/incomplete lookups/);
    expect(() => verifyDecision(input([]))).toThrow(/incomplete lookups/);
    expect(lookupsColumn([count(0), unavailable])).toEqual([0, null]);
  });

  it("no input ever resubmits unless both lookups counted 0 and own attempts are left", () => {
    const readingsSets: LookupReading[][] = [[count(1)], [count(2)], [unavailable], [unreadable], [count(0), count(1)], [count(0), count(2)], [count(0), unavailable], [count(0), unreadable], [count(0), count(0)]];
    for (const readings of readingsSets) {
      for (const priorStatus of ["failure", "business_outcome", "needs_human", null] as const) {
        for (const [attempt, maxAttempts, leaseCrashes] of [[1, 3, 0], [3, 3, 0], [1, 1, 0], [3, 3, 2], [4, 3, 1], [2, 1, 1]] as const) {
          for (const deferredForSeconds of [null, 10, 10_000]) {
            const d = verifyDecision(input(readings, { priorStatus, attempt, maxAttempts, leaseCrashes, deferredForSeconds }));
            if (d.to === "queued") {
              expect(lookupsColumn(readings)).toEqual([0, 0]);
              expect(priorStatus).not.toBe("business_outcome");
              expect(attempt - leaseCrashes).toBeLessThan(maxAttempts);
            }
          }
        }
      }
    }
  });
});

describe("completionAllowed (T4's state guard, section 3)", () => {
  const targets: CompletionTarget[] = ["succeeded", "business_outcome", "needs_human", "failed", "queued"];

  it("from running: every final state and the requeue", () => {
    for (const to of targets) expect(completionAllowed("running", to), to).toBe(true);
  });

  it("from committing: only succeeded or needs_human (never a requeue, failed or business_outcome past the intent)", () => {
    expect(targets.filter((to) => completionAllowed("committing", to))).toEqual(["succeeded", "needs_human"]);
  });

  it("from any other state: nothing (a completion is only ever by a live holder)", () => {
    for (const from of JOB_STATES.filter((s) => s !== "running" && s !== "committing")) {
      for (const to of targets) expect(completionAllowed(from, to), `${from} -> ${to}`).toBe(false);
    }
  });
});

describe("requeueBackoffSeconds (Step 10 section 1, reviewer decision 2: option B; D49)", () => {
  it("10 s x 3^(attempt - 1), capped at 120 s: 10, 30, 90, 120, 120", () => {
    expect([1, 2, 3, 4, 9].map((a) => requeueBackoffBaseSeconds(a))).toEqual([10, 30, 90, 120, 120]);
    expect(DEFAULT_REQUEUE_BACKOFF).toEqual({ baseSeconds: 10, factor: 3, capSeconds: 120, jitter: 0.2 });
  });

  it("jittered x [0.8, 1.2] (random 0 -> x 0.8, 0.5 -> x 1.0, 0.99 -> x 1.196), rounded to the millisecond (so a draw just under 1 can round up to x 1.2)", () => {
    expect(requeueBackoffSeconds(1, () => 0)).toBe(8);
    expect(requeueBackoffSeconds(1, () => 0.5)).toBe(10);
    expect(requeueBackoffSeconds(2, () => 0.5)).toBe(30);
    expect(requeueBackoffSeconds(2, () => 0.99)).toBe(35.88);
    expect(requeueBackoffSeconds(2, () => 0.999999)).toBe(36);
    expect(requeueBackoffSeconds(9, () => 0)).toBe(96);
    for (let i = 0; i < 200; i += 1) {
      const s = requeueBackoffSeconds(1);
      expect(s).toBeGreaterThanOrEqual(8);
      expect(s).toBeLessThanOrEqual(12);
      expect(Math.abs(s * 1000 - Math.round(s * 1000))).toBeLessThan(1e-6); // whole milliseconds
    }
  });

  it("refuses a non-positive attempt and a random() outside [0, 1)", () => {
    expect(() => requeueBackoffSeconds(0)).toThrow(RangeError);
    expect(() => requeueBackoffSeconds(1.5)).toThrow(RangeError);
    expect(() => requeueBackoffSeconds(1, () => 1)).toThrow(RangeError);
    expect(() => requeueBackoffSeconds(1, () => -0.1)).toThrow(RangeError);
  });

  it("the shortest schedule to the last attempt: 3 attempts -> 0.8 x (10 + 30) = 32 s (longer than the brief's 30 s outage); 1 attempt -> 0", () => {
    expect(minRequeueScheduleSeconds(3)).toBeCloseTo(32, 9);
    expect(minRequeueScheduleSeconds(2)).toBeCloseTo(8, 9);
    expect(minRequeueScheduleSeconds(1)).toBe(0);
  });
});

describe("reconcileDecision (Step 10 section 2, R2's table; D50; every terminal state, D55)", () => {
  const defer = { budgetSeconds: 600, backoffBaseSeconds: 5, backoffCapSeconds: 60 };
  const count = (n: number, ref: string | null = n > 0 ? "TXN-000001" : null): LookupReading => ({ kind: "count", n, firstMatchRef: ref, evidenceRef: "e" });
  const decide = (reading: LookupReading, deferrals = 0, deferredForSeconds: number | null = null, jobState: ReconcilableState = "succeeded") =>
    reconcileDecision({ jobState, reading, deferrals, deferredForSeconds, defer });

  it("succeeded, 1 match -> reconciled: stays succeeded", () => {
    expect(decide(count(1))).toEqual({ decision: "reconciled", to: "succeeded", outcome: null, matches: 1, firstMatchRef: "TXN-000001", error: null });
  });

  it("the expected count is the job's own promise: 1 row for succeeded, 0 for failed / business_outcome", () => {
    expect(RECONCILABLE_STATES.map(reconcileExpectedMatches)).toEqual([1, 0, 0]);
    expect(RECONCILE_TRIGGERS).toEqual(["resubmitted", "exhausted", "not_committed_final"]);
    expect(RECONCILE_FLAGS).toEqual(["duplicate_suspected", "unrecorded_commit_suspected", "reconcile_unreadable"]);
  });

  it("failed / business_outcome, 0 matches -> reconciled: stays in its state (no money moved, as the job says)", () => {
    for (const s of ["failed", "business_outcome"] as const) {
      expect(decide(count(0, "No matching transfers."), 0, null, s)).toEqual({ decision: "reconciled", to: s, outcome: null, matches: 0, firstMatchRef: null, error: null });
    }
  });

  it("failed / business_outcome, 1+ matches -> unrecorded_commit_suspected: needs_human, with the count and the first match's reference", () => {
    for (const s of ["failed", "business_outcome"] as const) {
      for (const n of [1, 2]) {
        expect(decide(count(n), 0, null, s), `${s} ${n}`).toMatchObject({ decision: "unrecorded_commit_suspected", to: "needs_human", outcome: "unrecorded_commit_suspected", matches: n, firstMatchRef: "TXN-000001" });
      }
    }
    expect(decide(count(1), 0, null, "failed").error).toMatch(/reconcile found 1 transfer\(s\) with this memo_key although the job ended failed after a \[0, 0\] verify/);
  });

  it("failed / business_outcome: an unreadable page -> reconcile_unreadable; the bank unavailable -> reconcile_deferred, staying in its state", () => {
    expect(decide({ kind: "unreadable", detail: "garbled", evidenceRef: null }, 0, null, "failed")).toMatchObject({ decision: "reconcile_unreadable", to: "needs_human" });
    expect(decide({ kind: "unavailable", detail: "503", evidenceRef: null }, 0, null, "business_outcome")).toMatchObject({ decision: "reconcile_deferred", to: "business_outcome", backoffSeconds: 5 });
    expect(decide({ kind: "unavailable", detail: "503", evidenceRef: null }, 10, 600, "failed")).toMatchObject({ decision: "reconcile_unreadable", to: "needs_human" });
  });

  it("never for a state the reconcile does not cover (needs_human is a human's already; active states are not terminal)", () => {
    for (const s of ["needs_human", "queued", "running", "committing", "verifying"]) {
      expect(() => reconcileDecision({ jobState: s as ReconcilableState, reading: count(1), deferrals: 0, deferredForSeconds: null, defer }), s).toThrow(/is never reconciled/);
    }
  });

  it("2+ matches -> duplicate_suspected: needs_human, with the count and the first match's reference", () => {
    for (const n of [2, 3]) expect(decide(count(n))).toMatchObject({ decision: "duplicate_suspected", to: "needs_human", outcome: "duplicate_suspected", matches: n, firstMatchRef: "TXN-000001" });
    expect(decide(count(2)).error).toMatch(/reconcile found 2 transfers with this memo_key after the job succeeded on a resubmit/);
  });

  it("0 matches, or a page it cannot read -> reconcile_unreadable: needs_human (a succeeded job the history cannot show is an alarm)", () => {
    expect(decide(count(0))).toMatchObject({ decision: "reconcile_unreadable", to: "needs_human", outcome: "reconcile_unreadable", matches: 0 });
    expect(decide({ kind: "unreadable", detail: "garbled", evidenceRef: null })).toMatchObject({ decision: "reconcile_unreadable", matches: null });
  });

  it("the bank unavailable -> reconcile_deferred with D44's backoff (5, 10, 20 ... capped at 60 s); past the budget -> reconcile_unreadable", () => {
    const down: LookupReading = { kind: "unavailable", detail: "BANK_UNAVAILABLE", evidenceRef: null };
    expect(decide(down)).toMatchObject({ decision: "reconcile_deferred", to: "succeeded", outcome: null, backoffSeconds: 5 });
    expect(decide(down, 2, 30)).toMatchObject({ decision: "reconcile_deferred", backoffSeconds: 20 });
    expect(decide(down, 9, 599)).toMatchObject({ decision: "reconcile_deferred", backoffSeconds: 60 });
    expect(decide(down, 10, 600)).toMatchObject({ decision: "reconcile_unreadable", to: "needs_human" });
    expect(decide({ kind: "transient", detail: "t", evidenceRef: null })).toMatchObject({ decision: "reconcile_deferred" });
  });

  it("result.reconcile carries the decision, the count, the first match's reference and the job's own confirmationRef", () => {
    expect(reconcileResultPatch(decide(count(2)), "e", "TXN-000002")).toEqual({ decision: "duplicate_suspected", matches: 2, firstMatchRef: "TXN-000001", jobConfirmationRef: "TXN-000002", evidenceRef: "e" });
    expect(reconcileResultPatch(decide({ kind: "unavailable", detail: "d", evidenceRef: null }), null, undefined)).toMatchObject({ matches: null, firstMatchRef: null, jobConfirmationRef: null });
  });

  it("reconcileDueSeconds = lease + settle (whole seconds, rounded up) + margin; production 30 + 5 + 25 = 60", () => {
    expect(reconcileDueSeconds(30, 5000)).toBe(60);
    expect(reconcileDueSeconds(5, 5000, 10)).toBe(20);
    expect(reconcileDueSeconds(5, 1001, 1)).toBe(8);
    expect(() => reconcileDueSeconds(-1, 0, 0)).toThrow(RangeError);
  });

  it("jobSettled: terminal and no reconcile due (none set, or the pass decided)", () => {
    const at = new Date();
    expect(jobSettled({ state: "succeeded", reconcile_after: null, reconciled_at: null })).toBe(true);
    expect(jobSettled({ state: "succeeded", reconcile_after: at, reconciled_at: null })).toBe(false);
    expect(jobSettled({ state: "succeeded", reconcile_after: at, reconciled_at: at })).toBe(true);
    expect(jobSettled({ state: "needs_human", reconcile_after: at, reconciled_at: at })).toBe(true);
    expect(jobSettled({ state: "failed", reconcile_after: at, reconciled_at: null })).toBe(false); // D55
    expect(jobSettled({ state: "business_outcome", reconcile_after: at, reconciled_at: at })).toBe(true);
    for (const state of ["queued", "running", "committing", "verifying"]) expect(jobSettled({ state, reconcile_after: null, reconciled_at: null }), state).toBe(false);
    // D59: the pass abandoned it: settled (no automatic check runs again), though nothing was confirmed.
    expect(jobSettled({ state: "succeeded", reconcile_after: at, reconciled_at: null, reconcile_abandoned_at: at })).toBe(true);
    expect(jobSettled({ state: "failed", reconcile_after: at, reconciled_at: null, reconcile_abandoned_at: null })).toBe(false);
  });

  it("reconcileStatus (GET /jobs/:id `reconcile`, D59): none, pending, reconciled, flagged, abandoned; a decision after an abandonment wins", () => {
    const at = new Date();
    const job = (over: Partial<Parameters<typeof reconcileStatus>[0]>) => ({ state: "succeeded", outcome: "success", reconcile_after: at, reconciled_at: null, reconcile_abandoned_at: null, ...over });
    expect(reconcileStatus(job({ reconcile_after: null }))).toBe("none");
    expect(reconcileStatus(job({ state: "needs_human", outcome: "ambiguous", reconcile_after: null }))).toBe("none"); // a verify's escalation, never marked
    expect(reconcileStatus(job({}))).toBe("pending");
    expect(reconcileStatus(job({ state: "failed", outcome: "not_committed_attempts_exhausted" }))).toBe("pending");
    expect(reconcileStatus(job({ reconciled_at: at }))).toBe("reconciled");
    expect(reconcileStatus(job({ state: "business_outcome", outcome: "business_outcome", reconciled_at: at }))).toBe("reconciled");
    for (const flag of RECONCILE_FLAGS) expect(reconcileStatus(job({ state: "needs_human", outcome: flag, reconciled_at: at })), flag).toBe("flagged");
    expect(reconcileStatus(job({ reconcile_abandoned_at: at }))).toBe("abandoned");
    // The end-of-day batch decided after the pass gave up: its decision is the status.
    expect(reconcileStatus(job({ reconcile_abandoned_at: at, reconciled_at: at }))).toBe("reconciled");
    expect(reconcileStatus(job({ reconcile_abandoned_at: at, reconciled_at: at, state: "needs_human", outcome: "duplicate_suspected" }))).toBe("flagged");
    // Settled and abandoned are both true at once: settled alone never says "confirmed".
    expect(jobSettled(job({ reconcile_abandoned_at: at }))).toBe(true);
    // Rows read without 0008's column (undefined) are never abandoned.
    expect(reconcileStatus({ state: "succeeded", reconcile_after: at, reconciled_at: null })).toBe("pending");
  });

  it("reconcileClaimAction (D59): a reconciler's death counts apart; the workers' pass abandons at max_crashes (R3); the batch never does", () => {
    const pass = (reconcileCrashes: number, deadReconciler: boolean, maxCrashes = DEFAULT_MAX_CRASHES) =>
      reconcileClaimAction({ state: "succeeded", reconcileCrashes, deadReconciler, maxCrashes, by: "pass" });
    expect(pass(0, false)).toEqual({ kind: "reconcile", label: "R1", reconcileCrashes: 0 }); // the first claim
    expect(pass(0, true)).toEqual({ kind: "reconcile", label: "R1", reconcileCrashes: 1 }); // a dead reconciler: counted
    expect(pass(3, true)).toEqual({ kind: "reconcile", label: "R1", reconcileCrashes: 4 }); // 4 of 5: still reconciled
    const fifth = pass(4, true);
    expect(fifth).toMatchObject({ kind: "abandon", label: "R3", reconcileCrashes: 5 }); // the 5th death: abandoned
    if (fifth.kind !== "abandon") throw new Error("unreachable");
    expect(fifth.error).toMatch(/^reconcile abandoned: 5 reconciler\(s\) died on this job \(cap 5, counted apart from the job's own crash budget\); the job stays succeeded; .*`rote reconcile --since` still re-reads it$/);
    // At the cap already (the batch's deaths are counted, D59) with no new death: the pass abandons too.
    expect(pass(5, false)).toMatchObject({ kind: "abandon", reconcileCrashes: 5 });
    // The cap is the job's max_crashes.
    expect(pass(0, true, 1)).toMatchObject({ kind: "abandon", reconcileCrashes: 1 });
    expect(pass(1, true, 3)).toMatchObject({ kind: "reconcile", reconcileCrashes: 2 });
    expect(reconcileClaimAction({ state: "failed", reconcileCrashes: 1, deadReconciler: true, maxCrashes: 2, by: "pass" })).toMatchObject({ kind: "abandon", error: expect.stringMatching(/the job stays failed/) });
    // The batch (rote reconcile --since): counts the death, never abandons, however many.
    for (const n of [0, 4, 5, 19]) {
      expect(reconcileClaimAction({ state: "business_outcome", reconcileCrashes: n, deadReconciler: true, maxCrashes: 5, by: "batch" })).toEqual({ kind: "reconcile", label: "R1", reconcileCrashes: n + 1 });
    }
    expect(() => pass(-1, false)).toThrow(RangeError);
    expect(() => pass(0, false, 0)).toThrow(RangeError);
  });
});
