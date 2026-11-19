// Integration proof that the approval gate and confidence scoring are wired into the REAL replay
// path, not just unit-tested in isolation -- mirrors replay.test.ts's mock-app-on-ephemeral-port
// setup. Uses a fresh test-only capability id throughout so this never touches the real,
// grandfathered status/member-lookup.json.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import app from "../../mock-app/app.js";
import { deserializeCapability, type Capability } from "../artifact/index.js";
import { deserializeTenantOverride } from "../tenant/types.js";
import { applyTenantOverride } from "../tenant/apply.js";
import { approvalKey, approveCapability, readCapabilityStatus } from "../confidence/index.js";
import { runReplay } from "./replay.js";
import { listenOnSafePort } from "../testing/listen.js";

const FRESH_ID = "confidence-gate-test";
const CREDS = { username: "operator", password: "operator" };

let server: Server;
let baseUrl: string;
let baseCapability: Capability;
let statusDir: string;

async function loadJson(relativePath: string): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return readFile(path.join(here, relativePath), "utf8");
}

beforeAll(async () => {
  server = createServer(app);
  await listenOnSafePort(server); // never a port Chromium/fetch refuse (D31)
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://localhost:${port}`;

  const recorded = deserializeCapability(await loadJson("../../artifacts/member-lookup.json"));
  baseCapability = {
    ...recorded,
    id: FRESH_ID,
    target: { ...recorded.target, entryUrlPattern: "^http://localhost:\\d+/" },
  };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  if (statusDir) await rm(statusDir, { recursive: true, force: true });
});

describe("approval gate + confidence scoring, wired into the real replay path", () => {
  it("a fresh draft capability refuses unattended replay before any browser launches", async () => {
    statusDir = await mkdtemp(path.join(tmpdir(), "confidence-gate-test-"));
    const result = await runReplay({
      capability: baseCapability,
      params: { ...CREDS, memberId: "10001" },
      entryUrl: baseUrl,
      headless: true,
      statusDir,
    });
    expect(result.status).toBe("needs_human");
    if (result.status === "needs_human") {
      expect(result.reason).toMatch(/draft/);
    }
  });

  it("N consecutive high-confidence runs promote a draft capability, which then replays unattended without the flag", async () => {
    statusDir = await mkdtemp(path.join(tmpdir(), "confidence-gate-test-"));

    for (let i = 0; i < 3; i += 1) {
      const result = await runReplay({
        capability: baseCapability,
        params: { ...CREDS, memberId: "10001" },
        entryUrl: baseUrl,
        headless: true,
        statusDir,
        approveUnattended: true, // bootstrapping: a human opts each run in while it's unproven
      });
      expect(result.status).toBe("success");
    }

    const status = await readCapabilityStatus(FRESH_ID, statusDir);
    expect(status.approvalStatus).toBe("approved");
    expect(status.history.every((run) => run.confidence === 1)).toBe(true);

    // Now approved: no approveUnattended needed.
    const result = await runReplay({
      capability: baseCapability,
      params: { ...CREDS, memberId: "10001" },
      entryUrl: baseUrl,
      headless: true,
      statusDir,
    });
    expect(result.status).toBe("success");
  }, 60000);

  it("a low-confidence (hostile-DOM) run computes confidence 0 and does not count toward promotion", async () => {
    statusDir = await mkdtemp(path.join(tmpdir(), "confidence-gate-test-"));

    const override = deserializeTenantOverride(await loadJson("../../overrides/member-lookup.tenant-c.json"));
    const hostileCapability: Capability = {
      ...applyTenantOverride({ ...baseCapability, id: "member-lookup" }, override),
      id: FRESH_ID,
    };

    const result = await runReplay({
      capability: hostileCapability,
      params: { ...CREDS, memberId: "10001" },
      entryUrl: `${baseUrl}/tenant-c/`,
      headless: true,
      statusDir,
      approveUnattended: true,
    });
    expect(result.status).toBe("success");

    const status = await readCapabilityStatus(FRESH_ID, statusDir);
    expect(status.approvalStatus).toBe("draft");
    expect(status.history).toHaveLength(1);
    expect(status.history[0]!.confidence).toBe(0);
  }, 30000);

  it("an approval for another version refuses unattended replay before any browser launches (D15)", async () => {
    statusDir = await mkdtemp(path.join(tmpdir(), "confidence-gate-test-"));
    const v100: Capability = { ...baseCapability, version: "1.0.0" };
    await approveCapability(FRESH_ID, { ...approvalKey(v100), reason: "approved at 1.0.0", statusDir });
    const edited: Capability = { ...baseCapability, version: "1.1.0" };

    const refused = await runReplay({
      capability: edited,
      params: { ...CREDS, memberId: "10001" },
      entryUrl: baseUrl,
      headless: true,
      statusDir,
    });
    expect(refused.status).toBe("needs_human");
    if (refused.status === "needs_human") {
      expect(refused.reason).toContain("approved for 1.0.0, artifact is 1.1.0; re-approve");
      expect(refused.atStepId).toBe(edited.steps[0]!.id);
    }

    // Re-approving for 1.1.0 lets the same artifact run, with no approveUnattended.
    await approveCapability(FRESH_ID, { ...approvalKey(edited), reason: "re-approved at 1.1.0", statusDir });
    const allowed = await runReplay({
      capability: edited,
      params: { ...CREDS, memberId: "10001" },
      entryUrl: baseUrl,
      headless: true,
      statusDir,
    });
    expect(allowed.status).toBe("success");
  }, 30000);

  it("a content change with the SAME version is refused before any browser launches (D24)", async () => {
    statusDir = await mkdtemp(path.join(tmpdir(), "confidence-gate-test-"));
    await approveCapability(FRESH_ID, { ...approvalKey(baseCapability), reason: "approved this content", statusDir });
    // Same id, same version, one step's intent text edited: a different artifact.
    const edited: Capability = {
      ...baseCapability,
      steps: baseCapability.steps.map((s, i) => (i === 0 ? { ...s, intent: `${s.intent} (edited)` } : s)),
    };
    expect(edited.version).toBe(baseCapability.version);

    const refused = await runReplay({
      capability: edited,
      params: { ...CREDS, memberId: "10001" },
      entryUrl: baseUrl,
      headless: true,
      statusDir,
    });
    expect(refused.status).toBe("needs_human");
    if (refused.status === "needs_human") {
      expect(refused.reason).toContain("artifact content changed since approval; re-approve");
    }

    // The approved content itself still runs.
    const allowed = await runReplay({
      capability: baseCapability,
      params: { ...CREDS, memberId: "10001" },
      entryUrl: baseUrl,
      headless: true,
      statusDir,
    });
    expect(allowed.status).toBe("success");
  }, 30000);

  it("auto-promotion through real runs records the replayed artifact's version (D15)", async () => {
    statusDir = await mkdtemp(path.join(tmpdir(), "confidence-gate-test-"));
    const v = { ...baseCapability, version: "2.3.4" };
    for (let i = 0; i < 3; i += 1) {
      const result = await runReplay({
        capability: v,
        params: { ...CREDS, memberId: "10001" },
        entryUrl: baseUrl,
        headless: true,
        statusDir,
        approveUnattended: true,
      });
      expect(result.status).toBe("success");
    }
    const status = await readCapabilityStatus(FRESH_ID, statusDir);
    expect(status.approvalStatus).toBe("approved");
    expect(status.approvedVersion).toBe("2.3.4");
    expect(status.history.every((run) => run.version === "2.3.4")).toBe(true);
  }, 60000);
});
