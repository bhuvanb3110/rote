// Crash right BEFORE and right AFTER Submit, in `npm test` (the brief's deliverable: "integration tests for
// crash-before and crash-after Submit"; docs/plans/step-10.md section 6; D53). Real worker CHILD PROCESSES
// (src/testing/workerProcess.ts), the in-process mock bank on :4100, a Postgres test schema, then the
// ledger oracle (D32). A fault worker SIGKILLs itself at the point: a real signal on Linux (CI), Windows'
// TerminateProcess locally (exit code 1). A clean worker then recovers the job when its lease expires
// (T6.4), verifies it in the bank's history, and drains until the job is SETTLED (terminal, and the
// reconcile pass done if one was due). Expected, both cases: exactly 1 ledger row, succeeded, oracle PASS.
//   before-submit  the intent is written, the click never went out: verify [0, 0] -> resubmitted ->
//                  attempt 2 succeeds -> the reconcile pass reads 1 match (reconciled)
//   after-submit   the bank wrote the row: verify [1] -> succeeded / already_done on attempt 1, no reconcile
// The lease is 5 s / heartbeat 2 s (as in the crash matrix, D40), the settle 1 s and the reconcile margin
// 1 s, so each case takes seconds, not minutes.
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resetLedger } from "../../mock-app/data.js";
import { findCapability } from "../catalog/registry.js";
import { jobSettled } from "../fleet/stateMachine.js";
import { checkLedger, fetchLedger, readJobs } from "../oracle/index.js";
import { enqueue } from "../queue/index.js";
import { createTestSchema } from "../queue/testDb.js";
import { BANK, closeBank, listenBank, runFaultWorker, startWorker, stopWorker, workerEnv } from "../testing/workerProcess.js";

let bank: Server;
let dir: string;

beforeAll(async () => {
  bank = await listenBank();
  dir = await mkdtemp(path.join(tmpdir(), "rote-crash-submit-"));
});
afterAll(async () => {
  if (bank) await closeBank(bank);
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function crashThenRecover(point: "before-submit" | "after-submit") {
  const db = await createTestSchema(`crash_submit_${point.replace("-", "_")}`, { max: 4 });
  resetLedger();
  try {
    const capability = (await findCapability("transfer"))!;
    const { job } = await enqueue(db.pool, {
      capability,
      tenantId: "tenant-a",
      idempotencyKey: `crash-submit-${point}`,
      params: { memberId: "10001", toMemberId: "10002", amount: "1.00" },
    });
    const base = workerEnv(db, {
      ROTE_LEASE_SECONDS: "5",
      ROTE_HEARTBEAT_SECONDS: "2",
      ROTE_VERIFY_SETTLE_MS: "1000",
      ROTE_RECONCILE_MARGIN_SECONDS: "1",
      ROTE_EVIDENCE_DIR: path.join(dir, point, "worker-evidence"),
    });
    const fault = await runFaultWorker(base, point, path.join(dir, `${point}-fault.log`), 120_000);
    const clean = startWorker({ ...base, ROTE_WORKER_ID: `clean-${point}` }, path.join(dir, `${point}-clean.log`));
    let drainTimedOut = false;
    try {
      const deadline = Date.now() + 120_000;
      for (;;) {
        const [current] = await readJobs(db.pool, [job.id]);
        if (jobSettled(current!)) break;
        if (Date.now() > deadline) {
          drainTimedOut = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    } finally {
      await stopWorker(clean);
    }
    const [final] = await readJobs(db.pool, [job.id]);
    const ledger = await fetchLedger(BANK);
    const report = checkLedger({ jobs: [final!], ledger, drainTimedOut });
    const phases = (
      await db.pool.query<{ reason: string; decision: string | null; lookups: number[] | null }>("SELECT reason, decision, lookups FROM job_verifications WHERE job_id = $1 ORDER BY id", [job.id])
    ).rows;
    const attempts = (await db.pool.query<{ attempt: number; worker_id: string; outcome: string | null }>("SELECT attempt, worker_id, outcome FROM job_attempts WHERE job_id = $1 ORDER BY attempt", [job.id])).rows;
    return { fault, final: final!, ledger, report, phases, attempts, drainTimedOut };
  } finally {
    await db.drop();
  }
}

describe("crash before / after Submit (real worker processes, a real SIGKILL on Linux)", () => {
  it("crash right BEFORE Submit (after the intent): verified [0, 0] -> resubmitted -> attempt 2 succeeds -> reconciled; exactly 1 row", async () => {
    const r = await crashThenRecover("before-submit");
    expect(r.fault.fired, `the fault worker: ${r.fault.exit}`).toBe(true);
    expect(r.fault.exit).toMatch(/^(signal SIGKILL|exit 1)$/);
    expect(r.drainTimedOut).toBe(false);
    expect(r.final).toMatchObject({ state: "succeeded", outcome: "success", attempt: 2 });
    expect(r.final.reconciled_at).not.toBeNull();
    expect(r.phases).toEqual([
      { reason: "lease_expired_in_committing", decision: "resubmitted", lookups: [0, 0] },
      { reason: "reconcile", decision: "reconciled", lookups: [1] },
    ]);
    expect(r.attempts.map((a) => [a.attempt, a.outcome])).toEqual([
      [1, "crashed"],
      [2, "success"],
    ]);
    expect(r.ledger).toHaveLength(1);
    expect(r.report.pass, r.report.text).toBe(true);
  }, 240_000);

  it("crash right AFTER Submit (the bank wrote the row): verified [1] -> succeeded / already_done on attempt 1, no reconcile due; exactly 1 row", async () => {
    const r = await crashThenRecover("after-submit");
    expect(r.fault.fired, `the fault worker: ${r.fault.exit}`).toBe(true);
    expect(r.fault.exit).toMatch(/^(signal SIGKILL|exit 1)$/);
    expect(r.drainTimedOut).toBe(false);
    expect(r.final).toMatchObject({ state: "succeeded", outcome: "already_done", attempt: 1, reconcile_after: null });
    expect(r.phases).toEqual([{ reason: "lease_expired_in_committing", decision: "already_done", lookups: [1] }]);
    expect(r.ledger).toHaveLength(1);
    expect((r.final.result as { outputs: { confirmationRef: string } }).outputs.confirmationRef).toBe(r.ledger[0]!.id);
    expect(r.report.pass, r.report.text).toBe(true);
  }, 240_000);
});
