import { describe, expect, it } from "vitest";
import { RECOVERY_FAULT_POINTS } from "../worker/fault.js";
import { ALL_POINTS, expectedFor, judgePoint, RECOVERY_SCENARIOS, scenariosFor } from "./crashExpected.js";

describe("crash-point expectations (step-08 section 9)", () => {
  it("every transfer crash point has a Step 8 expectation; none ever allows 2 rows", () => {
    for (const point of ALL_POINTS) {
      const e = expectedFor(point);
      expect(e.ledgerRows, point).toBeLessThanOrEqual(1);
    }
    expect(() => expectedFor("after-step-99")).toThrow(/no Step 8 expectation/);
  });

  it("before the intent: retried (attempt 2, 1 row); after it: needs_human with 0 or 1 row; after-complete: done", () => {
    expect(expectedFor("after-dequeue")).toMatchObject({ state: "succeeded", attempt: 2, ledgerRows: 1 });
    expect(expectedFor("after-step-10")).toMatchObject({ state: "succeeded", attempt: 2, ledgerRows: 1 });
    expect(expectedFor("before-submit")).toMatchObject({ state: "needs_human", outcome: "commit_uncertain", attempt: 1, ledgerRows: 0 });
    for (const p of ["after-submit", "after-step-12", "before-complete"]) {
      expect(expectedFor(p)).toMatchObject({ state: "needs_human", outcome: "commit_uncertain", attempt: 1, ledgerRows: 1 });
    }
    expect(expectedFor("after-complete")).toMatchObject({ state: "succeeded", attempt: 1, ledgerRows: 1 });
  });

  it("judgePoint: fired + oracle ok + every expected field, or a reason", () => {
    const e = expectedFor("before-submit");
    const ok = { fired: true, oracleVerdict: "ok", state: "needs_human", outcome: "commit_uncertain", attempt: 1, ledgerRows: 0 };
    expect(judgePoint(ok, e)).toBeNull();
    expect(judgePoint({ ...ok, fired: false }, e)).toBe("FAULT_NOT_FIRED");
    expect(judgePoint({ ...ok, oracleVerdict: "LOST" }, e)).toBe("LOST");
    expect(judgePoint({ ...ok, state: "succeeded", outcome: "success", ledgerRows: 1 }, e)).toBe(
      "UNEXPECTED: state succeeded (expected needs_human), outcome success (expected commit_uncertain), rows 1 (expected 0)",
    );
  });
});

describe("crash-point expectations, Step 9 (docs/plans/step-09.md section 4)", () => {
  it("before the intent: unchanged; after it: VERIFIED -- [0, 0] resubmitted (attempt 2) or [1] already_done (attempt 1); always exactly 1 row, never needs_human", () => {
    for (const point of ALL_POINTS) {
      const e = expectedFor(point, "step-09");
      expect(e.ledgerRows, point).toBe(1);
      expect(e.state, point).toBe("succeeded");
      expect(e.oracle ?? "ok").toBe("ok");
    }
    expect(expectedFor("after-step-10", "step-09")).toMatchObject({ outcome: "success", attempt: 2 });
    expect(expectedFor("before-submit", "step-09")).toMatchObject({ outcome: "success", attempt: 2 });
    for (const p of ["after-submit", "after-step-12", "before-complete"]) expect(expectedFor(p, "step-09")).toMatchObject({ outcome: "already_done", attempt: 1 });
    expect(expectedFor("after-complete", "step-09")).toMatchObject({ outcome: "success", attempt: 1 });
    expect(() => expectedFor("verify-after-login", "step-09")).toThrow(/no Step 9 expectation/);
  });

  it("the seven two-fault recovery scenarios (step-08 section 9's second table): a recovery-internal point second, each with its expectation; step-09 judges 16 + 7", () => {
    expect(RECOVERY_SCENARIOS.map((s) => [s.first, s.second])).toEqual([
      ["after-submit", "verify-after-login"],
      ["after-submit", "verify-after-count"],
      ["after-submit", "verify-before-result"],
      ["before-submit", "verify-after-count"],
      ["before-submit", "verify-before-requeue"],
      ["before-submit", "verify-after-requeue"],
      ["after-dequeue", "recover-in-transaction"],
    ]);
    for (const s of RECOVERY_SCENARIOS) {
      expect(s.second && RECOVERY_FAULT_POINTS.includes(s.second as (typeof RECOVERY_FAULT_POINTS)[number]), s.name).toBe(true);
      expect(s.expected).toMatchObject({ state: "succeeded", ledgerRows: 1, attempt: s.first === "after-submit" ? 1 : 2 });
    }
    expect(scenariosFor("step-08")).toHaveLength(16);
    expect(scenariosFor("step-09")).toHaveLength(23);
  });

  it("judgePoint: a second fault that did not fire fails the scenario; an expected non-ok oracle verdict must be seen", () => {
    const e = expectedFor("after-submit", "step-09");
    const ok = { fired: true, secondFired: true, oracleVerdict: "ok", state: "succeeded", outcome: "already_done", attempt: 1, ledgerRows: 1 };
    expect(judgePoint(ok, e)).toBeNull();
    expect(judgePoint({ ...ok, secondFired: false }, e)).toBe("SECOND_FAULT_NOT_FIRED");
    const dup = { ...e, oracle: "DUPLICATE", ledgerRows: 2 };
    expect(judgePoint({ ...ok, ledgerRows: 2 }, dup)).toBe("ORACLE_OK (expected DUPLICATE)");
    expect(judgePoint({ ...ok, oracleVerdict: "DUPLICATE", ledgerRows: 2 }, dup)).toBeNull();
  });
});

describe("crash-point expectations, Step 10 (docs/plans/step-10.md; D50, D54)", () => {
  it("Step 9's outcomes; the resubmit paths (first fault before-submit) are reconciled, every other scenario has no reconcile due; step-10 judges 16 + 7", () => {
    const all = scenariosFor("step-10");
    expect(all).toHaveLength(23);
    for (const s of all) {
      const nine = s.second ? RECOVERY_SCENARIOS.find((r) => r.name === s.name)!.expected : expectedFor(s.first, "step-09");
      expect({ ...s.expected, reconcile: undefined, says: undefined }, s.name).toEqual({ ...nine, reconcile: undefined, says: undefined });
      expect(s.expected.reconcile, s.name).toBe(s.first === "before-submit" ? "reconciled" : "");
    }
    expect(all.filter((s) => s.expected.reconcile === "reconciled").map((s) => s.name)).toEqual([
      "before-submit",
      "before-submit>verify-after-count",
      "before-submit>verify-before-requeue",
      "before-submit>verify-after-requeue",
    ]);
  });

  it("judgePoint compares the reconcile decisions when the expectation names them", () => {
    const e = expectedFor("before-submit", "step-10");
    const ok = { fired: true, oracleVerdict: "ok", state: "succeeded", outcome: "success", attempt: 2, ledgerRows: 1, reconcile: "reconciled" };
    expect(judgePoint(ok, e)).toBeNull();
    expect(judgePoint({ ...ok, reconcile: "" }, e)).toBe('UNEXPECTED: reconcile "" (expected "reconciled")');
    expect(judgePoint({ ...ok, reconcile: "duplicate_suspected" }, e)).toMatch(/reconcile "duplicate_suspected"/);
    expect(judgePoint({ ...ok, reconcile: "anything" }, expectedFor("before-submit", "step-09"))).toBeNull(); // step-09 does not judge it
  });
});
