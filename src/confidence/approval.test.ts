// checkApproval is bound to the artifact version (docs/DECISIONS.md D15): match, mismatch,
// missing (grandfathered), draft and the per-run approveUnattended opt-in.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkApproval } from "./approval.js";
import { approveCapability } from "./store.js";

let statusDir: string;

beforeEach(async () => {
  statusDir = await mkdtemp(path.join(tmpdir(), "approval-gate-test-"));
});

afterEach(async () => {
  await rm(statusDir, { recursive: true, force: true });
});

describe("checkApproval(capabilityId, version)", () => {
  it("match: approved for 1.1.0, artifact is 1.1.0 -> allowed", async () => {
    await approveCapability("cap", { version: "1.1.0", reason: "ok", statusDir });
    const decision = await checkApproval("cap", "1.1.0", { statusDir });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toMatch(/approved for unattended replay at version 1\.1\.0/);
  });

  it("mismatch: approved for 1.0.0, artifact is 1.1.0 -> not allowed, says re-approve", async () => {
    await approveCapability("cap", { version: "1.0.0", reason: "ok", statusDir });
    const decision = await checkApproval("cap", "1.1.0", { statusDir });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("approved for 1.0.0, artifact is 1.1.0; re-approve");
  });

  it("mismatch also refuses a DOWNGRADE (approved for 1.1.0, artifact is 1.0.0)", async () => {
    await approveCapability("cap", { version: "1.1.0", reason: "ok", statusDir });
    const decision = await checkApproval("cap", "1.0.0", { statusDir });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("approved for 1.1.0, artifact is 1.0.0; re-approve");
  });

  it("missing approvedVersion (grandfathered) -> allowed, and the reason says it is grandfathered", async () => {
    await writeFile(
      path.join(statusDir, "cap.json"),
      JSON.stringify({
        capabilityId: "cap",
        approvalStatus: "approved",
        history: [],
        approvedAt: "2026-09-03T20:53:01.785Z",
        approvedReason: "Grandfathered: pre-existing artifact",
      }),
    );
    const decision = await checkApproval("cap", "1.0.0", { statusDir });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toMatch(/grandfathered/);
    expect(decision.reason).toMatch(/no approvedVersion/);
    expect(decision.reason).toMatch(/artifact is 1\.0\.0/);
  });

  it("draft (no status file) -> not allowed", async () => {
    const decision = await checkApproval("never-seen", "1.0.0", { statusDir });
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/draft/);
  });

  it("approveUnattended allows a stale approval for this one run, without reading status", async () => {
    await approveCapability("cap", { version: "1.0.0", reason: "ok", statusDir });
    const decision = await checkApproval("cap", "1.1.0", { statusDir, approveUnattended: true });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toMatch(/approveUnattended/);
  });
});
