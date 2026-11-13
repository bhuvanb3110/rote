// recoveryAction (T6), completionAllowed (T4's guard), classifyLookup and verifyDecision (Step 9): one
// case per row of docs/plans/step-08.md sections 3, 4 and 5, plus step-09 reviewer decision 5 (the
// deferral). jobOutcomeFor's rows are in jobOutcome.test.ts.
import { describe, expect, it } from "vitest";
import type { ReplayResult } from "../artifact/index.js";
import { JOB_STATES } from "../queue/types.js";
import {
  afterRetry,
  alreadyDoneResult,
  classifyLookup,
  completionAllowed,
  DEFAULT_DEFER_CONFIG,
  deferBackoffSeconds,
  EMPTY_VERIFY_CYCLE,
  lookupsColumn,
  readingsComplete,
  recoveryAction,
  verifyDecision,
  type CompletionTarget,
  type LookupReading,
  type VerifyCycle,
  type VerifyInput,
} from "./stateMachine.js";

const cycle = (over: Partial<VerifyCycle>): VerifyCycle => ({ ...EMPTY_VERIFY_CYCLE, phases: 1, deadPhases: 1, ...over });

describe("recoveryAction (section 4's table; Step 9 rows)", () => {
  it("running with attempts left -> T6.1 requeue (no intent: nothing irreversible happened)", () => {
    const a = recoveryAction({ state: "running", attempt: 1, maxAttempts: 3 });
    expect(a).toMatchObject({ kind: "requeue", label: "T6.1", to: "queued", outcome: null });
    expect(a.error).toMatch(/lease expired while running \(attempt 1\/3\), before any commit intent; requeued/);
    expect(recoveryAction({ state: "running", attempt: 2, maxAttempts: 3 }).kind).toBe("requeue");
  });

  it("running on the last attempt -> T6.2 fail / lease_expired, NEVER queued (D21)", () => {
    for (const [attempt, maxAttempts] of [
      [3, 3],
      [1, 1],
      [4, 3], // defensive: never more than max, but if so still not queued
    ] as const) {
      const a = recoveryAction({ state: "running", attempt, maxAttempts });
      expect(a).toMatchObject({ kind: "fail", label: "T6.2", to: "failed", outcome: "lease_expired" });
      expect(a.error).toMatch(/nothing irreversible happened/);
    }
  });

  it("committing -> T6.4 claim to verify (Step 9 replaces Step 8's T6.3 escalate), whatever the attempts", () => {
    for (const attempt of [1, 2, 3]) {
      const a = recoveryAction({ state: "committing", attempt, maxAttempts: 3 });
      expect(a).toMatchObject({ kind: "verify", label: "T6.4", to: "verifying", outcome: "commit_uncertain", reason: "lease_expired_in_committing" });
      expect(a.error).toMatch(/after the commit intent: the Submit may have committed; verifying in the bank's history by memo_key \(T6\.4\)/);
    }
  });

  it("verifying, fewer than 3 dead phases -> T6.5 re-claim; 3 or more -> T6.6 escalate needs_human / verify_exhausted", () => {
    for (const deadPhases of [0, 1, 2]) {
      expect(recoveryAction({ state: "verifying", attempt: 1, maxAttempts: 3, verify: cycle({ deadPhases }) })).toMatchObject({
        kind: "verify",
        label: "T6.5",
        reason: "lease_expired_in_verifying",
      });
    }
    for (const deadPhases of [3, 4]) {
      const a = recoveryAction({ state: "verifying", attempt: 1, maxAttempts: 3, verify: cycle({ deadPhases }) });
      expect(a).toMatchObject({ kind: "escalate", label: "T6.6", to: "needs_human", outcome: "verify_exhausted" });
      expect(a.error).toMatch(new RegExp(`verify exhausted: ${deadPhases} verify phases died without a decision`));
    }
  });

  it("verifying whose newest phase was deferred or handed off -> T6.7 resume, even past the dead-phase cap (deferrals never count)", () => {
    for (const lastDecision of ["deferred", "handed_off"] as const) {
      for (const deadPhases of [0, 2, 3]) {
        expect(recoveryAction({ state: "verifying", attempt: 2, maxAttempts: 3, verify: cycle({ lastDecision, deadPhases, deferrals: 4 }) })).toMatchObject({
          kind: "verify",
          label: "T6.7",
          reason: "resumed",
        });
      }
    }
  });

  it("a verifying row without its cycle is a programming error", () => {
    expect(() => recoveryAction({ state: "verifying", attempt: 1, maxAttempts: 3 })).toThrow(/needs its verify cycle/);
  });

  it("no input ever yields queued without an attempt left, or queued from past the intent", () => {
    for (const state of ["running", "committing", "verifying"] as const) {
      for (let maxAttempts = 1; maxAttempts <= 4; maxAttempts += 1) {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          for (const verify of [cycle({}), cycle({ deadPhases: 3 }), cycle({ lastDecision: "deferred" })]) {
            const a = recoveryAction({ state, attempt, maxAttempts, verify });
            if (a.to === "queued") {
              expect(state).toBe("running");
              expect(attempt).toBeLessThan(maxAttempts);
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

  it("no input ever resubmits unless both lookups counted 0 and attempts are left", () => {
    const readingsSets: LookupReading[][] = [[count(1)], [count(2)], [unavailable], [unreadable], [count(0), count(1)], [count(0), count(2)], [count(0), unavailable], [count(0), unreadable], [count(0), count(0)]];
    for (const readings of readingsSets) {
      for (const priorStatus of ["failure", "business_outcome", "needs_human", null] as const) {
        for (const [attempt, maxAttempts] of [[1, 3], [3, 3], [1, 1]] as const) {
          for (const deferredForSeconds of [null, 10, 10_000]) {
            const d = verifyDecision(input(readings, { priorStatus, attempt, maxAttempts, deferredForSeconds }));
            if (d.to === "queued") {
              expect(lookupsColumn(readings)).toEqual([0, 0]);
              expect(priorStatus).not.toBe("business_outcome");
              expect(attempt).toBeLessThan(maxAttempts);
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
