// One batch, one commit (the reviewer's change to chaos-seeds during 10b, 2026-11-18): --out is required, and a
// folder whose finished seeds carry another commit's stamp is refused before anything is written.
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { batchCommitConflict, finishedSeedCommits, requireOut } from "./batchCommit.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("batchCommitConflict / requireOut (pure)", () => {
  it("--out is required: absent, empty or another flag in its place is refused, naming the reason", () => {
    for (const v of [undefined, "", "  ", "--seeds"]) expect(() => requireOut(v), String(v)).toThrow(/^--out <dir> is required: .*no default/);
    expect(requireOut("evidence/chaos/day2-exit-final")).toBe("evidence/chaos/day2-exit-final");
  });

  it("no finished seed, or every one on this commit: allowed (a new batch, or a resume)", () => {
    expect(batchCommitConflict([], "b3892d4", "out")).toBeNull();
    expect(batchCommitConflict([{ index: 1, seed: 7, commit: "b3892d4" }, { index: 2, seed: 9, commit: "b3892d4" }], "b3892d4", "out")).toBeNull();
  });

  it("any finished seed on another commit: refused, naming every other commit with its seeds and this tree's", () => {
    const finished = [
      { index: 1, seed: 2080386450, commit: "d84b556" },
      { index: 2, seed: 1980443797, commit: "d84b556" },
      { index: 3, seed: 5, commit: "b3892d4" },
    ];
    expect(batchCommitConflict(finished, "b3892d4", "evidence/chaos/day2-exit-after-d58")).toBe(
      "evidence/chaos/day2-exit-after-d58 holds seeds finished on another commit: d84b556 (seeds 1, 2); this tree is b3892d4. " +
        "One batch, one commit: nothing was written. Use a new --out (copy its seeds.json there to keep the same seeds), or check out that commit.",
    );
  });

  it("the stamps are compared whole: a dirty tree never resumes a clean batch, nor a clean tree a dirty one", () => {
    expect(batchCommitConflict([{ index: 1, seed: 7, commit: "b3892d4" }], "b3892d4+dirty", "out")).toMatch(/b3892d4 \(seed 1\); this tree is b3892d4\+dirty/);
    expect(batchCommitConflict([{ index: 2, seed: 7, commit: "0a30ac0+dirty" }], "0a30ac0", "out")).toMatch(/0a30ac0\+dirty \(seed 2\); this tree is 0a30ac0\./);
  });
});

describe("finishedSeedCommits and the chaos-seeds script (a temp folder, no Docker)", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "rote-batch-commit-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  /** A batch folder: seeds.json, and the given seed folders (a summary.json when `commit` is given). */
  async function batch(name: string, seeds: Array<{ index: number; seed: number; commit?: string }>, extra: string[] = []): Promise<string> {
    const out = path.join(dir, name);
    await mkdir(out, { recursive: true });
    const config = { seeds: seeds.map((s) => s.seed), jobs: 500, workers: 4, durationMs: 800000, drainTimeoutMs: 900000, family: "standard", createdAt: "2026-11-18T01:07:16.299Z", command: "test" };
    await writeFile(path.join(out, "seeds.json"), JSON.stringify(config, null, 2) + "\n");
    for (const s of seeds) {
      const sd = path.join(out, `seed-${String(s.index).padStart(2, "0")}-${s.seed}`);
      await mkdir(sd, { recursive: true });
      if (s.commit !== undefined) await writeFile(path.join(sd, "summary.json"), JSON.stringify({ version: 1, seed: s.seed, commit: s.commit }));
    }
    for (const e of extra) await mkdir(path.join(out, e), { recursive: true });
    return out;
  }

  const runSeeds = (args: string[]) =>
    new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      execFile(process.execPath, ["--import", "tsx", path.join(ROOT, "scripts", "chaos-seeds.ts"), ...args], { cwd: ROOT, timeout: 60_000 }, (err, stdout, stderr) =>
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr }),
      );
    });

  it("reads every finished seed's stamp; an interrupted seed (no summary.json) and set-aside folders are not read", async () => {
    const out = await batch("read", [{ index: 2, seed: 22, commit: "abc1234" }, { index: 1, seed: 11, commit: "abc1234+dirty" }, { index: 3, seed: 33 }], ["seed-01-11.rerun-2026-11-18T01-00-00-000Z"]);
    expect(await finishedSeedCommits(out)).toEqual([
      { index: 1, seed: 11, commit: "abc1234+dirty" },
      { index: 2, seed: 22, commit: "abc1234" },
    ]);
    expect(await finishedSeedCommits(path.join(dir, "does-not-exist"))).toEqual([]);
  });

  it("the script without --out exits 2 and says --out is required", async () => {
    const r = await runSeeds(["--seeds", "2", "--jobs", "500"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/chaos-seeds: --out <dir> is required/);
  }, 60_000);

  it("the script refuses a folder with a seed finished on another commit: exit 2, both commits printed, nothing written", async () => {
    const out = await batch("other-commit", [{ index: 1, seed: 2080386450, commit: "0000000" }, { index: 2, seed: 1980443797 }]);
    const before = await readFile(path.join(out, "seeds.json"), "utf8");
    const r = await runSeeds(["--seeds", "20", "--jobs", "500", "--out", out]);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/holds seeds finished on another commit: 0000000 \(seed 1\); this tree is [0-9a-f]{7,}(\+dirty)?\. One batch, one commit: nothing was written/);
    expect(await readFile(path.join(out, "seeds.json"), "utf8")).toBe(before); // not extended to 20
    expect((await readdir(out)).sort()).toEqual(["seed-01-2080386450", "seed-02-1980443797", "seeds.json"]); // no tally, no runner log
  }, 60_000);
});
