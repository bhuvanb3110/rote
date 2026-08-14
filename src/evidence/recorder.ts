// Evidence capture: every discovery/replay turn writes a JSONL record plus a screenshot.
// Redaction itself lives in src/safety/redact.ts (the single redact() helper) -- callers pass
// already-redacted values in; this module is pure I/O and doesn't decide what's sensitive.
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Vitest always sets process.env.VITEST, regardless of config -- used here so test runs
 * physically cannot write into the committed evidence/ folder, without every test file needing
 * to remember to pass evidenceBaseDir itself.
 */
export function defaultEvidenceBaseDir(): string {
  return process.env.VITEST ? path.join(os.tmpdir(), "rote-evidence-test") : "evidence";
}

export interface RunLogEntry {
  turn: number;
  kind:
    | "action"
    | "checkpoint"
    | "output"
    | "escalate"
    | "blocked"
    | "model_call"
    | "business_outcome"
    | "recover"
    | "drift"
    | "result"
    | "risk_approved"
    | "escalation_raised"
    | "escalation_resumed";
  detail: Record<string, unknown>;
  screenshotFile?: string;
}

export class EvidenceRecorder {
  private readonly runDir: string;
  private screenshotCounter = 0;

  private constructor(runDir: string) {
    this.runDir = runDir;
  }

  static async create(baseDir: string, runId: string): Promise<EvidenceRecorder> {
    const runDir = path.join(baseDir, runId);
    await mkdir(runDir, { recursive: true });
    return new EvidenceRecorder(runDir);
  }

  get directory(): string {
    return this.runDir;
  }

  async recordScreenshot(screenshot: Buffer): Promise<string> {
    this.screenshotCounter += 1;
    const filename = `step-${String(this.screenshotCounter).padStart(3, "0")}.png`;
    await writeFile(path.join(this.runDir, filename), screenshot);
    return filename;
  }

  async append(entry: RunLogEntry): Promise<void> {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry });
    await appendFile(path.join(this.runDir, "run.jsonl"), `${line}\n`, "utf8");
  }
}
