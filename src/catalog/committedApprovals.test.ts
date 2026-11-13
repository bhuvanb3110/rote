// Guards the committed status/ files against the gaps D15 and D24 closed: every committed artifact
// is approved, the approval names a version AND a content digest, and both are the artifact's
// current ones. If an artifact is edited -- with or without a version bump -- and not re-approved,
// this goes red here, in the same commit, instead of silently turning into a needs_human refusal at
// run time.
import { describe, expect, it } from "vitest";
import { capabilityDigest } from "../artifact/index.js";
import { loadCapabilities } from "./registry.js";
import { checkApproval, readCapabilityStatus } from "../confidence/index.js";
import { DEFAULT_OVERRIDES_DIR, resolveTenant, tenantOverrideDigests } from "../tenant/index.js";

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

    // D30: the approval names every committed override file of the capability, by digest, and no
    // other. An override edited (or added) without a re-approval goes red here.
    it(`${capability.id}: approved for exactly its committed tenant overrides`, async () => {
      const status = await readCapabilityStatus(capability.id);
      const onDisk = await tenantOverrideDigests(capability.id, DEFAULT_OVERRIDES_DIR);
      expect(status.approvedOverrideDigests).toEqual(onDisk);
      for (const tenant of Object.keys(onDisk)) {
        const { override } = await resolveTenant(capability, tenant, "http://unused");
        const decision = await checkApproval(capability, { tenantOverride: override });
        expect(decision).toEqual({
          allowed: true,
          reason:
            `Capability "${capability.id}" is approved for unattended replay at version ${capability.version} ` +
            `(content digest matches). Tenant "${tenant}" override digest matches.`,
        });
      }
    });
  }

  it("Step 9: the verify's lookup is approved at 1.2.0 (firstMatchRef, BANK_UNAVAILABLE) with all three tenant overrides", async () => {
    const lookup = capabilities.find((c) => c.id === "transfer-history-lookup")!;
    expect(lookup.version).toBe("1.2.0");
    expect(lookup.outputs.map((o) => o.name)).toEqual(["matchingCount", "firstMatchRef"]);
    const status = await readCapabilityStatus(lookup.id);
    expect(status.approvedVersion).toBe("1.2.0");
    expect(status.approvedDigest).toBe(capabilityDigest(lookup));
    expect(Object.keys(status.approvedOverrideDigests ?? {})).toEqual(["tenant-a", "tenant-b", "tenant-c"]);
    expect(status.approvedOverrideDigests).toEqual(await tenantOverrideDigests(lookup.id, DEFAULT_OVERRIDES_DIR));
    expect(status.approvedReason).toMatch(/evidence\/transfer-history-lookup-1\.2\.0\//);
  });

  it("the committed overrides are the ones the fleet runs: transfer and the lookup on tenants a/b/c", async () => {
    for (const id of ["transfer", "transfer-history-lookup", "member-lookup"]) {
      expect(Object.keys(await tenantOverrideDigests(id, DEFAULT_OVERRIDES_DIR))).toEqual(["tenant-a", "tenant-b", "tenant-c"]);
    }
  });
});
