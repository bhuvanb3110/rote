// Reads a run's confidence back from its evidence log -- the same read-the-log-back pattern
// src/tenant/multiTenant.test.ts already uses for drift entries. Confidence is never added to
// ReplayResult itself (it's a property of the run/evidence, not of the result contract), so this
// is how a caller (the CLI's --show-confidence) gets the number back after the fact.
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function readRunConfidence(evidenceRef: string): Promise<number | undefined> {
  const stripped = evidenceRef.replace("evidence://", "");
  const logPath = path.isAbsolute(stripped) ? stripped : path.join(process.cwd(), stripped);
  const log = await readFile(logPath, "utf8");
  const lines = log.trim().split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const entry = JSON.parse(lines[i]!) as { kind: string; detail?: { confidence?: number } };
    if (entry.kind === "result") return entry.detail?.confidence;
  }
  return undefined;
}
