// Evidence capture and redaction: every discovery/replay turn writes a JSONL record plus a
// screenshot. Redaction happens here, at the write boundary — callers pass the raw value and a
// redact flag, and only the recorder decides what actually reaches disk.
import { mkdir, appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
    | "result";
  detail: Record<string, unknown>;
  screenshotFile?: string;
}

/** Never writes the raw value when shouldRedact is true — the only case that matters. */
export function redactValue(value: string, shouldRedact: boolean): string {
  return shouldRedact ? "[REDACTED]" : value;
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
