// The chaos tally (step-10 reviewer decisions 1 and 8; D56): recovery kinds counted from the rows, the batch
// tally's verdict, and the batch runner's promises that can be checked without Docker.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildTally, dirName, EMPTY_RECOVERY_KINDS, recoveryKinds, RECOVERY_KIND_LABELS, type SeedSummary } from "./tally.js";

describe("recoveryKinds: each kind, from the job_attempts / job_verifications rows", () => {
  it("counts T6.1 / T6.2 from recovery's notes, T4 requeues from jobOutcomeFor's '(retrying)', claims from the phases' reasons, and every verify / reconcile decision", () => {
    const k = recoveryKinds(
      [
        { outcome: "crashed", error: "lease expired in running; recovered by w-2 (T6.1 requeue)" },
        { outcome: "crashed", error: "lease expired in running; recovered by w-3 (T6.1 requeue)" },
        { outcome: "crashed", error: "lease expired in running; recovered by w-1 (T6.2 fail)" },
        { outcome: "crashed", error: "lease expired in committing; recovered by w-1 (T6.4 verify)" },
        { outcome: "failure", error: "attempt 1/3 (retrying): failure (unexpected-state) at step-03: ..." },
        { outcome: "aborted", error: "attempt 2/3 aborted before anything irreversible (retrying): ..." },
        { outcome: "failure", error: "attempt 3/3 (attempts exhausted): ..." },
        { outcome: "success", error: null },
      ],
      [
        { reason: "lease_expired_in_committing", decision: "resubmitted", error: "verified not committed" },
        { reason: "lease_expired_in_committing", decision: "already_done", error: null },
        { reason: "lease_expired_in_verifying", decision: "crashed", error: "lease expired in verifying; recovered by w (T6.6 escalate)" },
        { reason: "resumed", decision: "deferred", error: "verify deferred 5 s" },
        { reason: "commit_uncertain", decision: "exhausted", error: "x" },
        { reason: "commit_uncertain", decision: "handed_off", error: null },
        { reason: "reconcile", decision: "reconciled", error: null },
        { reason: "reconcile", decision: "unrecorded_commit_suspected", error: "x" },
        { reason: "reconcile", decision: "crashed", error: "reconcile lease expired; re-claimed by w" },
      ],
    );
    expect(k).toMatchObject({
      requeuedAfterCrash: 2,
      failedByRecovery: 1,
      requeuedAfterFailure: 2,
      claimedToVerify: 2,
      reclaimedVerify: 1,
      resumedVerify: 1,
      escalatedByRecovery: 1,
      ownVerify: 1, // the handed-off row is a reverify, not a T5
      resubmitted: 1,
      already_done: 1,
      deferred: 1,
      exhausted: 1,
      reconciled: 1,
      unrecorded_commit_suspected: 1,
      duplicate_suspected: 0,
    });
    expect(Object.keys(EMPTY_RECOVERY_KINDS).sort()).toEqual(Object.keys(RECOVERY_KIND_LABELS).sort());
  });

  it("a paused worker that wakes after T6.1 re-labels its own attempt lease_lost, keeping recovery's note: still a crash requeue (bank-fault-kills 41379566 after D57: 15 crashes, 14 crashed rows)", () => {
    const k = recoveryKinds(
      [
        {
          outcome: "lease_lost",
          error:
            "lease lost during the run (heartbeat); nothing recorded on the job. lease lost: ... [recovery had recorded: lease expired in running; recovered by w-3 (T6.1 requeue)]",
        },
        { outcome: "lease_lost", error: "lease lost during the run (heartbeat); nothing recorded on the job. [recovery had recorded: lease expired in running; recovered by w-1 (T6.2 fail)]" },
        // A worker fenced out with no recovery note (its own heartbeat lost the lease first): not counted.
        { outcome: "lease_lost", error: "lease lost during the run (heartbeat); nothing recorded on the job." },
      ],
      [],
    );
    expect(k).toMatchObject({ requeuedAfterCrash: 1, failedByRecovery: 1 });
  });
});

const summary = (seed: number, over: Partial<SeedSummary> = {}): SeedSummary => ({
  version: 1,
  completed: true,
  seed,
  family: "standard",
  jobs: 500,
  workers: 4,
  durationMs: 800_000,
  pauseMs: 45_000,
  drainTimeoutMs: 900_000,
  commit: "abc1234",
  startedAt: "2026-11-17T00:00:00.000Z",
  wallMs: 1_000_000,
  workMs: 900_000,
  drainMs: 120_000,
  drainTimedOut: false,
  kills: 80,
  restarts: 80,
  actionErrors: 0,
  pause: { replica: 2, fromMs: 1000, toMs: 46_000 },
  bank: null,
  bankControlsApplied: 0,
  oracle: { pass: true, counts: { ok: 500, DUPLICATE: 0, LOST: 0 }, ledgerRows: 500 },
  finals: { "succeeded/success": 490, "succeeded/already_done": 10 },
  needsHuman: [],
  failed: [],
  notSettled: 0,
  recoveries: { ...EMPTY_RECOVERY_KINDS, requeuedAfterCrash: 50, claimedToVerify: 10, already_done: 10 },
  workerProtections: {},
  leaks: [],
  oom: [],
  problems: [],
  pass: true,
  ...over,
});
const config = { jobs: 500, workers: 4, durationMs: 800_000, drainTimeoutMs: 900_000, family: "standard" as const };
const tally = (summaries: Array<SeedSummary | null>, interruptions: Array<{ index: number; seed: number; movedTo: string; at: string }> = []) =>
  buildTally({
    outDir: "evidence/chaos/day2-exit",
    seeds: summaries.map((s, i) => s?.seed ?? 100 + i),
    config,
    summaries: new Map(summaries.map((s, i) => [i + 1, s])),
    interruptions,
    generatedAt: "2026-11-17T01:00:00.000Z",
  });

describe("buildTally", () => {
  it("PASS only when every seed finished and passed; the per-seed rows link each seed's check.txt", () => {
    const t = tally([summary(11), summary(22)]);
    expect(t).toMatchObject({ result: "PASS", finished: 2, passed: 2 });
    expect(t.markdown).toContain("[11](seed-01-11/check.txt)");
    expect(t.markdown.trim().split("\n").at(-1)).toBe("RESULT: PASS (2/2 seeds passed their family judge: 0 DUPLICATE, 0 LOST, 0 needs_human, every job settled)");
    expect(t.totals).toMatchObject({ requeuedAfterCrash: 100, claimedToVerify: 20, already_done: 20 });
  });

  it("INCOMPLETE while seeds are still to run (a partial tally is written after every seed)", () => {
    const t = tally([summary(11), null, null]);
    expect(t.result).toBe("INCOMPLETE");
    expect(t.markdown).toMatch(/1 of 3 seeds finished/);
    expect(t.markdown).toMatch(/\| 2 \| 101 \|.*not run yet \|/);
  });

  it("FAIL names every failing seed, keeps it in the table with its problems, and a run that did not complete is a failed seed", () => {
    const bad = summary(22, { pass: false, problems: ["1 job(s) ended needs_human/duplicate_suspected, which the standard family does not allow"] });
    const crashed = summary(33, { completed: false, error: "docker: engine stopped", pass: false });
    const t = tally([summary(11), bad, crashed]);
    expect(t.result).toBe("FAIL");
    expect(t.markdown).toContain("**FAIL**: 1 job(s) ended needs_human/duplicate_suspected");
    expect(t.markdown).toContain("the run did not complete (docker: engine stopped)");
    expect(t.markdown.trim().split("\n").at(-1)).toBe("RESULT: FAIL (2 of 3 finished seeds failed: #2 seed 22, #3 seed 33; each stays in this tally and is investigated)");
  });

  it("says plainly whether the resubmit path was exercised (decision 8), and where it is covered when it was not", () => {
    expect(tally([summary(11)]).markdown).toMatch(/The resubmit path was NOT exercised by these seeds.*crash matrix.*crashSubmit\.db\.test\.ts.*verify-scenarios/s);
    const resub = summary(11, { recoveries: { ...EMPTY_RECOVERY_KINDS, resubmitted: 2, reconciled: 2 } });
    expect(tally([resub]).markdown).toMatch(/The resubmit path was exercised\*\*: 2 verify decision\(s\) `resubmitted` in 1 seed\(s\)/);
  });

  it("lists interrupted runs that were set aside and re-run", () => {
    const t = tally([summary(11)], [{ index: 1, seed: 11, movedTo: "evidence/chaos/day2-exit/seed-01-11.interrupted-x", at: "t" }]);
    expect(t.markdown).toContain("seed 1 (11): interrupted, moved to `evidence/chaos/day2-exit/seed-01-11.interrupted-x`");
    expect(dirName(3, 42)).toBe("seed-03-42");
  });
});

describe("scripts/chaos-seeds.ts, the promises checkable without Docker (reviewer decision 1)", () => {
  const source = readFileSync(new URL("../../scripts/chaos-seeds.ts", import.meta.url), "utf8");
  const code = source.replace(/^\s*\/\/.*$/gm, ""); // comments may say what it never does

  it("never runs the test suite", () => {
    expect(code).not.toMatch(/vitest|npm(\.cmd)?["',\s]+(run\s+)?test|"test"|test:fast|test:unit/);
  });

  it("saves the seeds before running any, writes the tally after every seed, and stops the whole stack at the end and on Ctrl-C", () => {
    expect(code.indexOf('path.join(OUT, "seeds.json")')).toBeLessThan(code.indexOf("runSeed(batch"));
    expect(code).toMatch(/const tally = await writeTally\(batch\);\s+log\(`seed \$\{i\}/);
    expect(code).toMatch(/await stopFleet\("the batch is done"\)/);
    expect(code).toMatch(/process\.on\(signal/);
    expect(code).toMatch(/\["compose", "stop"\]/);
  });

  it("resumes: a seed with a summary.json is skipped; a folder without one is set aside, never deleted", () => {
    expect(code).toMatch(/already finished, skipped/);
    expect(code).toMatch(/await rename\(dir, movedTo\)/);
    expect(code).not.toMatch(/\brm\(|rmSync|unlink/);
  });
});
