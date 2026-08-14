// Integration proof of REPORT.md §4's multi-tenant design: the SAME base member-lookup
// Capability replays to success against both tenants the mock app serves -- tenant A unmodified
// (no override at all) and tenant B via a thin per-step override -- without the artifact ever
// being re-recorded. See overrides/member-lookup.tenant-b.json for what actually differs.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../mock-app/app.js";
import { deserializeCapability, type Capability } from "../artifact/index.js";
import { runReplay } from "../replay/index.js";
import { applyTenantOverride } from "./apply.js";
import { deserializeTenantOverride } from "./types.js";

let server: Server;
let baseUrl: string;
let capability: Capability;

const CREDS = { username: "operator", password: "operator" };

async function loadJson(relativePath: string): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return readFile(path.join(here, relativePath), "utf8");
}

// The real artifact's entryUrlPattern is pinned to the fixed dev port (4100); tests run the
// mock app on an ephemeral port to stay CI-safe, so relax just the pattern -- everything else
// (steps, inputs, outputs, recognizers) is the real, unmodified artifact. Mirrors
// src/replay/replay.test.ts's loadRelaxed helper.
async function loadRelaxedCapability(): Promise<Capability> {
  const recorded = deserializeCapability(await loadJson("../../artifacts/member-lookup.json"));
  return { ...recorded, target: { ...recorded.target, entryUrlPattern: "^http://localhost:\\d+/" } };
}

async function readEvidenceEntries(evidenceRef: string): Promise<Array<Record<string, unknown>>> {
  const stripped = evidenceRef.replace("evidence://", "");
  const logPath = path.isAbsolute(stripped) ? stripped : path.join(process.cwd(), stripped);
  const log = await readFile(logPath, "utf8");
  return log
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://localhost:${port}`;
  capability = await loadRelaxedCapability();
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("member-lookup replays against multiple tenants without being re-recorded", () => {
  it("tenant A, no override: the base capability succeeds as-is against the root-mounted tenant", async () => {
    const result = await runReplay({
      capability,
      params: { ...CREDS, memberId: "10001" },
      entryUrl: baseUrl,
      headless: true,
    });
    expect(result.status).toBe("success");
    if (result.status === "success") {
      expect(String(result.outputs.savingsBalance)).toContain("4532.10");
    }
  }, 30000);

  it("tenant B, with override: the SAME base capability succeeds against /tenant-b/, same balance, and logs drift for the overridden controls", async () => {
    const override = deserializeTenantOverride(
      await loadJson("../../overrides/member-lookup.tenant-b.json"),
    );
    const effective = applyTenantOverride(capability, override);

    const result = await runReplay({
      capability: effective,
      params: { ...CREDS, memberId: "10001" },
      entryUrl: `${baseUrl}/tenant-b/`,
      headless: true,
    });

    expect(result.status).toBe("success");
    if (result.status !== "success") return;
    expect(String(result.outputs.savingsBalance)).toContain("4532.10");

    const entries = await readEvidenceEntries(result.evidenceRef);
    const driftEntries = entries.filter((e) => e.kind === "drift");

    const searchDrift = driftEntries.find(
      (e) => (e.detail as Record<string, unknown>).stepId === "step-05",
    );
    expect(searchDrift).toBeDefined();
    expect((searchDrift!.detail as Record<string, unknown>).expectedStrategy).toBe("roleName");
    expect((searchDrift!.detail as Record<string, unknown>).actualStrategy).toBe("css");

    const balanceDrift = driftEntries.find(
      (e) => (e.detail as Record<string, unknown>).stepId === "step-06",
    );
    expect(balanceDrift).toBeDefined();
    expect((balanceDrift!.detail as Record<string, unknown>).expectedStrategy).toBe("labelText");
    expect((balanceDrift!.detail as Record<string, unknown>).actualStrategy).toBe("tableCell");
  }, 30000);

  it("tenant B without the override would fail: the base capability alone can't find 'Search' or the old balance label", async () => {
    const result = await runReplay({
      capability, // no override applied -- deliberately reusing the base descriptors on tenant B
      params: { ...CREDS, memberId: "10001" },
      entryUrl: `${baseUrl}/tenant-b/`,
      headless: true,
    });
    // "Search" doesn't exist on tenant B (it's "Find Member"), and the base target has no
    // fallback strategy at all -- locate() falls through to the unusable "visual" stub and the
    // click throws, landing here as an unrecognized-state failure.
    expect(result.status).toBe("failure");
  }, 30000);
});
