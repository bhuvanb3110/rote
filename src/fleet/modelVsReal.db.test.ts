// Model vs real (Step 8 reviewer addition R1; Step 9 adds T5, T7, T8, the verify claims T6.4-T6.7 and
// the reverify hand-off): fast-check model-based (command) testing that runs the SAME random command
// sequences against the pure model (src/fleet/model.ts) and the real SQL on a test Postgres schema, and
// compares, after EVERY command, each job's state, fencing token, owner, attempt, outcome and lease, its
// verify cycle as VERIFY_CYCLE_SQL derives it from job_verifications (phases, dead phases, deferrals,
// deferred-for, prior status, the newest phase's decision), its requeue backoff (not_before, Step 10 D49),
// plus each command's own answer (leased which
// job, extended or not, recorded / fenced (lease_lost) / illegal_transition / CHECK violation, which jobs
// recovered how, which one was claimed to verify). This is what catches drift between the model the
// property tests trust and the SQL the workers run.
//
// TIME: the database clock is never faked. Time is simulated by SHIFTING EVERY STORED TIME BACK by dt
// (`lease_expires_at`, and job_verifications' started_at / ended_at), which is exactly equivalent to the
// database clock moving forward by dt, because every rule compares those with now(). The model advances
// its `now` by the same dt. Real time also passes while a sequence runs (a few ms per command), so the
// lease and deferred-for comparisons allow a slack of 1 s PLUS the real time since the stored times were
// last compensated (see sync): under load one command (a dequeue transaction and the compare's reads) can
// itself take more than a second, and that time moves every real remaining-time by at most that much
// (Step 10: a loaded 8 GB laptop drifted 1.27 s; the bound is sound, the answers are still compared
// exactly). A command whose answer depends on a lease boundary is not generated while a lease sits within
// 1 s of it (fast-check `check`); with whole-second leases and ticks that only excludes "exactly at
// expiry", where `>` and `<` are both false. A recovery
// is also not generated while two expired jobs share an expiry and one of them would be claimed to
// verify: the sweep stops at its claim, and Postgres breaks such a tie by the real (millisecond) order of
// the writes, which the model's whole seconds do not record.
//
// About 200 sequences of up to 30 commands, a fixed seed; on failure fast-check prints the seed and the
// shrunk command sequence (each command's toString), e.g. `dequeue(wA), tick(31), recover(wB), ...`.
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Capability } from "../artifact/index.js";
import { dequeue, enqueue, sqlState, type Pool } from "../queue/index.js";
import { createTestSchema, resetQueueTables, type TestSchema } from "../queue/testDb.js";
import { completeJob } from "../worker/complete.js";
import { extendLease } from "../worker/heartbeat.js";
import { writeCommitIntent } from "../worker/intent.js";
import { FencingError } from "../worker/leaseErrors.js";
import { recoverExpired } from "../worker/recover.js";
import { completeIntoVerify, deferVerify, readVerifyCycle, reverifyJob, writeVerifyResult } from "../worker/verifySql.js";
import { jobOutcomeFor, type JobOutcome, type VerifyDecision } from "./stateMachine.js";
import {
  isActive,
  leaseRemaining,
  modelComplete,
  modelCompleteIntoVerify,
  modelDequeue,
  modelHeartbeat,
  modelIntent,
  modelRecover,
  modelReverify,
  modelTick,
  modelVerifyCycle,
  modelVerifyDefer,
  modelVerifyResult,
  newJob,
  notBeforeRemaining,
  type ModelDb,
  type ModelFencedResult,
  type ModelJob,
} from "./model.js";

const LEASE = 30;
const SEED = 1111;
const RUNS = 200;
/** The verify-focused property (sequences that start in verifying). */
const VERIFY_RUNS = 100;
const TENANT = "tenant-a";
const WORKERS = ["wA", "wB", "wC"] as const;
type W = (typeof WORKERS)[number];

const CAP = {
  id: "cap",
  inputs: [{ name: "memberId", type: "string", required: true, redact: false, description: "m" }],
  steps: [],
} as unknown as Pick<Capability, "id" | "inputs" | "steps">;

let db: TestSchema;

beforeAll(async () => {
  db = await createTestSchema("model_vs_real", { max: 2 });
});
afterAll(async () => {
  await db?.drop();
});

interface Model {
  db: ModelDb;
  /** The lease each worker last took: what it would present to T2/T3/T4 (kept after it is stale: a zombie). */
  held: Partial<Record<W, { jobId: string; token: number }>>;
}
interface Real {
  pool: Pool;
  /** Last seen token per job, for R2b. */
  tokens: Map<string, number>;
  /** Date.now() when the stored times were last re-synced (see sync). */
  lastSync: number;
}

/**
 * Stops real time from leaking into the comparison: before every command, every stored time moves
 * FORWARD by the real time that passed since the last command (the inverse of TickCmd), so between
 * commands the database clock stands still relative to the data, as the model's does. Only the few ms a
 * command itself takes are left for the 1 s slack. (Without it, a loaded machine -- the full parallel
 * suite -- let a sequence drift past the slack: Step 9's first full run, `lease remaining real 28.995 vs
 * model 30`.)
 */
async function sync(r: Real): Promise<void> {
  const now = Date.now();
  const elapsed = (now - r.lastSync) / 1000;
  if (elapsed < 0.1) return; // a few ms are what the 1 s slack is for; they accumulate until here
  r.lastSync = now; // the updates' own time is compensated by the next sync
  // Only the times a rule compares with now(): leases, and the phase ends that "deferred for" is measured
  // from. A row written inside the window is shifted by up to the window's length too much (it did not
  // exist for all of it): well inside the 1 s slack, but enough to push a started_at past a later
  // ended_at = now(), so started_at is never shifted forward (moving ended_at forward keeps
  // ended_at >= started_at).
  await r.pool.query(
    `UPDATE jobs SET lease_expires_at = lease_expires_at + make_interval(secs => $1), not_before = not_before + make_interval(secs => $1)
     WHERE lease_expires_at IS NOT NULL OR not_before IS NOT NULL`,
    [elapsed],
  );
  await r.pool.query("UPDATE job_verifications SET ended_at = ended_at + make_interval(secs => $1) WHERE ended_at IS NOT NULL", [elapsed]);
}

/** Every command runs after a sync. */
function synced(c: Cmd): Cmd {
  return { check: (m) => c.check(m), run: async (m, r) => { await sync(r); await c.run(m, r); }, toString: () => c.toString() };
}

interface RealJob {
  id: string;
  state: string;
  attempt: number;
  fencing_token: number;
  lease_owner: string | null;
  outcome: string | null;
  remaining: number | null;
  /** Seconds until not_before (negative = due), or null. */
  not_before_in: number | null;
}

async function readReal(pool: Pool): Promise<RealJob[]> {
  return (
    await pool.query<RealJob>(
      `SELECT id, state, attempt, fencing_token, lease_owner, outcome,
              EXTRACT(EPOCH FROM (lease_expires_at - now()))::float8 AS remaining,
              EXTRACT(EPOCH FROM (not_before - now()))::float8 AS not_before_in
       FROM jobs ORDER BY created_at, id`,
    )
  ).rows;
}

/** After every command: the model and the database agree, and R2a/R2b hold in the database. */
async function compare(m: Model, r: Real, after: string): Promise<void> {
  const real = await readReal(r.pool);
  // Real time not yet compensated by sync() when the rows above were read: the most any real
  // remaining-time can have drifted from the model's (1 s base, as before, for the whole-second model).
  const slack = 1 + Math.max(0, (Date.now() - r.lastSync) / 1000);
  expect(real.map((j) => j.id), after).toEqual(m.db.jobs.map((j) => j.id));
  const cycles = await Promise.all(real.map((j) => readVerifyCycle(r.pool, j.id)));
  for (const [i, mj] of m.db.jobs.entries()) {
    const rj = real[i]!;
    const where = `${after}: job ${i}`;
    expect({ state: rj.state, attempt: rj.attempt, token: rj.fencing_token, owner: rj.lease_owner, outcome: rj.outcome }, where).toEqual({
      state: mj.state,
      attempt: mj.attempt,
      token: mj.token,
      owner: mj.owner,
      outcome: mj.outcome,
    });
    const mRemaining = leaseRemaining(mj, m.db.now);
    if (mRemaining === null) expect(rj.remaining, `${where}: lease`).toBeNull();
    else {
      expect(rj.remaining, `${where}: lease`).not.toBeNull();
      expect(Math.abs(rj.remaining! - mRemaining), `${where}: lease remaining real ${rj.remaining} vs model ${mRemaining} (slack ${slack.toFixed(3)} s)`).toBeLessThan(slack);
    }
    // The requeue backoff (D49).
    const mNotBefore = notBeforeRemaining(mj, m.db.now);
    if (mNotBefore === null) expect(rj.not_before_in, `${where}: not_before`).toBeNull();
    else {
      expect(rj.not_before_in, `${where}: not_before`).not.toBeNull();
      expect(Math.abs(rj.not_before_in! - mNotBefore), `${where}: not_before in real ${rj.not_before_in} vs model ${mNotBefore} (slack ${slack.toFixed(3)} s)`).toBeLessThan(slack);
    }
    // The verify cycle (VERIFY_CYCLE_SQL vs the model's phases).
    const rc = cycles[i]!;
    const mc = modelVerifyCycle(mj, m.db.now);
    expect({ ...rc, deferredForSeconds: rc.deferredForSeconds === null }, `${where}: verify cycle`).toEqual({ ...mc, deferredForSeconds: mc.deferredForSeconds === null });
    if (mc.deferredForSeconds !== null) {
      expect(Math.abs(rc.deferredForSeconds! - mc.deferredForSeconds), `${where}: deferred for real ${rc.deferredForSeconds} vs model ${mc.deferredForSeconds} (slack ${slack.toFixed(3)} s)`).toBeLessThan(slack);
    }
    // R2b: the token never decreases.
    const prev = r.tokens.get(rj.id) ?? 0;
    expect(rj.fencing_token, `${where}: token decreased`).toBeGreaterThanOrEqual(prev);
    r.tokens.set(rj.id, rj.fencing_token);
    // R2a: at most one worker holds a valid lease (owner + token match, lease_expires_at > now).
    const valid = WORKERS.filter((w) => {
      const h = m.held[w];
      return h?.jobId === rj.id && h.token === rj.fencing_token && rj.lease_owner === w && rj.remaining !== null && rj.remaining > 0;
    });
    expect(valid.length, `${where}: workers with a valid lease ${JSON.stringify(valid)}`).toBeLessThanOrEqual(1);
  }
}

/** A lease within 1 s of now: the next lease-checked answer could differ by the few ms of real time. */
function nearBoundary(m: Model, jobId?: string): boolean {
  return m.db.jobs.some((j) => (jobId === undefined || j.id === jobId) && isActive(j.state) && j.leaseExpiresAt !== null && Math.abs(j.leaseExpiresAt - m.db.now) < 1);
}

/** A queued job's backoff within 1 s of passing: whether a dequeue takes it could differ by the few ms of real time. */
function nearDue(m: Model): boolean {
  return m.db.jobs.some((j) => j.state === "queued" && j.notBefore !== null && Math.abs(j.notBefore - m.db.now) < 1);
}

type Cmd = fc.AsyncCommand<Model, Real>;

/** How often each interesting answer happened (the agreement must not be vacuous). */
const hits = new Map<string, number>();
const hit = (key: string) => hits.set(key, (hits.get(key) ?? 0) + 1);

class DequeueCmd implements Cmd {
  constructor(readonly w: W) {}
  check = (m: Readonly<Model>) => !nearDue(m as Model);
  async run(m: Model, r: Real) {
    const { db: next, job } = modelDequeue(m.db, this.w, LEASE);
    const real = await dequeue(r.pool, { workerId: this.w, leaseSeconds: LEASE });
    expect(real ? { id: real.id, token: real.fencing_token } : null, this.toString()).toEqual(job ? { id: job.id, token: job.token } : null);
    // A queued job was there but not due yet: the backoff held it back (D49).
    if (!job && m.db.jobs.some((j) => j.state === "queued" && j.notBefore !== null && j.notBefore > m.db.now)) hit("dequeue:held_back_by_not_before");
    m.db = next;
    if (job) m.held[this.w] = { jobId: job.id, token: job.token };
    await compare(m, r, this.toString());
  }
  toString = () => `dequeue(${this.w})`;
}

class HeartbeatCmd implements Cmd {
  constructor(readonly w: W) {}
  check = (m: Readonly<Model>) => m.held[this.w] !== undefined && !nearBoundary(m as Model, m.held[this.w]!.jobId);
  async run(m: Model, r: Real) {
    const h = m.held[this.w]!;
    const { db: next, extended } = modelHeartbeat(m.db, { jobId: h.jobId, token: h.token, owner: this.w }, LEASE);
    const real = await extendLease(r.pool, { jobId: h.jobId, fencingToken: h.token, workerId: this.w, leaseSeconds: LEASE });
    expect(real, this.toString()).toBe(extended);
    m.db = next;
    await compare(m, r, this.toString());
  }
  toString = () => `heartbeat(${this.w})`;
}

class IntentCmd implements Cmd {
  constructor(readonly w: W) {}
  check = (m: Readonly<Model>) => m.held[this.w] !== undefined && !nearBoundary(m as Model, m.held[this.w]!.jobId);
  async run(m: Model, r: Real) {
    const h = m.held[this.w]!;
    const { db: next, written } = modelIntent(m.db, { jobId: h.jobId, token: h.token, owner: this.w }, LEASE);
    let real: boolean;
    try {
      await writeCommitIntent(r.pool, { jobId: h.jobId, fencingToken: h.token, workerId: this.w, leaseSeconds: LEASE });
      real = true;
    } catch (err) {
      if (!(err instanceof FencingError)) throw err;
      real = false;
    }
    expect(real, this.toString()).toBe(written);
    m.db = next;
    await compare(m, r, this.toString());
  }
  toString = () => `intent(${this.w})`;
}

type T4Target = Exclude<JobOutcome["state"], "verifying">;
const OUTCOMES: Record<T4Target, Pick<JobOutcome, "outcome" | "attemptOutcome">> = {
  succeeded: { outcome: "success", attemptOutcome: "success" },
  needs_human: { outcome: "commit_uncertain", attemptOutcome: "needs_human" },
  failed: { outcome: "failure", attemptOutcome: "failure" },
  business_outcome: { outcome: "business_outcome", attemptOutcome: "business_outcome" },
  queued: { outcome: null, attemptOutcome: "failure" },
};

/** What a fenced write's real answer maps to in the model's vocabulary. */
async function realFenced(write: () => Promise<{ recorded: boolean; reason?: string }>): Promise<ModelFencedResult> {
  try {
    const res = await write();
    return res.recorded ? "recorded" : res.reason === "illegal_transition" ? "illegal_transition" : "fenced";
  } catch (err) {
    if (sqlState(err) !== "23514") throw err;
    return "check_violation";
  }
}

class CompleteCmd implements Cmd {
  constructor(
    readonly w: W,
    readonly to: T4Target,
    /** A requeue's backoff (D49), seconds; ignored for every other target. */
    readonly backoff: number | null = null,
  ) {}
  check = (m: Readonly<Model>) => m.held[this.w] !== undefined;
  async run(m: Model, r: Real) {
    const h = m.held[this.w]!;
    const { db: next, result } = modelComplete(m.db, { jobId: h.jobId, token: h.token, owner: this.w }, this.to, OUTCOMES[this.to].outcome, null, {
      notBeforeSeconds: this.backoff,
    });
    const outcome: JobOutcome = { state: this.to, ...OUTCOMES[this.to], error: null, result: null, commitUncertain: false };
    let real: "recorded" | "fenced" | "illegal_transition" | "check_violation";
    try {
      const res = await completeJob(r.pool, { jobId: h.jobId, fencingToken: h.token, workerId: this.w, outcome, requeueAfterSeconds: this.backoff });
      real = res.recorded ? "recorded" : res.reason === "illegal_transition" ? "illegal_transition" : "fenced";
    } catch (err) {
      if (sqlState(err) !== "23514") throw err;
      real = "check_violation";
    }
    expect(real, this.toString()).toBe(result);
    m.db = next;
    await compare(m, r, this.toString());
  }
  toString = () => `complete(${this.w}, ${this.to}${this.to === "queued" && this.backoff !== null ? `, backoff ${this.backoff}` : ""})`;
}

/**
 * Two expired jobs sharing an expiry, one of them claimable to verify: the sweep's stop-at-claim would
 * depend on the real millisecond order of the writes, which the model does not record.
 */
function claimTie(m: Model): boolean {
  const expired = m.db.jobs.filter((j) => isActive(j.state) && j.leaseExpiresAt !== null && j.leaseExpiresAt < m.db.now);
  if (!expired.some((j) => j.state === "committing" || j.state === "verifying")) return false;
  return new Set(expired.map((j) => j.leaseExpiresAt)).size < expired.length;
}

class RecoverCmd implements Cmd {
  constructor(readonly w: W) {}
  check = (m: Readonly<Model>) => !nearBoundary(m as Model) && !claimTie(m as Model);
  async run(m: Model, r: Real) {
    const { db: next, recovered, claimed } = modelRecover(m.db, 10, { owner: this.w, leaseSeconds: LEASE });
    const real = await recoverExpired(r.pool, { workerId: this.w, leaseSeconds: LEASE, max: 10 });
    const key = (x: { jobId: string; action: { kind: string; label: string }; token?: number; fencingToken?: number }) =>
      `${x.jobId}:${x.action.kind}:${x.action.label}:${x.token ?? x.fencingToken}`;
    expect(real.recovered.map(key).sort(), this.toString()).toEqual(recovered.map(key).sort());
    expect(real.claim ? `${real.claim.job.id}:${real.claim.fencingToken}` : null, `${this.toString()}: claim`).toEqual(claimed ? `${claimed.jobId}:${claimed.token}` : null);
    for (const x of recovered) hit(`recover:${x.action.label}`);
    m.db = next;
    if (claimed) m.held[this.w] = { jobId: claimed.jobId, token: claimed.token };
    await compare(m, r, this.toString());
  }
  toString = () => `recover(${this.w})`;
}

const CU = { irreversibleStepId: "step-11", detail: "attempted (model vs real)" };
const PRIOR_RESULTS = {
  failure: { status: "failure" as const, atStepId: "step-12", expected: "x", observed: "y", category: "unknown" as const, evidenceRef: "e", commitUncertain: CU },
  business_outcome: { status: "business_outcome" as const, code: "INSUFFICIENT_FUNDS", detail: "refused", evidenceRef: "e", commitUncertain: CU },
};

/** T5: the holder's run may have committed; into its own verify phase. */
class CompleteIntoVerifyCmd implements Cmd {
  constructor(
    readonly w: W,
    readonly prior: keyof typeof PRIOR_RESULTS,
  ) {}
  check = (m: Readonly<Model>) => m.held[this.w] !== undefined;
  async run(m: Model, r: Real) {
    const h = m.held[this.w]!;
    const outcome = jobOutcomeFor({ kind: "result", result: PRIOR_RESULTS[this.prior] }, { attempt: 1, maxAttempts: 3, irreversibleStarted: true });
    const { db: next, result, token } = modelCompleteIntoVerify(m.db, { jobId: h.jobId, token: h.token, owner: this.w }, LEASE, outcome.priorStatus ?? null, outcome.result);
    let realToken: number | null = null;
    const real = await realFenced(async () => {
      const res = await completeIntoVerify(r.pool, { jobId: h.jobId, fencingToken: h.token, workerId: this.w, leaseSeconds: LEASE, outcome });
      if (res.recorded) realToken = res.fencingToken;
      return res;
    });
    expect(real, this.toString()).toBe(result);
    expect(realToken, `${this.toString()}: token`).toBe(token);
    hit(`T5:${result}`);
    m.db = next;
    if (token !== null) m.held[this.w] = { jobId: h.jobId, token };
    await compare(m, r, this.toString());
  }
  toString = () => `completeIntoVerify(${this.w}, ${this.prior})`;
}

const DECISIONS: Record<Exclude<VerifyDecision["decision"], "deferred">, Exclude<VerifyDecision, { decision: "deferred" }>> = {
  already_done: { decision: "already_done", to: "succeeded", outcome: "already_done", confirmationRef: "TXN-000001", evidenceRef: "e", error: null },
  resubmitted: { decision: "resubmitted", to: "queued", outcome: null, error: "verified not committed" },
  exhausted: { decision: "exhausted", to: "failed", outcome: "not_committed_attempts_exhausted", error: "verified not committed, last attempt" },
  not_committed_final: { decision: "not_committed_final", to: "business_outcome", outcome: "business_outcome", error: "the refusal stands" },
  escalated: { decision: "escalated", to: "needs_human", outcome: "unreadable", error: "could not read the history" },
};

/** The worker that holds a verifying job right now (by the model), if any. Deterministic in the model state. */
function verifierOf(m: Readonly<Model>): W | undefined {
  return WORKERS.find((x) => {
    const h = m.held[x];
    const j = h && m.db.jobs.find((jj) => jj.id === h.jobId);
    return j !== undefined && j.state === "verifying" && j.token === h!.token && j.owner === x;
  });
}
type Who = W | "holder";
/** "holder": whoever holds a verifying job (a T7/T8 that can succeed); a named worker: possibly a stale one. */
const resolve = (m: Readonly<Model>, who: Who): W | undefined => (who === "holder" ? verifierOf(m) : m.held[who] ? who : undefined);

/** T7: the verifier's decision. (Which decision is right is verifyDecision's job, tested elsewhere; here, what each one writes.) */
class VerifyResultCmd implements Cmd {
  constructor(
    readonly who: Who,
    readonly decision: keyof typeof DECISIONS,
  ) {}
  check = (m: Readonly<Model>) => resolve(m, this.who) !== undefined;
  async run(m: Model, r: Real) {
    const w = resolve(m, this.who)!;
    const h = m.held[w]!;
    const d = DECISIONS[this.decision];
    const lookups = d.decision === "already_done" ? [1] : [0, 0];
    const result = d.decision === "already_done" ? { status: "success", outputs: { confirmationRef: "TXN-000001" }, evidenceRef: "e", recoveredBy: "verify" } : undefined;
    const { db: next, result: answer } = modelVerifyResult(m.db, { jobId: h.jobId, token: h.token, owner: w }, d, lookups, result);
    const real = await realFenced(() =>
      writeVerifyResult(r.pool, { jobId: h.jobId, fencingToken: h.token, workerId: w, lookups, evidenceRefs: lookups.map(() => "e"), decision: d, result: result ?? null }),
    );
    expect(real, this.toString()).toBe(answer);
    hit(`T7:${this.decision}:${answer}`);
    m.db = next;
    await compare(m, r, this.toString());
  }
  toString = () => `verifyResult(${this.who}, ${this.decision})`;
}

/** T8: the bank is unavailable; defer. */
class VerifyDeferCmd implements Cmd {
  constructor(
    readonly who: Who,
    readonly backoff: number,
  ) {}
  check = (m: Readonly<Model>) => resolve(m, this.who) !== undefined;
  async run(m: Model, r: Real) {
    const w = resolve(m, this.who)!;
    const h = m.held[w]!;
    const d = { decision: "deferred" as const, to: "verifying" as const, outcome: "commit_uncertain" as const, backoffSeconds: this.backoff, error: "bank unavailable" };
    const { db: next, result } = modelVerifyDefer(m.db, { jobId: h.jobId, token: h.token, owner: w }, this.backoff, [null]);
    hit(`T8:${result}`);
    const real = await realFenced(() => deferVerify(r.pool, { jobId: h.jobId, fencingToken: h.token, workerId: w, lookups: [null], evidenceRefs: [null], decision: d }));
    expect(real, this.toString()).toBe(result);
    m.db = next;
    await compare(m, r, this.toString());
  }
  toString = () => `verifyDefer(${this.who}, ${this.backoff})`;
}

/** rote jobs reverify on job i. */
class ReverifyCmd implements Cmd {
  constructor(readonly i: number) {}
  check = (m: Readonly<Model>) => this.i < m.db.jobs.length;
  async run(m: Model, r: Real) {
    const id = m.db.jobs[this.i]!.id;
    const { db: next, token } = modelReverify(m.db, id, "reverify:cli");
    const real = await reverifyJob(r.pool, { jobId: id, who: "reverify:cli" });
    expect(real.moved ? real.fencingToken : null, this.toString()).toBe(token);
    hit(`reverify:${token === null ? "refused" : "moved"}`);
    m.db = next;
    await compare(m, r, this.toString());
  }
  toString = () => `reverify(job ${this.i})`;
}

class TickCmd implements Cmd {
  constructor(readonly dt: number) {}
  check = () => true;
  async run(m: Model, r: Real) {
    // The database clock moving forward by dt == every stored time moving back by dt.
    await r.pool.query(
      `UPDATE jobs SET lease_expires_at = lease_expires_at - make_interval(secs => $1), not_before = not_before - make_interval(secs => $1)
       WHERE lease_expires_at IS NOT NULL OR not_before IS NOT NULL`,
      [this.dt],
    );
    await r.pool.query(
      "UPDATE job_verifications SET started_at = started_at - make_interval(secs => $1), ended_at = ended_at - make_interval(secs => $1)",
      [this.dt],
    );
    m.db = modelTick(m.db, this.dt);
    await compare(m, r, this.toString());
  }
  toString = () => `tick(${this.dt})`;
}

const w = fc.constantFrom(...WORKERS);
const who = fc.constantFrom<Who>(...WORKERS, "holder", "holder");
const commandArbs = [
  w.map((x) => new DequeueCmd(x)),
  w.map((x) => new HeartbeatCmd(x)),
  w.map((x) => new IntentCmd(x)),
  fc.tuple(w, fc.constantFrom<T4Target>("succeeded", "needs_human", "failed", "queued", "business_outcome"), fc.constantFrom<number | null>(null, 8, 10.5, 30, 36)).map(
    ([x, to, backoff]) => new CompleteCmd(x, to, backoff),
  ),
  w.map((x) => new RecoverCmd(x)),
  // The verify commands twice or three times over (fc.commands picks uniformly among these
  // arbitraries): T7/T8 need a job the same worker holds in verifying, which is rarer than a dequeue.
  ...Array.from({ length: 2 }, () => fc.tuple(w, fc.constantFrom<keyof typeof PRIOR_RESULTS>("failure", "business_outcome")).map(([x, p]) => new CompleteIntoVerifyCmd(x, p))),
  ...Array.from({ length: 3 }, () =>
    fc.tuple(who, fc.constantFrom<keyof typeof DECISIONS>("already_done", "resubmitted", "exhausted", "not_committed_final", "escalated")).map(([x, d]) => new VerifyResultCmd(x, d)),
  ),
  ...Array.from({ length: 2 }, () => fc.tuple(who, fc.constantFrom(5, 20)).map(([x, b]) => new VerifyDeferCmd(x, b))),
  ...Array.from({ length: 2 }, () => fc.constantFrom(0, 1).map((i) => new ReverifyCmd(i))),
  fc.constantFrom(5, 12, 29, 31, 45).map((dt) => new TickCmd(dt)),
].map((arb) => arb.map((c) => synced(c)));

describe("model vs real SQL (R1): dequeue, T2, T3, T4, T5, T6 (T6.1-T6.7), T7, T8 and reverify on a test Postgres schema", () => {
  it(`${RUNS} seeded command sequences agree after every command`, async () => {
    const pool = db.pool;
    let commandsRun = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.record({ cap: fc.constantFrom(1, 2), maxAttempts: fc.constantFrom(1, 2, 3), jobs: fc.constantFrom(1, 2) }),
        fc.commands(commandArbs, { maxCommands: 30, size: "max" }),
        async (cfg, cmds) => {
          await resetQueueTables(pool);
          await pool.query("UPDATE tenants SET max_concurrent = $1 WHERE id = $2", [cfg.cap, TENANT]);
          const jobs: ModelJob[] = [];
          for (let i = 0; i < cfg.jobs; i += 1) {
            const { job } = await enqueue(pool, { capability: CAP, tenantId: TENANT, idempotencyKey: `mvr-${i}`, params: { memberId: "1" }, maxAttempts: cfg.maxAttempts });
            jobs.push(newJob({ id: job.id, tenant: TENANT, seq: i + 1, maxAttempts: cfg.maxAttempts }));
          }
          const setup = () => ({
            model: { db: { now: 0, jobs, caps: { [TENANT]: cfg.cap } }, held: {} } as Model,
            real: { pool, tokens: new Map<string, number>(), lastSync: Date.now() } as Real,
          });
          await fc.asyncModelRun(setup, cmds);
          commandsRun += [...cmds].length;
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
    expect(commandsRun).toBeGreaterThan(RUNS * 5); // the sequences were not trivially short
  }, 300_000);

  it(`${VERIFY_RUNS} more sequences that START with a job in committing (a real dequeue + T3) or in verifying (+ T5): the expired-commit claim, the verify writes, re-claims and deferrals; then every Step 9 path was exercised`, async () => {
    const pool = db.pool;
    await fc.assert(
      fc.asyncProperty(
        fc.record({
          maxAttempts: fc.constantFrom(1, 2, 3),
          jobs: fc.constantFrom(1, 2),
          prior: fc.constantFrom<keyof typeof PRIOR_RESULTS>("failure", "business_outcome"),
          // committing: the T6.4 claim (an expired commit) is one tick + one recovery away; it no longer depends on luck.
          start: fc.constantFrom<"committing" | "verifying">("committing", "verifying"),
        }),
        fc.commands(commandArbs, { maxCommands: 15, size: "max" }),
        async (cfg, cmds) => {
          await resetQueueTables(pool);
          await pool.query("UPDATE tenants SET max_concurrent = 2 WHERE id = $1", [TENANT]);
          const jobs: ModelJob[] = [];
          for (let i = 0; i < cfg.jobs; i += 1) {
            const { job } = await enqueue(pool, { capability: CAP, tenantId: TENANT, idempotencyKey: `mvr-v-${i}`, params: { memberId: "1" }, maxAttempts: cfg.maxAttempts });
            jobs.push(newJob({ id: job.id, tenant: TENANT, seq: i + 1, maxAttempts: cfg.maxAttempts }));
          }
          const model = { db: { now: 0, jobs, caps: { [TENANT]: 2 } }, held: {} } as Model;
          const real = { pool, tokens: new Map<string, number>(), lastSync: Date.now() } as Real;
          // The prefix, through the same commands (so it is compared too): wA takes job 0 and writes its intent,
          // or verifies it.
          const second = cfg.start === "committing" ? new IntentCmd("wA") : new CompleteIntoVerifyCmd("wA", cfg.prior);
          for (const c of [new DequeueCmd("wA"), second].map(synced)) await c.run(model, real);
          await fc.asyncModelRun(() => ({ model, real }), cmds);
        },
      ),
      { numRuns: VERIFY_RUNS, seed: SEED + 1 },
    );
    // Every Step 9 path was exercised, recorded AND fenced, not just generated (both tests together).
    const seen = JSON.stringify(Object.fromEntries(hits));
    for (const key of [
      "T5:recorded", "T5:fenced", "T5:illegal_transition",
      "T7:already_done:recorded", "T7:resubmitted:recorded", "T7:exhausted:recorded", "T7:not_committed_final:recorded", "T7:escalated:recorded",
      "T7:resubmitted:check_violation",
      "T8:recorded", "T8:fenced", "T8:illegal_transition",
      "recover:T6.1", "recover:T6.2", "recover:T6.4", "recover:T6.5", "recover:T6.7",
      "dequeue:held_back_by_not_before",
      "reverify:moved", "reverify:refused",
    ]) {
      expect(hits.get(key) ?? 0, `never happened: ${key}; seen ${seen}`).toBeGreaterThan(0);
    }
    const t7Any = (suffix: string) => [...hits.keys()].some((k) => k.startsWith("T7:") && k.endsWith(suffix));
    expect(t7Any(":fenced"), `a stale T7 never happened; seen ${seen}`).toBe(true);
    expect(t7Any(":illegal_transition"), `an illegal T7 never happened; seen ${seen}`).toBe(true);
  }, 300_000);
});
