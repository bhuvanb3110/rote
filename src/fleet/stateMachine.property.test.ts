// Property tests of the fleet's state machine (docs/plans/step-08.md section 7, reviewer addition R2),
// fast-check over a pure simulation: ONE transfer job, a bank ledger, three workers that can crash,
// restart, freeze (docker pause) and wake, and the database clock. Every job transition goes through
// src/fleet/model.ts (which mirrors the SQL) and every decision through the real jobOutcomeFor /
// completionAllowed / recoveryAction, so these properties are about the code the worker runs.
//
// Each property: 10 000 generated event sequences, a fixed seed; a failure prints the seed and the
// SHRUNK event sequence (fast-check's report), so it can be replayed exactly. Every sequence ends with
// the same drain (everyone wakes, the clock passes every lease, clean workers run the loop until the
// job is terminal), and the invariants are checked on every single transition, so a requeue that a
// dequeue undoes within the same event is still seen. Mutation-checked: making recoveryAction requeue
// an expired `committing` job fails properties 1, 5 and 6 (docs/DECISIONS.md D39).
//
// Step 8's machine (no verify yet): anything past the commit intent ends needs_human and is never
// requeued, so even a zombie click cannot produce a second transfer. Property 1 therefore holds for
// EVERY sequence here, zombies included; Step 9 (verify + resubmit) reopens the section-6 window, and
// property 1 then gets its "no worker clicks while frozen across its own lease expiry" precondition and
// property 2 its own form. Properties 3, 4, 5, 6 and R2's two are Step 8's set.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { ReplayResult } from "../artifact/index.js";
import { checkLedger, type LedgerRow } from "../oracle/index.js";
import {
  isTerminal,
  modelComplete,
  modelDequeue,
  modelHeartbeat,
  modelIntent,
  modelRecover,
  modelTick,
  newJob,
  type LeaseRef,
  type ModelDb,
  type ModelJob,
} from "./model.js";
import { jobOutcomeFor, type RunEnd } from "./stateMachine.js";

const LEASE = 30;
const BEAT = 10;
const RECOVER_PER_LOOP = 10;
const RUNS = 10_000;
const SEED = 20261111;
const JOB_ID = "00000000-0000-4000-8000-000000000001";
const MEMO = `rote-${JOB_ID}`;
const TENANT = "tenant-a";

// ------------------------------------------------------------------------------------------ events

type Ev =
  /** The worker loop: T6 recovery, then dequeue. */
  | { k: "dequeue"; w: number }
  /** An extra T6 pass (another worker's loop). */
  | { k: "recover"; w: number }
  /** onIrreversible.before: T3. */
  | { k: "intent"; w: number }
  /** The Submit reaches the bank: it appends a row (commits) or refuses. */
  | { k: "click"; w: number; commits: boolean }
  /** runReplay ends; jobOutcomeFor; T4. */
  | { k: "finish"; w: number; how: "ok" | "failure" | "refused" | "throw" }
  | { k: "crash"; w: number }
  | { k: "restart"; w: number }
  | { k: "pause"; w: number }
  /** beatFirst: the overdue heartbeat runs before anything else on waking (else the zombie acts first). */
  | { k: "resume"; w: number; beatFirst: boolean }
  /** The clock moves; live holders beat every <= 10 s within it. */
  | { k: "tick"; dt: number };

const worker = fc.integer({ min: 0, max: 2 });
const eventArb: fc.Arbitrary<Ev> = fc.oneof(
  { weight: 3, arbitrary: worker.map((w) => ({ k: "dequeue" as const, w })) },
  { weight: 1, arbitrary: worker.map((w) => ({ k: "recover" as const, w })) },
  { weight: 3, arbitrary: worker.map((w) => ({ k: "intent" as const, w })) },
  { weight: 3, arbitrary: fc.record({ k: fc.constant("click" as const), w: worker, commits: fc.boolean() }) },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("finish" as const), w: worker, how: fc.constantFrom("ok" as const, "failure" as const, "refused" as const, "throw" as const) }) },
  { weight: 2, arbitrary: worker.map((w) => ({ k: "crash" as const, w })) },
  { weight: 2, arbitrary: worker.map((w) => ({ k: "restart" as const, w })) },
  { weight: 2, arbitrary: worker.map((w) => ({ k: "pause" as const, w })) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("resume" as const), w: worker, beatFirst: fc.boolean() }) },
  { weight: 3, arbitrary: fc.integer({ min: 1, max: 45 }).map((dt) => ({ k: "tick" as const, dt })) },
);
const scenarioArb = fc.record({
  maxAttempts: fc.integer({ min: 1, max: 3 }),
  events: fc.array(eventArb, { maxLength: 60, size: "max" }),
});
type Scenario = { maxAttempts: number; events: Ev[] };

// ------------------------------------------------------------------------------------------- world

type Phase = "idle" | "steps" | "intent" | "clicked";
interface SimWorker {
  name: string;
  incarnation: number;
  alive: boolean;
  paused: boolean;
  phase: Phase;
  /** The lease this worker believes it holds (kept while frozen: that is the zombie). */
  held: { token: number; attempt: number } | null;
  /** The row its click wrote, when the bank committed it. */
  clickedRow: LedgerRow | null;
}

interface World {
  db: ModelDb;
  ledger: LedgerRow[];
  workers: SimWorker[];
  /** Set once any attempt wrote a commit intent (property 5). */
  intentEver: boolean;
  /** Owner of the most recent successful dequeue (R2a). */
  lastDequeuer: string | null;
  violations: string[];
  /** Every change of the job's state or token, as it happens (several can happen inside one event). */
  transitions: Transition[];
}

interface Transition {
  from: ModelJob;
  to: ModelJob;
  /** An intent had been written for this job before this transition. */
  afterIntent: boolean;
}

/** The only way the simulation writes the database: records every job transition. */
function commit(world: World, db: ModelDb): void {
  const from = job(world);
  world.db = db;
  const to = job(world);
  if (from.state !== to.state || from.token !== to.token) world.transitions.push({ from, to, afterIntent: world.intentEver });
}

const idOf = (w: SimWorker) => `${w.name}#${w.incarnation}`;
const job = (world: World): ModelJob => world.db.jobs[0]!;
const refOf = (w: SimWorker): LeaseRef => ({ jobId: JOB_ID, token: w.held!.token, owner: idOf(w) });
const canAct = (w: SimWorker) => w.alive && !w.paused;

function newWorld(maxAttempts: number): World {
  return {
    db: { now: 0, caps: { [TENANT]: 2 }, jobs: [newJob({ id: JOB_ID, tenant: TENANT, seq: 1, maxAttempts })] },
    ledger: [],
    workers: ["w0", "w1", "w2"].map((name) => ({ name, incarnation: 0, alive: true, paused: false, phase: "idle", held: null, clickedRow: null })),
    intentEver: false,
    lastDequeuer: null,
    violations: [],
    transitions: [],
  };
}

const EV = "evidence://model";

/** What runReplay would hand back, given how far the run got and how it ended (D10, D11, rule 5.3). */
function runEndFor(w: SimWorker, how: "ok" | "failure" | "refused" | "throw"): RunEnd {
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

/** The worker's run ends: jobOutcomeFor decides, T4 records (fenced). */
function finishRun(world: World, w: SimWorker, end: RunEnd, irreversibleStarted: boolean): void {
  const j = job(world);
  const outcome = jobOutcomeFor(end, { attempt: w.held!.attempt, maxAttempts: j.maxAttempts, irreversibleStarted });
  const { db, result } = modelComplete(world.db, refOf(w), outcome.state, outcome.outcome, outcome.result);
  if (result === "check_violation") world.violations.push(`T4 would violate jobs_queued_has_attempts_left (${outcome.state} at attempt ${w.held!.attempt})`);
  commit(world, db);
  w.phase = "idle";
  w.held = null;
  w.clickedRow = null;
}

/** The heartbeat found the lease gone: runReplay rejects with LeaseLostError; nothing goes to jobs. */
function loseLease(w: SimWorker): void {
  w.phase = "idle";
  w.held = null;
  w.clickedRow = null;
}

function beat(world: World, w: SimWorker): void {
  if (!w.held || w.phase === "idle") return;
  const { db, extended } = modelHeartbeat(world.db, refOf(w), LEASE);
  commit(world, db);
  if (!extended) loseLease(w);
}

function recover(world: World): void {
  commit(world, modelRecover(world.db, RECOVER_PER_LOOP).db);
}

function dequeue(world: World, w: SimWorker): void {
  recover(world);
  const { db, job: leased } = modelDequeue(world.db, idOf(w), LEASE);
  commit(world, db);
  if (leased) {
    w.held = { token: leased.token, attempt: leased.attempt };
    w.phase = "steps";
    world.lastDequeuer = idOf(w);
  }
}

function intent(world: World, w: SimWorker): void {
  const { db, written } = modelIntent(world.db, refOf(w), LEASE);
  commit(world, db);
  if (written) {
    w.phase = "intent";
    world.intentEver = true;
  } else {
    // FencingError: definitely not written, no click; the run rejects and is retried like any
    // failure before the irreversible step (its T4 is fenced unless the lease merely expired).
    finishRun(world, w, { kind: "thrown", error: new Error("FencingError"), aborted: false }, false);
  }
}

function click(world: World, w: SimWorker, commits: boolean): void {
  if (commits) {
    const row: LedgerRow = { id: `TXN-${String(world.ledger.length + 1).padStart(6, "0")}`, tenantId: TENANT, fromMemberId: "10001", toMemberId: "10002", amount: 1, memo: MEMO };
    world.ledger.push(row);
    w.clickedRow = row;
  }
  w.phase = "clicked";
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
  const w = world.workers[ev.w]!;
  switch (ev.k) {
    case "dequeue":
      if (canAct(w) && w.phase === "idle") dequeue(world, w);
      return;
    case "recover":
      if (canAct(w)) recover(world);
      return;
    case "intent":
      if (canAct(w) && w.phase === "steps") intent(world, w);
      return;
    case "click":
      if (canAct(w) && w.phase === "intent") click(world, w, ev.commits);
      return;
    case "finish":
      if (canAct(w) && w.phase !== "idle") finishRun(world, w, runEndFor(w, ev.how), w.phase !== "steps");
      return;
    case "crash":
      if (w.alive) Object.assign(w, { alive: false, paused: false, phase: "idle", held: null, clickedRow: null });
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

interface Trace {
  world: World;
  /** Problems found after any event, by property. */
  found: Record<"duplicate" | "terminalMoved" | "queuedExhausted" | "requeueAfterIntent" | "twoHolders" | "tokenDecreased", string[]>;
}

function holdersOfValidLease(world: World): string[] {
  const j = job(world);
  return world.workers
    .filter((w) => w.alive && w.held && w.held.token === j.token && j.owner === idOf(w) && j.leaseExpiresAt !== null && j.leaseExpiresAt > world.db.now)
    .map(idOf);
}

/**
 * The generated events, then the drain (quiesce): every property sees the whole life of the job,
 * including the recoveries that only happen once everyone's lease has passed. Invariants are checked
 * after every event and on every transition, the drain's included.
 */
function simulate(s: Scenario): Trace {
  const trace = runEvents(s);
  const { world, found } = trace;
  const seen = world.transitions.length;
  quiesce(world);
  checkTransitions(world.transitions.slice(seen), "drain", found);
  if (world.ledger.length > 1) found.duplicate.push(`drain: ${world.ledger.length} ledger rows`);
  return trace;
}

function runEvents(s: Scenario): Trace {
  const world = newWorld(s.maxAttempts);
  const found: Trace["found"] = { duplicate: [], terminalMoved: [], queuedExhausted: [], requeueAfterIntent: [], twoHolders: [], tokenDecreased: [] };
  s.events.forEach((ev, i) => {
    const seen = world.transitions.length;
    apply(world, ev);
    const at = `event ${i} ${JSON.stringify(ev)}`;
    checkTransitions(world.transitions.slice(seen), at, found);
    if (world.ledger.length > 1) found.duplicate.push(`${at}: ${world.ledger.length} ledger rows`);
    const holders = holdersOfValidLease(world);
    if (holders.length > 1 || (holders.length === 1 && holders[0] !== world.lastDequeuer)) {
      found.twoHolders.push(`${at}: valid holders ${JSON.stringify(holders)}, last dequeuer ${world.lastDequeuer}`);
    }
  });
  for (const v of world.violations) found.queuedExhausted.push(v);
  return { world, found };
}

/** Checked on EVERY transition, including the ones inside one event (recover, then dequeue). */
function checkTransitions(transitions: Transition[], at: string, found: Trace["found"]): void {
  for (const { from, to, afterIntent } of transitions) {
    const what = `${at}: ${from.state}/${from.token} -> ${to.state}/${to.token}`;
    if (isTerminal(from.state)) found.terminalMoved.push(what);
    if (to.state === "queued" && !(to.attempt < to.maxAttempts)) found.queuedExhausted.push(`${what} at attempt ${to.attempt}/${to.maxAttempts}`);
    if (to.state === "queued" && afterIntent) found.requeueAfterIntent.push(`${what} after a commit intent`);
    if (to.token < from.token) found.tokenDecreased.push(what);
  }
}

/**
 * Property 3's epilogue: everyone wakes (heartbeat first), every live run finishes, the clock passes
 * every lease, then clean workers run the loop (recover, dequeue, run to success) until the job is
 * terminal or the attempts are surely spent.
 */
/** Read through a call so TypeScript does not narrow a phase that the simulation mutates. */
const phaseOf = (w: SimWorker): Phase => w.phase;

function quiesce(world: World): void {
  for (const w of world.workers) if (w.alive && w.paused) apply(world, { k: "resume", w: world.workers.indexOf(w), beatFirst: true });
  for (const w of world.workers) {
    if (!canAct(w) || w.phase === "idle") continue;
    const i = world.workers.indexOf(w);
    if (w.phase === "steps") apply(world, { k: "intent", w: i });
    if (w.phase === "intent") apply(world, { k: "click", w: i, commits: true });
    if (w.phase === "clicked") apply(world, { k: "finish", w: i, how: "ok" });
  }
  commit(world, modelTick(world.db, LEASE + 1));
  for (let round = 0; round < job(world).maxAttempts + 3 && !isTerminal(job(world).state); round += 1) {
    const clean: SimWorker = { name: `clean${round}`, incarnation: 0, alive: true, paused: false, phase: "idle", held: null, clickedRow: null };
    dequeue(world, clean);
    if (phaseOf(clean) === "steps") {
      intent(world, clean);
      if (phaseOf(clean) === "intent") {
        click(world, clean, true);
        finishRun(world, clean, runEndFor(clean, "ok"), true);
      }
    }
    commit(world, modelTick(world.db, LEASE + 1));
  }
}

function oracleFor(world: World) {
  const j = job(world);
  return checkLedger({
    jobs: [{ id: j.id, tenant_id: TENANT, state: j.state, memo_key: MEMO, result: j.result, lease_owner: j.owner, attempt: j.attempt, outcome: j.outcome }],
    ledger: world.ledger,
    drainTimedOut: true,
  });
}

const params = { numRuns: RUNS, seed: SEED };

describe("fleet state machine, pure model (Step 8), 10 000 sequences per property", () => {
  it("property 1 (Step 8 form): no duplicate transfer in ANY sequence, zombies included -- nothing is requeued after an intent", () => {
    fc.assert(fc.property(scenarioArb, (s) => {
      expect(simulate(s).found.duplicate).toEqual([]);
    }), params);
  });

  it("property 3: no lost job -- after everyone wakes and the leases pass, recovery + clean workers reach a terminal state", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { world } = simulate(s);
        expect(isTerminal(job(world).state), `job ended ${job(world).state}`).toBe(true);
      }),
      params,
    );
  });

  it("property 4: terminal states are final, and queued always has an attempt left (D21)", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { found } = simulate(s);
        expect(found.terminalMoved).toEqual([]);
        expect(found.queuedExhausted).toEqual([]);
      }),
      params,
    );
  });

  it("property 5 (Step 8 form): no blind retry after the intent -- a job never returns to queued once an intent was written", () => {
    fc.assert(fc.property(scenarioArb, (s) => {
      expect(simulate(s).found.requeueAfterIntent).toEqual([]);
    }), params);
  });

  it("property 6: the oracle agrees with the model -- checkLedger passes exactly when there is no duplicate and the job is terminal", () => {
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { world, found } = simulate(s);
        expect(Object.values(found).flat()).toEqual([]);
        const noDuplicate = world.ledger.length <= 1;
        const terminal = isTerminal(job(world).state);
        const report = oracleFor(world);
        expect(report.pass, report.text).toBe(noDuplicate && terminal);
        expect(report.pass, report.text).toBe(true); // Step 8: both always hold
      }),
      params,
    );
  });

  it("R2a: at most one worker holds a valid lease (owner + token match, lease_expires_at > now), and it is the latest dequeuer", () => {
    fc.assert(fc.property(scenarioArb, (s) => {
      expect(simulate(s).found.twoHolders).toEqual([]);
    }), params);
  });

  it("R2b: the fencing token never decreases", () => {
    fc.assert(fc.property(scenarioArb, (s) => {
      expect(simulate(s).found.tokenDecreased).toEqual([]);
    }), params);
  });
});

describe("the simulation reaches the interesting states (so the properties are not vacuous)", () => {
  it("over the same sequences: zombie clicks, recoveries of every kind, every terminal state", () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(scenarioArb, (s) => {
        const { world } = simulate(s);
        for (const t of world.transitions) if (t.from.state !== t.to.state) seen.add(`${t.from.state}->${t.to.state}`);
        seen.add(`final:${job(world).state}`);
        seen.add(`rows:${world.ledger.length}`);
      }),
      { numRuns: 2000, seed: SEED },
    );
    for (const expected of [
      "running->queued", // T6.1 or T4 requeue
      "running->failed", // T6.2 or T4 exhausted
      "committing->needs_human", // T6.3 or T4 commit_uncertain
      "committing->succeeded",
      "running->business_outcome",
      "final:succeeded",
      "final:needs_human",
      "final:failed",
      "final:business_outcome",
      "rows:0",
      "rows:1",
    ] as const satisfies readonly string[]) {
      expect(seen, `never reached: ${expected}`).toContain(expected);
    }
    expect(seen).not.toContain("rows:2");
  });
});

describe("the zombie, deterministically (docs/plans/step-08.md section 6, Step 8 rows)", () => {
  const run = (events: Ev[], maxAttempts = 3) => simulate({ maxAttempts, events });

  it("frozen BEFORE the intent: recovered (T6.1) and finished by another worker; on waking, its fenced T3 stops the click", () => {
    const { world, found } = run([
      { k: "dequeue", w: 0 },
      { k: "pause", w: 0 },
      { k: "tick", dt: 31 }, // w0's lease expires while it is frozen
      { k: "dequeue", w: 1 }, // T6.1 requeue (token +1), then w1 leases it (token +1)
      { k: "intent", w: 1 },
      { k: "click", w: 1, commits: true },
      { k: "finish", w: 1, how: "ok" },
      { k: "resume", w: 0, beatFirst: false }, // the zombie acts before its heartbeat
      { k: "intent", w: 0 }, // fenced: no click
      { k: "click", w: 0, commits: true }, // never reaches the bank (w0 is idle)
    ]);
    expect(job(world).state).toBe("succeeded");
    expect(world.ledger).toHaveLength(1);
    expect(Object.values(found).flat()).toEqual([]);
    expect(oracleFor(world).pass).toBe(true);
  });

  it("frozen AFTER the intent, before the click (the section-6 window): Step 8 escalates (T6.3) and never requeues, so the zombie's late click is the only row", () => {
    const { world, found } = run([
      { k: "dequeue", w: 0 },
      { k: "intent", w: 0 },
      { k: "pause", w: 0 },
      { k: "tick", dt: 31 },
      { k: "dequeue", w: 1 }, // T6.3: needs_human / commit_uncertain; nothing to dequeue
      { k: "resume", w: 0, beatFirst: false },
      { k: "click", w: 0, commits: true }, // the zombie's click lands: the bank has no lease to check
      { k: "finish", w: 0, how: "ok" }, // its T4 is fenced (token bumped)
    ]);
    expect(job(world)).toMatchObject({ state: "needs_human", outcome: "commit_uncertain" });
    expect(world.ledger).toHaveLength(1);
    expect(Object.values(found).flat()).toEqual([]);
    expect(oracleFor(world).pass).toBe(true);
  });

  it("frozen after the intent, and its heartbeat fires first on waking: the run is aborted, no click, 0 rows", () => {
    const { world } = run([
      { k: "dequeue", w: 0 },
      { k: "intent", w: 0 },
      { k: "pause", w: 0 },
      { k: "tick", dt: 31 },
      { k: "recover", w: 1 },
      { k: "resume", w: 0, beatFirst: true },
      { k: "click", w: 0, commits: true }, // w0 is idle after the abort: nothing happens
    ]);
    expect(job(world)).toMatchObject({ state: "needs_human", outcome: "commit_uncertain" });
    expect(world.ledger).toHaveLength(0);
  });

  it("a crash after the click on the LAST attempt is escalated, not failed: needs_human with 1 row, never UNRECORDED_COMMIT", () => {
    const { world } = run(
      [
        { k: "dequeue", w: 0 },
        { k: "intent", w: 0 },
        { k: "click", w: 0, commits: true },
        { k: "crash", w: 0 },
        { k: "tick", dt: 31 },
        { k: "recover", w: 1 },
      ],
      1,
    );
    expect(job(world)).toMatchObject({ state: "needs_human", outcome: "commit_uncertain", attempt: 1 });
    expect(world.ledger).toHaveLength(1);
    expect(oracleFor(world).pass).toBe(true);
  });
});
