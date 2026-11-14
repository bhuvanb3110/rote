// The reconcile pass with the REAL lookup against the REAL (in-process) bank (docs/plans/step-10.md
// section 2, integration; D50, D51): a real worker, Chromium and Postgres, judged by the bank's own ledger.
// A job is taken to "succeeded after a resubmit" (attempt 1's intent, a verified [0, 0], then attempt 2 run
// for real by a worker), then:
//   - a second ledger row with its memo (what a zombie's late click leaves) -> the worker's reconcile reads
//     2 matches -> needs_human / duplicate_suspected, the count and both references on the job;
//   - no second row -> 1 match -> reconciled, settled;
//   - the end-of-day batch (rote reconcile --since) after the workers' pass reconciled the job: the late row
//     is found and flagged, and the ledger is unchanged (read-only toward the bank).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { appendLedgerEntry } from "../../mock-app/data.js";
import type { ReplayResult } from "../artifact/index.js";
import { jobOutcomeFor, jobSettled } from "../fleet/stateMachine.js";
import { checkLedger, readJobs } from "../oracle/index.js";
import { dequeue, type JobRow } from "../queue/index.js";
import { writeCommitIntent } from "./intent.js";
import { InMemoryCounters } from "./metrics.js";
import { reconcileWindow } from "./reconcile.js";
import { createWorkerTestEnv, type WorkerTestEnv } from "./testEnv.js";
import { completeIntoVerify, writeVerifyResult } from "./verifySql.js";

let env: WorkerTestEnv;

beforeAll(async () => {
  env = await createWorkerTestEnv("worker_reconcile_bank");
}, 60_000);
afterAll(async () => {
  await env?.close();
});
beforeEach(async () => {
  await env.reset();
});

const cuFailure: ReplayResult = { status: "failure", atStepId: "step-12", expected: "x", observed: "503", category: "unexpected-state", evidenceRef: "e", commitUncertain: { irreversibleStepId: "step-11", detail: "test" } };
const phases = async (id: string) => (await env.pool.query("SELECT worker_id, reason, decision, lookups FROM job_verifications WHERE job_id = $1 ORDER BY id", [id])).rows;
const job = async (id: string) => (await readJobs(env.pool, [id]))[0]!;
const makeDue = (id: string) => env.pool.query("UPDATE jobs SET reconcile_after = now() - interval '1 second' WHERE id = $1", [id]);

/** Attempt 1 wrote its intent and was verified [0, 0] (nothing at the bank); a real worker runs attempt 2. */
async function succeededAfterResubmit(): Promise<JobRow> {
  const [queued] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
  const a1 = (await dequeue(env.pool, { workerId: "attempt-1", leaseSeconds: 30 }))!;
  await writeCommitIntent(env.pool, { jobId: a1.id, fencingToken: a1.fencing_token, workerId: "attempt-1", leaseSeconds: 30 });
  const outcome = jobOutcomeFor({ kind: "result", result: cuFailure }, { attempt: 1, maxAttempts: 3, irreversibleStarted: true });
  const moved = await completeIntoVerify(env.pool, { jobId: a1.id, fencingToken: a1.fencing_token, workerId: "attempt-1", leaseSeconds: 30, outcome });
  if (!moved.recorded) throw new Error(moved.detail);
  const t7 = await writeVerifyResult(env.pool, {
    jobId: a1.id,
    fencingToken: moved.fencingToken,
    workerId: "attempt-1",
    lookups: [0, 0],
    evidenceRefs: [null, null],
    decision: { decision: "resubmitted", to: "queued", outcome: null, error: "verified not committed" },
    result: null,
  });
  if (!t7.recorded) throw new Error(t7.detail);
  expect(await env.newWorker().tick()).toBe("ran"); // attempt 2, for real
  const j = await job(queued!.id);
  expect(j).toMatchObject({ state: "succeeded", outcome: "success", attempt: 2, reconciled_at: null });
  expect(j.reconcile_after).toBeInstanceOf(Date);
  expect(jobSettled(j)).toBe(false);
  expect(await env.ledger()).toHaveLength(1);
  return j;
}

/** What a zombie's late click leaves: a second transfer with the job's memo. */
const zombieRow = (j: JobRow) => appendLedgerEntry({ tenantId: "tenant-a", fromMemberId: "10001", toMemberId: "10002", amount: 1, memo: j.memo_key });

describe("the reconcile pass, real lookup, real bank", () => {
  it("two ledger rows for one memo -> the worker's reconcile reads 2 -> needs_human / duplicate_suspected, the count and both references on the job; the oracle agrees (DUPLICATE)", async () => {
    const j = await succeededAfterResubmit();
    const late = zombieRow(j);
    await makeDue(j.id);
    const metrics = new InMemoryCounters();
    expect(await env.newWorker({ metrics, verifyCtx: { metrics } }).tick()).toBe("ran"); // R1 -> lookup -> R2
    const after = await job(j.id);
    const own = (j.result as { outputs: { confirmationRef: string } }).outputs.confirmationRef;
    expect(after).toMatchObject({ state: "needs_human", outcome: "duplicate_suspected", lease_owner: null });
    expect(after.result).toMatchObject({ outputs: { confirmationRef: own }, reconcile: { decision: "duplicate_suspected", matches: 2, jobConfirmationRef: own, lookups: [2] } });
    // The history lists oldest first: its first match is the job's own row; the late row is the other.
    expect((after.result as { reconcile: { firstMatchRef: string } }).reconcile.firstMatchRef).toBe(own);
    expect((await env.ledger()).map((r) => r.id).sort()).toEqual([own, late.id].sort());
    expect((await phases(j.id)).at(-1)).toMatchObject({ reason: "reconcile", decision: "duplicate_suspected", lookups: [2] });
    expect(metrics.get("duplicates_detected_total")).toBe(1);
    expect(jobSettled(after)).toBe(true);
    expect(checkLedger({ jobs: [after], ledger: await env.ledger(), drainTimedOut: false }).findings[0]!.verdict).toBe("DUPLICATE");
  }, 120_000);

  it("one row -> reconciled: stays succeeded, settled; the oracle passes", async () => {
    const j = await succeededAfterResubmit();
    await makeDue(j.id);
    expect(await env.newWorker().tick()).toBe("ran");
    const after = await job(j.id);
    expect(after).toMatchObject({ state: "succeeded", outcome: "success", attempt: 2 });
    expect(after.reconciled_at).toBeInstanceOf(Date);
    expect(jobSettled(after)).toBe(true);
    expect((await phases(j.id)).at(-1)).toMatchObject({ reason: "reconcile", decision: "reconciled", lookups: [1] });
    expect(checkLedger({ jobs: [after], ledger: await env.ledger(), drainTimedOut: false }).pass).toBe(true);
  }, 120_000);

  it("rote reconcile --since: after the workers' pass reconciled the job (1 row), a late row appears; the batch reads it regardless of reconciled_at, flags it like R2, and never writes to the bank", async () => {
    const j = await succeededAfterResubmit();
    await makeDue(j.id);
    expect(await env.newWorker().tick()).toBe("ran");
    expect((await job(j.id)).reconciled_at).toBeInstanceOf(Date);
    zombieRow(j); // the zombie clicked after the pass
    const ledgerBefore = await env.ledger();
    const report = await reconcileWindow(
      {
        pool: env.pool,
        workerId: "reconcile:batch-test",
        leaseSeconds: 30,
        settleMs: 0,
        getBrowser: async () => env.browser,
        credentials: env.credentials,
        evidenceBaseDir: env.ctx.evidenceBaseDir,
        artifactsDir: env.ctx.artifactsDir,
        overridesDir: env.ctx.overridesDir,
        statusDir: env.ctx.statusDir,
      },
      { sinceSeconds: 3600 },
    );
    expect(report).toMatchObject({ flagged: 1, undecided: 0 });
    expect(report.rows).toMatchObject([{ jobId: j.id, result: "duplicate_suspected", matches: 2 }]);
    expect(await job(j.id)).toMatchObject({ state: "needs_human", outcome: "duplicate_suspected" });
    expect(await env.ledger()).toEqual(ledgerBefore); // read-only toward the bank
    expect((await phases(j.id)).filter((p) => p.reason === "reconcile").map((p) => [p.worker_id, p.decision])).toEqual([
      [expect.stringMatching(/^test-worker-/), "reconciled"],
      ["reconcile:batch-test", "duplicate_suspected"],
    ]);
  }, 120_000);
});
