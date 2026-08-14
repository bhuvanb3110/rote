import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceRecorder } from "../evidence/index.js";
import type { ElementDescriptor, Handle, Observation, Surface } from "../surface/index.js";
import { EscalationController } from "./controller.js";

const SCRATCH_DIR = "evidence-scratch-controller-test";

// A minimal fake Surface -- EscalationController only ever calls perceive(), so that's all
// this needs to implement. Its URL advances each call, letting tests distinguish before/after.
class FakeSurface implements Surface {
  private callCount = 0;

  async perceive(): Promise<Observation> {
    this.callCount += 1;
    return {
      url: `http://localhost:4100/step-${this.callCount}`,
      accessibilitySnapshot: "",
      visibleText: `state ${this.callCount}`,
      landmarks: [],
      screenshot: Buffer.from(`screenshot-${this.callCount}`),
    };
  }

  async act(): Promise<void> {
    // unused by EscalationController
  }

  async locate(_descriptor: ElementDescriptor): Promise<Handle | null> {
    return null;
  }
}

describe("EscalationController", () => {
  let evidence: EvidenceRecorder;
  let surface: FakeSurface;
  let controller: EscalationController;

  beforeEach(async () => {
    surface = new FakeSurface();
    evidence = await EvidenceRecorder.create(SCRATCH_DIR, `run-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    controller = new EscalationController();
    controller.bind(surface, evidence);
  });

  afterEach(async () => {
    await rm(SCRATCH_DIR, { recursive: true, force: true });
  });

  it("starts owned by automation with no pending request", () => {
    expect(controller.controller).toBe("automation");
    expect(controller.pendingRequest).toBeNull();
  });

  it("raise() flips owner to human and persists an escalation_raised entry", async () => {
    const request = await controller.raise({
      capabilityId: "open-sub-account-confirmed",
      goal: "Open a sub-account",
      atStepId: "step-09",
      reason: "risky action blocked",
    });

    expect(controller.controller).toBe("human");
    expect(controller.pendingRequest).toEqual(request);
    expect(request.atStepId).toBe("step-09");
    expect(request.reason).toContain("risky");
    expect(request.screenshot.length).toBeGreaterThan(0);

    const log = await readFile(path.join(evidence.directory, "run.jsonl"), "utf8");
    const entries = log.trim().split("\n").map((line) => JSON.parse(line));
    const raised = entries.find((e) => e.kind === "escalation_raised");
    expect(raised).toBeDefined();
    expect(raised.detail.atStepId).toBe("step-09");
    expect(raised.detail.id).toBe(request.id);
  });

  it("takeControl() flips owner to human even with no pending request", () => {
    controller.takeControl();
    expect(controller.controller).toBe("human");
    expect(controller.pendingRequest).toBeNull();
  });

  it("handBack() is a no-op when automation already owns it", async () => {
    const record = await controller.handBack("nothing to hand back");
    expect(record).toBeNull();
    expect(controller.controller).toBe("automation");
  });

  it("handBack() flips owner back, clears the pending request, and persists escalation_resumed", async () => {
    await controller.raise({
      capabilityId: "cap",
      goal: "goal",
      atStepId: "step-01",
      reason: "test",
    });

    const record = await controller.handBack("resolved manually");
    expect(record).not.toBeNull();
    expect(record?.note).toBe("resolved manually");
    expect(controller.controller).toBe("automation");
    expect(controller.pendingRequest).toBeNull();

    const log = await readFile(path.join(evidence.directory, "run.jsonl"), "utf8");
    const entries = log.trim().split("\n").map((line) => JSON.parse(line));
    const resumed = entries.find((e) => e.kind === "escalation_resumed");
    expect(resumed).toBeDefined();
    expect(resumed.detail.note).toBe("resolved manually");
    expect(resumed.detail.beforeUrl).not.toBe(resumed.detail.afterUrl);
  });

  it("waitForAutomation() resolves immediately when already automation", async () => {
    await expect(controller.waitForAutomation()).resolves.toBeUndefined();
  });

  it("waitForAutomation() blocks until handBack() is called", async () => {
    await controller.raise({ capabilityId: "cap", goal: "goal", atStepId: "step-01", reason: "test" });

    let resolved = false;
    const waitPromise = controller.waitForAutomation().then(() => {
      resolved = true;
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resolved).toBe(false);

    await controller.handBack();
    await waitPromise;
    expect(resolved).toBe(true);
  });
});
