// The commit a script's evidence is stamped with: the short HEAD, plus "+dirty" when a TRACKED file differs
// from it (untracked files, such as the run's own output folder, do not count). One definition for chaos.ts
// (each seed's summary.json `commit`) and chaos-seeds.ts (which refuses to mix commits in one batch, D56).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export async function gitCommitStamp(cwd?: string): Promise<string> {
  const run = promisify(execFile);
  try {
    const head = (await run("git", ["rev-parse", "--short", "HEAD"], { cwd })).stdout.trim();
    const dirty = (await run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd })).stdout.trim() !== "";
    return dirty ? `${head}+dirty` : head;
  } catch {
    return "unknown";
  }
}
