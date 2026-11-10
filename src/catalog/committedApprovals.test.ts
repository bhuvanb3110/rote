// Guards the committed status/ files against the gap D15 closed: every committed artifact is
// approved, the approval names a version, and that version is the artifact's current version. If
// an artifact is edited and its version bumped without a re-approval, this goes red here, in the
// same commit, instead of silently turning into a needs_human refusal at run time.
import { describe, expect, it } from "vitest";
import { loadCapabilities } from "./registry.js";
import { checkApproval, readCapabilityStatus } from "../confidence/index.js";

describe("committed approvals (status/) match the committed artifacts (artifacts/)", async () => {
  const capabilities = await loadCapabilities();

  it("finds the committed artifacts", () => {
    expect(capabilities.map((c) => c.id).sort()).toEqual([
      "member-lookup",
      "open-sub-account",
      "open-sub-account-confirmed",
      "transfer",
      "transfer-history-lookup",
    ]);
  });

  for (const capability of capabilities) {
    it(`${capability.id} ${capability.version}: approved for exactly this version`, async () => {
      const status = await readCapabilityStatus(capability.id);
      expect(status.approvalStatus).toBe("approved");
      expect(status.approvedVersion).toBe(capability.version);
      const decision = await checkApproval(capability.id, capability.version, {});
      expect(decision).toEqual({
        allowed: true,
        reason: `Capability "${capability.id}" is approved for unattended replay at version ${capability.version}.`,
      });
    });
  }
});
