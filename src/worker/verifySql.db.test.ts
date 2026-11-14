// The verify transactions against real Postgres (docs/plans/step-09.md section 3, DB): T5 into verify,
// T7 per decision, T8 (deferral, step-09 reviewer decision 5), the cycle read (VERIFY_CYCLE_SQL), the
// reverify hand-off, and the fence on each (a stale verifier writes nothing; D41's lease_lost vs
// illegal_transition).
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Capability } from "../artifact/index.js";
import { dequeue, enqueue, type JobRow, type Pool } from "../queue/index.js";
import { createTestSchema, resetQueueTables, type TestSchema } from "../queue/testDb.js";
import { jobOutcomeFor, verifyDecision, DEFAULT_DEFER_CONFIG, type LookupReading, type VerifyDecision } from "../fleet/stateMachine.js";
import { writeCommitIntent } from "./intent.js";
import { recoverOne } from "./recover.js";
import { completeIntoVerify, deferVerify, readVerifyCycle, reverifyJob, writeVerifyResult } from "./verifySql.js";

const CAP = {
  id: "cap",
  inputs: [{ name: "memberId", type: "string", required: true, redact: false, description: "m" }],
  steps: [],
} as unknown as Pick<Capability, "id" | "inputs" | "steps">;
const LEASE = 30;

let db: TestSchema;
let pool: Pool;

beforeAll(async () => {
  db = await createTestSchema("worker_verify_sql");
  pool = db.pool;
});
afterAll(async () => {
  await db?.drop();
});
beforeEach(async () => {
  await resetQueueTables(pool);
  await pool.query("UPDATE tenants SET max_concurrent = 100"); // verifying jobs count as active
});

async function leased(maxAttempts = 3): Promise<JobRow> {
  await enqueue(pool, { capability: CAP, tenantId: "tenant-a", idempotencyKey: `k-${Math.random()}`, params: { memberId: "1" }, maxAttempts });
  const job = await dequeue(pool, { workerId: "w1", leaseSeconds: LEASE });
  if (!job) throw new Error("no job");
  return job;
}

const row = async (id: string) => (await pool.query("SELECT * FROM jobs WHERE id = $1", [id])).rows[0];
const phases = async (id: string) =>
  (await pool.query("SELECT fencing_token, worker_id, reason, prior_status, decision, lookups, ended_at, error FROM job_verifications WHERE job_id = $1 ORDER BY id", [id])).rows;
const attempt = async (id: string) => (await pool.query("SELECT * FROM job_attempts WHERE job_id = $1", [id])).rows[0];

const cuFailure = {
  status: "failure" as const,
  atStepId: "step-12",
  expected: "x",
  observed: "503",
  category: "unexpected-state" as const,
  evidenceRef: "evidence://t",
  commitUncertain: { irreversibleStepId: "step-11", detail: "write-then-error" },
};
const cuRefusal = { status: "business_outcome" as const, code: "INSUFFICIENT_FUNDS", detail: "refused", evidenceRef: "e", commitUncertain: cuFailure.commitUncertain };

/** A job in this worker's verify phase via T5 (from committing). Returns the phase token. */
async function verifying(result: typeof cuFailure | typeof cuRefusal = cuFailure, maxAttempts = 3): Promise<{ job: JobRow; token: number }> {
  const job = await leased(maxAttempts);
  await writeCommitIntent(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", leaseSeconds: LEASE });
  const outcome = jobOutcomeFor({ kind: "result", result }, { attempt: 1, maxAttempts, irreversibleStarted: true });
  const moved = await completeIntoVerify(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", leaseSeconds: LEASE, outcome });
  if (!moved.recorded) throw new Error(moved.detail);
  return { job, token: moved.fencingToken };
}

const count = (n: number, ref: string | null = n > 0 ? "TXN-000001" : null): LookupReading => ({ kind: "count", n, firstMatchRef: ref, evidenceRef: `evidence://l${n}` });
const decide = (readings: LookupReading[], priorStatus: "business_outcome" | "failure" | null = "failure", attempt = 1, maxAttempts = 3): VerifyDecision =>
  verifyDecision({ readings, priorStatus, attempt, maxAttempts, deferrals: 0, deferredForSeconds: null, defer: DEFAULT_DEFER_CONFIG });

async function t7(job: JobRow, token: number, d: VerifyDecision, lookups: Array<number | null>, workerId = "w1") {
  if (d.decision === "deferred") throw new Error("use T8");
  return writeVerifyResult(pool, {
    jobId: job.id,
    fencingToken: token,
    workerId,
    lookups,
    evidenceRefs: lookups.map(() => "evidence://x"),
    decision: d,
    result: d.decision === "already_done" ? { status: "success", outputs: { confirmationRef: d.confirmationRef }, evidenceRef: "e", recoveredBy: "verify" } : null,
  });
}

describe("T5: completion into verify", () => {
  it("committing -> verifying: token + 1, a fresh lease, outcome commit_uncertain, the result stored, the attempt closed, a phase row (commit_uncertain, prior_status)", async () => {
    const { job, token } = await verifying();
    expect(token).toBe(job.fencing_token + 1);
    const r = await row(job.id);
    expect(r).toMatchObject({ state: "verifying", outcome: "commit_uncertain", fencing_token: token, lease_owner: "w1" });
    expect(r.result).toEqual(cuFailure);
    expect(r.commit_intent_at).toBeInstanceOf(Date);
    expect(await attempt(job.id)).toMatchObject({ outcome: "failure", commit_uncertain: true, fencing_token: job.fencing_token });
    expect((await attempt(job.id)).ended_at).toBeInstanceOf(Date);
    expect(await phases(job.id)).toEqual([
      expect.objectContaining({ fencing_token: token, worker_id: "w1", reason: "commit_uncertain", prior_status: "failure", decision: null, ended_at: null }),
    ]);
    expect(await readVerifyCycle(pool, job.id)).toEqual({ phases: 1, deadPhases: 1, deferrals: 0, deferredForSeconds: null, priorStatus: "failure", lastDecision: null });
  });

  it("also from running (a T3 COMMIT whose result was unknown): a thrown run, prior_status NULL", async () => {
    const job = await leased();
    const outcome = jobOutcomeFor({ kind: "thrown", error: new Error("COMMIT result unknown"), aborted: false }, { attempt: 1, maxAttempts: 3, irreversibleStarted: true });
    const moved = await completeIntoVerify(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", leaseSeconds: LEASE, outcome });
    expect(moved).toMatchObject({ recorded: true });
    expect(await row(job.id)).toMatchObject({ state: "verifying", result: null });
    expect((await phases(job.id))[0]).toMatchObject({ prior_status: null });
  });

  it("fenced: a stale T5 (token bumped by recovery) writes nothing (lease_lost); the same token on a job already verifying is illegal_transition", async () => {
    const job = await leased();
    await writeCommitIntent(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", leaseSeconds: LEASE });
    await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job.id]);
    await recoverOne(pool, { workerId: "rescuer", leaseSeconds: LEASE }); // T6.4: token 2, rescuer verifies
    const before = await row(job.id);
    const outcome = jobOutcomeFor({ kind: "result", result: cuFailure }, { attempt: 1, maxAttempts: 3, irreversibleStarted: true });
    expect(await completeIntoVerify(pool, { jobId: job.id, fencingToken: job.fencing_token, workerId: "w1", leaseSeconds: LEASE, outcome })).toMatchObject({
      recorded: false,
      reason: "lease_lost",
    });
    expect(await row(job.id)).toEqual(before);
    expect((await phases(job.id)).map((p) => p.worker_id)).toEqual(["rescuer"]);
    // The rescuer (token 2) asking for T5 on a job that is already verifying: refused, token unchanged.
    expect(await completeIntoVerify(pool, { jobId: job.id, fencingToken: 2, workerId: "rescuer", leaseSeconds: LEASE, outcome })).toMatchObject({
      recorded: false,
      reason: "illegal_transition",
    });
    expect(await row(job.id)).toEqual(before);
  });
});

describe("T7: the verify result, one row per decision", () => {
  it("[1] -> succeeded / already_done, confirmationRef = the bank's row, the phase decided with its lookups", async () => {
    const { job, token } = await verifying();
    expect(await t7(job, token, decide([count(1, "TXN-000042")]), [1])).toEqual({ recorded: true });
    const r = await row(job.id);
    expect(r).toMatchObject({ state: "succeeded", outcome: "already_done", lease_owner: null, lease_expires_at: null, error: null });
    expect(r.result).toEqual({ status: "success", outputs: { confirmationRef: "TXN-000042" }, evidenceRef: "e", recoveredBy: "verify" });
    expect((await phases(job.id))[0]).toMatchObject({ decision: "already_done", lookups: [1] });
  });

  it("[0, 0], attempts left -> queued (resubmitted): commit_intent_at cleared, outcome NULL, the stored result kept + the verify info", async () => {
    const { job, token } = await verifying();
    expect(await t7(job, token, decide([count(0), count(0)]), [0, 0])).toEqual({ recorded: true });
    const r = await row(job.id);
    // A verified resubmit does not back off (D49): not_before NULL, dequeued at once below.
    expect(r).toMatchObject({ state: "queued", outcome: null, commit_intent_at: null, lease_owner: null, attempt: 1, not_before: null });
    expect(r.result).toMatchObject({ ...cuFailure, verify: { decision: "resubmitted", lookups: [0, 0], phaseToken: token } });
    expect((await phases(job.id))[0]).toMatchObject({ decision: "resubmitted", lookups: [0, 0] });
    expect(await dequeue(pool, { workerId: "w2", leaseSeconds: LEASE })).toMatchObject({ id: job.id, attempt: 2 }); // the resubmit
  });

  it("[0, 0] on the last attempt -> failed / not_committed_attempts_exhausted, never queued (D21)", async () => {
    const { job, token } = await verifying(cuFailure, 1);
    const d = decide([count(0), count(0)], "failure", 1, 1);
    expect(d.decision).toBe("exhausted");
    await t7(job, token, d, [0, 0]);
    expect(await row(job.id)).toMatchObject({ state: "failed", outcome: "not_committed_attempts_exhausted" });
  });

  it("[0, 0] after a refusal shown after Submit -> business_outcome (the refusal stands), never retried", async () => {
    const { job, token } = await verifying(cuRefusal);
    expect((await readVerifyCycle(pool, job.id)).priorStatus).toBe("business_outcome");
    const d = decide([count(0), count(0)], "business_outcome");
    expect(d.decision).toBe("not_committed_final");
    await t7(job, token, d, [0, 0]);
    const r = await row(job.id);
    expect(r).toMatchObject({ state: "business_outcome", outcome: "business_outcome" });
    expect(r.result).toMatchObject({ code: "INSUFFICIENT_FUNDS", verify: { decision: "not_committed_final" } });
  });

  it("[0, 2] -> needs_human / ambiguous with both lookups' evidence; unreadable -> needs_human / unreadable", async () => {
    const a = await verifying();
    await t7(a.job, a.token, decide([count(0), count(2)]), [0, 2]);
    expect(await row(a.job.id)).toMatchObject({ state: "needs_human", outcome: "ambiguous" });
    expect((await row(a.job.id)).result.verify).toMatchObject({ lookups: [0, 2], evidenceRefs: ["evidence://x", "evidence://x"] });
    const b = await verifying();
    await t7(b.job, b.token, decide([{ kind: "unreadable", detail: "count not a number", evidenceRef: null }]), [null]);
    expect(await row(b.job.id)).toMatchObject({ state: "needs_human", outcome: "unreadable" });
    expect((await phases(b.job.id))[0]).toMatchObject({ decision: "escalated", lookups: [null] });
  });

  it("a stale T7 after a re-claim writes nothing on jobs; its own phase row says lease_lost and keeps recovery's note", async () => {
    const { job, token } = await verifying();
    await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job.id]);
    const r = await recoverOne(pool, { workerId: "v2", leaseSeconds: LEASE }); // T6.5
    expect(r!.action.label).toBe("T6.5");
    const before = await row(job.id);
    expect(await t7(job, token, decide([count(1)]), [1])).toMatchObject({ recorded: false, reason: "lease_lost" });
    expect(await row(job.id)).toEqual(before);
    const [dead, live] = await phases(job.id);
    expect(dead).toMatchObject({ decision: "lease_lost" });
    expect(dead.error).toMatch(/^lease lost before T7 \(already_done\).*\[recovery had recorded: lease expired in verifying; recovered by v2 \(T6\.5 verify\)\]$/);
    expect(live).toMatchObject({ worker_id: "v2", decision: null });
  });

  it("the guard: T7 never writes `verifying` or `running` (token unchanged -> illegal_transition, the phase says so)", async () => {
    const { job, token } = await verifying();
    const bogus = { ...decide([count(1)]), to: "running" } as unknown as VerifyDecision;
    expect(await t7(job, token, bogus, [1])).toMatchObject({ recorded: false, reason: "illegal_transition" });
    expect(await row(job.id)).toMatchObject({ state: "verifying", lease_owner: "w1" });
    expect((await phases(job.id))[0]).toMatchObject({ decision: "illegal_transition" });
  });
});

describe("T8: deferral (the bank unavailable), step-09 reviewer decision 5", () => {
  it("the job STAYS verifying with the deferring verifier as owner (jobs_active_has_owner), the token bumped (nobody holds it), lease = now + backoff; the phase is `deferred`", async () => {
    const { job, token } = await verifying();
    const d = verifyDecision({
      readings: [{ kind: "unavailable", detail: "BANK_UNAVAILABLE", evidenceRef: "evidence://down" }],
      priorStatus: "failure",
      attempt: 1,
      maxAttempts: 3,
      deferrals: 0,
      deferredForSeconds: null,
      defer: DEFAULT_DEFER_CONFIG,
    });
    if (d.decision !== "deferred") throw new Error("expected a deferral");
    expect(d.backoffSeconds).toBe(5);
    const res = await deferVerify(pool, { jobId: job.id, fencingToken: token, workerId: "w1", lookups: [null], evidenceRefs: ["evidence://down"], decision: d });
    expect(res).toEqual({ recorded: true, fencingToken: token + 1 });
    const r = await row(job.id);
    expect(r).toMatchObject({ state: "verifying", outcome: "commit_uncertain", fencing_token: token + 1, lease_owner: "w1" });
    expect(r.error).toMatch(/verify deferred 5 s \(deferral 1; the bank is unavailable\)/);
    const left = (await pool.query("SELECT EXTRACT(EPOCH FROM lease_expires_at - now())::float8 AS s FROM jobs WHERE id = $1", [job.id])).rows[0].s;
    expect(left).toBeGreaterThan(3);
    expect(left).toBeLessThanOrEqual(5);
    expect((await phases(job.id))[0]).toMatchObject({ decision: "deferred", lookups: [null] });
    // The deferring verifier is fenced out of its own job (its old token): a heartbeat or T7 gets 0 rows.
    expect(await t7(job, token, decide([count(1)]), [1])).toMatchObject({ recorded: false, reason: "lease_lost" });
    const cycle = await readVerifyCycle(pool, job.id);
    expect(cycle).toMatchObject({ phases: 1, deadPhases: 0, deferrals: 1, lastDecision: "deferred" });
    expect(cycle.deferredForSeconds).toBeGreaterThanOrEqual(0);
    expect(cycle.deferredForSeconds).toBeLessThan(5);
    // Recovery leaves it alone until the backoff has passed (database clock), then resumes it (T6.7).
    expect(await recoverOne(pool, { workerId: "r", leaseSeconds: LEASE })).toBeNull();
    await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job.id]);
    const resumed = await recoverOne(pool, { workerId: "r", leaseSeconds: LEASE });
    expect(resumed).toMatchObject({ action: { label: "T6.7" }, claim: { priorStatus: "failure", fencingToken: token + 2 } });
  });

  it("the budget: deferred-for (database clock, from the first deferral's end) at or past the budget -> needs_human / verify_unavailable", async () => {
    const { job, token } = await verifying();
    const unavailable = (deferrals: number, deferredForSeconds: number | null) =>
      verifyDecision({
        readings: [{ kind: "unavailable", detail: "BANK_UNAVAILABLE", evidenceRef: null }],
        priorStatus: "failure",
        attempt: 1,
        maxAttempts: 3,
        deferrals,
        deferredForSeconds,
        defer: DEFAULT_DEFER_CONFIG,
      });
    const first = unavailable(0, null);
    if (first.decision !== "deferred") throw new Error("expected a deferral");
    await deferVerify(pool, { jobId: job.id, fencingToken: token, workerId: "w1", lookups: [null], evidenceRefs: [null], decision: first });
    // 650 s pass on the database clock (the deferral ended that long ago), and the backoff is over.
    await pool.query("UPDATE job_verifications SET started_at = started_at - interval '650 seconds', ended_at = ended_at - interval '650 seconds' WHERE job_id = $1", [job.id]);
    await pool.query("UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [job.id]);
    const resumed = await recoverOne(pool, { workerId: "r", leaseSeconds: LEASE });
    expect(resumed).toMatchObject({ action: { label: "T6.7" }, fencingToken: token + 2 });
    const cycle = await readVerifyCycle(pool, job.id);
    expect(cycle).toMatchObject({ phases: 2, deadPhases: 1, deferrals: 1, lastDecision: null });
    expect(cycle.deferredForSeconds).toBeGreaterThanOrEqual(650);
    // Still unavailable, and past the 600 s budget: escalate instead of deferring again.
    const d = unavailable(cycle.deferrals, cycle.deferredForSeconds);
    expect(d).toMatchObject({ decision: "escalated", outcome: "verify_unavailable" });
    expect(await t7(job, token + 2, d, [null], "r")).toEqual({ recorded: true });
    expect(await row(job.id)).toMatchObject({ state: "needs_human", outcome: "verify_unavailable" });
    expect((await phases(job.id)).map((p) => [p.reason, p.decision])).toEqual([
      ["commit_uncertain", "deferred"],
      ["resumed", "escalated"],
    ]);
  });
});

describe("rote jobs reverify (the SQL)", () => {
  async function parked(outcome: string, result: unknown = cuFailure): Promise<JobRow> {
    const job = await leased();
    await pool.query("UPDATE jobs SET state = 'needs_human', outcome = $2, result = $3::jsonb, lease_owner = NULL, lease_expires_at = NULL WHERE id = $1", [
      job.id,
      outcome,
      JSON.stringify(result),
    ]);
    return job;
  }

  it("a needs_human / commit_uncertain job (Steps 6-8 parked these) is handed to recovery: verifying, token + 1, lease already expired, a handed_off phase", async () => {
    const job = await parked("commit_uncertain", cuRefusal);
    const res = await reverifyJob(pool, { jobId: job.id, who: "reverify:ops" });
    expect(res).toEqual({ moved: true, fencingToken: job.fencing_token + 1, priorStatus: "business_outcome" });
    const r = await row(job.id);
    expect(r).toMatchObject({ state: "verifying", outcome: "commit_uncertain", lease_owner: "reverify:ops" });
    expect(r.lease_expires_at.getTime()).toBeLessThan(Date.now() + 1000);
    expect(await phases(job.id)).toEqual([
      expect.objectContaining({ worker_id: "reverify:ops", reason: "commit_uncertain", prior_status: "business_outcome", decision: "handed_off" }),
    ]);
    // The next recovery resumes it (T6.7) and its prior_status decides what [0, 0] means.
    const resumed = await recoverOne(pool, { workerId: "w9", leaseSeconds: LEASE });
    expect(resumed).toMatchObject({ action: { label: "T6.7" }, claim: { priorStatus: "business_outcome" } });
  });

  it("accepts the 'could not tell' outcomes; refuses ambiguous, other needs_human, other states, another tenant, a missing job", async () => {
    for (const outcome of ["unreadable", "verify_unavailable", "verify_exhausted"]) {
      expect((await reverifyJob(pool, { jobId: (await parked(outcome)).id, who: "x" })).moved).toBe(true);
    }
    for (const outcome of ["ambiguous", "needs_human"]) {
      expect(await reverifyJob(pool, { jobId: (await parked(outcome)).id, who: "x" })).toEqual({ moved: false, why: "not_reverifiable", state: "needs_human", outcome });
    }
    const running = await leased();
    expect(await reverifyJob(pool, { jobId: running.id, who: "x" })).toMatchObject({ moved: false, why: "not_reverifiable", state: "running" });
    const p = await parked("commit_uncertain");
    expect(await reverifyJob(pool, { jobId: p.id, tenant: "tenant-b", who: "x" })).toEqual({ moved: false, why: "not_found" });
    expect(await reverifyJob(pool, { jobId: "00000000-0000-4000-8000-000000000000", who: "x" })).toEqual({ moved: false, why: "not_found" });
    expect((await reverifyJob(pool, { jobId: p.id, tenant: "tenant-a", who: "x" })).moved).toBe(true);
    // Fenced on its state: a second reverify of the same job is refused (it is verifying now).
    expect(await reverifyJob(pool, { jobId: p.id, who: "x" })).toMatchObject({ moved: false, state: "verifying" });
  });
});
