import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import app from "../../mock-app/app.js";
import { deserializeCapability, type Capability } from "../artifact/index.js";
import { EscalationController } from "../escalation/index.js";
import { runReplay } from "./replay.js";

let server: Server;
let baseUrl: string;
let capability: Capability;
let subAccountCapability: Capability;
let confirmedCapability: Capability;

const CONFIRM_TARGET = {
  describedAs: "Confirm button",
  strategies: [{ kind: "roleName" as const, role: "button", name: "Confirm", confidence: 0.95 }],
};

async function waitForPendingRequest(controller: EscalationController, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (controller.pendingRequest) return controller.pendingRequest;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for a pending intervention request after ${timeoutMs}ms.`);
}

const CREDS = { username: "operator", password: "operator" };

async function loadRelaxed(relativePath: string): Promise<Capability> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const artifactPath = path.join(here, relativePath);
  const recorded = deserializeCapability(await readFile(artifactPath, "utf8"));
  // The real artifacts' entryUrlPattern is pinned to the fixed dev port (4100); tests run the
  // mock app on an ephemeral port to stay CI-safe, so relax just the pattern -- everything else
  // (steps, inputs, outputs, recognizers) is the real, unmodified artifact.
  return { ...recorded, target: { ...recorded.target, entryUrlPattern: "^http://localhost:\\d+/" } };
}

beforeAll(async () => {
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://localhost:${port}`;

  capability = await loadRelaxed("../../artifacts/member-lookup.json");
  subAccountCapability = await loadRelaxed("../../artifacts/open-sub-account.json");
  confirmedCapability = await loadRelaxed("../../artifacts/open-sub-account-confirmed.json");
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

  it("(e) risky action without approveRisky returns needs_human, not silent execution", async () => {
    const withConfirm: Capability = {
      ...subAccountCapability,
      steps: [
        ...subAccountCapability.steps,
        {
          id: "step-09",
          intent: "Confirm the new sub-account.",
          action: { kind: "click" },
          target: {
            describedAs: "Confirm button",
            strategies: [{ kind: "roleName", role: "button", name: "Confirm", confidence: 0.95 }],
          },
          risk: "risky",
        },
      ],
      successCondition: { kind: "textPresent", text: "Created" },
    };
    const result = await runReplay({
      capability: withConfirm,
      params: { ...CREDS, memberId: "10001", initialDeposit: "50.00" },
      entryUrl: baseUrl,
      headless: true,
    });
    expect(result.status).toBe("needs_human");
    if (result.status === "needs_human") {
      expect(result.atStepId).toBe("step-09");
    }
  }, 30000);

  it("(f) risky action WITH approveRisky executes and actually completes the flow", async () => {
    const withConfirm: Capability = {
      ...subAccountCapability,
      steps: [
        ...subAccountCapability.steps,
        {
          id: "step-09",
          intent: "Confirm the new sub-account.",
          action: { kind: "click" },
          target: {
            describedAs: "Confirm button",
            strategies: [{ kind: "roleName", role: "button", name: "Confirm", confidence: 0.95 }],
          },
          risk: "risky",
        },
      ],
      successCondition: { kind: "textPresent", text: "Created" },
    };
    const result = await runReplay({
      capability: withConfirm,
      params: { ...CREDS, memberId: "10001", initialDeposit: "50.00" },
      entryUrl: baseUrl,
      headless: true,
      approveRisky: true,
    });
    expect(result.status).toBe("success");
  }, 30000);

  it("(g) escalation: pauses on the risky step, resumes to success once a human resolves it", async () => {
    const controller = new EscalationController();
    const resultPromise = runReplay({
      capability: confirmedCapability,
      params: { ...CREDS, memberId: "10001", initialDeposit: "50.00" },
      entryUrl: baseUrl,
      headless: true, // only a REAL human needs headed; simulating one here works headless
      controller,
    });

    const request = await waitForPendingRequest(controller);
    expect(controller.controller).toBe("human");
    expect(request.atStepId).toBe("step-09");
    expect(request.reason).toContain("risky");
    expect(request.capabilityId).toBe("open-sub-account-confirmed");
    expect(request.screenshot.length).toBeGreaterThan(0);

    // Simulate the human: operate the SAME live session the controller is bound to.
    await controller.boundSurface!.act({ kind: "click", target: CONFIRM_TARGET });
    const handoff = await controller.handBack("resolved manually in test");
    expect(handoff?.note).toBe("resolved manually in test");
    expect(controller.controller).toBe("automation");

    const result = await resultPromise;
    expect(result.status).toBe("success");

    if (result.status === "success") {
      // evidenceRef is "evidence://evidence/<runId>/run.jsonl" -- strip the scheme to get the
      // real relative path (which already includes the "evidence/" base dir).
      const relativeLogPath = result.evidenceRef.replace("evidence://", "");
      const log = await readFile(path.join(process.cwd(), relativeLogPath), "utf8");
      const kinds = log.trim().split("\n").map((line) => JSON.parse(line).kind);
      expect(kinds).toContain("escalation_raised");
      expect(kinds).toContain("escalation_resumed");
    }
  }, 30000);

  it("(h) escalation: a no-op hand-back safely re-pauses instead of crashing", async () => {
    const controller = new EscalationController();
    const resultPromise = runReplay({
      capability: confirmedCapability,
      params: { ...CREDS, memberId: "10001", initialDeposit: "50.00" },
      entryUrl: baseUrl,
      headless: true,
      controller,
    });

    const first = await waitForPendingRequest(controller);
    await controller.handBack("did nothing"); // no-op: doesn't touch the Confirm button
    expect(controller.controller).toBe("automation");

    // Replay retries the same step, hits the same risky-blocked condition, pauses again.
    const second = await waitForPendingRequest(controller);
    expect(second.atStepId).toBe("step-09");
    expect(second.id).not.toBe(first.id);

    await controller.boundSurface!.act({ kind: "click", target: CONFIRM_TARGET });
    await controller.handBack("resolved on the second attempt");

    const result = await resultPromise;
    expect(result.status).toBe("success");
  }, 30000);
});
