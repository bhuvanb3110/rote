// Approvals cover tenant overrides (docs/DECISIONS.md D30; Step 7 reviewer decision A1). Built on
// copies of the committed transfer artifact and its three overrides in a temp dir:
//   - every approved tenant runs; editing ONE override refuses that tenant only, the others are
//     unaffected; a new override file that was never approved is refused;
//   - a status without approvedOverrideDigests is grandfathered (allowed, and the reason says so);
//   - an approval written without overrides approves none of them (fail closed);
//   - through invokeCapability the refusal is a needs_human result before any browser is launched.
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deserializeCapability, type Capability } from "../artifact/index.js";
import { invokeCapability } from "../catalog/invoke.js";
import { resolveTenant, tenantOverrideDigest, type TenantOverride } from "../tenant/index.js";
import { checkApproval } from "./approval.js";
import { approvalKey, approvalKeyWithOverrides, approveCapability, isApprovalCurrent, readCapabilityStatus } from "./store.js";
import { serializeCapabilityStatus } from "./types.js";

const TENANTS = ["tenant-a", "tenant-b", "tenant-c"] as const;

let work: string;
let artifactsDir: string;
let overridesDir: string;
let statusDir: string;
let transfer: Capability;

async function overrideOf(tenant: string): Promise<TenantOverride> {
  const resolved = await resolveTenant(transfer, tenant, "http://unused", overridesDir);
  return resolved.override!;
}

async function decide(tenant: string) {
  return checkApproval(transfer, { statusDir, tenantOverride: await overrideOf(tenant) });
}

async function editOverride(tenant: string, mutate: (o: Record<string, any>) => void): Promise<void> {
  const file = path.join(overridesDir, `transfer.${tenant}.json`);
  const raw = JSON.parse(await readFile(file, "utf8"));
  mutate(raw);
  await writeFile(file, JSON.stringify(raw, null, 2));
}

beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "override-approval-"));
  artifactsDir = path.join(work, "artifacts");
  overridesDir = path.join(work, "overrides");
  statusDir = path.join(work, "status");
  await Promise.all([artifactsDir, overridesDir, statusDir].map((d) => mkdir(d)));
  await copyFile(path.join("artifacts", "transfer.json"), path.join(artifactsDir, "transfer.json"));
  for (const tenant of TENANTS) {
    await copyFile(path.join("overrides", `transfer.${tenant}.json`), path.join(overridesDir, `transfer.${tenant}.json`));
  }
  transfer = deserializeCapability(await readFile(path.join(artifactsDir, "transfer.json"), "utf8"));
  await approveCapability("transfer", { ...(await approvalKeyWithOverrides(transfer, overridesDir)), statusDir, reason: "test" });
});

afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

describe("approvals bound to tenant overrides (D30)", () => {
  it("records one digest per override file and allows every approved tenant", async () => {
    const status = await readCapabilityStatus("transfer", statusDir);
    expect(Object.keys(status.approvedOverrideDigests ?? {})).toEqual([...TENANTS]);
    for (const tenant of TENANTS) {
      expect(status.approvedOverrideDigests![tenant]).toBe(tenantOverrideDigest(await overrideOf(tenant)));
      expect(await decide(tenant)).toEqual({
        allowed: true,
        reason: `Capability "transfer" is approved for unattended replay at version 1.1.0 (content digest matches). Tenant "${tenant}" override digest matches.`,
      });
    }
  });

  it("an edited override is refused for THAT tenant only; the other tenants are unaffected", async () => {
    const approvedB = tenantOverrideDigest(await overrideOf("tenant-b"));
    await editOverride("tenant-b", (o) => {
      o.stepOverrides["step-05"].strategies[0].name = "Find Member Now";
    });
    const b = await decide("tenant-b");
    expect(b.allowed).toBe(false);
    expect(b.reason).toContain(`tenant override for "tenant-b" changed since approval; re-approve`);
    expect(b.reason).toContain(`Approved override digest ${approvedB}`);
    expect((await decide("tenant-a")).allowed).toBe(true);
    expect((await decide("tenant-c")).allowed).toBe(true);
    // The base artifact itself is still approved (a run without a tenant).
    expect((await checkApproval(transfer, { statusDir })).allowed).toBe(true);
  });

  it("a formatting-only rewrite of an override (key order, tabs, CRLF) is still allowed", async () => {
    const file = path.join(overridesDir, "transfer.tenant-c.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    await writeFile(file, JSON.stringify(Object.fromEntries(Object.entries(raw).reverse()), null, "\t").replace(/\n/g, "\r\n"));
    expect((await decide("tenant-c")).allowed).toBe(true);
  });

  it("an override file that exists but was not approved is refused", async () => {
    const raw = JSON.parse(await readFile(path.join(overridesDir, "transfer.tenant-a.json"), "utf8"));
    await writeFile(path.join(overridesDir, "transfer.tenant-d.json"), JSON.stringify({ ...raw, tenantId: "tenant-d" }));
    const d = await decide("tenant-d");
    expect(d.allowed).toBe(false);
    expect(d.reason).toContain(`tenant override for "tenant-d" exists but was not approved (the approval covers: tenant-a, tenant-b, tenant-c)`);
  });

  it("re-approving binds the edited override, and the tenant runs again", async () => {
    await editOverride("tenant-b", (o) => {
      o.entryUrl = "http://localhost:4100/tenant-b/?v=2";
    });
    expect((await decide("tenant-b")).allowed).toBe(false);
    const key = await approvalKeyWithOverrides(transfer, overridesDir);
    expect(isApprovalCurrent(await readCapabilityStatus("transfer", statusDir), key)).toBe(false);
    await approveCapability("transfer", { ...key, statusDir, reason: "re-approved after the tenant-b edit" });
    expect((await decide("tenant-b")).allowed).toBe(true);
  });

  it("a status with no approvedOverrideDigests is grandfathered: allowed, and the reason says the override was not checked", async () => {
    const status = await readCapabilityStatus("transfer", statusDir);
    delete status.approvedOverrideDigests;
    await writeFile(path.join(statusDir, "transfer.json"), serializeCapabilityStatus(status));
    await editOverride("tenant-b", (o) => {
      o.entryUrl = "http://localhost:4100/tenant-b/?edited";
    });
    const b = await decide("tenant-b");
    expect(b.allowed).toBe(true);
    expect(b.reason).toContain(`records no approvedOverrideDigests (it predates override-bound approvals), so tenant "tenant-b"'s override was not checked (grandfathered)`);
  });

  it("an approval written without overrides (e.g. auto-promotion) approves none: tenant runs refused, base runs allowed", async () => {
    await approveCapability("transfer", { ...approvalKey(transfer), statusDir, reason: "base only" });
    expect((await readCapabilityStatus("transfer", statusDir)).approvedOverrideDigests).toEqual({});
    const a = await decide("tenant-a");
    expect(a.allowed).toBe(false);
    expect(a.reason).toContain(`exists but was not approved (the approval covers: no overrides)`);
    expect((await checkApproval(transfer, { statusDir })).allowed).toBe(true);
  });

  it("refuses to check an override of another capability (a caller bug, not a decision)", async () => {
    const other = { ...(await overrideOf("tenant-a")), capabilityId: "member-lookup" };
    await expect(checkApproval(transfer, { statusDir, tenantOverride: other })).rejects.toThrow(/for capability "member-lookup", not "transfer"/);
  });

  it("through invokeCapability: the edited tenant gets needs_human before any browser is launched", async () => {
    await editOverride("tenant-b", (o) => {
      o.stepOverrides["step-05"].describedAs = "Find Member button (edited)";
    });
    const result = await invokeCapability({
      id: "transfer",
      tenant: "tenant-b",
      params: { username: "operator", password: "operator", memberId: "10001", toMemberId: "10002", amount: "1.00", memo: "m" },
      artifactsDir,
      overridesDir,
      statusDir,
      evidenceBaseDir: path.join(work, "evidence"),
      approveRisky: true,
    });
    expect(result.status).toBe("needs_human");
    if (result.status === "needs_human") {
      expect(result.reason).toContain(`tenant override for "tenant-b" changed since approval`);
      expect(result.atStepId).toBe(transfer.steps[0]!.id);
    }
  });
});
