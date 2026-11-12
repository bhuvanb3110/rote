// Model vs real (Step 8 reviewer addition R1): fast-check model-based (command) testing that runs the
// SAME random command sequences against the pure model (src/fleet/model.ts) and the real SQL on a test
// Postgres schema -- dequeue, T2 heartbeat, T3 commit intent, T4 completion, T6 recovery (T5 and T7 join
// in Step 9) -- and compares, after EVERY command, each job's state, fencing token, owner, attempt,
// outcome and lease, plus each command's own answer (leased which job, extended or not, fenced or not,
// recorded / fenced / CHECK violation, which jobs recovered how). This is what catches drift between
// the model the property tests trust and the SQL the workers run.
//
// TIME: the database clock is never faked. Time is simulated by SHIFTING EVERY STORED LEASE BACK by dt
// (`UPDATE jobs SET lease_expires_at = lease_expires_at - dt`), which is exactly equivalent to the
// database clock moving forward by dt, because every lease rule compares lease_expires_at with now().
// The model advances its `now` by the same dt. Real time also passes while a sequence runs (a few ms per
// command), so the lease comparison allows 1 s of slack, and a command whose answer depends on a lease
// boundary is not generated while a lease sits within 1 s of it (fast-check `check`); with whole-second
// leases and ticks that only excludes "exactly at expiry", where `>` and `<` are both false.
//
// About 200 sequences of up to 25 commands, a fixed seed; on failure fast-check prints the seed and the
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
import type { JobOutcome } from "./stateMachine.js";
import {
  isActive,
  leaseRemaining,
  modelComplete,
  modelDequeue,
  modelHeartbeat,
  modelIntent,
  modelRecover,
  modelTick,
  newJob,
  type ModelDb,
  type ModelJob,
} from "./model.js";

const LEASE = 30;
const SEED = 1111;
const RUNS = 200;
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
}

interface RealJob {
  id: string;
  state: string;
  attempt: number;
  fencing_token: number;
  lease_owner: string | null;
  outcome: string | null;
  remaining: number | null;
}

async function readReal(pool: Pool): Promise<RealJob[]> {
  return (
    await pool.query<RealJob>(
      `SELECT id, state, attempt, fencing_token, lease_owner, outcome,
              EXTRACT(EPOCH FROM (lease_expires_at - now()))::float8 AS remaining
       FROM jobs ORDER BY created_at, id`,
    )
  ).rows;
}

/** After every command: the model and the database agree, and R2a/R2b hold in the database. */
async function compare(m: Model, r: Real, after: string): Promise<void> {
  const real = await readReal(r.pool);
  expect(real.map((j) => j.id), after).toEqual(m.db.jobs.map((j) => j.id));
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
      expect(Math.abs(rj.remaining! - mRemaining), `${where}: lease remaining real ${rj.remaining} vs model ${mRemaining}`).toBeLessThan(1);
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

type Cmd = fc.AsyncCommand<Model, Real>;

class DequeueCmd implements Cmd {
  constructor(readonly w: W) {}
  check = () => true;
  async run(m: Model, r: Real) {
    const { db: next, job } = modelDequeue(m.db, this.w, LEASE);
    const real = await dequeue(r.pool, { workerId: this.w, leaseSeconds: LEASE });
    expect(real ? { id: real.id, token: real.fencing_token } : null, this.toString()).toEqual(job ? { id: job.id, token: job.token } : null);
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

const OUTCOMES: Record<JobOutcome["state"], Pick<JobOutcome, "outcome" | "attemptOutcome">> = {
  succeeded: { outcome: "success", attemptOutcome: "success" },
  needs_human: { outcome: "commit_uncertain", attemptOutcome: "needs_human" },
  failed: { outcome: "failure", attemptOutcome: "failure" },
  business_outcome: { outcome: "business_outcome", attemptOutcome: "business_outcome" },
  queued: { outcome: null, attemptOutcome: "failure" },
};

class CompleteCmd implements Cmd {
  constructor(
    readonly w: W,
    readonly to: JobOutcome["state"],
  ) {}
  check = (m: Readonly<Model>) => m.held[this.w] !== undefined;
  async run(m: Model, r: Real) {
    const h = m.held[this.w]!;
    const { db: next, result } = modelComplete(m.db, { jobId: h.jobId, token: h.token, owner: this.w }, this.to, OUTCOMES[this.to].outcome);
    const outcome: JobOutcome = { state: this.to, ...OUTCOMES[this.to], error: null, result: null, commitUncertain: false };
    let real: "recorded" | "fenced" | "check_violation";
    try {
      real = (await completeJob(r.pool, { jobId: h.jobId, fencingToken: h.token, workerId: this.w, outcome })).recorded ? "recorded" : "fenced";
    } catch (err) {
      if (sqlState(err) !== "23514") throw err;
      real = "check_violation";
    }
    expect(real, this.toString()).toBe(result);
    m.db = next;
    await compare(m, r, this.toString());
  }
  toString = () => `complete(${this.w}, ${this.to})`;
}

class RecoverCmd implements Cmd {
  constructor(readonly w: W) {}
  check = (m: Readonly<Model>) => !nearBoundary(m as Model);
  async run(m: Model, r: Real) {
    const { db: next, recovered } = modelRecover(m.db, 10);
    const real = await recoverExpired(r.pool, { workerId: this.w, max: 10 });
    const key = (x: { jobId: string; action: { kind: string }; token?: number; fencingToken?: number }) =>
      `${x.jobId}:${x.action.kind}:${x.token ?? x.fencingToken}`;
    expect(real.map(key).sort(), this.toString()).toEqual(recovered.map(key).sort());
    m.db = next;
    await compare(m, r, this.toString());
  }
  toString = () => `recover(${this.w})`;
}

class TickCmd implements Cmd {
  constructor(readonly dt: number) {}
  check = () => true;
  async run(m: Model, r: Real) {
    // The database clock moving forward by dt == every stored lease moving back by dt.
    await r.pool.query("UPDATE jobs SET lease_expires_at = lease_expires_at - make_interval(secs => $1) WHERE lease_expires_at IS NOT NULL", [this.dt]);
    m.db = modelTick(m.db, this.dt);
    await compare(m, r, this.toString());
  }
  toString = () => `tick(${this.dt})`;
}

const w = fc.constantFrom(...WORKERS);
const commandArbs = [
  w.map((x) => new DequeueCmd(x)),
  w.map((x) => new HeartbeatCmd(x)),
  w.map((x) => new IntentCmd(x)),
  fc.tuple(w, fc.constantFrom<JobOutcome["state"]>("succeeded", "needs_human", "failed", "queued", "business_outcome")).map(([x, to]) => new CompleteCmd(x, to)),
  w.map((x) => new RecoverCmd(x)),
  fc.constantFrom(5, 12, 29, 31, 45).map((dt) => new TickCmd(dt)),
];

describe("model vs real SQL (R1): dequeue, T2, T3, T4, T6 on a test Postgres schema", () => {
  it(`${RUNS} seeded command sequences agree after every command`, async () => {
    const pool = db.pool;
    let commandsRun = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.record({ cap: fc.constantFrom(1, 2), maxAttempts: fc.constantFrom(1, 2, 3), jobs: fc.constantFrom(1, 2) }),
        fc.commands(commandArbs, { maxCommands: 25, size: "max" }),
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
            real: { pool, tokens: new Map<string, number>() } as Real,
          });
          await fc.asyncModelRun(setup, cmds);
          commandsRun += [...cmds].length;
        },
      ),
      { numRuns: RUNS, seed: SEED },
    );
    expect(commandsRun).toBeGreaterThan(RUNS * 5); // the sequences were not trivially short
  }, 300_000);
});
