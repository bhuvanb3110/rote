// Proves the three required catalog behaviors: list() derives schema-accurate typed contracts
// straight from the real on-disk artifacts; invoke() with valid params succeeds via the REAL
// replay path (mock app on an ephemeral port, same pattern as tenant/multiTenant.test.ts); and
// invoke() rejects an invalid/missing param before any browser is ever launched.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../mock-app/app.js";
import { listCapabilities } from "./registry.js";
import { invokeCapability } from "./invoke.js";

describe("catalog list() derives typed contracts from the real artifacts on disk", () => {
  it("lists all saved capabilities with schema-accurate inputSchema/outputSchema", async () => {
    const entries = await listCapabilities({ artifactsDir: "artifacts" });
    const ids = entries.map((entry) => entry.id).sort();
    expect(ids).toEqual(["member-lookup", "open-sub-account", "open-sub-account-confirmed"].sort());

    const memberLookup = entries.find((entry) => entry.id === "member-lookup")!;
    expect(memberLookup.name).toBe("Member Lookup");
    expect(memberLookup.inputSchema.required).toEqual(
      expect.arrayContaining(["username", "password", "memberId"]),
    );
    const properties = memberLookup.inputSchema.properties as Record<string, { type: string }>;
    expect(properties.username.type).toBe("string");
    expect(properties.memberId.type).toBe("string");

    const outputProperties = memberLookup.outputSchema.properties as Record<string, { type: string }>;
    expect(outputProperties.savingsBalance.type).toBe("string");
  });
});

describe("catalog invoke() calls the real replay path", () => {
  let server: Server;
  let baseUrl: string;
  let tempArtifactsDir: string;

  beforeAll(async () => {
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as AddressInfo;
    baseUrl = `http://localhost:${port}`;

    // Same relax trick as tenant/multiTenant.test.ts: the real artifact's entryUrlPattern is
    // pinned to the fixed dev port, tests run on an ephemeral one to stay CI-safe. invoke() loads
    // by id from an artifactsDir, so the relaxed copy has to actually exist on disk.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const recorded = JSON.parse(await readFile(path.join(here, "../../artifacts/member-lookup.json"), "utf8"));
    const relaxed = {
      ...recorded,
      target: { ...recorded.target, entryUrlPattern: "^http://localhost:\\d+/" },
    };
    tempArtifactsDir = await mkdtemp(path.join(tmpdir(), "catalog-test-"));
    await writeFile(path.join(tempArtifactsDir, "member-lookup.json"), JSON.stringify(relaxed, null, 2));
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(tempArtifactsDir, { recursive: true, force: true });
  });

  it("succeeds with valid params via the real replay path", async () => {
    const result = await invokeCapability({
      id: "member-lookup",
      params: { username: "operator", password: "operator", memberId: "10001" },
      entryUrl: baseUrl,
      artifactsDir: tempArtifactsDir,
      headless: true,
    });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(String(result.outputs.savingsBalance)).toContain("4532.10");
    }
  }, 30000);

  it("rejects a missing required param before touching a browser", async () => {
    await expect(
      invokeCapability({
        id: "member-lookup",
        params: { username: "operator" },
        entryUrl: baseUrl,
        artifactsDir: tempArtifactsDir,
        headless: true,
      }),
    ).rejects.toThrow(/password|memberId/);
  });

  it("rejects invoking an unknown capability id before touching a browser", async () => {
    await expect(
      invokeCapability({
        id: "does-not-exist",
        params: {},
        artifactsDir: tempArtifactsDir,
      }),
    ).rejects.toThrow(/No capability with id/);
  });
});
