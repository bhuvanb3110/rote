// Internal recording shapes for the discovery loop. These are NOT the artifact schema —
// they're what accumulates turn by turn before compile.ts promotes them into a Capability.
import type { Action, Capability, Checkpoint, ElementDescriptor } from "../artifact/index.js";

export interface RecordedStep {
  id: string;
  intent: string;
  actionKind: Action["kind"];
  url?: string;
  timeoutMs?: number;
  target?: ElementDescriptor;
  rawValue?: { value: string; redact: boolean };
  checkpoint?: Checkpoint;
  risk: "safe" | "risky";
}

export interface RecordedOutput {
  name: string;
  value: string;
  producedByStepId: string;
}

export interface DiscoveryTranscript {
  goalId: string;
  goalName: string;
  goalDescription: string;
  entryUrl: string;
  model: string;
  steps: RecordedStep[];
  outputs: RecordedOutput[];
  successCondition: Checkpoint;
  transcriptRef: string;
  tokenUsage: { inputTokens: number; outputTokens: number };
}

export interface DiscoveryOptions {
  goal: string;
  entryUrl: string;
  headless?: boolean;
  model?: string;
  maxSteps?: number;
  timeoutMs?: number;
  evidenceBaseDir?: string;
  artifactsDir?: string;
}

export type DiscoveryOutcome =
  | { status: "success"; capability: Capability; capabilityPath: string; evidenceDir: string; steps: number }
  | { status: "needs_human"; reason: string; evidenceDir: string; steps: number }
  | { status: "failure"; reason: string; evidenceDir: string; steps: number };
