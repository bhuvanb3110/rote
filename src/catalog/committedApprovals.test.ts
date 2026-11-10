// Guards the committed status/ files against the gaps D15 and D24 closed: every committed artifact
// is approved, the approval names a version AND a content digest, and both are the artifact's
// current ones. If an artifact is edited -- with or without a version bump -- and not re-approved,
// this goes red here, in the same commit, instead of silently turning into a needs_human refusal at
// run time.
import { describe, expect, it } from "vitest";
import { capabilityDigest } from "../artifact/index.js";
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
    it(`${capability.id} ${capability.version}: approved for exactly this version and this content`, async () => {
      const status = await readCapabilityStatus(capability.id);
      expect(status.approvalStatus).toBe("approved");
      expect(status.approvedVersion).toBe(capability.version);
      expect(status.approvedDigest).toBe(capabilityDigest(capability));
      const decision = await checkApproval(capability, {});
      expect(decision).toEqual({
        allowed: true,
        reason: `Capability "${capability.id}" is approved for unattended replay at version ${capability.version} (content digest matches).`,
      });
    });
  }
});
