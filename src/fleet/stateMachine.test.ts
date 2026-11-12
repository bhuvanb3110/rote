// recoveryAction (T6) and completionAllowed (T4's guard): one case per row of docs/plans/step-08.md
// sections 3 and 4. jobOutcomeFor's rows are in jobOutcome.test.ts.
import { describe, expect, it } from "vitest";
import { JOB_STATES } from "../queue/types.js";
import { completionAllowed, recoveryAction, type CompletionTarget } from "./stateMachine.js";

describe("recoveryAction (section 4's table, Step 8)", () => {
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

  it("committing -> T6.3 escalate to needs_human / commit_uncertain (Step 8 interim), whatever the attempts", () => {
    for (const attempt of [1, 2, 3]) {
      const a = recoveryAction({ state: "committing", attempt, maxAttempts: 3 });
      expect(a).toMatchObject({ kind: "escalate", label: "T6.3", to: "needs_human", outcome: "commit_uncertain" });
      expect(a.error).toMatch(/after the commit intent: the Submit may have committed; check the bank's history for memo_key/);
    }
  });

  it("verifying (unreachable in Step 8) -> escalated too, never requeued", () => {
    const a = recoveryAction({ state: "verifying", attempt: 1, maxAttempts: 3 });
    expect(a).toMatchObject({ kind: "escalate", to: "needs_human", outcome: "commit_uncertain" });
  });

  it("no input ever yields queued without an attempt left, or queued from past the intent", () => {
    for (const state of ["running", "committing", "verifying"] as const) {
      for (let maxAttempts = 1; maxAttempts <= 4; maxAttempts += 1) {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const a = recoveryAction({ state, attempt, maxAttempts });
          if (a.to === "queued") {
            expect(state).toBe("running");
            expect(attempt).toBeLessThan(maxAttempts);
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
