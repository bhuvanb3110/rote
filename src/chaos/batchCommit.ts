// One batch, one commit (the reviewer's change to chaos-seeds during 10b, 2026-11-18; D56). The unattended
// batch (`npm run chaos-seeds`) must never mix runs of different code into one tally: not into day2-exit
// (the run that failed before D58) nor into any older run. So:
//   - --out is REQUIRED (no default folder to fall into by accident);
//   - before it writes anything, the runner reads the commit every FINISHED seed in that folder was stamped
//     with (its summary.json `commit`, scripts/lib/git.ts: the short HEAD, "+dirty" when a tracked file
//     differed) and refuses -- printing both -- when any differs from the stamp of the tree it runs from now.
//     The stamps are compared whole, so a dirty tree never resumes a clean batch either.
// A seed folder set aside after an interruption or a --rerun (`seed-NN-<seed>.interrupted-...`) is not part of
// the tally and is not read.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

export interface FinishedSeedCommit {
  index: number;
  seed: number;
  /** summary.json `commit`, e.g. "b3892d4" or "0a30ac0+dirty". */
  commit: string;
}

/** `--out` is required: no default folder (D56, 2026-11-18). Throws the message to print. */
export function requireOut(value: string | undefined): string {
  if (value === undefined || value.trim() === "" || value.startsWith("--")) {
    throw new Error(
      "--out <dir> is required: name the batch's folder, e.g. --out evidence/chaos/day2-exit-final. There is no default, so a batch can " +
        "never fall into an older run's folder (each folder holds one commit's seeds).",
    );
  }
  return value;
}

/** null = the batch may run here; otherwise why not (both commits named). */
export function batchCommitConflict(finished: readonly FinishedSeedCommit[], head: string, outRel: string): string | null {
  const others = finished.filter((f) => f.commit !== head);
  if (others.length === 0) return null;
  const byCommit = new Map<string, number[]>();
  for (const f of others) byCommit.set(f.commit, [...(byCommit.get(f.commit) ?? []), f.index]);
  const theirs = [...byCommit].map(([commit, idx]) => `${commit} (seed${idx.length > 1 ? "s" : ""} ${idx.join(", ")})`).join(", ");
  return (
    `${outRel} holds seeds finished on another commit: ${theirs}; this tree is ${head}. One batch, one commit: ` +
    "nothing was written. Use a new --out (copy its seeds.json there to keep the same seeds), or check out that commit."
  );
}

/** The finished seeds in a batch folder: every `seed-NN-<seed>/summary.json`, by its index. */
export async function finishedSeedCommits(outDir: string): Promise<FinishedSeedCommit[]> {
  const entries = await readdir(outDir, { withFileTypes: true }).catch(() => []);
  const found: FinishedSeedCommit[] = [];
  for (const e of entries) {
    const m = /^seed-(\d+)-(\d+)$/.exec(e.name);
    if (!e.isDirectory() || !m) continue;
    const text = await readFile(path.join(outDir, e.name, "summary.json"), "utf8").catch(() => null);
    if (text === null) continue; // interrupted mid-seed: no summary, nothing finished there
    const commit = (JSON.parse(text) as { commit?: unknown }).commit;
    found.push({ index: Number(m[1]), seed: Number(m[2]), commit: typeof commit === "string" ? commit : "unknown" });
  }
  return found.sort((a, b) => a.index - b.index);
}
