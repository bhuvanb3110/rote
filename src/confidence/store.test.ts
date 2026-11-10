import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  approveCapability,
  consecutiveQualifyingRuns,
  isApprovalCurrent,
  readCapabilityStatus,
  recordConfidenceRun,
} from "./store.js";
import type { ConfidenceRunRecord } from "./types.js";

const V1 = "1.0.0";
const V2 = "1.1.0";

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
    const opts = { version: V1, statusDir, threshold: 0.8, requiredConsecutive: 3 };
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
    const opts = { version: V1, statusDir, threshold: 0.8, requiredConsecutive: 3 };
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
    const status = await approveCapability("override-test", { version: V1, reason: "manual QA sign-off", statusDir });
    expect(status.approvalStatus).toBe("approved");
    expect(status.approvedReason).toBe("manual QA sign-off");
  });

  it("approveCapability without a reason rejects a capability that doesn't yet qualify", async () => {
    await expect(approveCapability("not-ready", { version: V1, statusDir, requiredConsecutive: 3 })).rejects.toThrow(
      /does not yet qualify/,
    );
  });

  it("approveCapability without a reason succeeds once history already qualifies", async () => {
    const opts = { version: V1, statusDir, threshold: 0.8, requiredConsecutive: 2 };
    await recordConfidenceRun("already-qualifies", 1, "run-1", { ...opts, requiredConsecutive: 99 });
    await recordConfidenceRun("already-qualifies", 1, "run-2", { ...opts, requiredConsecutive: 99 });
    const status = await approveCapability("already-qualifies", {
      version: V1,
      statusDir,
      threshold: 0.8,
      requiredConsecutive: 2,
    });
    expect(status.approvalStatus).toBe("approved");
  });
});

describe("approvals are bound to the artifact version (docs/DECISIONS.md D15)", () => {
  let statusDir: string;

  beforeEach(async () => {
    statusDir = await mkdtemp(path.join(tmpdir(), "confidence-version-test-"));
  });

  afterEach(async () => {
    await rm(statusDir, { recursive: true, force: true });
  });

  it("auto-promotion records the promoted version as approvedVersion, and each run records its version", async () => {
    const opts = { version: V2, statusDir, threshold: 0.8, requiredConsecutive: 2 };
    await recordConfidenceRun("auto-version", 1, "run-1", opts);
    const status = await recordConfidenceRun("auto-version", 1, "run-2", opts);
    expect(status.approvalStatus).toBe("approved");
    expect(status.approvedVersion).toBe(V2);
    expect(status.approvedReason).toMatch(/runs of 1\.1\.0/);
    expect(status.history.map((run) => run.version)).toEqual([V2, V2]);

    // And it is on disk, not just in the returned object.
    const onDisk = JSON.parse(await readFile(path.join(statusDir, "auto-version.json"), "utf8"));
    expect(onDisk.approvedVersion).toBe(V2);
  });

  it("manual approval (with a reason) records approvedVersion", async () => {
    const status = await approveCapability("manual-version", { version: V2, reason: "QA sign-off", statusDir });
    expect(status.approvedVersion).toBe(V2);
    expect((await readCapabilityStatus("manual-version", statusDir)).approvedVersion).toBe(V2);
  });

  it("manual approval without a reason records the version its history qualified for", async () => {
    const opts = { version: V2, statusDir, threshold: 0.8, requiredConsecutive: 99 };
    await recordConfidenceRun("manual-auto", 1, "run-1", opts);
    await recordConfidenceRun("manual-auto", 1, "run-2", opts);
    const status = await approveCapability("manual-auto", { version: V2, statusDir, requiredConsecutive: 2 });
    expect(status.approvedVersion).toBe(V2);
  });

  it("runs of another version never count toward promoting this one", async () => {
    const v1 = { version: V1, statusDir, threshold: 0.8, requiredConsecutive: 99 };
    await recordConfidenceRun("mixed", 1, "run-1", v1);
    await recordConfidenceRun("mixed", 1, "run-2", v1);
    // Two qualifying 1.0.0 runs are not two qualifying 1.1.0 runs.
    await expect(approveCapability("mixed", { version: V2, statusDir, requiredConsecutive: 2 })).rejects.toThrow(
      /1\.1\.0 does not yet qualify.*0\/2/,
    );
    // One 1.1.0 run after them is a streak of 1, not 3.
    const status = await recordConfidenceRun("mixed", 1, "run-3", { ...v1, version: V2, requiredConsecutive: 2 });
    expect(status.approvalStatus).toBe("draft");
    expect(consecutiveQualifyingRuns(status.history, 0.8, V2)).toBe(1);
    expect(consecutiveQualifyingRuns(status.history, 0.8)).toBe(3); // version-blind count unchanged
  });

  it("a stale approval (another version) does not stop runs being recorded, and re-promotes for the new version", async () => {
    await approveCapability("stale", { version: V1, reason: "approved at 1.0.0", statusDir });
    const opts = { version: V2, statusDir, threshold: 0.8, requiredConsecutive: 2 };
    let status = await recordConfidenceRun("stale", 1, "run-1", opts);
    expect(status.approvedVersion).toBe(V1); // still the old approval
    expect(status.history).toHaveLength(1);
    status = await recordConfidenceRun("stale", 1, "run-2", opts);
    expect(status.approvedVersion).toBe(V2);
  });

  it("a current approval is left untouched by further runs (no write)", async () => {
    await approveCapability("current", { version: V2, reason: "approved", statusDir });
    const before = await readFile(path.join(statusDir, "current.json"), "utf8");
    await recordConfidenceRun("current", 1, "run-1", { version: V2, statusDir });
    expect(await readFile(path.join(statusDir, "current.json"), "utf8")).toBe(before);
  });

  it("an old status file with no approvedVersion and unversioned history still parses, and counts as current (grandfathered)", async () => {
    await writeFile(
      path.join(statusDir, "old.json"),
      JSON.stringify({
        capabilityId: "old",
        approvalStatus: "approved",
        history: [{ runId: "r1", confidence: 1, at: "2026-09-03T20:53:01.785Z" }],
        approvedAt: "2026-09-03T20:53:01.785Z",
        approvedReason: "Grandfathered",
      }),
    );
    const status = await readCapabilityStatus("old", statusDir);
    expect(status.approvedVersion).toBeUndefined();
    expect(isApprovalCurrent(status, V1)).toBe(true);
    expect(isApprovalCurrent(status, V2)).toBe(true);
    expect(isApprovalCurrent({ ...status, approvedVersion: V1 }, V2)).toBe(false);
    expect(isApprovalCurrent({ ...status, approvalStatus: "draft" }, V1)).toBe(false);
  });

  it("rejects a non-semver approvedVersion", async () => {
    await writeFile(
      path.join(statusDir, "bad.json"),
      JSON.stringify({ capabilityId: "bad", approvalStatus: "approved", history: [], approvedVersion: "latest" }),
    );
    await expect(readCapabilityStatus("bad", statusDir)).rejects.toThrow(/schema validation/);
  });
});
