import { describe, expect, it } from "vitest";
import { ALL_POINTS, expectedFor, judgePoint } from "./crashExpected.js";

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
