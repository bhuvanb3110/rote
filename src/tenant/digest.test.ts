// tenantOverrideDigest / tenantOverrideDigests (docs/DECISIONS.md D30): formatting never changes the
// digest, any value does; the directory scan keeps capabilities apart and refuses a file whose name
// and content disagree.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deserializeTenantOverride } from "./types.js";
import { tenantOverrideDigest, tenantOverrideDigests } from "./digest.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "override-digest-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function committed(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join("overrides", name), "utf8"));
}

describe("tenantOverrideDigest", () => {
  it("is 64 hex chars and ignores key order, whitespace and CRLF", async () => {
    const raw = await committed("transfer.tenant-b.json");
    const a = tenantOverrideDigest(deserializeTenantOverride(JSON.stringify(raw)));
    const reordered = Object.fromEntries(Object.entries(raw).reverse());
    const b = tenantOverrideDigest(deserializeTenantOverride(JSON.stringify(reordered, null, "\t").replace(/\n/g, "\r\n")));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it("changes when any value changes (a locator's name, the entry URL)", async () => {
    const raw = await committed("transfer.tenant-b.json");
    const base = tenantOverrideDigest(deserializeTenantOverride(JSON.stringify(raw)));
    const url = tenantOverrideDigest(deserializeTenantOverride(JSON.stringify({ ...raw, entryUrl: "http://localhost:4100/x/" })));
    const firstStep = Object.keys(raw.stepOverrides as object)[0]!;
    const edited = structuredClone(raw) as { stepOverrides: Record<string, { describedAs: string }> };
    edited.stepOverrides[firstStep]!.describedAs += " (edited)";
    const locator = tenantOverrideDigest(deserializeTenantOverride(JSON.stringify(edited)));
    expect(new Set([base, url, locator]).size).toBe(3);
  });
});

describe("tenantOverrideDigests(capabilityId, dir)", () => {
  it("maps every override file of exactly this capability to its digest", async () => {
    for (const name of ["transfer.tenant-a.json", "transfer.tenant-b.json", "transfer-history-lookup.tenant-a.json"]) {
      await writeFile(path.join(dir, name), JSON.stringify(await committed(name)));
    }
    const digests = await tenantOverrideDigests("transfer", dir);
    expect(Object.keys(digests)).toEqual(["tenant-a", "tenant-b"]);
    expect(digests["tenant-b"]).toBe(tenantOverrideDigest(deserializeTenantOverride(JSON.stringify(await committed("transfer.tenant-b.json")))));
    expect(Object.keys(await tenantOverrideDigests("transfer-history-lookup", dir))).toEqual(["tenant-a"]);
  });

  it("does not read open-sub-account-confirmed's files as open-sub-account's", async () => {
    const raw = { ...(await committed("transfer.tenant-a.json")), capabilityId: "open-sub-account-confirmed" };
    await writeFile(path.join(dir, "open-sub-account-confirmed.tenant-a.json"), JSON.stringify(raw));
    expect(await tenantOverrideDigests("open-sub-account", dir)).toEqual({});
  });

  it("refuses a file whose name and content name different tenants", async () => {
    await writeFile(path.join(dir, "transfer.tenant-z.json"), JSON.stringify(await committed("transfer.tenant-a.json")));
    await expect(tenantOverrideDigests("transfer", dir)).rejects.toThrow(/file name says transfer\/tenant-z, content says transfer\/tenant-a/);
  });

  it("a missing directory means no overrides", async () => {
    expect(await tenantOverrideDigests("transfer", path.join(dir, "nope"))).toEqual({});
  });
});
