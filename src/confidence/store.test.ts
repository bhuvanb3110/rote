import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveCapability,
  consecutiveQualifyingRuns,
  readCapabilityStatus,
  recordConfidenceRun,
} from "./store.js";
import type { ConfidenceRunRecord } from "./types.js";

function record(confidence: number): ConfidenceRunRecord {
  return { runId: `run-${Math.random()}`, confidence, at: new Date().toISOString() };
}

describe("consecutiveQualifyingRuns", () => {
  it("counts from the tail, stopping at the first sub-threshold run", () => {
    const history = [record(1), record(0.2), record(1), record(1), record(1)];
    expect(consecutiveQualifyingRuns(history, 0.8)).toBe(3);
  });

  it("is 0 when the most recent run is below threshold", () => {
    const history = [record(1), record(1), record(0.5)];
    expect(consecutiveQualifyingRuns(history, 0.8)).toBe(0);
  });

  it("is 0 for empty history", () => {
    expect(consecutiveQualifyingRuns([], 0.8)).toBe(0);
  });
});

describe("recordConfidenceRun / approveCapability", () => {
  let statusDir: string;

  beforeEach(async () => {
    statusDir = await mkdtemp(path.join(tmpdir(), "confidence-store-test-"));
  });

  afterEach(async () => {
    await rm(statusDir, { recursive: true, force: true });
  });

  it("a fresh capability with no sidecar file starts draft", async () => {
    const status = await readCapabilityStatus("fresh-capability", statusDir);
    expect(status.approvalStatus).toBe("draft");
    expect(status.history).toEqual([]);
  });

  it("auto-promotes only once N consecutive qualifying runs have landed, not before", async () => {
    const opts = { statusDir, threshold: 0.8, requiredConsecutive: 3 };
    await recordConfidenceRun("promo-test", 1, "run-1", opts);
    let status = await readCapabilityStatus("promo-test", statusDir);
    expect(status.approvalStatus).toBe("draft");

    await recordConfidenceRun("promo-test", 1, "run-2", opts);
    status = await readCapabilityStatus("promo-test", statusDir);
    expect(status.approvalStatus).toBe("draft");

    status = await recordConfidenceRun("promo-test", 1, "run-3", opts);
    expect(status.approvalStatus).toBe("approved");
    expect(status.history).toHaveLength(3);
  });

  it("a low-confidence run resets the streak and does not count toward promotion", async () => {
    const opts = { statusDir, threshold: 0.8, requiredConsecutive: 3 };
    await recordConfidenceRun("streak-test", 1, "run-1", opts);
    await recordConfidenceRun("streak-test", 1, "run-2", opts);
    // Without this drift run, run-1/run-2 plus one more good run would already be 3 consecutive.
    // Confirm it actually resets the count, not merely fails to itself qualify.
    await recordConfidenceRun("streak-test", 0.3, "run-3", opts); // heavy drift, breaks the streak
    let status = await readCapabilityStatus("streak-test", statusDir);
    expect(status.approvalStatus).toBe("draft");

    // Two more good runs is NOT 3 consecutive -- run-3 reset the count to 0, so only run-4/run-5
    // are in the streak so far.
    await recordConfidenceRun("streak-test", 1, "run-4", opts);
    status = await recordConfidenceRun("streak-test", 1, "run-5", opts);
    expect(status.approvalStatus).toBe("draft");

    // The 3rd consecutive good run since the reset is what finally promotes it.
    status = await recordConfidenceRun("streak-test", 1, "run-6", opts);
    expect(status.approvalStatus).toBe("approved");
  });

  it("approveCapability with a reason force-approves regardless of history", async () => {
    const status = await approveCapability("override-test", { reason: "manual QA sign-off", statusDir });
    expect(status.approvalStatus).toBe("approved");
    expect(status.approvedReason).toBe("manual QA sign-off");
  });

  it("approveCapability without a reason rejects a capability that doesn't yet qualify", async () => {
    await expect(approveCapability("not-ready", { statusDir, requiredConsecutive: 3 })).rejects.toThrow(
      /does not yet qualify/,
    );
  });

  it("approveCapability without a reason succeeds once history already qualifies", async () => {
    const opts = { statusDir, threshold: 0.8, requiredConsecutive: 2 };
    await recordConfidenceRun("already-qualifies", 1, "run-1", { ...opts, requiredConsecutive: 99 });
    await recordConfidenceRun("already-qualifies", 1, "run-2", { ...opts, requiredConsecutive: 99 });
    const status = await approveCapability("already-qualifies", { statusDir, threshold: 0.8, requiredConsecutive: 2 });
    expect(status.approvalStatus).toBe("approved");
  });
});
