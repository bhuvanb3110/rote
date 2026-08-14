// Explicit control-transfer state machine. Exactly one owner at a time -- "automation" or
// "human" -- checked by replay before every action. The human operates the SAME live
// WebSurface session (bind() is called once, right after replay creates it); nothing here ever
// launches a second browser or a new session.
import { randomUUID } from "node:crypto";
import type { EvidenceRecorder } from "../evidence/index.js";
import type { Surface } from "../surface/index.js";

export type ControllerOwner = "automation" | "human";

export interface InterventionRequest {
  id: string;
  capabilityId: string;
  goal: string;
  atStepId: string;
  url: string;
  screenshot: Buffer;
  reason: string;
  raisedAt: string;
}

export interface HandoffRecord {
  requestId?: string;
  beforeUrl?: string;
  afterUrl: string;
  beforeScreenshotFile?: string;
  afterScreenshotFile: string;
  note?: string;
  raisedAt?: string;
  handedBackAt: string;
}

export class EscalationController {
  private owner: ControllerOwner = "automation";
  private pending: InterventionRequest | null = null;
  private resumeWaiters: Array<() => void> = [];
  private surface: Surface | null = null;
  private evidence: EvidenceRecorder | null = null;

  /** Wires the controller to the live session replay is already running -- called once. */
  bind(surface: Surface, evidence: EvidenceRecorder): void {
    this.surface = surface;
    this.evidence = evidence;
  }

  get controller(): ControllerOwner {
    return this.owner;
  }

  get pendingRequest(): InterventionRequest | null {
    return this.pending;
  }

  /** The exact live session the human should operate -- never a new one. */
  get boundSurface(): Surface | null {
    return this.surface;
  }

  private requireBound(): { surface: Surface; evidence: EvidenceRecorder } {
    if (!this.surface || !this.evidence) {
      throw new Error("EscalationController used before bind() was called.");
    }
    return { surface: this.surface, evidence: this.evidence };
  }

  /** Called by replay when it hits a needs_human condition. Flips the owner to human. */
  async raise(input: {
    capabilityId: string;
    goal: string;
    atStepId: string;
    reason: string;
  }): Promise<InterventionRequest> {
    const { surface, evidence } = this.requireBound();
    const observation = await surface.perceive();
    const screenshotFile = await evidence.recordScreenshot(observation.screenshot);
    const request: InterventionRequest = {
      id: randomUUID(),
      capabilityId: input.capabilityId,
      goal: input.goal,
      atStepId: input.atStepId,
      url: observation.url,
      screenshot: observation.screenshot,
      reason: input.reason,
      raisedAt: new Date().toISOString(),
    };
    this.owner = "human";
    this.pending = request;
    await evidence.append({
      turn: -1,
      kind: "escalation_raised",
      detail: {
        id: request.id,
        capabilityId: request.capabilityId,
        atStepId: request.atStepId,
        url: request.url,
        reason: request.reason,
      },
      screenshotFile,
    });
    return request;
  }

  /**
   * Called by the operator console's "Take control" button. Idempotent when a request is
   * already pending (owner is already human); also legitimately usable to proactively pause
   * automation with no pending request at all -- a human deciding to step in before anything
   * has gone wrong, distinct from an auto-raised pause.
   */
  takeControl(): void {
    this.owner = "human";
  }

  /**
   * Called by the operator console's "Hand back" button. Captures an after-screenshot via the
   * SAME bound surface, persists the handoff, flips ownership back, and wakes replay.
   */
  async handBack(note?: string): Promise<HandoffRecord | null> {
    if (this.owner !== "human") return null;
    const { surface, evidence } = this.requireBound();
    const before = this.pending;
    const after = await surface.perceive();
    const afterScreenshotFile = await evidence.recordScreenshot(after.screenshot);
    const record: HandoffRecord = {
      requestId: before?.id,
      beforeUrl: before?.url,
      afterUrl: after.url,
      afterScreenshotFile,
      note,
      raisedAt: before?.raisedAt,
      handedBackAt: new Date().toISOString(),
    };
    this.owner = "automation";
    this.pending = null;
    await evidence.append({
      turn: -1,
      kind: "escalation_resumed",
      detail: { ...record },
      screenshotFile: afterScreenshotFile,
    });
    this.notifyResume();
    return record;
  }

  /** Blocks until ownership is back with automation. Resolves immediately if it already is. */
  async waitForAutomation(): Promise<void> {
    if (this.owner === "automation") return;
    await new Promise<void>((resolve) => this.resumeWaiters.push(resolve));
  }

  private notifyResume(): void {
    const waiters = this.resumeWaiters;
    this.resumeWaiters = [];
    for (const wake of waiters) wake();
  }
}
