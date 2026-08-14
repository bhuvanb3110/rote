import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../mock-app/app.js";
import { deserializeCapability, type Capability } from "../artifact/index.js";
import { runReplay } from "./replay.js";

let server: Server;
let baseUrl: string;
let capability: Capability;

const CREDS = { username: "operator", password: "operator" };

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://localhost:${port}`;

  const here = path.dirname(fileURLToPath(import.meta.url));
  const artifactPath = path.join(here, "../../artifacts/member-lookup.json");
  const recorded = deserializeCapability(await readFile(artifactPath, "utf8"));
  // The real artifact's entryUrlPattern is pinned to the fixed dev port (4100); tests run the
  // mock app on an ephemeral port to stay CI-safe, so relax just the pattern -- everything else
  // (steps, inputs, outputs, recognizers) is the real, unmodified artifact.
  capability = { ...recorded, target: { ...recorded.target, entryUrlPattern: "^http://localhost:\\d+/" } };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("replay against the mock app", () => {
  it("(a) happy path: succeeds and returns the savings balance", async () => {
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

  it("(b) business outcome: unknown member returns NO_SUCH_MEMBER, not a failure", async () => {
    const result = await runReplay({
      capability,
      params: { ...CREDS, memberId: "99999" },
      entryUrl: baseUrl,
      headless: true,
    });
    expect(result.status).toBe("business_outcome");
    if (result.status === "business_outcome") {
      expect(result.code).toBe("NO_SUCH_MEMBER");
    }
  }, 30000);

  it("(c) recoverable: transient interstitial is retried and replay still succeeds", async () => {
    // The mock app's transient toggle fires ~30% of the time, independently, on each of several
    // authenticated requests this flow makes (login redirect, search, search's own redirect) --
    // the artifact's own maxAttempts:3 is realistic for a genuine flake but leaves a small
    // (~3%) chance of exhausting retries purely by bad luck in one test run. Raise the ceiling
    // for this test only (mirrors how test (d) overrides successCondition) so the test verifies
    // the retry MECHANISM deterministically rather than being at the mercy of Math.random().
    const resilientCapability: Capability = {
      ...capability,
      recoverables: capability.recoverables.map((rule) => ({ ...rule, maxAttempts: 20 })),
    };
    await fetch(`${baseUrl}/control/transient/on`);
    try {
      const result = await runReplay({
        capability: resilientCapability,
        params: { ...CREDS, memberId: "10001" },
        entryUrl: baseUrl,
        headless: true,
      });
      expect(result.status).toBe("success");
    } finally {
      await fetch(`${baseUrl}/control/transient/off`);
    }
  }, 30000);

  it("(d) hard failure: an impossible success condition returns a debuggable failure", async () => {
    const broken: Capability = {
      ...capability,
      successCondition: { kind: "textPresent", text: "this text will never appear on this page 12345" },
    };
    const result = await runReplay({
      capability: broken,
      params: { ...CREDS, memberId: "10001" },
      entryUrl: baseUrl,
      headless: true,
    });
    expect(result.status).toBe("failure");
    if (result.status === "failure") {
      expect(result.category).toBe("unexpected-state");
      expect(result.expected).toContain("this text will never appear");
      expect(result.observed.length).toBeGreaterThan(0);
      expect(result.atStepId.length).toBeGreaterThan(0);
    }
  }, 30000);
});
