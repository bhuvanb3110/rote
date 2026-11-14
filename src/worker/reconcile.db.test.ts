// The reconcile pass against real Postgres (docs/plans/step-10.md section 2; reviewer decisions 3 and 5;
// D50, D51), with a scripted lookup (the invokeLookup seam): T4 / T7 marking, R1's selection and its
// re-claim after a dead reconciler, R2 per decision, a stale R2, the batch's window, settled. The real
// lookup against the real bank is in reconcileBank.db.test.ts.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Capability, ReplayResult } from "../artifact/index.js";
import { jobOutcomeFor, jobSettled, type LookupEnd } from "../fleet/stateMachine.js";
import { dequeue, enqueue, JobRowSchema, type JobRow, type Pool } from "../queue/index.js";
import { createTestSchema, resetQueueTables, type TestSchema } from "../queue/testDb.js";
import { createRedactor, loadTenantCredentials } from "./credentials.js";
import { completeJob } from "./complete.js";
import { writeCommitIntent } from "./intent.js";
import { InMemoryCounters } from "./metrics.js";
import {
  claimReconcile,
  claimReconcileJob,
  parseDurationSeconds,
  reconcileWindow,
  runReconcilePhase,
  writeReconcileResult,
  type ReconcileClaim,
} from "./reconcile.js";
import type { VerifyContext } from "./verify.js";
import { completeIntoVerify, writeVerifyResult } from "./verifySql.js";

const CAP = {
  id: "cap",
  inputs: [{ name: "memberId", type: "string", required: true, redact: false, description: "m" }],
  steps: [],
} as unknown as Pick<Capability, "id" | "inputs" | "steps">;
const LEASE = 30;
const DUE = 60;

let db: TestSchema;
let pool: Pool;

beforeAll(async () => {
  db = await createTestSchema("reconcile");
  pool = db.pool;
});
afterAll(async () => {
  await db?.drop();
});
beforeEach(async () => {
  await resetQueueTables(pool);
});

const row = async (id: string) => JobRowSchema.parse((await pool.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0]);
const phases = async (id: string) =>
  (await pool.query("SELECT fencing_token, worker_id, reason, decision, lookups, error FROM job_verifications WHERE job_id = $1 ORDER BY id", [id])).rows;
const dueIn = async (id: string) => (await pool.query<{ s: number }>("SELECT EXTRACT(EPOCH FROM reconcile_after - now())::float8 AS s FROM jobs WHERE id = $1", [id])).rows[0]!.s;
/** The reconcile is due now (the database clock moved past reconcile_after). */
const makeDue = (id: string) => pool.query("UPDATE jobs SET reconcile_after = now() - interval '1 second' WHERE id = $1", [id]);

const cuFailure: ReplayResult = { status: "failure", atStepId: "step-12", expected: "x", observed: "503", category: "unexpected-state", evidenceRef: "e", commitUncertain: { irreversibleStepId: "step-11", detail: "t" } };
const success = (ref: string): ReplayResult => ({ status: "success", outputs: { confirmationRef: ref }, evidenceRef: "e" });

/** A job taken through: attempt 1 intent + commit-uncertain -> T5 -> T7 resubmitted -> attempt 2 leased. */
async function resubmittedAndLeased(): Promise<JobRow> {
  const { job } = await enqueue(pool, { capability: CAP, tenantId: "tenant-a", idempotencyKey: `k-${Math.random()}`, params: { memberId: "1" } });
  const a1 = (await dequeue(pool, { workerId: "w1", leaseSeconds: LEASE }))!;
  await writeCommitIntent(pool, { jobId: a1.id, fencingToken: a1.fencing_token, workerId: "w1", leaseSeconds: LEASE });
  const outcome = jobOutcomeFor({ kind: "result", result: cuFailure }, { attempt: 1, maxAttempts: 3, irreversibleStarted: true });
  const moved = await completeIntoVerify(pool, { jobId: a1.id, fencingToken: a1.fencing_token, workerId: "w1", leaseSeconds: LEASE, outcome });
  if (!moved.recorded) throw new Error(moved.detail);
  const t7 = await writeVerifyResult(pool, {
    jobId: a1.id,
    fencingToken: moved.fencingToken,
    workerId: "w1",
    lookups: [0, 0],
    evidenceRefs: ["e", "e"],
    decision: { decision: "resubmitted", to: "queued", outcome: null, error: "verified not committed" },
    result: null,
    reconcileDueSeconds: DUE,
  });
  if (!t7.recorded) throw new Error(t7.detail);
  const a2 = (await dequeue(pool, { workerId: "w2", leaseSeconds: LEASE }))!;
  expect(a2).toMatchObject({ id: job.id, attempt: 2 });
  return a2;
}

/** ... and attempt 2 succeeded (T4): the job is marked for reconcile. */
async function succeededAfterResubmit(ref = "TXN-000002"): Promise<JobRow> {
  const a2 = await resubmittedAndLeased();
  const outcome = jobOutcomeFor({ kind: "result", result: success(ref) }, { attempt: 2, maxAttempts: 3, irreversibleStarted: true });
  expect(await completeJob(pool, { jobId: a2.id, fencingToken: a2.fencing_token, workerId: "w2", outcome, reconcileDueSeconds: DUE })).toEqual({ recorded: true });
  return row(a2.id);
}

const count = (n: number, ref = n > 0 ? "TXN-000001" : "No matching transfers."): LookupEnd => ({
  kind: "result",
  result: { status: "success", outputs: { matchingCount: String(n), firstMatchRef: ref }, evidenceRef: `evidence://fake-${n}` },
});
const unavailable: LookupEnd = { kind: "result", result: { status: "business_outcome", code: "BANK_UNAVAILABLE", detail: "System unavailable", evidenceRef: "evidence://503" } };
const garbled: LookupEnd = { kind: "result", result: { status: "success", outputs: { matchingCount: "lots" }, evidenceRef: "evidence://garbled" } };

function ctx(script: LookupEnd[], over: Partial<VerifyContext> = {}): VerifyContext & { metrics: InMemoryCounters; calls: number[] } {
  const credentials = loadTenantCredentials({ ROTE_CRED_TENANT_A_USERNAME: "fake-user-a-recon", ROTE_CRED_TENANT_A_PASSWORD: "fake-pass-a-recon" }, ["tenant-a"], ["username", "password"]);
  const calls: number[] = [];
  return {
    pool,
    workerId: "reconciler",
    leaseSeconds: LEASE,
    settleMs: 0,
    defer: { budgetSeconds: 600, backoffBaseSeconds: 5, backoffCapSeconds: 60 },
    getBrowser: async () => {
      throw new Error("the scripted lookup never needs a browser");
    },
    credentials,
    redact: createRedactor(credentials),
    evidenceBaseDir: "unused",
    invokeLookup: async ({ attempt }) => {
      calls.push(attempt);
      const next = script[attempt - 1];
      if (!next) throw new Error(`lookup ${attempt} was not scripted`);
      return next;
    },
    ...over,
    metrics: new InMemoryCounters(),
    calls,
  };
}

describe("marking (T4 / T7): only a job that succeeded AFTER A RESUBMIT gets reconcile_after = now() + lease + settle + margin", () => {
  it("T4 succeeded after a resubmit: reconcile_after ~60 s out (database clock), reconciled_at NULL, not settled", async () => {
    const j = await succeededAfterResubmit();
    expect(j).toMatchObject({ state: "succeeded", attempt: 2, reconciled_at: null });
    expect(await dueIn(j.id)).toBeGreaterThan(DUE - 2);
    expect(await dueIn(j.id)).toBeLessThanOrEqual(DUE);
    expect(jobSettled(j)).toBe(false);
  });

  it("T4 succeeded on attempt 1 (no resubmit): no reconcile, settled at once", async () => {
    const { job } = await enqueue(pool, { capability: CAP, tenantId: "tenant-a", idempotencyKey: "plain", params: { memberId: "1" } });
    const a1 = (await dequeue(pool, { workerId: "w1", leaseSeconds: LEASE }))!;
    const outcome = jobOutcomeFor({ kind: "result", result: success("TXN-1") }, { attempt: 1, maxAttempts: 3, irreversibleStarted: true });
    await completeJob(pool, { jobId: a1.id, fencingToken: a1.fencing_token, workerId: "w1", outcome, reconcileDueSeconds: DUE });
    const j = await row(job.id);
    expect(j).toMatchObject({ state: "succeeded", reconcile_after: null });
    expect(jobSettled(j)).toBe(true);
  });

  it("T4 to anything but succeeded after a resubmit (a failure): no reconcile", async () => {
    const a2 = await resubmittedAndLeased();
    const outcome = jobOutcomeFor({ kind: "result", result: { ...cuFailure, commitUncertain: undefined } as ReplayResult }, { attempt: 2, maxAttempts: 3, irreversibleStarted: false });
    await completeJob(pool, { jobId: a2.id, fencingToken: a2.fencing_token, workerId: "w2", outcome, reconcileDueSeconds: DUE });
    expect(await row(a2.id)).toMatchObject({ state: "queued", reconcile_after: null });
  });

  it("T7 already_done after an earlier resubmit (attempt 2 crashed after Submit, verified [1]): marked", async () => {
    const a2 = await resubmittedAndLeased();
    await writeCommitIntent(pool, { jobId: a2.id, fencingToken: a2.fencing_token, workerId: "w2", leaseSeconds: LEASE });
    const outcome = jobOutcomeFor({ kind: "result", result: cuFailure }, { attempt: 2, maxAttempts: 3, irreversibleStarted: true });
    const moved = await completeIntoVerify(pool, { jobId: a2.id, fencingToken: a2.fencing_token, workerId: "w2", leaseSeconds: LEASE, outcome });
    if (!moved.recorded) throw new Error(moved.detail);
    const done = { decision: "already_done" as const, to: "succeeded" as const, outcome: "already_done" as const, confirmationRef: "TXN-7", evidenceRef: "e", error: null };
    await writeVerifyResult(pool, { jobId: a2.id, fencingToken: moved.fencingToken, workerId: "w2", lookups: [1], evidenceRefs: ["e"], decision: done, result: success("TXN-7"), reconcileDueSeconds: DUE });
    expect(await row(a2.id)).toMatchObject({ state: "succeeded", outcome: "already_done", reconciled_at: null });
    expect(await dueIn(a2.id)).toBeGreaterThan(DUE - 2);
  });
});

describe("R1 (the claim) and R2 (the result)", () => {
  it("R1 takes nothing before the job is due; once due it takes it: still succeeded, token + 1, the reconcile lease, a 'reconcile' phase", async () => {
    const j = await succeededAfterResubmit();
    expect(await claimReconcile(pool, { workerId: "r1", leaseSeconds: LEASE })).toBeNull();
    await makeDue(j.id);
    const claim = (await claimReconcile(pool, { workerId: "r1", leaseSeconds: LEASE }))!;
    expect(claim).toMatchObject({ label: "R1", fencingToken: j.fencing_token + 1, confirmationRef: "TXN-000002", job: { id: j.id } });
    expect(await row(j.id)).toMatchObject({ state: "succeeded", fencing_token: j.fencing_token + 1, lease_owner: "r1" });
    expect((await phases(j.id)).at(-1)).toMatchObject({ reason: "reconcile", worker_id: "r1", decision: null });
    expect(await claimReconcile(pool, { workerId: "r2", leaseSeconds: LEASE })).toBeNull(); // held
  });

  it("two concurrent claims never take the same job (SKIP LOCKED); 4 due jobs, 8 claimers: each claimed once", async () => {
    const jobs = [];
    for (let i = 0; i < 4; i += 1) jobs.push(await succeededAfterResubmit(`TXN-${i}`));
    for (const j of jobs) await makeDue(j.id);
    const claims = (await Promise.all(Array.from({ length: 8 }, (_, i) => claimReconcile(pool, { workerId: `r${i}`, leaseSeconds: LEASE })))).filter((c): c is ReconcileClaim => c !== null);
    expect(claims.map((c) => c.job.id).sort()).toEqual(jobs.map((j) => j.id).sort());
  });

  it("a dead reconciler: once its lease expires the job is claimable again; its open phase is closed 'crashed'; its late R2 is fenced (lease_lost)", async () => {
    const j = await succeededAfterResubmit();
    await makeDue(j.id);
    const dead = (await claimReconcile(pool, { workerId: "dead", leaseSeconds: LEASE }))!;
    await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [j.id]);
    const alive = (await claimReconcile(pool, { workerId: "alive", leaseSeconds: LEASE }))!;
    expect(alive.fencingToken).toBe(dead.fencingToken + 1);
    expect((await phases(j.id)).slice(-2).map((p) => [p.worker_id, p.decision])).toEqual([
      ["dead", "crashed"],
      ["alive", null],
    ]);
    const decision = { decision: "reconciled" as const, to: "succeeded" as const, outcome: null, matches: 1 as const, firstMatchRef: "TXN-000002", error: null };
    const late = await writeReconcileResult(pool, { jobId: j.id, fencingToken: dead.fencingToken, workerId: "dead", decision, lookups: [1], evidenceRefs: ["e"], patch: {} });
    expect(late).toMatchObject({ recorded: false, reason: "lease_lost" });
    expect(await row(j.id)).toMatchObject({ lease_owner: "alive", reconciled_at: null }); // untouched
  });

  it("1 match -> reconciled: stays succeeded, reconciled_at set, lease released, settled; the phase says so", async () => {
    const j = await succeededAfterResubmit();
    await makeDue(j.id);
    const c = ctx([count(1, "TXN-000002")]);
    const done = await runReconcilePhase(c, (await claimReconcile(pool, { workerId: "reconciler", leaseSeconds: LEASE }))!);
    expect(done).toMatchObject({ recorded: true, decision: { decision: "reconciled" } });
    const after = await row(j.id);
    expect(after).toMatchObject({ state: "succeeded", outcome: "success", lease_owner: null, lease_expires_at: null });
    expect(after.reconciled_at).toBeInstanceOf(Date);
    expect(jobSettled(after)).toBe(true);
    expect((await phases(j.id)).at(-1)).toMatchObject({ reason: "reconcile", decision: "reconciled", lookups: [1] });
    expect(c.metrics.get("reconcile_decisions_total", { decision: "reconciled" })).toBe(1);
  });

  it("2 matches -> duplicate_suspected: needs_human, the job's own result kept + result.reconcile, duplicates_detected_total = 1, an error-level log line", async () => {
    const j = await succeededAfterResubmit("TXN-000002");
    await makeDue(j.id);
    const errors: Array<Record<string, unknown>> = [];
    const c = ctx([count(2, "TXN-000001")], { log: { info() {}, warn() {}, error: (o) => errors.push(o) } });
    await runReconcilePhase(c, (await claimReconcile(pool, { workerId: "reconciler", leaseSeconds: LEASE }))!);
    const after = await row(j.id);
    expect(after).toMatchObject({ state: "needs_human", outcome: "duplicate_suspected", lease_owner: null });
    expect(after.error).toMatch(/reconcile found 2 transfers with this memo_key/);
    expect(after.result).toMatchObject({
      status: "success",
      outputs: { confirmationRef: "TXN-000002" },
      reconcile: { decision: "duplicate_suspected", matches: 2, firstMatchRef: "TXN-000001", jobConfirmationRef: "TXN-000002", lookups: [2], evidenceRefs: ["evidence://fake-2"] },
    });
    expect(jobSettled(after)).toBe(true);
    expect(c.metrics.get("duplicates_detected_total")).toBe(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ decision: "duplicate_suspected", matches: 2, duplicates_detected_total: 1 });
  });

  it("0 matches, or a page it cannot read -> reconcile_unreadable: needs_human", async () => {
    for (const reading of [count(0), garbled]) {
      const j = await succeededAfterResubmit();
      await makeDue(j.id);
      await runReconcilePhase(ctx([reading]), (await claimReconcile(pool, { workerId: "reconciler", leaseSeconds: LEASE }))!);
      expect(await row(j.id)).toMatchObject({ state: "needs_human", outcome: "reconcile_unreadable" });
    }
  });

  it("the bank unavailable (after the one retry) -> reconcile_deferred: stays succeeded, reconcile_after moved by the backoff, not settled; then due again and reconciled", async () => {
    const j = await succeededAfterResubmit();
    await makeDue(j.id);
    const c = ctx([unavailable]);
    const done = await runReconcilePhase(c, (await claimReconcile(pool, { workerId: "reconciler", leaseSeconds: LEASE }))!);
    expect(done.decision).toMatchObject({ decision: "reconcile_deferred", backoffSeconds: 5 });
    expect(c.calls).toEqual([1]); // BANK_UNAVAILABLE is unavailable at once (no retry: it is not transient)
    const after = await row(j.id);
    expect(after).toMatchObject({ state: "succeeded", reconciled_at: null, lease_owner: null });
    expect(await dueIn(j.id)).toBeGreaterThan(3);
    expect(jobSettled(after)).toBe(false);
    await makeDue(j.id);
    await runReconcilePhase(ctx([count(1)]), (await claimReconcile(pool, { workerId: "reconciler", leaseSeconds: LEASE }))!);
    expect((await phases(j.id)).filter((p) => p.reason === "reconcile").map((p) => p.decision)).toEqual(["reconcile_deferred", "reconciled"]);
    expect(jobSettled(await row(j.id))).toBe(true);
  });
});

describe("rote reconcile --since (the end-of-day batch, D51)", () => {
  it("re-reads every job in the window that succeeded after a resubmit, REGARDLESS of reconciled_at; flags 2+ like R2; leaves not-yet-due jobs to the workers' pass; ignores jobs never resubmitted", async () => {
    const reconciled = await succeededAfterResubmit("TXN-A");
    await makeDue(reconciled.id);
    await runReconcilePhase(ctx([count(1, "TXN-A")]), (await claimReconcile(pool, { workerId: "reconciler", leaseSeconds: LEASE }))!);
    expect((await row(reconciled.id)).reconciled_at).toBeInstanceOf(Date); // the workers' pass ran: 1 match then
    const notDue = await succeededAfterResubmit("TXN-B"); // reconcile_after ~60 s out
    const { job: plain } = await enqueue(pool, { capability: CAP, tenantId: "tenant-a", idempotencyKey: "plain", params: { memberId: "1" } });
    const p1 = (await dequeue(pool, { workerId: "w", leaseSeconds: LEASE }))!;
    await completeJob(pool, { jobId: p1.id, fencingToken: p1.fencing_token, workerId: "w", outcome: jobOutcomeFor({ kind: "result", result: success("TXN-C") }, { attempt: 1, maxAttempts: 3, irreversibleStarted: true }) });
    // A zombie clicked after the pass: the history now shows 2.
    const report = await reconcileWindow(ctx([count(2, "TXN-A")], { workerId: "reconcile:batch" }), { sinceSeconds: 3600 });
    expect(report.rows.map((r) => [r.jobId, r.result])).toEqual([
      [reconciled.id, "duplicate_suspected"],
      [notDue.id, "not_due"],
    ]);
    expect(report).toMatchObject({ flagged: 1, undecided: 0 });
    expect(await row(reconciled.id)).toMatchObject({ state: "needs_human", outcome: "duplicate_suspected" });
    expect(await row(notDue.id)).toMatchObject({ state: "succeeded", reconciled_at: null });
    expect(await row(plain.id)).toMatchObject({ state: "succeeded", reconcile_after: null });
  });

  it("the window: a job whose reconcile_after is older than --since is not read", async () => {
    const j = await succeededAfterResubmit();
    await pool.query("UPDATE jobs SET reconcile_after = now() - interval '2 hours', reconciled_at = now() - interval '2 hours' WHERE id = $1", [j.id]);
    const report = await reconcileWindow(ctx([]), { sinceSeconds: 3600 });
    expect(report.rows).toEqual([]);
  });

  it("a job held by a live reconciler is reported busy, not read", async () => {
    const j = await succeededAfterResubmit();
    await makeDue(j.id);
    await claimReconcile(pool, { workerId: "worker", leaseSeconds: LEASE });
    const report = await reconcileWindow(ctx([]), { sinceSeconds: 3600 });
    expect(report.rows).toMatchObject([{ jobId: j.id, result: "busy" }]);
    expect(report.undecided).toBe(1);
    expect(await claimReconcileJob(pool, { jobId: j.id, workerId: "x", leaseSeconds: LEASE })).toBeNull();
  });

  it("parseDurationSeconds: 90s, 30m, 24h, 2d, a bare number; refuses junk and zero", () => {
    expect(["90s", "30m", "24h", "2d", "45"].map(parseDurationSeconds)).toEqual([90, 1800, 86_400, 172_800, 45]);
    for (const bad of ["", "1w", "-5m", "0", "abc"]) expect(() => parseDurationSeconds(bad), bad).toThrow(RangeError);
  });
});
