// Property tests of the fleet's state machine (docs/plans/step-08.md section 7, reviewer addition R2;
// Step 9 forms per docs/plans/step-09.md), fast-check over a pure simulation: ONE transfer job, a bank
// ledger whose history shows a row only `lag` seconds after it was written (step-09 reviewer decision 4)
// and that can be down (its 503: decision 5), three workers that crash, restart, freeze (docker pause)
// and wake, and the database clock. Every job transition goes through src/fleet/model.ts (which mirrors
// the SQL) and every decision through the real jobOutcomeFor / completionAllowed / recoveryAction /
// verifyDecision, so these properties are about the code the worker runs.
//
// A verifier's phase is three kinds of event: `lookup` (the next history read; the second one only once
// the settle period has passed since the first), `decide` (verifyDecision, then T7 or T8), and the
// heartbeats inside `tick`. Recovery inside `dequeue` can hand an idle worker a job to verify (T6.4/
// T6.5/T6.7), and a run that may have committed moves into its own worker's verify phase (T5).
//
// Each property: 10 000 generated event sequences, a fixed seed; a failure prints the seed and the
// SHRUNK event sequence. Every sequence ends with the same drain (everyone wakes, the bank comes back,
// live runs and verify phases finish, the clock passes every lease and backoff, clean workers loop until
// the job is terminal), and the invariants are checked on every single transition.
//
// Step 9 reopens the zombie window (docs/plans/step-08.md section 6): verify + resubmit means a worker
// frozen after its intent can click after another worker resubmitted. And a history lag longer than the
// settle period makes [0, 0] wrong. So:
//   property 1  no duplicate unless a worker clicked with a lease that was no longer valid (the zombie)
//               or the history lag exceeds the settle period -- and both preconditions are shown to be
//               NECESSARY (fast-check finds a duplicate without each);
//   property 2  no duplicate at all when no click lands more than lease + settle after the clicker's
//               lease was last extended (no pause spans lease + settle), with no history lag;
//   property 5  every requeue after an intent passed through a verify whose two lookups counted 0.
//
// Step 10 adds the requeue backoff (D49): T4's requeue after a failure sets not_before, and a separate
// simulation (below) proves that an outage shorter than the backoff schedule fails no job. And the
// reconcile pass (D50; every terminal state since the reviewer decisions on 10a, D55): a job that turned
// succeeded / failed / business_outcome after a [0, 0] verify is re-read once due (R1 in an idle worker's
// loop, one `lookup`, `decide` = R2); the drain runs past the reconcile delay, so:
//   property 4  terminal states are final, with ONE exception: a reconcile's flag (terminal -> needs_human)
//   property 8  a duplicate never stays silently `succeeded`, unless a row became visible in the history
//               only after the reconcile's read (the zombie that clicks after the pass: the honest limit), or
//               the pass abandoned the job's reconcile after max_crashes dead reconcilers (D59: settled, but
//               `reconcile: "abandoned"`)
//   property 10 an unrecorded commit (a row against a job that ended failed / business_outcome) never stays
//               silent either, with the same exemptions (D55)
//   property 9  with the end-of-day batch (rote reconcile --since, D51) after the drain: neither, ever (the
//               batch also covers an abandoned reconcile, D59)
//
// Step 10b (D57, D58, the reviewer decisions during 10b): crashes stop using attempts, and every worker death
// counts against ONE crash budget. A lease that dies before its intent (T6.1) is a lease crash; a lease that dies
// after it (T6.4) and a verifier that dies (T6.5) are deaths too; the death that reaches max_crashes fails the job
// before any intent (T6.2) and sends it to a human after one (T6.6), both `crash_limit`. The simulation counts
// ITSELF, never from the model's counters: leases and lease crashes from the transitions (a dequeue: queued ->
// running; a lease crash: running -> queued / failed with the token bumped), and every death in its recovery
// step, from the job as it was before (an expired active lease, unless a deferred or handed-off verify), so:
//   property 11 a job is never failed or escalated by worker deaths before max_crashes of them, and never failed
//               by fewer than max_attempts of its own failures (leases that were not lease crashes); a job past
//               its intent is never failed by the cap, only escalated
//   property 12 (D59) a reconciler's deaths never touch a terminal job's crash counts; the pass abandons a
//               reconcile only after max_crashes of them; the end-of-day batch still flags what it would have
//               (its own scenarios: dead reconcilers under caps of 1-5)
// The randomized tests print how often each path was reached (src/testing/coverage.ts), so a path the
// generator rarely or never reaches shows up in every run's log.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ReplayResult } from "../artifact/index.js";
import { checkLedger, type LedgerRow } from "../oracle/index.js";
import { printCoverage } from "../testing/coverage.js";
import {
  isActive,
  isTerminal,
  modelComplete,
  modelCompleteIntoVerify,
  modelDequeue,
  modelHeartbeat,
  modelIntent,
  modelReconcileClaim,
  modelReconcileClaimJob,
  modelReconcileCycle,
  modelReconcileResult,
  modelRecover,
  modelSettled,
  modelTick,
  modelVerifyCycle,
  modelVerifyDefer,
  modelVerifyResult,
  newJob,
  type LeaseRef,
  type ModelDb,
  type ModelJob,
} from "./model.js";
import {
  alreadyDoneResult,
  DEFAULT_MAX_CRASHES,
  isReconcilable,
  jobOutcomeFor,
  lookupsColumn,
  minRequeueScheduleSeconds,
  ownAttempts,
  readingsComplete,
  RECONCILE_FLAGS,
  reconcileDecision,
  reconcileDueSeconds,
  requeueBackoffSeconds,
  verifyDecision,
  type CompletionTarget,
  type DeferConfig,
  type LookupReading,
  type ReconcilableState,
  type RunEnd,
} from "./stateMachine.js";

const LEASE = 30;
const BEAT = 10;
const SETTLE = 5;
const RECOVER_PER_LOOP = 10;
/** lease + settle + margin, as in production (30 + 5 + 25 = 60 s). */
const RECONCILE_DUE = reconcileDueSeconds(LEASE, SETTLE * 1000, 25);
/** Smaller than production (600 / 5 / 60) so outages can exhaust it within a sequence. */
const DEFER: DeferConfig = { budgetSeconds: 120, backoffBaseSeconds: 5, backoffCapSeconds: 20 };
const RUNS = 10_000;
const SEED = 20261111;
const JOB_ID = "00000000-0000-4000-8000-000000000001";
const MEMO = `rote-${JOB_ID}`;
const TENANT = "tenant-a";

// ------------------------------------------------------------------------------------------ events

type How = "ok" | "failure" | "refused" | "throw";
type Ev =
  /** The worker loop: T6 recovery (which may hand it a job to verify), then dequeue. */
  | { k: "dequeue"; w: number }
  /** A recovery sweep by an idle worker (its dequeue found nothing). */
  | { k: "recover"; w: number }
  /** onIrreversible.before: T3. */
  | { k: "intent"; w: number }
  /** The Submit reaches the bank: it appends a row (commits) or refuses. */
  | { k: "click"; w: number; commits: boolean }
  /** runReplay ends; jobOutcomeFor; T4, or T5 into this worker's verify phase. */
  | { k: "finish"; w: number; how: How }
  /** A verifier's next history lookup (the second only once SETTLE has passed since the first). */
  | { k: "lookup"; w: number }
  /** A verifier decides (verifyDecision) and writes it: T7, or T8 when the bank is unavailable. */
  | { k: "decide"; w: number }
  | { k: "crash"; w: number }
  | { k: "restart"; w: number }
  | { k: "pause"; w: number }
  /** beatFirst: the overdue heartbeat runs before anything else on waking (else the zombie acts first). */
  | { k: "resume"; w: number; beatFirst: boolean }
  /** The bank's 503 on (up: false) or off. */
  | { k: "bank"; up: boolean }
  /** The clock moves; live holders beat every <= 10 s within it. */
  | { k: "tick"; dt: number };

const worker = fc.integer({ min: 0, max: 2 });
const EVENT_ARBS: Record<Ev["k"], fc.Arbitrary<Ev>> = {
  dequeue: worker.map((w) => ({ k: "dequeue" as const, w })),
  recover: worker.map((w) => ({ k: "recover" as const, w })),
  intent: worker.map((w) => ({ k: "intent" as const, w })),
  click: fc.record({ k: fc.constant("click" as const), w: worker, commits: fc.boolean() }),
  finish: fc.record({ k: fc.constant("finish" as const), w: worker, how: fc.constantFrom<How>("ok", "failure", "refused", "throw") }),
  lookup: worker.map((w) => ({ k: "lookup" as const, w })),
  decide: worker.map((w) => ({ k: "decide" as const, w })),
  crash: worker.map((w) => ({ k: "crash" as const, w })),
  restart: worker.map((w) => ({ k: "restart" as const, w })),
  pause: worker.map((w) => ({ k: "pause" as const, w })),
  resume: fc.record({ k: fc.constant("resume" as const), w: worker, beatFirst: fc.boolean() }),
  bank: fc.boolean().map((up) => ({ k: "bank" as const, up })),
  tick: fc.integer({ min: 1, max: 45 }).map((dt) => ({ k: "tick" as const, dt })),
};
const eventOf = (weights: Record<Ev["k"], number>): fc.Arbitrary<Ev> =>
  fc.oneof(...(Object.keys(weights) as Array<Ev["k"]>).map((k) => ({ weight: weights[k], arbitrary: EVENT_ARBS[k] })));
const BASE_WEIGHTS: Record<Ev["k"], number> = { dequeue: 3, recover: 1, intent: 3, click: 3, finish: 2, lookup: 3, decide: 2, crash: 2, restart: 2, pause: 2, resume: 2, bank: 1, tick: 3 };
/** Many crashes, freezes and outages, over longer sequences: dead verifiers, exhausted deferral budgets. */
const STORM_WEIGHTS: Record<Ev["k"], number> = { dequeue: 3, recover: 1, intent: 2, click: 2, finish: 2, lookup: 3, decide: 3, crash: 3, restart: 3, pause: 2, resume: 2, bank: 3, tick: 4 };
const eventArb = eventOf(BASE_WEIGHTS);
const eventsArb = fc.array(eventArb, { maxLength: 60, size: "max" });
const stormArb = fc.array(eventOf(STORM_WEIGHTS), { maxLength: 100, size: "max" });
/**
 * The zombie window (docs/plans/step-08.md section 6) as a template with random noise between its
 * steps: w0 freezes after its intent, w1 verifies [0, 0] and resubmits, w2 transfers, w0 wakes and
 * clicks first. Random search alone almost never lines these up; the noise keeps it a search (a crash
 * or a tick in the wrong place defuses it, which is half the point).
 */
const zombieArb: fc.Arbitrary<Ev[]> = fc
  .tuple(fc.integer({ min: 31, max: 45 }), fc.integer({ min: 5, max: 9 }), fc.array(fc.array(eventArb, { maxLength: 2 }), { minLength: 15, maxLength: 15 }))
  .map(([expire, settle, noise]) => {
    const core: Ev[] = [
      { k: "dequeue", w: 0 },
      { k: "intent", w: 0 },
      { k: "pause", w: 0 },
      { k: "tick", dt: expire },
      { k: "dequeue", w: 1 },
      { k: "lookup", w: 1 },
      { k: "tick", dt: settle },
      { k: "lookup", w: 1 },
      { k: "decide", w: 1 },
      { k: "dequeue", w: 2 },
      { k: "intent", w: 2 },
      { k: "click", w: 2, commits: true },
      { k: "finish", w: 2, how: "ok" },
      { k: "resume", w: 0, beatFirst: false },
      { k: "click", w: 0, commits: true },
    ];
    return core.flatMap((ev, i) => [ev, ...noise[i]!]);
  });
/** A core sequence with 0..2 random events after each step. */
const withNoise = (core: Ev[]): fc.Arbitrary<Ev[]> =>
  fc.array(fc.array(eventArb, { maxLength: 2 }), { minLength: core.length, maxLength: core.length }).map((noise) => core.flatMap((ev, i) => [ev, ...noise[i]!]));
/**
 * Verifiers that keep dying (T6.5, then T6.6 at the crash cap: needs_human / crash_limit, D58), the first worker
 * having committed or not. Its death plus five dead verifiers: 6 deaths, past the default cap of 5.
 */
const deadVerifiersArb: fc.Arbitrary<Ev[]> = fc.boolean().chain((clicked) =>
  withNoise([
    { k: "dequeue", w: 0 },
    { k: "intent", w: 0 },
    ...(clicked ? [{ k: "click", w: 0, commits: true } as Ev] : []),
    { k: "crash", w: 0 },
    ...[1, 2, 0, 1, 2].flatMap((w): Ev[] => [{ k: "tick", dt: 31 }, { k: "restart", w }, { k: "dequeue", w }, { k: "lookup", w }, { k: "crash", w }]),
    { k: "tick", dt: 31 },
    { k: "restart", w: 0 },
    { k: "dequeue", w: 0 },
  ]),
);
/** A long bank outage during a verify: deferrals (T8/T6.7), possibly past the budget (verify_unavailable). */
const outageArb: fc.Arbitrary<Ev[]> = fc.tuple(fc.boolean(), fc.integer({ min: 3, max: 9 })).chain(([clicked, rounds]) =>
  withNoise([
    { k: "dequeue", w: 0 },
    { k: "intent", w: 0 },
    ...(clicked ? [{ k: "click", w: 0, commits: true } as Ev] : []),
    { k: "crash", w: 0 },
    { k: "bank", up: false },
    { k: "tick", dt: 31 },
    ...Array.from({ length: rounds }, (_, i): Ev[] => [
      { k: "dequeue", w: 1 + (i % 2) },
      { k: "lookup", w: 1 + (i % 2) },
      { k: "decide", w: 1 + (i % 2) },
      { k: "tick", dt: 21 },
    ]).flat(),
  ]),
);
/**
 * The reconcile pass's honest limit (D50): the zombie of zombieArb, but it stays frozen past the reconcile
 * delay and clicks only after a worker's reconcile READ the history (R1, lookup), before or after its R2.
 */
const lateZombieArb: fc.Arbitrary<Ev[]> = fc.boolean().chain((clickBeforeDecide) =>
  withNoise([
    { k: "dequeue", w: 0 },
    { k: "intent", w: 0 },
    { k: "pause", w: 0 },
    { k: "tick", dt: 31 },
    { k: "dequeue", w: 1 },
    { k: "lookup", w: 1 },
    { k: "tick", dt: 5 },
    { k: "lookup", w: 1 },
    { k: "decide", w: 1 },
    { k: "dequeue", w: 2 },
    { k: "intent", w: 2 },
    { k: "click", w: 2, commits: true },
    { k: "finish", w: 2, how: "ok" },
    { k: "tick", dt: 45 },
    { k: "tick", dt: 20 }, // past the reconcile delay (60 s)
    { k: "dequeue", w: 1 }, // R1
    { k: "lookup", w: 1 }, // the reconcile reads: 1 row
    ...(clickBeforeDecide
      ? ([{ k: "resume", w: 0, beatFirst: false }, { k: "click", w: 0, commits: true }, { k: "decide", w: 1 }] as Ev[])
      : ([{ k: "decide", w: 1 }, { k: "resume", w: 0, beatFirst: false }, { k: "click", w: 0, commits: true }] as Ev[])),
  ]),
);
/**
 * D55 (the reviewer decisions on 10a, decision 2): the zombie window again, but the job does NOT succeed
 * after the resubmit -- attempt 2 fails before Submit, is refused, or its worker dies (since D57 a crash:
 * the job runs once more, unless a small crash cap fails it) -- and the zombie's
 * late click lands on a job that says no money moved. Or (resubmit: false) the verify on the LAST attempt
 * reads [0, 0] and fails the job outright (exhausted) while its own worker is still frozen.
 */
const zombieThenNotSucceededArb: fc.Arbitrary<Ev[]> = fc
  .tuple(fc.constantFrom<"failure" | "refused" | "crash">("failure", "refused", "crash"), fc.boolean())
  .chain(([end, resubmit]) =>
    withNoise([
      { k: "dequeue", w: 0 },
      { k: "intent", w: 0 },
      { k: "pause", w: 0 },
      { k: "tick", dt: 31 },
      { k: "dequeue", w: 1 }, // T6.4
      { k: "lookup", w: 1 },
      { k: "tick", dt: 5 },
      { k: "lookup", w: 1 },
      { k: "decide", w: 1 }, // [0, 0]: resubmitted (attempts left) or exhausted
      ...(resubmit
        ? ([{ k: "dequeue", w: 2 }, end === "crash" ? { k: "crash", w: 2 } : { k: "finish", w: 2, how: end }, { k: "tick", dt: 31 }, { k: "recover", w: 1 }] as Ev[])
        : []),
      { k: "resume", w: 0, beatFirst: false },
      { k: "click", w: 0, commits: true },
    ]),
  );
/**
 * D57: a run of leases, each ending one way -- its worker dies before the intent (a crash: T6.1, or T6.2 at
 * the cap), it fails before Submit (an own failure: T4, backed off), it throws, or it transfers -- with noise
 * between them. The first bank-fault+kills chaos run (seed 41379566) is two of these: 1:crashed 2:crashed
 * 3:failure, and 1:crashed 2:failure 3:crashed, each then failed under Step 8's rule.
 */
type LeaseEnd = "crash" | "failure" | "throw" | "ok";
const leaseRunArb: fc.Arbitrary<Ev[]> = fc
  .array(fc.constantFrom<LeaseEnd>("crash", "crash", "failure", "throw", "ok"), { minLength: 1, maxLength: 9 })
  .chain((ends) =>
    withNoise(
      ends.flatMap((end, i): Ev[] => {
        const w = i % 3;
        if (end === "crash") return [{ k: "dequeue", w }, { k: "crash", w }, { k: "tick", dt: 31 }, { k: "restart", w }];
        if (end === "ok") return [{ k: "dequeue", w }, { k: "intent", w }, { k: "click", w, commits: true }, { k: "finish", w, how: "ok" }];
        return [{ k: "dequeue", w }, { k: "finish", w, how: end }, { k: "tick", dt: 31 }]; // past the backoff (10 s, 30 s)
      }),
    ),
  );
/** A poison job (D57): every worker that leases it dies before its intent, up to and past the crash cap. */
const crashLoopArb: fc.Arbitrary<Ev[]> = fc
  .integer({ min: 1, max: 7 })
  .chain((n) => withNoise(Array.from({ length: n }, (_, i): Ev[] => [{ k: "dequeue", w: i % 3 }, { k: "crash", w: i % 3 }, { k: "tick", dt: 31 }, { k: "restart", w: i % 3 }]).flat()));
/**
 * Property 11's scenarios: small crash caps, so the cap is reached before the intent (lease runs, poison loops)
 * and after it (dead verifiers, D58); the storm for everything else at once.
 */
const crashScenarioArb = fc.record({
  maxAttempts: fc.integer({ min: 1, max: 3 }),
  maxCrashes: fc.integer({ min: 1, max: 5 }),
  lag: fc.constant(0),
  events: fc.oneof(
    { weight: 3, arbitrary: leaseRunArb },
    { weight: 2, arbitrary: crashLoopArb },
    { weight: 2, arbitrary: deadVerifiersArb },
    { weight: 1, arbitrary: stormArb },
  ),
});
const lagArb = fc.oneof(fc.constant(0), fc.integer({ min: 0, max: 12 }));
const scenarioArb = fc.record({
  maxAttempts: fc.integer({ min: 1, max: 3 }),
  /** The bank's history visibility delay, seconds (0 = shows at once). */
  lag: lagArb,
  events: fc.oneof(
    { weight: 4, arbitrary: eventsArb },
    { weight: 3, arbitrary: stormArb },
    { weight: 1, arbitrary: zombieArb },
    { weight: 1, arbitrary: deadVerifiersArb },
    { weight: 1, arbitrary: outageArb },
    { weight: 1, arbitrary: lateZombieArb },
    { weight: 1, arbitrary: zombieThenNotSucceededArb },
  ),
});
/** maxCrashes: the job's crash cap (D57); default 5, as jobs.max_crashes. */
type Scenario = { maxAttempts: number; maxCrashes?: number; lag: number; events: Ev[] };

// ------------------------------------------------------------------------------------------- world

type Phase = "idle" | "steps" | "intent" | "clicked" | "verify" | "reconcile";
interface SimWorker {
  name: string;
  incarnation: number;
  alive: boolean;
  paused: boolean;
  phase: Phase;
  /**
   * The lease this worker believes it holds (kept while frozen: that is the zombie), with the job's attempt
   * and lease crashes as its dequeued row carried them (what the worker passes to jobOutcomeFor, D57).
   */
  held: { token: number; attempt: number; leaseCrashes: number } | null;
  /** Database time its held lease was last set or extended (dequeue, T3, T2, T5, a claim). */
  lastExtendedAt: number;
  /** The row its click wrote, when the bank committed it. */
  clickedRow: LedgerRow | null;
  /** Its verify phase: the lookups so far and when the first one was read. */
  verify: { readings: LookupReading[]; firstAt: number | null } | null;
  /** Its reconcile run: the state it claimed the job in, the one lookup, when it was read, and the ledger rows the history showed then. */
  rec: { state: ReconcilableState; reading: LookupReading | null; at: number | null; seen: string[] } | null;
}

interface SimRow extends LedgerRow {
  /** When the bank's history starts showing it (written + lag); the oracle sees it at once. */
  visibleAt: number;
}

interface World {
  db: ModelDb;
  ledger: SimRow[];
  workers: SimWorker[];
  lag: number;
  bankUp: boolean;
  /** Set once any attempt wrote a commit intent. */
  intentEver: boolean;
  /** The worker that most recently took the job (dequeue, a verify claim, T5) (R2a). */
  lastHolder: string | null;
  violations: string[];
  /** Every change of the job's state or token, as it happens (several can happen inside one event). */
  transitions: Transition[];
  /** A click by a worker whose lease was no longer valid: it was frozen across its expiry (the zombie). */
  zombieClick: boolean;
  /** The largest (click time - the clicker's lastExtendedAt) over all clicks. */
  maxClickStaleness: number;
  /** Decisions reached (for the "interesting states" check). */
  decisions: string[];
  /** When the history was read for the latest reconcile that decided `reconciled` (property 8). */
  lastReconciledRead: number | null;
  /** The ledger rows that read saw (a row not among them came after it: a late zombie). */
  lastReconciledSeen: string[] | null;
  /**
   * Property 11 (D57, D58), counted by the SIMULATION, never from the model's counters: leases (queued ->
   * running), lease crashes (recovery of a `running` lease: running -> queued / failed with the token bumped --
   * T4 never bumps it, T5 goes to verifying), and deaths (every recovery of an expired active lease that was not a
   * deferred or handed-off verify, judged on the job before the recovery: recover() sets pendingDeath).
   */
  simLeases: number;
  simLeaseCrashes: number;
  simDeaths: number;
  /** Set by recover() just before it commits a recovery of a dead holder's lease; consumed by commit(). */
  pendingDeath: boolean;
}

interface Transition {
  from: ModelJob;
  to: ModelJob;
  afterIntent: boolean;
  /** The simulation's own counts after this transition (property 11). */
  leases: number;
  leaseCrashes: number;
  deaths: number;
}

/** The only way the simulation writes the database: records every job transition. */
function commit(world: World, db: ModelDb): void {
  const from = job(world);
  world.db = db;
  const to = job(world);
  if (from.state !== to.state || from.token !== to.token) {
    if (from.state === "queued" && to.state === "running") world.simLeases += 1;
    if (from.state === "running" && to.token === from.token + 1 && (to.state === "queued" || to.state === "failed")) world.simLeaseCrashes += 1;
    if (world.pendingDeath) world.simDeaths += 1;
    world.transitions.push({ from, to, afterIntent: world.intentEver, leases: world.simLeases, leaseCrashes: world.simLeaseCrashes, deaths: world.simDeaths });
  }
  world.pendingDeath = false;
}

/**
 * Did the job's holder die (D58: a death counts against the crash budget)? An active job whose lease expired,
 * unless its newest verify phase ended on purpose (deferred, or handed off by reverify): that one is resumed.
 * Judged on the job BEFORE recovery, from the phases the verifiers wrote, not from recoveryAction's decision.
 */
function holderDied(j: ModelJob, now: number): boolean {
  if (!(isActive(j.state) && j.leaseExpiresAt !== null && j.leaseExpiresAt < now)) return false;
  if (j.state !== "verifying") return true;
  const last = j.phases.filter((p) => p.reason !== "reconcile").at(-1);
  return !(last && (last.decision === "deferred" || last.decision === "handed_off"));
}

const idOf = (w: SimWorker) => `${w.name}#${w.incarnation}`;
const job = (world: World): ModelJob => world.db.jobs[0]!;
const refOf = (w: SimWorker): LeaseRef => ({ jobId: JOB_ID, token: w.held!.token, owner: idOf(w) });
const canAct = (w: SimWorker) => w.alive && !w.paused;
const IDLE = (): Pick<SimWorker, "phase" | "held" | "clickedRow" | "verify" | "rec"> => ({ phase: "idle", held: null, clickedRow: null, verify: null, rec: null });

function newWorld(maxAttempts: number, lag: number, maxCrashes: number = DEFAULT_MAX_CRASHES): World {
  return {
    db: { now: 0, caps: { [TENANT]: 2 }, jobs: [newJob({ id: JOB_ID, tenant: TENANT, seq: 1, maxAttempts, maxCrashes })] },
    ledger: [],
    workers: ["w0", "w1", "w2"].map((name) => ({ name, incarnation: 0, alive: true, paused: false, ...IDLE(), lastExtendedAt: 0 })),
    lag,
    bankUp: true,
    intentEver: false,
    lastHolder: null,
    violations: [],
    transitions: [],
    zombieClick: false,
    maxClickStaleness: 0,
    decisions: [],
    lastReconciledRead: null,
    lastReconciledSeen: null,
    simLeases: 0,
    simLeaseCrashes: 0,
    simDeaths: 0,
    pendingDeath: false,
  };
}

const EV = "evidence://model";

/** What runReplay would hand back, given how far the run got and how it ended (D10, D11, rule 5.3). */
function runEndFor(w: SimWorker, how: How): RunEnd {
  const cu = { irreversibleStepId: "step-11", detail: "attempted the irreversible step (model)" };
  if (w.phase === "steps") {
    if (how === "refused") return { kind: "result", result: { status: "business_outcome", code: "NO_SUCH_RECIPIENT", detail: "refused before Submit", evidenceRef: EV } };
    if (how === "throw") return { kind: "thrown", error: new Error("step threw before Submit"), aborted: false };
    return { kind: "result", result: { status: "failure", atStepId: "step-05", expected: "x", observed: "y", category: "unexpected-state", evidenceRef: EV } };
  }
  if (w.phase === "intent") {
    // The intent is written but no click went out (e.g. a throw right after the hook): replay rejects.
    return { kind: "thrown", error: new Error("threw after the commit intent, before the click"), aborted: false };
  }
  // clicked
  if (how === "ok" && w.clickedRow) {
    return { kind: "result", result: { status: "success", outputs: { confirmationRef: w.clickedRow.id }, evidenceRef: EV } };
  }
  const result: ReplayResult =
    how === "refused" || (how === "ok" && !w.clickedRow)
      ? { status: "business_outcome", code: "INSUFFICIENT_FUNDS", detail: "refused after Submit", evidenceRef: EV, commitUncertain: cu }
      : { status: "failure", atStepId: "step-12", expected: "x", observed: "y", category: "unknown", evidenceRef: EV, commitUncertain: cu };
  return { kind: "result", result };
}

function startVerify(world: World, w: SimWorker, token: number, attempt: number, leaseCrashes: number): void {
  Object.assign(w, { phase: "verify", held: { token, attempt, leaseCrashes }, clickedRow: null, verify: { readings: [], firstAt: null }, lastExtendedAt: world.db.now });
  world.lastHolder = idOf(w);
}

/** The worker's run ends: jobOutcomeFor decides (on the lease crashes its dequeued row carried, D57); T4 records it, or T5 moves it into this worker's verify. */
function finishRun(world: World, w: SimWorker, end: RunEnd, irreversibleStarted: boolean): void {
  const j = job(world);
  const { attempt, leaseCrashes } = w.held!;
  const outcome = jobOutcomeFor(end, { attempt, maxAttempts: j.maxAttempts, leaseCrashes, irreversibleStarted });
  if (outcome.state === "verifying") {
    const { db, result, token } = modelCompleteIntoVerify(world.db, refOf(w), LEASE, outcome.priorStatus ?? null, outcome.result);
    commit(world, db);
    if (result === "recorded") return startVerify(world, w, token!, attempt, leaseCrashes);
    Object.assign(w, IDLE());
    return;
  }
  // A requeue backs off as the worker's does (D49), keyed on the job's own attempt that failed (D57), with
  // the jitter at its middle (x 1.0): 10 s, 30 s.
  const notBeforeSeconds = outcome.state === "queued" ? requeueBackoffSeconds(ownAttempts(attempt, leaseCrashes), () => 0.5) : null;
  const { db, result } = modelComplete(world.db, refOf(w), outcome.state, outcome.outcome, outcome.result, { notBeforeSeconds, reconcileDueSeconds: RECONCILE_DUE });
  if (result === "check_violation") world.violations.push(`T4 would violate jobs_queued_has_attempts_left (${outcome.state} at attempt ${attempt})`);
  commit(world, db);
  Object.assign(w, IDLE());
}

function beat(world: World, w: SimWorker): void {
  // A reconcile run has no heartbeat (D50: one lookup against a full lease; a re-run is harmless).
  if (!w.held || w.phase === "idle" || w.phase === "reconcile") return;
  const { db, extended } = modelHeartbeat(world.db, refOf(w), LEASE);
  commit(world, db);
  // The heartbeat found the lease gone: the run (or verify) rejects with LeaseLostError; nothing on jobs.
  if (extended) w.lastExtendedAt = world.db.now;
  else Object.assign(w, IDLE());
}

/** T6 by `w` (idle): may hand it a job to verify; if not, R1 may hand it a due reconcile (the sweep). */
function recover(world: World, w: SimWorker): boolean {
  // One job: a sweep recovers it at most once (afterwards it is queued, terminal, or freshly leased).
  world.pendingDeath = holderDied(job(world), world.db.now);
  const { db, claimed } = modelRecover(world.db, RECOVER_PER_LOOP, { owner: idOf(w), leaseSeconds: LEASE, reconcileDueSeconds: RECONCILE_DUE });
  commit(world, db);
  if (!claimed) return reconcileClaim(world, w);
  startVerify(world, w, claimed.token, job(world).attempt, job(world).leaseCrashes);
  return true;
}

function startReconcile(world: World, w: SimWorker, token: number): void {
  const state = job(world).state;
  if (!isReconcilable(state)) throw new Error(`the simulation: a reconcile claimed a ${state} job`);
  Object.assign(w, { phase: "reconcile", held: { token, attempt: job(world).attempt, leaseCrashes: job(world).leaseCrashes }, clickedRow: null, verify: null, rec: { state, reading: null, at: null, seen: [] }, lastExtendedAt: world.db.now });
  world.lastHolder = idOf(w);
}

/** R1 by an idle worker after its recovery sweep claimed nothing: may hand it a due reconcile. */
function reconcileClaim(world: World, w: SimWorker): boolean {
  const { db, claimed } = modelReconcileClaim(world.db, idOf(w), LEASE);
  commit(world, db);
  if (!claimed) return false;
  startReconcile(world, w, claimed.token);
  return true;
}

/** The reconcile's one lookup (no settle: one look, after the delay). */
function reconcileLookup(world: World, w: SimWorker): void {
  const rec = w.rec!;
  if (rec.reading) return;
  rec.reading = lookupNow(world);
  rec.at = world.db.now;
  rec.seen = world.bankUp ? world.ledger.filter((r) => r.memo === MEMO && r.visibleAt <= world.db.now).map((r) => r.id) : [];
}

function reconcileDecide(world: World, w: SimWorker): void {
  const rec = w.rec!;
  if (!rec.reading) return;
  const j = job(world);
  const cycle = modelReconcileCycle(j, world.db.now);
  const d = reconcileDecision({ jobState: rec.state, reading: rec.reading, deferrals: cycle.deferrals, deferredForSeconds: cycle.deferredForSeconds, defer: DEFER });
  const { db, result } = modelReconcileResult(world.db, refOf(w), d, lookupsColumn([rec.reading]));
  commit(world, db);
  if (result === "recorded") {
    world.decisions.push(`${d.decision}:${JSON.stringify(lookupsColumn([rec.reading]))}`);
    if (d.decision === "reconciled") {
      world.lastReconciledRead = rec.at;
      world.lastReconciledSeen = rec.seen;
    }
  }
  Object.assign(w, IDLE());
}

/**
 * The end-of-day batch (rote reconcile --since, D51) after the drain: if the job is terminal after a [0, 0]
 * verify (D55) and the workers' pass is due (or ran), re-read it regardless of reconciled_at, once every
 * row is visible (the drain's last tick plus the largest lag).
 */
function endOfDayBatch(world: World): void {
  const j = job(world);
  if (!(isReconcilable(j.state) && j.reconcileAfter !== null)) return;
  if (j.reconciledAt === null && j.reconcileAfter > world.db.now) return; // not due: the workers' pass's
  commit(world, modelTick(world.db, 13)); // past the largest history lag (12 s)
  const batch: SimWorker = { name: "batch", incarnation: 0, alive: true, paused: false, ...IDLE(), lastExtendedAt: 0 };
  const { db, claimed } = modelReconcileClaimJob(world.db, JOB_ID, idOf(batch), LEASE);
  commit(world, db);
  if (!claimed) return;
  startReconcile(world, batch, claimed.token);
  reconcileLookup(world, batch);
  reconcileDecide(world, batch);
}


function dequeue(world: World, w: SimWorker): void {
  if (recover(world, w)) return; // the claim is this iteration's work
  const { db, job: leased } = modelDequeue(world.db, idOf(w), LEASE);
  commit(world, db);
  if (leased) {
    Object.assign(w, { phase: "steps", held: { token: leased.token, attempt: leased.attempt, leaseCrashes: leased.leaseCrashes }, lastExtendedAt: world.db.now });
    world.lastHolder = idOf(w);
  }
}

function intent(world: World, w: SimWorker): void {
  const { db, written } = modelIntent(world.db, refOf(w), LEASE);
  commit(world, db);
  if (written) {
    w.phase = "intent";
    w.lastExtendedAt = world.db.now;
    world.intentEver = true;
  } else {
    // FencingError: definitely not written, no click; the run rejects and is retried like any
    // failure before the irreversible step (its T4 is fenced unless the lease merely expired).
    finishRun(world, w, { kind: "thrown", error: new Error("FencingError"), aborted: false }, false);
  }
}

function click(world: World, w: SimWorker, commits: boolean): void {
  const j = job(world);
  const valid = j.token === w.held!.token && j.owner === idOf(w) && j.leaseExpiresAt !== null && j.leaseExpiresAt > world.db.now;
  if (!valid) world.zombieClick = true;
  world.maxClickStaleness = Math.max(world.maxClickStaleness, world.db.now - w.lastExtendedAt);
  if (commits) {
    const row: SimRow = {
      id: `TXN-${String(world.ledger.length + 1).padStart(6, "0")}`,
      tenantId: TENANT,
      fromMemberId: "10001",
      toMemberId: "10002",
      amount: 1,
      memo: MEMO,
      visibleAt: world.db.now + world.lag,
    };
    world.ledger.push(row);
    w.clickedRow = row;
  }
  w.phase = "clicked";
}

/** A history lookup now: the bank's 503 when it is down; else the rows it shows (lag). */
function lookupNow(world: World): LookupReading {
  if (!world.bankUp) return { kind: "unavailable", detail: "BANK_UNAVAILABLE (model)", evidenceRef: null };
  const shown = world.ledger.filter((r) => r.memo === MEMO && r.visibleAt <= world.db.now);
  return { kind: "count", n: shown.length, firstMatchRef: shown[0]?.id ?? "No matching transfers.", evidenceRef: EV };
}

function lookup(world: World, w: SimWorker): void {
  const v = w.verify!;
  if (readingsComplete(v.readings)) return;
  if (v.readings.length === 0) {
    v.readings.push(lookupNow(world));
    v.firstAt = world.db.now;
  } else if (world.db.now >= v.firstAt! + SETTLE) {
    v.readings.push(lookupNow(world)); // the settle period has passed since the first lookup
  }
}

function decide(world: World, w: SimWorker): void {
  const v = w.verify!;
  if (!readingsComplete(v.readings)) return;
  const j = job(world);
  const cycle = modelVerifyCycle(j, world.db.now);
  const d = verifyDecision({
    readings: v.readings,
    priorStatus: cycle.priorStatus,
    attempt: j.attempt,
    maxAttempts: j.maxAttempts,
    leaseCrashes: j.leaseCrashes,
    deferrals: cycle.deferrals,
    deferredForSeconds: cycle.deferredForSeconds,
    defer: DEFER,
  });
  const lookups = lookupsColumn(v.readings);
  if (d.decision === "deferred") {
    const { db, result } = modelVerifyDefer(world.db, refOf(w), d.backoffSeconds, lookups);
    commit(world, db);
    if (result === "recorded") world.decisions.push("deferred");
  } else {
    const { db, result } = modelVerifyResult(world.db, refOf(w), d, lookups, d.decision === "already_done" ? alreadyDoneResult(d) : undefined, { reconcileDueSeconds: RECONCILE_DUE });
    if (result === "check_violation") world.violations.push(`T7 would violate jobs_queued_has_attempts_left (${d.decision})`);
    commit(world, db);
    if (result === "recorded") world.decisions.push(`${d.decision}${d.decision === "escalated" ? `:${d.outcome}` : ""}:${JSON.stringify(lookups)}`);
  }
  Object.assign(w, IDLE());
}

function apply(world: World, ev: Ev): void {
  if (ev.k === "tick") {
    let left = ev.dt;
    while (left > 0) {
      const chunk = Math.min(left, BEAT);
      commit(world, modelTick(world.db, chunk));
      left -= chunk;
      for (const w of world.workers) if (canAct(w)) beat(world, w);
    }
    return;
  }
  if (ev.k === "bank") {
    world.bankUp = ev.up;
    return;
  }
  const w = world.workers[ev.w]!;
  switch (ev.k) {
    case "dequeue":
      if (canAct(w) && w.phase === "idle") dequeue(world, w);
      return;
    case "recover":
      if (canAct(w) && w.phase === "idle") recover(world, w);
      return;
    case "intent":
      if (canAct(w) && w.phase === "steps") intent(world, w);
      return;
    case "click":
      if (canAct(w) && w.phase === "intent") click(world, w, ev.commits);
      return;
    case "finish":
      if (canAct(w) && (w.phase === "steps" || w.phase === "intent" || w.phase === "clicked")) finishRun(world, w, runEndFor(w, ev.how), w.phase !== "steps");
      return;
    case "lookup":
      if (canAct(w) && w.phase === "verify") lookup(world, w);
      else if (canAct(w) && w.phase === "reconcile") reconcileLookup(world, w);
      return;
    case "decide":
      if (canAct(w) && w.phase === "verify") decide(world, w);
      else if (canAct(w) && w.phase === "reconcile") reconcileDecide(world, w);
      return;
    case "crash":
      if (w.alive) Object.assign(w, { alive: false, paused: false, ...IDLE() });
      return;
    case "restart":
      if (!w.alive) Object.assign(w, { alive: true, incarnation: w.incarnation + 1 });
      return;
    case "pause":
      if (canAct(w)) w.paused = true;
      return;
    case "resume":
      if (w.alive && w.paused) {
        w.paused = false;
        if (ev.beatFirst) beat(world, w);
      }
      return;
  }
}

// ---------------------------------------------------------------------------- per-event invariants

type Found = Record<"duplicate" | "terminalMoved" | "queuedExhausted" | "blindRetryAfterIntent" | "twoHolders" | "tokenDecreased" | "failedEarly", string[]>;
interface Trace {
  world: World;
  found: Found;
}

function holdersOfValidLease(world: World): string[] {
  const j = job(world);
  return world.workers
    .filter((w) => w.alive && w.held && w.held.token === j.token && j.owner === idOf(w) && j.leaseExpiresAt !== null && j.leaseExpiresAt > world.db.now)
    .map(idOf);
}

/** The generated events, then the drain: every property sees the whole life of the job. */
function simulate(s: Scenario): Trace {
  const trace = runEvents(s);
  const { world, found } = trace;
  const seen = world.transitions.length;
  quiesce(world);
  checkTransitions(world.transitions.slice(seen), "drain", found);
  if (world.ledger.length > 1) found.duplicate.push(`drain: ${world.ledger.length} ledger rows`);
  for (const v of world.violations) found.queuedExhausted.push(v);
  return trace;
}

function runEvents(s: Scenario): Trace {
  const world = newWorld(s.maxAttempts, s.lag, s.maxCrashes);
  const found: Found = { duplicate: [], terminalMoved: [], queuedExhausted: [], blindRetryAfterIntent: [], twoHolders: [], tokenDecreased: [], failedEarly: [] };
  s.events.forEach((ev, i) => {
    const seen = world.transitions.length;
    apply(world, ev);
    const at = `event ${i} ${JSON.stringify(ev)}`;
    checkTransitions(world.transitions.slice(seen), at, found);
    if (world.ledger.length > 1) found.duplicate.push(`${at}: ${world.ledger.length} ledger rows`);
    const holders = holdersOfValidLease(world);
    if (holders.length > 1 || (holders.length === 1 && holders[0] !== world.lastHolder)) {
      found.twoHolders.push(`${at}: valid holders ${JSON.stringify(holders)}, last holder ${world.lastHolder}`);
    }
  });
  return { world, found };
}

/** Checked on EVERY transition, including the ones inside one event (recover, then dequeue). */
function checkTransitions(transitions: Transition[], at: string, found: Found): void {
  for (const { from, to, leases, leaseCrashes, deaths } of transitions) {
    const what = `${at}: ${from.state}/${from.token} -> ${to.state}/${to.token}`;
    // Terminal states are final, except: reverify (needs_human -> verifying; not modelled here), and the
    // reconcile pass on a succeeded / failed / business_outcome job: its claim / deferral bump the token (the
    // state stays), and its flag moves it to needs_human (duplicate_suspected / unrecorded_commit_suspected /
    // reconcile_unreadable) -- the ONE exception (D50, D55).
    const reverify = from.state === "needs_human" && to.state === "verifying";
    const reconcileTouch = isReconcilable(from.state) && to.state === from.state;
    const reconcileFlag = isReconcilable(from.state) && to.state === "needs_human" && (RECONCILE_FLAGS as readonly string[]).includes(to.outcome ?? "");
    if (isTerminal(from.state) && !reverify && !reconcileTouch && !reconcileFlag) found.terminalMoved.push(what);
    // Queued always has an own attempt left and is under the crash cap (D21; D57's and D58's two budgets).
    if (to.state === "queued" && !(to.attempt - to.leaseCrashes < to.maxAttempts && to.crashes < to.maxCrashes)) {
      found.queuedExhausted.push(`${what} at attempt ${to.attempt}/${to.maxAttempts}, lease crashes ${to.leaseCrashes}, crashes ${to.crashes}/${to.maxCrashes}`);
    }
    // Property 11 (D57, D58), on the simulation's own counts: failed only after max_attempts own failures
    // (leases that were not lease crashes), or at the crash cap with max_crashes deaths -- and then only before
    // any intent (from running).
    const counts = `${leases} leases, ${leaseCrashes} lease crashes, ${deaths} deaths (max_attempts ${to.maxAttempts}, max_crashes ${to.maxCrashes})`;
    if (to.state === "failed" && from.state !== "failed") {
      const ownFailures = leases - leaseCrashes;
      const ok = to.outcome === "crash_limit" ? deaths >= to.maxCrashes && from.state === "running" : ownFailures >= to.maxAttempts;
      if (!ok) found.failedEarly.push(`${what}: failed/${to.outcome} after ${counts}`);
    }
    // ... and escalated by recovery (an active job to needs_human, the token bumped: T6.6; T7 and T4 never bump
    // it) only at the crash cap, as crash_limit, past the intent.
    if (to.state === "needs_human" && (from.state === "committing" || from.state === "verifying") && to.token === from.token + 1) {
      if (!(to.outcome === "crash_limit" && deaths >= to.maxCrashes)) found.failedEarly.push(`${what}: needs_human/${to.outcome} by recovery after ${counts}`);
    }
    if (to.state === "queued" && from.state !== "running") {
      // Property 5: after an intent, the only way back to queued is a verify that looked twice and saw 0.
      const phase = to.phases.find((p) => p.token === from.token);
      const ok = from.state === "verifying" && phase?.decision === "resubmitted" && JSON.stringify(phase.lookups) === "[0,0]";
      if (!ok) found.blindRetryAfterIntent.push(`${what} (phase ${JSON.stringify(phase ?? null)})`);
    }
    if (to.token < from.token) found.tokenDecreased.push(what);
  }
}

const phaseOf = (w: SimWorker): Phase => w.phase;

/** A live verifier finishes its phase: lookups (ticking through the settle period), then decides. */
function runVerifyToEnd(world: World, w: SimWorker): void {
  for (let guard = 0; guard < 6 && phaseOf(w) === "verify"; guard += 1) {
    const v = w.verify!;
    if (readingsComplete(v.readings)) {
      decide(world, w);
      return;
    }
    if (v.readings.length > 0) apply(world, { k: "tick", dt: SETTLE });
    if (phaseOf(w) !== "verify") return; // lost its lease while waiting
    lookup(world, w);
  }
}

/** Runs a live worker's current work to its end, verify phase included. */
function finishWork(world: World, w: SimWorker): void {
  const i = world.workers.indexOf(w);
  if (phaseOf(w) === "steps") (i >= 0 ? apply(world, { k: "intent", w: i }) : intent(world, w));
  if (phaseOf(w) === "intent") (i >= 0 ? apply(world, { k: "click", w: i, commits: true }) : click(world, w, true));
  if (phaseOf(w) === "clicked") finishRun(world, w, runEndFor(w, "ok"), true);
  if (phaseOf(w) === "verify") runVerifyToEnd(world, w);
  if (phaseOf(w) === "reconcile") {
    reconcileLookup(world, w);
    reconcileDecide(world, w);
  }
}

/**
 * Property 3's epilogue: the bank comes back, everyone wakes (heartbeat first), every live run and
 * verify finishes, the clock passes every lease and backoff, then clean workers run the loop (recover --
 * which may hand them a verify --, dequeue, run to success) until the job is terminal.
 */
function quiesce(world: World): void {
  world.bankUp = true;
  for (const w of world.workers) if (w.alive && w.paused) apply(world, { k: "resume", w: world.workers.indexOf(w), beatFirst: true });
  for (const w of world.workers) if (canAct(w) && w.phase !== "idle") finishWork(world, w);
  commit(world, modelTick(world.db, LEASE + 1));
  // Until the job is terminal AND settled: past the reconcile delay, its pass has run (D50).
  for (let round = 0; round < 4 * job(world).maxAttempts + 14 && !modelSettled(job(world)); round += 1) {
    const clean: SimWorker = { name: `clean${round}`, incarnation: 0, alive: true, paused: false, ...IDLE(), lastExtendedAt: 0 };
    dequeue(world, clean);
    finishWork(world, clean);
    commit(world, modelTick(world.db, LEASE + 1));
  }
}

function oracleFor(world: World) {
  const j = job(world);
  return checkLedger({
    jobs: [{ id: j.id, tenant_id: TENANT, state: j.state, memo_key: MEMO, result: j.result, lease_owner: j.owner, attempt: j.attempt, outcome: j.outcome }],
    ledger: world.ledger.map(({ visibleAt: _v, ...row }) => row),
    drainTimedOut: true,
  });
}

/** A row the reconcile's history read did not see: it was written, or became visible, only after the read (a late zombie). */
const lateRow = (world: World) => world.lastReconciledSeen !== null && world.ledger.some((r) => !world.lastReconciledSeen!.includes(r.id));
/** The workers' pass gave up on the job's reconcile after max_crashes dead reconcilers (R3, D59): only the batch re-reads it. */
const passAbandoned = (world: World) => job(world).reconcileAbandonedAt !== null && job(world).reconciledAt === null;
/** Property 8: a succeeded job with 2+ rows, no row that became visible only after the reconcile's read, and a pass that did not give up. */
const silentDuplicate = (world: World) => job(world).state === "succeeded" && world.ledger.length >= 2 && !lateRow(world) && !passAbandoned(world);
/** A job that says no money moved (failed / business_outcome) with a ledger row: the oracle's UNRECORDED_COMMIT. */
const unrecordedCommit = (world: World) => (job(world).state === "failed" || job(world).state === "business_outcome") && world.ledger.length >= 1;
/** Property 10 (D55): an unrecorded commit, with property 8's exemptions. */
const silentUnrecorded = (world: World) => unrecordedCommit(world) && !lateRow(world) && !passAbandoned(world);
/** D59: an abandoned reconcile follows max_crashes dead reconcile phases, on a job that kept its terminal state. */
function abandonedOnlyAtTheCap(world: World): string[] {
  const j = job(world);
  if (j.reconcileAbandonedAt === null) return [];
  // A dead reconciler's phase is closed `crashed`; its late R2, fenced, relabels it `lease_lost`: one death either way.
  const dead = j.phases.filter((p) => p.reason === "reconcile" && (p.decision === "crashed" || p.decision === "lease_lost")).length;
  const problems: string[] = [];
  if (dead < j.maxCrashes) problems.push(`abandoned after ${dead} dead reconcile phase(s), cap ${j.maxCrashes}`);
  if (j.reconcileCrashes !== dead) problems.push(`reconcileCrashes ${j.reconcileCrashes} but ${dead} dead reconcile phase(s)`);
  if (!isReconcilable(j.state) && j.state !== "needs_human") problems.push(`abandoned in state ${j.state}`);
  return problems;
}

/** Property 1's precondition: no zombie click, and the settle period covers the history lag. */
const p1Holds = (world: World) => !world.zombieClick && world.lag <= SETTLE;
/** Property 2's precondition: no history lag, and no click lands lease + settle after its lease was last extended. */
const p2Holds = (world: World) => world.lag === 0 && world.maxClickStaleness < LEASE + SETTLE;

const params = { numRuns: RUNS, seed: SEED };
/** 10 000 sequences take 1-6 s alone, longer under the full parallel suite: never vitest's 5 s default. */
const PROPERTY_TIMEOUT_MS = 120_000;

describe("fleet state machine, pure model (Step 9: verify, settle, history lag, bank outages), 10 000 sequences per property", () => {
  it("property 1: no duplicate unless a zombie clicked (frozen across its own lease expiry) or the history lag exceeds the settle period", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { world, found } = simulate(s);
        if (p1Holds(world)) expect(found.duplicate).toEqual([]);
      }),
      params,
    );
  }, PROPERTY_TIMEOUT_MS);

  it("property 1's preconditions are NECESSARY: without the zombie, a lag over the settle period alone duplicates; without the lag, a zombie alone does", () => {
    const lagOnly = fc.check(
      fc.property(fc.record({ maxAttempts: fc.integer({ min: 2, max: 3 }), lag: fc.integer({ min: SETTLE + 1, max: 12 }), events: eventsArb }), (s) => {
        const { world, found } = simulate(s);
        return world.zombieClick || found.duplicate.length === 0;
      }),
      params,
    );
    expect(lagOnly.failed, "fast-check found no duplicate caused by history lag alone").toBe(true);
    const zombieOnly = fc.check(
      fc.property(fc.record({ maxAttempts: fc.integer({ min: 2, max: 3 }), lag: fc.constant(0), events: fc.oneof(eventsArb, stormArb, zombieArb) }), (s) => simulate(s).found.duplicate.length === 0),
      params,
    );
    expect(zombieOnly.failed, "fast-check found no zombie duplicate").toBe(true);
    // With no lag, the (shrunk) duplicate it found is a zombie's, exactly as property 1 says.
    const [shrunk] = zombieOnly.counterexample!;
    const { world } = simulate(shrunk);
    expect(world.zombieClick).toBe(true);
    expect(world.maxClickStaleness).toBeGreaterThanOrEqual(LEASE + SETTLE - BEAT);
  }, PROPERTY_TIMEOUT_MS);

  it("property 2: no duplicate at all when no pause spans lease + settle (no click lands that long after its lease was extended) and there is no history lag", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { world, found } = simulate(s);
        if (p2Holds(world)) expect(found.duplicate).toEqual([]);
      }),
      params,
    );
  }, PROPERTY_TIMEOUT_MS);

  it("property 3: no lost job -- after the bank is back, everyone wakes and the leases pass, recovery + verify + clean workers reach a terminal state, and it is SETTLED (its reconcile, if one was due, ran)", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { world } = simulate(s);
        expect(isTerminal(job(world).state), `job ended ${job(world).state}`).toBe(true);
        expect(modelSettled(job(world)), "settled").toBe(true);
      }),
      params,
    );
  }, PROPERTY_TIMEOUT_MS);

  it("property 4: terminal states are final -- except the reconcile pass's succeeded -> needs_human (duplicate_suspected / reconcile_unreadable; reviewer decision 3); rote jobs reverify is not modelled -- and queued always has an attempt left (D21)", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { found } = simulate(s);
        expect(found.terminalMoved).toEqual([]);
        expect(found.queuedExhausted).toEqual([]);
      }),
      params,
    );
  }, PROPERTY_TIMEOUT_MS);

  it("property 5: no blind retry after the intent -- every requeue of a job past its intent passed through a verify with two 0-match lookups", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        expect(simulate(s).found.blindRetryAfterIntent).toEqual([]);
      }),
      params,
    );
  }, PROPERTY_TIMEOUT_MS);

  it("property 6: the oracle agrees with the model -- PASS whenever property 1's preconditions hold, DUPLICATE whenever there are 2+ rows, and a PASS means <= 1 row and terminal", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { world } = simulate(s);
        const report = oracleFor(world);
        if (p1Holds(world)) expect(report.pass, report.text).toBe(true);
        if (world.ledger.length >= 2) expect(report.findings[0]!.verdict).toBe("DUPLICATE");
        if (report.pass) {
          expect(world.ledger.length).toBeLessThanOrEqual(1);
          expect(isTerminal(job(world).state)).toBe(true);
        }
      }),
      params,
    );
  }, PROPERTY_TIMEOUT_MS);

  it("property 8: after the drain past the reconcile delay, a duplicate never stays silently succeeded -- unless a row became visible only after the reconcile's read (a zombie clicking after the pass: the honest limit, D50) or the pass abandoned the reconcile at max_crashes dead reconcilers (D59), which only ever happens at that cap", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { world } = simulate(s);
        expect(abandonedOnlyAtTheCap(world)).toEqual([]);
        expect(silentDuplicate(world), `${world.ledger.length} rows, job ${job(world).state}/${job(world).outcome}, last reconciled read at ${world.lastReconciledRead} saw ${JSON.stringify(world.lastReconciledSeen)}, rows ${JSON.stringify(world.ledger.map((r) => [r.id, r.visibleAt]))}`).toBe(false);
      }),
      params,
    );
  }, PROPERTY_TIMEOUT_MS);

  it("property 10 (D55): after the drain past the reconcile delay, an unrecorded commit (a row against a job that ended failed / business_outcome) never stays silent -- unless a row became visible only after the reconcile's read, or the pass abandoned the reconcile (D59)", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { world } = simulate(s);
        expect(silentUnrecorded(world), `${world.ledger.length} rows, job ${job(world).state}/${job(world).outcome}, phases ${JSON.stringify(job(world).phases.map((p) => p.decision))}, last reconciled read saw ${JSON.stringify(world.lastReconciledSeen)}`).toBe(false);
      }),
      params,
    );
  }, PROPERTY_TIMEOUT_MS);

  it("property 9: with the end-of-day batch (rote reconcile --since, D51) after the drain, NO duplicate stays succeeded and NO unrecorded commit stays failed / business_outcome -- the honest limit of properties 8 and 10 is closed", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { world } = simulate(s);
        endOfDayBatch(world);
        expect(job(world).state === "succeeded" && world.ledger.length >= 2, `${world.ledger.length} rows, job ${job(world).state}/${job(world).outcome}`).toBe(false);
        expect(unrecordedCommit(world), `${world.ledger.length} rows, job ${job(world).state}/${job(world).outcome}`).toBe(false);
      }),
      params,
    );
  }, PROPERTY_TIMEOUT_MS);

  it("property 10's cases are real: fast-check finds an unrecorded commit that the workers' pass flagged, and every one of them had a [0, 0] verify (no other path leaves a row on a job that says no money moved)", () => {
    const flagged = fc.check(
      fc.property(scenarioArb, (s) => job(simulate(s).world).outcome !== "unrecorded_commit_suspected"),
      params,
    );
    expect(flagged.failed, "fast-check never reached unrecorded_commit_suspected").toBe(true);
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { world } = simulate(s);
        if (job(world).outcome === "unrecorded_commit_suspected" || unrecordedCommit(world)) {
          expect(job(world).phases.some((p) => p.decision === "resubmitted" || p.decision === "exhausted" || p.decision === "not_committed_final")).toBe(true);
        }
      }),
      params,
    );
  }, PROPERTY_TIMEOUT_MS);

  it("property 8's exemption is real (fast-check finds a duplicate that the workers' pass read too early), and the reconcile is what flags duplicates (without it, one stays succeeded)", () => {
    const late = fc.check(
      fc.property(scenarioArb, (s) => {
        const { world } = simulate(s);
        return !(job(world).state === "succeeded" && world.ledger.length >= 2);
      }),
      params,
    );
    expect(late.failed, "fast-check found no duplicate that stayed succeeded past the workers' pass (the late zombie)").toBe(true);
    const [shrunk] = late.counterexample!;
    const { world } = simulate(shrunk);
    expect(world.zombieClick).toBe(true);
    expect(lateRow(world)).toBe(true);
  }, PROPERTY_TIMEOUT_MS);

  it("R2a: at most one worker holds a valid lease (owner + token match, lease_expires_at > now), and it is the one that took the job last", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        expect(simulate(s).found.twoHolders).toEqual([]);
      }),
      params,
    );
  }, PROPERTY_TIMEOUT_MS);

  it("R2b: the fencing token never decreases", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        expect(simulate(s).found.tokenDecreased).toEqual([]);
      }),
      params,
    );
  }, PROPERTY_TIMEOUT_MS);
});

describe("the two budgets (Step 10b, D57, D58): crashes stop using attempts; one crash budget for every death", () => {
  it("property 11: a job is never failed or escalated by worker deaths before max_crashes of them, never failed by fewer than max_attempts own failures, and never failed past its intent -- over the Step 9/10 sequences (cap 5) AND crash-heavy ones (caps 1-5), queued always within both budgets", () => {
    fc.assert(
      fc.property(fc.oneof(scenarioArb, crashScenarioArb), (s) => {
        const { found } = simulate(s);
        expect(found.failedEarly).toEqual([]);
        expect(found.queuedExhausted).toEqual([]);
      }),
      params,
    );
  }, PROPERTY_TIMEOUT_MS);

  it("property 11's cases are real: fast-check reaches the crash cap before the intent (failed / crash_limit, 0 rows) and after it (needs_human / crash_limit), and a job whose deaths reached max_attempts still succeeds", () => {
    for (const [state, intent] of [
      ["failed", false],
      ["needs_human", true],
    ] as const) {
      const capped = fc.check(
        fc.property(crashScenarioArb, (s) => {
          const j = job(simulate(s).world);
          return !(j.state === state && j.outcome === "crash_limit");
        }),
        params,
      );
      expect(capped.failed, `fast-check never reached ${state} / crash_limit`).toBe(true);
      const [shrunk] = capped.counterexample!;
      const { world } = simulate(shrunk);
      expect(job(world)).toMatchObject({ state, outcome: "crash_limit" });
      expect(job(world).crashes).toBe(job(world).maxCrashes);
      expect(world.simDeaths).toBe(job(world).maxCrashes);
      expect(world.intentEver).toBe(intent);
      if (!intent) expect(world.ledger).toHaveLength(0);
    }
    // Under Step 8's rule a job whose crashes reached max_attempts was failed (lease_expired); now it goes on.
    const survived = fc.check(
      fc.property(crashScenarioArb, (s) => {
        const { world: w } = simulate(s);
        return !(job(w).state === "succeeded" && w.simDeaths >= job(w).maxAttempts);
      }),
      params,
    );
    expect(survived.failed, "fast-check found no job that succeeded after max_attempts deaths").toBe(true);
  }, PROPERTY_TIMEOUT_MS);
});

describe("the simulation reaches the interesting states (so the properties are not vacuous)", () => {
  it("over the same sequences: every verify decision, deferrals and their exhaustion, re-claims, lagged [0, 1], the zombie's duplicate", () => {
    // Counted, not just seen: the counts are printed, so a path reached rarely or never (like the reconcile cap
    // was in model vs real before D59's prefix) shows up in the log on its own.
    const counts = new Map<string, number>();
    const seen = { add: (k: string) => void counts.set(k, (counts.get(k) ?? 0) + 1), has: (k: string) => counts.has(k) };
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { world } = simulate(s);
        for (const t of world.transitions) seen.add(`${t.from.state}->${t.to.state}`);
        for (const d of world.decisions) seen.add(`decision:${d.replace(/:\[.*$/, "")}`);
        for (const d of world.decisions) if (d.endsWith("[0,1]")) seen.add("lookups:[0,1]");
        for (const p of job(world).phases) if (p.decision === "crashed") seen.add(p.reason === "reconcile" ? "phase:reconcile-crashed" : "phase:crashed");
        if (job(world).reconcileAbandonedAt !== null) seen.add("reconcile:abandoned"); // D59
        seen.add(`final:${job(world).state}${job(world).outcome ? `/${job(world).outcome}` : ""}`);
        seen.add(`rows:${Math.min(world.ledger.length, 2)}`);
      }),
      { numRuns: 4000, seed: SEED },
    );
    // Watched, not required: scenarioArb reaches the reconcile cap rarely or never ("NOT reached" in the log);
    // property 12 below has its own scenarios for it and requires it.
    printCoverage("property tests, 4000 sequences", counts, ["phase:reconcile-crashed", "reconcile:abandoned", "final:failed/crash_limit"]);
    for (const expected of [
      "running->queued",
      "running->failed",
      "running->business_outcome",
      "committing->succeeded",
      "committing->verifying", // T5 or T6.4
      "verifying->verifying", // T6.5 / T6.7 / T8 (token bumps)
      "verifying->succeeded",
      "verifying->queued",
      "verifying->failed",
      "verifying->business_outcome",
      "verifying->needs_human",
      "decision:already_done",
      "decision:resubmitted",
      "decision:exhausted",
      "decision:not_committed_final",
      "decision:deferred",
      "decision:escalated:ambiguous",
      "decision:escalated:verify_unavailable",
      "decision:reconciled",
      "decision:duplicate_suspected",
      "decision:unrecorded_commit_suspected", // D55
      "succeeded->succeeded", // R1's token bump on a succeeded job
      "failed->failed", // ... on a failed one (D55)
      "succeeded->needs_human", // the one exception (reconcile)
      "failed->needs_human",
      "final:needs_human/duplicate_suspected",
      "final:needs_human/unrecorded_commit_suspected",
      "lookups:[0,1]",
      "phase:crashed",
      "final:succeeded/success",
      "final:succeeded/already_done",
      "final:needs_human/crash_limit", // T6.6 at the one crash budget (D58; was verify_exhausted)
      "final:failed/not_committed_attempts_exhausted",
      "rows:0",
      "rows:1",
      "rows:2", // the zombie window or a lag over the settle period: real in the model, as it is in life
    ]) {
      expect(seen.has(expected), `never reached: ${expected}; reached: ${[...counts.keys()].sort().join(", ")}`).toBe(true);
    }
  }, PROPERTY_TIMEOUT_MS);
});

describe("property 12 (D59): a reconciler's deaths, under small crash caps", () => {
  // The coverage counts above showed the random sequences never reach the reconcile cap (reconcilers die a few
  // times in 4000 sequences, never max_crashes times on one job). So D59 gets its own scenarios, which leave
  // scenarioArb (every other property's samples) untouched: a job that ends after a [0, 0] verify -- resubmitted
  // and succeeded, a zombie's duplicate, or ended failed / business_outcome with a zombie's late row (D55) --
  // then 0-5 reconcilers that each claim it and die, under a crash cap of 1-5.
  const resubmittedThenSucceeded: Ev[] = [
    { k: "dequeue", w: 0 },
    { k: "intent", w: 0 },
    { k: "crash", w: 0 },
    { k: "tick", dt: 31 },
    { k: "dequeue", w: 1 },
    { k: "lookup", w: 1 },
    { k: "tick", dt: 5 },
    { k: "lookup", w: 1 },
    { k: "decide", w: 1 },
    { k: "dequeue", w: 2 },
    { k: "intent", w: 2 },
    { k: "click", w: 2, commits: true },
    { k: "finish", w: 2, how: "ok" },
  ];
  const reconcilerDeathsArb: fc.Arbitrary<Scenario> = fc.record({
    maxAttempts: fc.integer({ min: 2, max: 3 }),
    maxCrashes: fc.integer({ min: 1, max: 5 }),
    lag: fc.constant(0),
    events: fc
      .record({ base: fc.oneof({ weight: 2, arbitrary: fc.constant(resubmittedThenSucceeded) }, { weight: 1, arbitrary: zombieArb }, { weight: 1, arbitrary: zombieThenNotSucceededArb }), deaths: fc.integer({ min: 0, max: 5 }) })
      .map(({ base, deaths }): Ev[] => [
        ...base,
        { k: "tick", dt: 61 }, // past the reconcile delay
        ...Array.from({ length: deaths }, (_, i): Ev[] => [{ k: "restart", w: i % 3 }, { k: "dequeue", w: i % 3 }, { k: "crash", w: i % 3 }, { k: "tick", dt: 31 }]).flat(),
      ]),
  });

  it("an abandonment follows max_crashes dead reconcilers; a terminal job's own crash counts never change; no duplicate or unrecorded commit stays silent but an abandoned one, and none at all after the end-of-day batch", () => {
    const counts = new Map<string, number>();
    const count = (k: string) => void counts.set(k, (counts.get(k) ?? 0) + 1);
    fc.assert(
      fc.property(reconcilerDeathsArb, (s) => {
        const { world, found } = simulate(s);
        const j = job(world);
        expect(abandonedOnlyAtTheCap(world)).toEqual([]);
        expect(found.terminalMoved).toEqual([]);
        // A reconciler's death is never one of the job's crashes (D59): no counter moves once the job is terminal.
        for (const t of world.transitions.filter((t) => isTerminal(t.from.state))) {
          expect({ crashes: t.to.crashes, leaseCrashes: t.to.leaseCrashes }, `${t.from.state} -> ${t.to.state}`).toEqual({ crashes: t.from.crashes, leaseCrashes: t.from.leaseCrashes });
        }
        expect(modelSettled(j), "settled").toBe(true);
        expect(silentDuplicate(world), "property 8").toBe(false);
        expect(silentUnrecorded(world), "property 10").toBe(false);
        count(`reconcilerDeaths:${j.reconcileCrashes}`);
        if (passAbandoned(world)) {
          count("reconcile:abandoned");
          if (world.ledger.length >= 2 || unrecordedCommit(world)) count("reconcile:abandoned-while-wrong"); // only the batch can flag it now
        } else if (j.reconcileCrashes > 0) count("reconcile:decided-after-deaths");
        endOfDayBatch(world);
        expect(job(world).state === "succeeded" && world.ledger.length >= 2, "property 9: a duplicate stays succeeded").toBe(false);
        expect(unrecordedCommit(world), "property 9: an unrecorded commit stays failed / business_outcome").toBe(false);
      }),
      { numRuns: 2000, seed: SEED + 12 },
    );
    printCoverage("property 12 (D59), 2000 sequences", counts, ["reconcile:abandoned", "reconcile:decided-after-deaths", "reconcile:abandoned-while-wrong"]);
    expect(counts.get("reconcile:abandoned") ?? 0, "the pass never abandoned a reconcile: property 12 would be vacuous").toBeGreaterThan(0);
    expect(counts.get("reconcile:decided-after-deaths") ?? 0, "no reconcile was decided after a dead reconciler").toBeGreaterThan(0);
  }, PROPERTY_TIMEOUT_MS);
});

describe("deterministic: the two budgets (Step 10b, D57) -- the bank-fault+kills run's two failed jobs, replayed", () => {
  const run = (events: Ev[], opts: { maxAttempts?: number; maxCrashes?: number } = {}) => runEvents({ maxAttempts: opts.maxAttempts ?? 3, maxCrashes: opts.maxCrashes, lag: 0, events });
  /** A lease whose worker dies before its intent; once the lease has passed, a recovery sweep takes it (T6.1 / T6.2). */
  const crash = (w: number): Ev[] => [{ k: "dequeue", w }, { k: "crash", w }, { k: "tick", dt: 31 }, { k: "restart", w }, { k: "recover", w }];
  /** A lease that fails before Submit (T4: requeued with a backoff, or failed); then past the backoff. */
  const fail = (w: number): Ev[] => [{ k: "dequeue", w }, { k: "finish", w, how: "failure" }, { k: "tick", dt: 31 }];

  it("job 076e7ccd (1:crashed 2:crashed 3:failure) is no longer failed: two crashes and ONE own failure leave it queued, with 2 own attempts left", () => {
    const { world, found } = run([...crash(0), ...crash(1), ...fail(2)]);
    expect(job(world)).toMatchObject({ state: "queued", attempt: 3, crashes: 2, outcome: null });
    expect(Object.values(found).flat()).toEqual([]);
    // Step 8's rule failed it here (failed / failure, attempt 3/3). It runs again and succeeds.
    quiesce(world);
    expect(job(world)).toMatchObject({ state: "succeeded", outcome: "success", attempt: 4, crashes: 2 });
    expect(world.ledger).toHaveLength(1);
  });

  it("job 93c77857 (1:crashed 2:failure 3:crashed) is no longer failed / lease_expired: the third lease's death is a crash (T6.1), not its last attempt", () => {
    const { world, found } = run([...crash(0), ...fail(1), ...crash(2)]);
    expect(job(world)).toMatchObject({ state: "queued", attempt: 3, crashes: 2 });
    expect(Object.values(found).flat()).toEqual([]);
    quiesce(world);
    expect(job(world)).toMatchObject({ state: "succeeded", attempt: 4, crashes: 2 });
  });

  it("own failures still fail the job at max_attempts, however many crashes came between them (failed / failure after 3 own failures, attempt 5)", () => {
    const { world, found } = run([...fail(0), ...crash(1), ...fail(2), ...crash(0), ...fail(1)]);
    expect(job(world)).toMatchObject({ state: "failed", outcome: "failure", attempt: 5, crashes: 2 });
    expect(found.failedEarly).toEqual([]);
  });

  it("the crash cap: a poison job's 5th worker death before the intent fails it / crash_limit (T6.2), 0 rows; a cap of 2 fails it at the 2nd", () => {
    const five = run([...crash(0), ...crash(1), ...crash(2), ...crash(0), ...crash(1)]);
    expect(job(five.world)).toMatchObject({ state: "failed", outcome: "crash_limit", attempt: 5, crashes: 5 });
    expect(five.world.ledger).toHaveLength(0);
    expect(Object.values(five.found).flat()).toEqual([]);
    const four = run([...crash(0), ...crash(1), ...crash(2), ...crash(0)]);
    expect(job(four.world)).toMatchObject({ state: "queued", crashes: 4 });
    const two = run([...crash(0), ...crash(1)], { maxCrashes: 2 });
    expect(job(two.world)).toMatchObject({ state: "failed", outcome: "crash_limit", crashes: 2 });
  });

  it("a lease that expires AFTER the intent is a death (crashes 1, D58) but not a lease crash: T6.4 verifies [0, 0] and resubmits it as an own attempt", () => {
    const { world } = run(
      [{ k: "dequeue", w: 0 }, { k: "intent", w: 0 }, { k: "crash", w: 0 }, { k: "tick", dt: 31 }, { k: "dequeue", w: 1 }, { k: "lookup", w: 1 }, { k: "tick", dt: 5 }, { k: "lookup", w: 1 }, { k: "decide", w: 1 }],
      { maxAttempts: 2 },
    );
    expect(job(world)).toMatchObject({ state: "queued", attempt: 1, crashes: 1, leaseCrashes: 0 });
    expect(job(world).phases.map((p) => p.decision)).toEqual(["resubmitted"]);
  });

  /** Chaos seed 2080386450's job 1ba81fdf (evidence/chaos/day2-exit/README.md): its worker dies after the intent, then `verifiers` verifiers die mid-verify. */
  const killedVerifiers = (verifiers: number): Ev[] => [
    { k: "dequeue", w: 0 },
    { k: "intent", w: 0 },
    { k: "click", w: 0, commits: true },
    { k: "crash", w: 0 },
    ...Array.from({ length: verifiers }, (_, i): Ev[] => {
      const w = 1 + (i % 2);
      return [{ k: "tick", dt: 31 }, { k: "restart", w }, { k: "dequeue", w }, { k: "lookup", w }, { k: "crash", w }];
    }).flat(),
    { k: "tick", dt: 31 },
    { k: "restart", w: 0 },
    { k: "recover", w: 0 },
  ];

  it("the chaos seed's job, replayed: its worker and then three verifiers killed (4 deaths) is NOT escalated any more (Step 9's verify_exhausted at 3 dead phases, D58): the next verifier decides [1], already_done, 1 row", () => {
    const { world, found } = run(killedVerifiers(3));
    expect(job(world)).toMatchObject({ state: "verifying", crashes: 4, leaseCrashes: 0, attempt: 1 });
    expect(Object.values(found).flat()).toEqual([]);
    quiesce(world);
    expect(job(world)).toMatchObject({ state: "succeeded", outcome: "already_done", crashes: 4 });
    expect(world.ledger).toHaveLength(1);
  });

  it("the fifth death on the job, after the intent, escalates it: needs_human / crash_limit, never failed (T6.6, D58); with a cap of 2, the second death does", () => {
    const five = run(killedVerifiers(4));
    expect(job(five.world)).toMatchObject({ state: "needs_human", outcome: "crash_limit", crashes: 5, leaseCrashes: 0 });
    expect(five.world.simDeaths).toBe(5);
    expect(Object.values(five.found).flat()).toEqual([]);
    const two = run(killedVerifiers(1), { maxCrashes: 2 });
    expect(job(two.world)).toMatchObject({ state: "needs_human", outcome: "crash_limit", crashes: 2 });
    // The attempt's own death at a cap of 1: escalated at once, without a verify (the Submit may have committed).
    const one = run(killedVerifiers(0), { maxCrashes: 1 });
    expect(job(one.world)).toMatchObject({ state: "needs_human", outcome: "crash_limit", crashes: 1 });
  });

  it("one budget: lease crashes before the intent and verifier deaths after it add up (2 + 1 + 2 = 5 -> needs_human / crash_limit)", () => {
    const events: Ev[] = [...crash(0), ...crash(1), ...killedVerifiers(2)];
    const { world } = run(events);
    expect(job(world)).toMatchObject({ state: "needs_human", outcome: "crash_limit", crashes: 5, leaseCrashes: 2, attempt: 3 });
  });

  it("verify counts own attempts too: two crashes, then the third lease reaches its intent and dies; [0, 0] resubmits (Step 8's count would say exhausted)", () => {
    const { world } = run([
      ...crash(0),
      ...crash(1),
      { k: "dequeue", w: 2 },
      { k: "intent", w: 2 },
      { k: "crash", w: 2 },
      { k: "tick", dt: 31 },
      { k: "dequeue", w: 0 },
      { k: "lookup", w: 0 },
      { k: "tick", dt: 5 },
      { k: "lookup", w: 0 },
      { k: "decide", w: 0 },
    ]);
    expect(job(world)).toMatchObject({ state: "queued", attempt: 3, crashes: 3, leaseCrashes: 2 });
    expect(job(world).phases.map((p) => p.decision)).toEqual(["resubmitted"]);
  });
});

describe("deterministic scenarios (docs/plans/step-08.md section 6; step-09 reviewer decisions 4 and 5)", () => {
  const run = (events: Ev[], opts: { maxAttempts?: number; maxCrashes?: number; lag?: number } = {}) =>
    simulate({ maxAttempts: opts.maxAttempts ?? 3, maxCrashes: opts.maxCrashes, lag: opts.lag ?? 0, events });
  const rows = (world: World) => world.ledger.length;

  it("frozen BEFORE the intent: recovered (T6.1) and finished by another worker; on waking, its fenced T3 stops the click", () => {
    const { world, found } = run([
      { k: "dequeue", w: 0 },
      { k: "pause", w: 0 },
      { k: "tick", dt: 31 },
      { k: "dequeue", w: 1 },
      { k: "intent", w: 1 },
      { k: "click", w: 1, commits: true },
      { k: "finish", w: 1, how: "ok" },
      { k: "resume", w: 0, beatFirst: false },
      { k: "intent", w: 0 }, // fenced: no click
      { k: "click", w: 0, commits: true }, // never reaches the bank (w0 is idle)
    ]);
    expect(job(world)).toMatchObject({ state: "succeeded", outcome: "success" });
    expect(rows(world)).toBe(1);
    expect(Object.values(found).flat()).toEqual([]);
    expect(oracleFor(world).pass).toBe(true);
  });

  it("crash after the click: T6.4 claims the job, verify [1] -> succeeded / already_done with the row's id; 1 row, attempt 1", () => {
    const { world } = run([
      { k: "dequeue", w: 0 },
      { k: "intent", w: 0 },
      { k: "click", w: 0, commits: true },
      { k: "crash", w: 0 },
      { k: "tick", dt: 31 },
      { k: "dequeue", w: 1 }, // T6.4 -> w1 verifies
      { k: "lookup", w: 1 },
      { k: "decide", w: 1 },
    ]);
    expect(job(world)).toMatchObject({ state: "succeeded", outcome: "already_done", attempt: 1 });
    expect((job(world).result as { outputs: { confirmationRef: string } }).outputs.confirmationRef).toBe("TXN-000001");
    expect(world.decisions).toEqual(["already_done:[1]"]);
    expect(oracleFor(world).pass).toBe(true);
  });

  it("crash after the intent, before the click: verify [0, 0] -> resubmitted; attempt 2 succeeds; exactly 1 row", () => {
    const { world, found } = run([
      { k: "dequeue", w: 0 },
      { k: "intent", w: 0 },
      { k: "crash", w: 0 },
      { k: "tick", dt: 31 },
      { k: "dequeue", w: 1 },
      { k: "lookup", w: 1 },
      { k: "tick", dt: 5 },
      { k: "lookup", w: 1 },
      { k: "decide", w: 1 },
      { k: "dequeue", w: 2 },
      { k: "intent", w: 2 },
      { k: "click", w: 2, commits: true },
      { k: "finish", w: 2, how: "ok" },
    ]);
    expect(world.decisions).toEqual(["resubmitted:[0,0]", "reconciled:[1]"]); // the drain's reconcile pass: 1 row
    expect(job(world)).toMatchObject({ state: "succeeded", outcome: "success", attempt: 2 });
    expect(job(world).reconciledAt).not.toBeNull();
    expect(rows(world)).toBe(1);
    expect(Object.values(found).flat()).toEqual([]);
  });

  it("D59: the same job, then BOTH its reconcilers die (cap 2): the deaths count apart from its crashes; the drain's pass abandons the reconcile (settled, `abandoned`, still succeeded); the end-of-day batch reconciles it", () => {
    const { world, found } = run(
      [
        { k: "dequeue", w: 0 },
        { k: "intent", w: 0 },
        { k: "crash", w: 0 }, // a death after the intent: crash 1 of 2 (T6.4)
        { k: "tick", dt: 31 },
        { k: "dequeue", w: 1 },
        { k: "lookup", w: 1 },
        { k: "tick", dt: 5 },
        { k: "lookup", w: 1 },
        { k: "decide", w: 1 }, // [0, 0] -> resubmitted
        { k: "dequeue", w: 2 },
        { k: "intent", w: 2 },
        { k: "click", w: 2, commits: true },
        { k: "finish", w: 2, how: "ok" }, // succeeded; the reconcile is due in 60 s
        { k: "tick", dt: 61 },
        { k: "dequeue", w: 1 }, // R1: w1 reconciles ...
        { k: "crash", w: 1 }, // ... and dies before its lookup
        { k: "tick", dt: 31 },
        { k: "dequeue", w: 2 }, // R1: w2 closes w1's phase (reconciler death 1) and reconciles ...
        { k: "crash", w: 2 }, // ... and dies too
        { k: "tick", dt: 31 },
      ],
      { maxCrashes: 2 },
    );
    // The drain's clean worker closes w2's phase: reconciler death 2 of 2 -> R3, no lease, no lookup.
    expect(world.decisions).toEqual(["resubmitted:[0,0]"]);
    expect(job(world)).toMatchObject({ state: "succeeded", outcome: "success", attempt: 2, crashes: 1, reconcileCrashes: 2, reconciledAt: null, owner: null });
    expect(job(world).reconcileAbandonedAt).not.toBeNull();
    expect(modelSettled(job(world))).toBe(true);
    expect(abandonedOnlyAtTheCap(world)).toEqual([]);
    expect(rows(world)).toBe(1);
    expect(Object.values(found).flat()).toEqual([]);
    // The end-of-day batch still covers it: one lookup, 1 row, reconciled.
    endOfDayBatch(world);
    expect(world.decisions).toEqual(["resubmitted:[0,0]", "reconciled:[1]"]);
    expect(job(world)).toMatchObject({ state: "succeeded", reconcileCrashes: 2, crashes: 1 });
    expect(job(world).reconciledAt).not.toBeNull();
  });

  it("the settle period: a second lookup before SETTLE seconds have passed is not taken", () => {
    const { world } = run([
      { k: "dequeue", w: 0 },
      { k: "intent", w: 0 },
      { k: "crash", w: 0 },
      { k: "tick", dt: 31 },
      { k: "dequeue", w: 1 },
      { k: "lookup", w: 1 },
      { k: "tick", dt: 4 },
      { k: "lookup", w: 1 }, // too early: ignored
      { k: "decide", w: 1 }, // incomplete: ignored
    ]);
    // Only the drain decided, after the settle period (then its reconcile).
    expect(world.decisions).toEqual(["resubmitted:[0,0]", "reconciled:[1]"]);
  });

  it("history lag 3 s < settle 5 s, the bank's answer lost after it committed (T5 verifies at once): [0, 1] -> already_done, 1 row", () => {
    const { world } = run(
      [
        { k: "dequeue", w: 0 },
        { k: "intent", w: 0 },
        { k: "click", w: 0, commits: true },
        { k: "finish", w: 0, how: "failure" }, // 503 after the write: commit uncertain -> T5
        { k: "lookup", w: 0 }, // at once: the row is not shown yet
        { k: "tick", dt: 5 },
        { k: "lookup", w: 0 }, // after the settle period: shown (3 < 5)
        { k: "decide", w: 0 },
      ],
      { lag: 3 },
    );
    expect(world.decisions).toEqual(["already_done:[0,1]"]);
    expect(job(world)).toMatchObject({ state: "succeeded", outcome: "already_done" });
    expect(rows(world)).toBe(1);
    expect(oracleFor(world).pass).toBe(true);
  });

  it("history lag 8 s > settle 5 s, the same crash: [0, 0] -> resubmitted -> a second transfer: DUPLICATE (the settle must exceed the lag) -- and the reconcile pass flags it (D47's backstop)", () => {
    const { world } = run(
      [
        { k: "dequeue", w: 0 },
        { k: "intent", w: 0 },
        { k: "click", w: 0, commits: true },
        { k: "finish", w: 0, how: "failure" },
        { k: "lookup", w: 0 },
        { k: "tick", dt: 5 },
        { k: "lookup", w: 0 }, // 5 < 8: still not shown
        { k: "decide", w: 0 },
        { k: "dequeue", w: 1 },
        { k: "intent", w: 1 },
        { k: "click", w: 1, commits: true },
        { k: "finish", w: 1, how: "ok" },
      ],
      { lag: 8 },
    );
    expect(world.decisions).toEqual(["resubmitted:[0,0]", "duplicate_suspected:[2]"]);
    expect(rows(world)).toBe(2);
    expect(world.zombieClick).toBe(false);
    expect(job(world)).toMatchObject({ state: "needs_human", outcome: "duplicate_suspected" });
    expect(oracleFor(world).findings[0]!.verdict).toBe("DUPLICATE");
  });

  it("frozen AFTER the intent past lease + settle (the section-6 window): verify [0, 0] resubmits, the zombie's late click lands too -- the honest limit, a DUPLICATE -- and the reconcile pass flags it: needs_human / duplicate_suspected", () => {
    const { world } = run([
      { k: "dequeue", w: 0 },
      { k: "intent", w: 0 },
      { k: "pause", w: 0 },
      { k: "tick", dt: 31 },
      { k: "dequeue", w: 1 }, // T6.4: w1 verifies
      { k: "lookup", w: 1 },
      { k: "tick", dt: 5 },
      { k: "lookup", w: 1 },
      { k: "decide", w: 1 }, // [0, 0]: resubmitted
      { k: "dequeue", w: 2 },
      { k: "intent", w: 2 },
      { k: "click", w: 2, commits: true },
      { k: "finish", w: 2, how: "ok" },
      { k: "resume", w: 0, beatFirst: false }, // the zombie acts before its heartbeat
      { k: "click", w: 0, commits: true }, // the bank has no lease to check
    ]);
    expect(world.zombieClick).toBe(true);
    expect(world.maxClickStaleness).toBeGreaterThanOrEqual(LEASE + SETTLE);
    expect(rows(world)).toBe(2);
    expect(world.decisions).toEqual(["resubmitted:[0,0]", "duplicate_suspected:[2]"]);
    expect(job(world)).toMatchObject({ state: "needs_human", outcome: "duplicate_suspected", attempt: 2 });
    expect(oracleFor(world).findings[0]!.verdict).toBe("DUPLICATE");
  });

  it("the reconcile pass's limit: a zombie still frozen when the reconcile READ the history clicks after it -- the duplicate stays succeeded (property 8's exemption); the end-of-day batch then flags it", () => {
    const { world, found } = run([
      { k: "dequeue", w: 0 },
      { k: "intent", w: 0 },
      { k: "pause", w: 0 },
      { k: "tick", dt: 31 },
      { k: "dequeue", w: 1 },
      { k: "lookup", w: 1 },
      { k: "tick", dt: 5 },
      { k: "lookup", w: 1 },
      { k: "decide", w: 1 }, // [0, 0]: resubmitted
      { k: "dequeue", w: 2 },
      { k: "intent", w: 2 },
      { k: "click", w: 2, commits: true },
      { k: "finish", w: 2, how: "ok" }, // succeeded after a resubmit: reconcile due in 60 s
      { k: "tick", dt: 45 },
      { k: "tick", dt: 20 },
      { k: "dequeue", w: 1 }, // R1
      { k: "lookup", w: 1 }, // reads 1 row
      { k: "decide", w: 1 }, // reconciled
      { k: "resume", w: 0, beatFirst: false },
      { k: "click", w: 0, commits: true }, // after the read: the history the pass saw had 1 row
    ]);
    expect(world.decisions).toEqual(["resubmitted:[0,0]", "reconciled:[1]"]);
    expect(rows(world)).toBe(2);
    expect(job(world)).toMatchObject({ state: "succeeded", attempt: 2 });
    expect(lateRow(world)).toBe(true);
    expect(silentDuplicate(world)).toBe(false); // exempt: the row came after the read
    expect(found.terminalMoved).toEqual([]);
    endOfDayBatch(world);
    expect(world.decisions.at(-1)).toBe("duplicate_suspected:[2]");
    expect(job(world)).toMatchObject({ state: "needs_human", outcome: "duplicate_suspected" });
  });

  // The reviewer decisions on 10a, decision 2 (D55): the zombie's late click on a job that did NOT succeed.
  const zombieAfterResubmit: Ev[] = [
    { k: "dequeue", w: 0 },
    { k: "intent", w: 0 },
    { k: "pause", w: 0 }, // frozen after its intent
    { k: "tick", dt: 31 },
    { k: "dequeue", w: 1 }, // T6.4: w1 verifies
    { k: "lookup", w: 1 },
    { k: "tick", dt: 5 },
    { k: "lookup", w: 1 },
    { k: "decide", w: 1 }, // [0, 0]: resubmitted
    { k: "dequeue", w: 2 }, // attempt 2 (the last of 2)
  ];

  it("D55, the reviewer's case: a resubmitted job that ends FAILED (attempt 2 fails before Submit), then the zombie's row -> the reconcile reads 1 where failed promises 0 -> needs_human / unrecorded_commit_suspected", () => {
    const { world, found } = run(
      [
        ...zombieAfterResubmit,
        { k: "finish", w: 2, how: "failure" }, // before Submit, attempts exhausted: T4 failed, marked (a resubmit before it)
        { k: "resume", w: 0, beatFirst: false },
        { k: "click", w: 0, commits: true }, // the zombie's late click: 1 row against a failed job
      ],
      { maxAttempts: 2 },
    );
    expect(world.zombieClick).toBe(true);
    expect(rows(world)).toBe(1);
    expect(world.decisions).toEqual(["resubmitted:[0,0]", "unrecorded_commit_suspected:[1]"]);
    expect(job(world)).toMatchObject({ state: "needs_human", outcome: "unrecorded_commit_suspected", attempt: 2 });
    expect(job(world).result).toMatchObject({ reconcile: { decision: "unrecorded_commit_suspected" } });
    expect(Object.values(found).flat()).toEqual([]); // failed -> needs_human is the reconcile's exception, nothing else moved
    expect(oracleFor(world).pass).toBe(true); // needs_human with its 1 row, listed (D32)
  });

  it("D55: the same with attempt 2 refused before Submit (business_outcome), or its worker dying at the crash cap (T6.2 crash_limit, D57): flagged the same way", () => {
    for (const [end, maxCrashes] of [
      [[{ k: "finish", w: 2, how: "refused" }] as Ev[], undefined],
      // T6.2 marks it: a cap of 2, since w0's death after its intent (T6.4) is the job's first (D58).
      [[{ k: "crash", w: 2 }, { k: "tick", dt: 31 }, { k: "recover", w: 1 }] as Ev[], 2],
    ] as const) {
      const { world } = run([...zombieAfterResubmit, ...end, { k: "resume", w: 0, beatFirst: false }, { k: "click", w: 0, commits: true }], { maxAttempts: 2, maxCrashes });
      expect(world.decisions.at(-1), JSON.stringify(end)).toBe("unrecorded_commit_suspected:[1]");
      expect(job(world)).toMatchObject({ state: "needs_human", outcome: "unrecorded_commit_suspected" });
    }
  });

  it("D57: under the default crash cap, attempt 2's worker dying is a crash (T6.1), not its last attempt -- the job runs again and succeeds, and the zombie's row makes it a duplicate the reconcile flags", () => {
    const { world } = run(
      [...zombieAfterResubmit, { k: "crash", w: 2 }, { k: "tick", dt: 31 }, { k: "recover", w: 1 }, { k: "resume", w: 0, beatFirst: false }, { k: "click", w: 0, commits: true }],
      { maxAttempts: 2 },
    );
    expect(world.decisions.at(-1)).toBe("duplicate_suspected:[2]");
    expect(job(world)).toMatchObject({ state: "needs_human", outcome: "duplicate_suspected", attempt: 3, crashes: 2, leaseCrashes: 1 });
  });

  it("D55: with no zombie, the resubmitted job that ended failed is reconciled with 0 rows and stays failed (settled)", () => {
    const { world } = run([...zombieAfterResubmit, { k: "finish", w: 2, how: "failure" }, { k: "resume", w: 0, beatFirst: true }], { maxAttempts: 2 });
    expect(rows(world)).toBe(0);
    expect(world.decisions).toEqual(["resubmitted:[0,0]", "reconciled:[0]"]);
    expect(job(world)).toMatchObject({ state: "failed", attempt: 2 });
    expect(job(world).reconciledAt).not.toBeNull();
    expect(oracleFor(world).pass).toBe(true);
  });

  it("D55, why `exhausted` is a trigger too: on the LAST attempt, T6.4 verifies [0, 0] and fails the job while its own worker is still frozen -- no resubmit ever happened, so the reviewer's rule alone would leave the zombie's row silent; it is flagged", () => {
    const { world } = run(
      [
        { k: "dequeue", w: 0 },
        { k: "intent", w: 0 },
        { k: "pause", w: 0 },
        { k: "tick", dt: 31 },
        { k: "dequeue", w: 1 },
        { k: "lookup", w: 1 },
        { k: "tick", dt: 5 },
        { k: "lookup", w: 1 },
        { k: "decide", w: 1 }, // [0, 0] on attempt 1/1: exhausted -> failed
        { k: "resume", w: 0, beatFirst: false },
        { k: "click", w: 0, commits: true },
      ],
      { maxAttempts: 1 },
    );
    expect(job(world).phases.some((p) => p.decision === "resubmitted")).toBe(false); // no resubmit at all
    expect(world.decisions).toEqual(["exhausted:[0,0]", "unrecorded_commit_suspected:[1]"]);
    expect(job(world)).toMatchObject({ state: "needs_human", outcome: "unrecorded_commit_suspected", attempt: 1 });
  });

  it("D55, the honest limit and the batch: the zombie still frozen when the reconcile READ the failed job's history clicks after it -- the row stays silent (property 10's exemption); the end-of-day batch flags it", () => {
    const { world } = run(
      [
        ...zombieAfterResubmit,
        { k: "finish", w: 2, how: "failure" },
        { k: "tick", dt: 45 },
        { k: "tick", dt: 20 }, // past the reconcile delay
        { k: "dequeue", w: 1 }, // R1 on the failed job
        { k: "lookup", w: 1 }, // 0 rows
        { k: "decide", w: 1 }, // reconciled: stays failed
        { k: "resume", w: 0, beatFirst: false },
        { k: "click", w: 0, commits: true },
      ],
      { maxAttempts: 2 },
    );
    expect(world.decisions).toEqual(["resubmitted:[0,0]", "reconciled:[0]"]);
    expect(job(world).state).toBe("failed");
    expect(unrecordedCommit(world)).toBe(true);
    expect(silentUnrecorded(world)).toBe(false); // exempt: the row came after the read
    endOfDayBatch(world);
    expect(world.decisions.at(-1)).toBe("unrecorded_commit_suspected:[1]");
    expect(job(world)).toMatchObject({ state: "needs_human", outcome: "unrecorded_commit_suspected" });
  });

  it("frozen after the intent, and its heartbeat fires first on waking: the run is aborted, no click; verify resubmits; 1 row", () => {
    const { world } = run([
      { k: "dequeue", w: 0 },
      { k: "intent", w: 0 },
      { k: "pause", w: 0 },
      { k: "tick", dt: 31 },
      { k: "recover", w: 1 }, // T6.4: w1 verifies
      { k: "resume", w: 0, beatFirst: true },
      { k: "click", w: 0, commits: true }, // w0 is idle after the abort: nothing happens
    ]);
    expect(rows(world)).toBe(1); // only the resubmitted attempt's
    expect(job(world)).toMatchObject({ state: "succeeded", attempt: 2 });
    expect(world.decisions).toEqual(["resubmitted:[0,0]", "reconciled:[1]"]);
  });

  it("a crash after the click on the LAST attempt is verified, not failed: already_done with 1 row, never UNRECORDED_COMMIT", () => {
    const { world } = run(
      [
        { k: "dequeue", w: 0 },
        { k: "intent", w: 0 },
        { k: "click", w: 0, commits: true },
        { k: "crash", w: 0 },
        { k: "tick", dt: 31 },
        { k: "recover", w: 1 },
      ],
      { maxAttempts: 1 },
    );
    expect(job(world)).toMatchObject({ state: "succeeded", outcome: "already_done", attempt: 1 });
    expect(oracleFor(world).pass).toBe(true);
  });

  it("the bank down during the verify: deferred (T8), resumed after the backoff (T6.7) while still down, then the outage ends -> [1] already_done; deferrals never exhaust the 3-phase cap", () => {
    const { world, found } = run([
      { k: "dequeue", w: 0 },
      { k: "intent", w: 0 },
      { k: "click", w: 0, commits: true },
      { k: "crash", w: 0 },
      { k: "bank", up: false },
      { k: "tick", dt: 31 },
      ...[1, 2, 1, 2].flatMap((w): Ev[] => [
        { k: "dequeue", w }, // T6.4, then T6.7 resumes
        { k: "lookup", w },
        { k: "decide", w }, // unavailable: deferred
        { k: "tick", dt: 21 }, // past the (capped) backoff
      ]),
      { k: "bank", up: true },
      { k: "dequeue", w: 1 },
      { k: "lookup", w: 1 },
      { k: "decide", w: 1 },
    ]);
    expect(world.decisions).toEqual(["deferred", "deferred", "deferred", "deferred", "already_done:[1]"]);
    expect(job(world)).toMatchObject({ state: "succeeded", outcome: "already_done" });
    expect(job(world).phases.map((p) => p.decision)).toEqual(["deferred", "deferred", "deferred", "deferred", "already_done"]);
    expect(Object.values(found).flat()).toEqual([]);
  });

  it("the bank down for longer than the deferral budget: needs_human / verify_unavailable (and only after looking once more)", () => {
    const { world } = run([
      { k: "dequeue", w: 0 },
      { k: "intent", w: 0 },
      { k: "crash", w: 0 },
      { k: "bank", up: false },
      { k: "tick", dt: 31 },
      ...Array.from({ length: 9 }, (_, i): Ev[] => [
        { k: "dequeue", w: 1 + (i % 2) },
        { k: "lookup", w: 1 + (i % 2) },
        { k: "decide", w: 1 + (i % 2) },
        { k: "tick", dt: 21 },
      ]).flat(),
    ]);
    expect(world.decisions.at(-1)).toBe("escalated:verify_unavailable:[null]");
    expect(job(world)).toMatchObject({ state: "needs_human", outcome: "verify_unavailable" });
  });

  it("three verifiers die in a row: Step 9's T6.6 (verify_exhausted at 3 dead phases) is gone -- 4 deaths are under the crash cap of 5, so a fourth verifier claims it and the drain decides it (D58)", () => {
    const { world } = run([
      { k: "dequeue", w: 0 },
      { k: "intent", w: 0 },
      { k: "crash", w: 0 },
      { k: "tick", dt: 31 },
      { k: "dequeue", w: 1 },
      { k: "crash", w: 1 },
      { k: "tick", dt: 31 },
      { k: "dequeue", w: 2 },
      { k: "crash", w: 2 },
      { k: "tick", dt: 31 },
      { k: "restart", w: 0 },
      { k: "dequeue", w: 0 },
      { k: "crash", w: 0 },
      { k: "tick", dt: 31 },
      { k: "restart", w: 1 },
      { k: "dequeue", w: 1 }, // 3 dead phases, 4 deaths: T6.5, not an escalation
    ]);
    // No click ever went out: the drain's verify reads [0, 0] and resubmits; the next attempt transfers once.
    expect(job(world).phases.slice(0, 3).map((p) => p.decision)).toEqual(["crashed", "crashed", "crashed"]);
    expect(job(world).phases[3]).toMatchObject({ reason: "lease_expired_in_verifying", decision: "resubmitted" });
    expect(job(world)).toMatchObject({ state: "succeeded", crashes: 4, leaseCrashes: 0 });
    expect(world.ledger).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------- requeue backoff (D49)
//
// Step 10 (docs/plans/step-10.md section 1, reviewer decision 2): retries back off. A separate, smaller
// simulation, because the property is about time, not interleavings: ONE job (3 attempts), 1-3 workers
// that poll as eagerly as possible (every worker after every clock step: the worst case for retry
// pressure), and ONE bank outage [start, start + D). A run is instantaneous at its dequeue: while the
// bank is down it fails before Submit (the bank's 503 page, a `failure` result), else it transfers.
// Every transition goes through the model (modelDequeue, modelComplete with the backoff, modelIntent) and
// the real jobOutcomeFor / requeueBackoffSeconds.

interface OutageScenario {
  workers: number;
  outageStart: number;
  outageSeconds: number;
  /** Clock steps; after each, every worker polls. */
  steps: number[];
  /** The jitter draw (random() in [0, 1)) of each requeue, in order. */
  jitters: number[];
}

const BACKOFF_MAX_ATTEMPTS = 3;
const MIN_SCHEDULE = minRequeueScheduleSeconds(BACKOFF_MAX_ATTEMPTS); // 32 s with the defaults

function outageArbOf(outage: fc.Arbitrary<number>): fc.Arbitrary<OutageScenario> {
  return fc.record({
    workers: fc.integer({ min: 1, max: 3 }),
    outageStart: fc.oneof(fc.constant(0), fc.double({ min: 0, max: 60, noNaN: true })),
    outageSeconds: outage,
    steps: fc.array(fc.constantFrom(0.25, 0.5, 1, 2, 5), { minLength: 1, maxLength: 80 }),
    jitters: fc.array(fc.oneof(fc.constant(0), fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true })), { minLength: BACKOFF_MAX_ATTEMPTS, maxLength: BACKOFF_MAX_ATTEMPTS }),
  });
}

const FAILURE_503: ReplayResult = { status: "failure", atStepId: "step-03", expected: "the member search page", observed: "503 System unavailable", category: "unexpected-state", evidenceRef: EV };

/** Runs the scenario to the end (eager polling continues, 1 s steps, until the job is terminal). */
function simulateOutage(s: OutageScenario, backoff: (attempt: number, random: () => number) => number): { final: ModelJob; rows: number; attemptsDuringOutage: number } {
  let db: ModelDb = { now: 0, caps: { [TENANT]: 2 }, jobs: [newJob({ id: JOB_ID, tenant: TENANT, seq: 1, maxAttempts: BACKOFF_MAX_ATTEMPTS })] };
  let rows = 0;
  let requeues = 0;
  let attemptsDuringOutage = 0;
  const down = () => db.now >= s.outageStart && db.now < s.outageStart + s.outageSeconds;
  const poll = (w: number) => {
    const owner = `w${w}`;
    const { db: leased, job: j } = modelDequeue(db, owner, LEASE);
    db = leased;
    if (!j) return;
    const ref: LeaseRef = { jobId: j.id, token: j.token, owner };
    if (down()) {
      attemptsDuringOutage += 1;
      const outcome = jobOutcomeFor({ kind: "result", result: FAILURE_503 }, { attempt: j.attempt, maxAttempts: j.maxAttempts, leaseCrashes: j.leaseCrashes, irreversibleStarted: false });
      const jitter = s.jitters[requeues] ?? 0.5;
      if (outcome.state === "queued") requeues += 1;
      const notBeforeSeconds = outcome.state === "queued" ? backoff(j.attempt, () => jitter) : null;
      db = modelComplete(db, ref, outcome.state as CompletionTarget, outcome.outcome, outcome.result, { notBeforeSeconds }).db;
      return;
    }
    db = modelIntent(db, ref, LEASE).db;
    rows += 1;
    db = modelComplete(db, ref, "succeeded", "success", { status: "success", outputs: { confirmationRef: `TXN-${rows}` } }).db;
  };
  const pollAll = () => {
    for (let w = 0; w < s.workers && !isTerminal(db.jobs[0]!.state); w += 1) poll(w);
  };
  pollAll();
  for (const dt of s.steps) {
    if (isTerminal(db.jobs[0]!.state)) break;
    db = modelTick(db, dt);
    pollAll();
  }
  for (let guard = 0; guard < 1000 && !isTerminal(db.jobs[0]!.state); guard += 1) {
    db = modelTick(db, 1);
    pollAll();
  }
  return { final: db.jobs[0]!, rows, attemptsDuringOutage };
}

describe(`the requeue backoff (Step 10, D49): retries back off; the shortest schedule to the 3rd attempt is ${MIN_SCHEDULE} s`, () => {
  it(`property 7: a bank outage shorter than the backoff schedule (< ${MIN_SCHEDULE} s, 3 attempts) fails no job, however eagerly the workers poll: it ends succeeded with exactly 1 row`, () => {
    fc.assert(
      fc.property(outageArbOf(fc.double({ min: 0.5, max: MIN_SCHEDULE, maxExcluded: true, noNaN: true })), (s) => {
        const r = simulateOutage(s, requeueBackoffSeconds);
        expect(r.final.state, `attempts during the outage: ${r.attemptsDuringOutage}`).toBe("succeeded");
        expect(r.final.attempt).toBeLessThanOrEqual(BACKOFF_MAX_ATTEMPTS);
        expect(r.rows).toBe(1);
      }),
      params,
    );
  }, PROPERTY_TIMEOUT_MS);

  it("property 7's bound is tight, and the backoff is what holds it: a longer outage can fail a job, and so can a 30 s outage with no backoff (the 'T4 requeue without not_before' mutant)", () => {
    const longer = fc.check(
      fc.property(outageArbOf(fc.double({ min: MIN_SCHEDULE + 0.5, max: 90, noNaN: true })), (s) => simulateOutage(s, requeueBackoffSeconds).final.state !== "failed"),
      params,
    );
    expect(longer.failed, "fast-check found no failed job with an outage longer than the schedule").toBe(true);
    const noBackoff = fc.check(
      fc.property(outageArbOf(fc.constant(30)), (s) => simulateOutage(s, () => 0).final.state !== "failed"),
      params,
    );
    expect(noBackoff.failed, "fast-check found no failed job without the backoff").toBe(true);
    // The shrunk counterexample: every attempt landed inside the outage.
    const [shrunk] = noBackoff.counterexample!;
    const r = simulateOutage(shrunk, () => 0);
    expect(r).toMatchObject({ final: { state: "failed", attempt: BACKOFF_MAX_ATTEMPTS }, rows: 0, attemptsDuringOutage: BACKOFF_MAX_ATTEMPTS });
  }, PROPERTY_TIMEOUT_MS);

  it("deterministic: the brief's 30 s outage starting with the first attempt, the smallest jitter, a worker polling every 250 ms: attempts at 0 s, 8 s and 32 s; the third succeeds", () => {
    const r = simulateOutage({ workers: 1, outageStart: 0, outageSeconds: 30, steps: Array.from({ length: 200 }, () => 0.25), jitters: [0, 0, 0] }, requeueBackoffSeconds);
    expect(r).toMatchObject({ final: { state: "succeeded", attempt: 3 }, rows: 1, attemptsDuringOutage: 2 });
  });
});
