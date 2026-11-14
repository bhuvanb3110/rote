// The worker's poll loop (docs/plans/step-06.md sections 1 and 6; Day 2: docs/plans/step-08.md):
//
//   while not stopping:
//     claim = beforeDequeue()         # seam 4: expired-lease recovery (T6) runs HERE, then R1 (a due reconcile)
//     if claim: verify it (T6.4/T6.5/T6.7 handed this worker a job to verify), or reconcile it (R1 ->
//               lookup -> R2, Step 10 D50); that is the iteration
//     job = dequeue(...)              # transient DB error -> log, back off (cap 5 s), never exit
//     if none: sleep(poll backoff)    # 100 ms base, x2, cap 2 s, full jitter
//     heartbeat (T2) while it runs; run it; record it (T4, fenced; retried while Postgres is down);
//     a requeue after a failure backs off (not_before, requeueBackoffSeconds; Step 10, D49)
//     ... or, if it may have committed, move it into this worker's own verify phase (T5) and verify
//     it at once (src/worker/verify.ts: lookups, settle, T7 / T8)
//
// The heartbeat (heartbeatSeconds; Compose: 10 s against a 30 s lease) extends the lease on the
// database clock. When it finds the lease gone it aborts the run with a LeaseLostError: runReplay
// closes the context and rejects (D11), and the worker records NOTHING on `jobs` (the job is
// recovery's now), only `lease_lost` on its own attempt row.
//
// Graceful stop (SIGTERM/SIGINT): stop dequeuing at once; let an in-flight job finish for up to
// shutdownGraceMs, then abort it (runReplay closes its context and rejects, D11) and record that per
// jobOutcomeFor's abort rows. A second stop() aborts at once and stops retrying a completion.
// SIGKILL / OOM: nothing runs; the lease expires (no heartbeat) and another worker's recovery takes it.
import type { Browser } from "playwright";
import { dequeue, type JobRow, type Pool } from "../queue/index.js";
import { createBackoff, sleep } from "./backoff.js";
import { completeJobWithRetry, markAttemptLeaseLost, retryTransient } from "./complete.js";
import { Heartbeat, validateLeaseTiming } from "./heartbeat.js";
import { writeCommitIntent } from "./intent.js";
import { LeaseLostError } from "./leaseErrors.js";
import { redactDeep, type Redactor } from "./credentials.js";
import { isTransientDbError } from "../queue/index.js";
import { jobOutcomeFor, requeueBackoffSeconds, type JobOutcome } from "../fleet/stateMachine.js";
import type { RunJobOptions, RunJobResult } from "./runJob.js";
import { NO_FAULT, type FaultInjector } from "./fault.js";
import { NO_METRICS, type WorkerMetrics } from "./metrics.js";
import type { FencedOutReason } from "./complete.js";
import type { VerifyClaim } from "./recover.js";
import type { ReconcileClaim, ReconcilePhaseOutcome } from "./reconcile.js";
import type { VerifyPhaseOutcome } from "./verify.js";
import { completeIntoVerify } from "./verifySql.js";

export interface WorkerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export const silentLogger: WorkerLogger = { info() {}, warn() {}, error() {} };

/** The reason a shutdown abort carries (runReplay rejects with it). */
export class ShutdownAbortError extends Error {
  constructor() {
    super("worker shutting down: shutdown grace period expired");
    this.name = "AbortError";
  }
}

export interface JobDone {
  job: JobRow;
  outcome: JobOutcome;
  /** false: the lease was lost (nothing recorded on jobs); null: shutdown stopped the completion retry. */
  recorded: boolean | null;
  /** Why a completion was not recorded: the lease was lost, or (a bug) the state guard refused it (D41). */
  fencedOut?: FencedOutReason;
  durationMs: number;
}

export interface WorkerOptions {
  pool: Pool;
  workerId: string;
  /** Lease length (Compose: 30 s). Every dequeue, heartbeat and commit intent sets now() + this. */
  leaseSeconds: number;
  /**
   * Heartbeat interval (Compose: 10 s); must satisfy heartbeat * 2 < lease. Omitted: no heartbeat
   * (unit tests with long leases only; the worker entrypoint always sets it).
   */
  heartbeatSeconds?: number;
  /** A connected browser; relaunches if the last one died (one Chromium per worker, D13). */
  getBrowser: () => Promise<Browser>;
  runJob: (job: JobRow, options: RunJobOptions) => Promise<RunJobResult>;
  redact: Redactor;
  log?: WorkerLogger;
  /** Default 30 s (inside Compose's 45 s stop_grace_period). */
  shutdownGraceMs?: number;
  random?: () => number;
  /** Called after every loop iteration (health file, tests). */
  onTick?: () => void;
  onJobDone?: (done: JobDone) => void;
  /** Test-only crash points after-dequeue / before-complete / after-complete (fault.ts, D34). */
  fault?: FaultInjector;
  /**
   * Seam 4: expired-lease recovery (createRecoverySweep, T6). The entrypoint always sets it. Resolves
   * with a job it claimed to verify (T6.4/T6.5/T6.7), which is then this iteration's work.
   */
  beforeDequeue?: () => Promise<VerifyClaim | ReconcileClaim | null | void>;
  /**
   * Runs one verify phase (src/worker/verify.ts runVerifyPhase) on a job this worker holds in
   * `verifying` (after T5, or a recovery claim). The entrypoint always sets it. Without it, a
   * commit-uncertain run still goes through T5 and the job waits for a verifier's recovery.
   */
  verify?: (claim: VerifyClaim, controller: AbortController, hardSignal: AbortSignal) => Promise<VerifyPhaseOutcome>;
  onVerifyDone?: (done: VerifyPhaseOutcome) => void;
  /**
   * Runs one reconcile (src/worker/reconcile.ts runReconcilePhase) on a job recovery's sweep claimed with
   * R1 (Step 10, D50). The entrypoint always sets it. Without it, the claim's lease simply expires and
   * another worker reconciles the job.
   */
  reconcile?: (claim: ReconcileClaim, controller: AbortController, hardSignal: AbortSignal) => Promise<ReconcilePhaseOutcome>;
  onReconcileDone?: (done: ReconcilePhaseOutcome) => void;
  /**
   * T4 marks a success after a resubmit for the reconcile pass this many seconds later (lease + settle +
   * margin, D50). Default: 60 (the production defaults).
   */
  reconcileDueSeconds?: number;
  /** Counters (illegal_transitions_total, ...); Day 3 exports them. Default: not counted. */
  metrics?: WorkerMetrics;
  /**
   * Seconds a requeue after a failed attempt waits before the job may be dequeued again (T4's
   * not_before; Step 10, D49). Default: requeueBackoffSeconds(attempt, random): 10 s, 30 s, 90 s, capped
   * at 120 s, jittered x [0.8, 1.2).
   */
  requeueBackoff?: (attempt: number) => number;
}

export type TickResult = "ran" | "idle" | "db-unavailable";

export class Worker {
  private stopping = false;
  /** Wakes idle/backoff sleeps on stop(). */
  private readonly wake = new AbortController();
  /** Second stop(): abort the job now and stop retrying its completion. */
  private readonly hard = new AbortController();
  private current: { controller: AbortController; graceTimer?: NodeJS.Timeout } | null = null;
  private readonly log: WorkerLogger;
  private readonly pollBackoff;
  private readonly dbBackoff;

  constructor(private readonly options: WorkerOptions) {
    if (options.heartbeatSeconds !== undefined) validateLeaseTiming(options.leaseSeconds, options.heartbeatSeconds);
    this.log = options.log ?? silentLogger;
    this.pollBackoff = createBackoff({ baseMs: 100, capMs: 2000, random: options.random });
    this.dbBackoff = createBackoff({ baseMs: 200, capMs: 5000, random: options.random });
  }

  get isStopping(): boolean {
    return this.stopping;
  }

  /**
   * First call: graceful (no new dequeues; the in-flight job gets shutdownGraceMs, then is aborted).
   * Second call: abort the in-flight job at once and stop retrying its completion.
   */
  stop(): void {
    if (!this.stopping) {
      this.stopping = true;
      this.wake.abort();
      const current = this.current;
      if (current) {
        const grace = this.options.shutdownGraceMs ?? 30_000;
        this.log.info({ workerId: this.options.workerId, graceMs: grace }, "worker: stopping; letting the in-flight job finish");
        current.graceTimer = setTimeout(() => current.controller.abort(new ShutdownAbortError()), grace);
      } else {
        this.log.info({ workerId: this.options.workerId }, "worker: stopping (idle)");
      }
      return;
    }
    this.log.warn({ workerId: this.options.workerId }, "worker: second stop signal; aborting now");
    this.hard.abort();
    this.current?.controller.abort(new ShutdownAbortError());
  }

  /** One iteration: verify a job recovery just claimed, or dequeue at most one job and run + record it. */
  async tick(): Promise<TickResult> {
    const claim = await this.options.beforeDequeue?.();
    if (claim) {
      if (claim.label === "R1") await this.reconcilePhase(claim);
      else await this.verifyPhase(claim);
      return "ran";
    }
    let job: JobRow | null;
    try {
      job = await dequeue(this.options.pool, { workerId: this.options.workerId, leaseSeconds: this.options.leaseSeconds });
    } catch (err) {
      if (!isTransientDbError(err)) throw err;
      this.log.warn({ workerId: this.options.workerId, err: this.describe(err) }, "worker: Postgres unavailable during dequeue; backing off");
      return "db-unavailable";
    }
    if (!job) return "idle";
    await this.process(job);
    return "ran";
  }

  /** Loops until stop(). Rejects only on a fatal (non-transient) error. */
  async run(): Promise<void> {
    this.log.info({ workerId: this.options.workerId, leaseSeconds: this.options.leaseSeconds }, "worker: started");
    while (!this.stopping) {
      const result = await this.tick();
      this.options.onTick?.();
      if (result === "ran") {
        this.pollBackoff.reset();
        this.dbBackoff.reset();
      } else if (result === "idle") {
        this.dbBackoff.reset();
        await sleep(this.pollBackoff.next(), this.wake.signal);
      } else {
        await sleep(this.dbBackoff.next(), this.wake.signal);
      }
    }
    this.log.info({ workerId: this.options.workerId }, "worker: stopped");
  }

  private describe(err: unknown): string {
    return this.options.redact(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
  }

  private async process(job: JobRow): Promise<void> {
    const started = Date.now();
    const controller = new AbortController();
    this.current = { controller };
    const log = { workerId: this.options.workerId, jobId: job.id, tenant: job.tenant_id, capability: job.capability_id, attempt: job.attempt };
    this.log.info(log, "worker: job leased");
    const fault = this.options.fault ?? NO_FAULT;
    fault.at("after-dequeue"); // lease taken, before any browser work
    const heartbeat =
      this.options.heartbeatSeconds === undefined
        ? null
        : new Heartbeat({
            pool: this.options.pool,
            jobId: job.id,
            fencingToken: job.fencing_token,
            workerId: this.options.workerId,
            leaseSeconds: this.options.leaseSeconds,
            intervalMs: this.options.heartbeatSeconds * 1000,
            controller,
            log: this.log,
          });
    heartbeat?.start();
    try {
      let run: RunJobResult;
      try {
        const browser = await this.options.getBrowser();
        run = await this.options.runJob(job, {
          browser,
          signal: controller.signal,
          // T3, right before the Submit: fenced on this lease's token and owner, and on the lease
          // still being alive by the database's clock.
          commitIntent: async () => {
            await writeCommitIntent(this.options.pool, {
              jobId: job.id,
              fencingToken: job.fencing_token,
              workerId: this.options.workerId,
              leaseSeconds: this.options.leaseSeconds,
            });
            this.log.info(log, "worker: commit intent written; clicking Submit");
            // TEST-ONLY stall fault (stall-after-intent, D52): a frozen process runs no timers, so the
            // heartbeat stops; after the stall the click goes out at once (the zombie window's worst case).
            if (fault.stallMs("stall-after-intent") > 0) {
              heartbeat?.stop();
              this.log.warn({ ...log, stallMs: fault.stallMs("stall-after-intent") }, "worker: FAULT stall-after-intent: heartbeat suspended; frozen after the intent");
              await fault.stall("stall-after-intent");
            }
          },
        });
      } catch (error) {
        // getBrowser failed (Chromium would not start) or a bug escaped runJob: nothing irreversible ran.
        run = { end: { kind: "thrown", error, aborted: controller.signal.aborted }, irreversibleStarted: false };
      }
      // The heartbeat stops before the completion transaction (and on every other exit, below).
      heartbeat?.stop();
      const lost: unknown = controller.signal.reason;
      if (run.end.kind === "thrown" && lost instanceof LeaseLostError) {
        // The run was aborted because this worker no longer holds the job: write NOTHING to jobs.
        // (A run that returned a result before the abort landed still goes through the fenced T4.)
        const irreversibleStarted = run.irreversibleStarted;
        const marked = await retryTransient(
          () =>
            markAttemptLeaseLost(this.options.pool, {
              jobId: job.id,
              fencingToken: job.fencing_token,
              detail: this.options.redact(`lease lost during the run (heartbeat); nothing recorded on the job. ${lost.message}`),
              commitUncertain: irreversibleStarted,
            }),
          { signal: this.hard.signal, random: this.options.random },
        );
        this.log.warn(
          { ...log, err: lost.message, irreversibleStarted, attemptMarked: marked !== null, ms: Date.now() - started },
          "worker: lease lost; run aborted, outcome NOT recorded on the job",
        );
        const outcome = jobOutcomeFor(run.end, {
          attempt: job.attempt,
          maxAttempts: job.max_attempts,
          irreversibleStarted,
          redact: this.options.redact,
        });
        this.options.onJobDone?.({ job, outcome, recorded: false, durationMs: Date.now() - started });
        return;
      }
      const computed = jobOutcomeFor(run.end, {
        attempt: job.attempt,
        maxAttempts: job.max_attempts,
        irreversibleStarted: run.irreversibleStarted,
        redact: this.options.redact,
      });
      // Replay already redacts its result; this is the belt to that braces (credential values only).
      const outcome: JobOutcome = { ...computed, result: computed.result && redactDeep(computed.result, this.options.redact) };
      fault.at("before-complete"); // outcome computed, completion transaction not started
      if (outcome.state === "verifying") {
        // The run may have committed: T5 moves the job into THIS worker's verify phase (never T4).
        await this.completeIntoVerifyAndVerify(job, outcome, log, started);
        return;
      }
      // A requeue backs off (D49): the next attempt waits on the database clock, so an outage does not
      // burn every attempt in seconds.
      const requeueAfterSeconds =
        outcome.state === "queued"
          ? (this.options.requeueBackoff ?? ((attempt: number) => requeueBackoffSeconds(attempt, this.options.random ?? Math.random)))(job.attempt)
          : null;
      const completion = await completeJobWithRetry(
        this.options.pool,
        { jobId: job.id, fencingToken: job.fencing_token, workerId: this.options.workerId, outcome, requeueAfterSeconds, reconcileDueSeconds: this.options.reconcileDueSeconds },
        {
          signal: this.hard.signal,
          random: this.options.random,
          onTransientError: (err, n) =>
            this.log.warn({ ...log, err: this.describe(err), retry: n }, "worker: Postgres unavailable while recording; outcome held in memory, retrying"),
        },
      );
      if (completion?.recorded) fault.at("after-complete"); // the completion transaction committed
      const recorded = completion === null ? null : completion.recorded;
      const fencedOut = completion && !completion.recorded ? completion.reason : undefined;
      const fields = {
        ...log,
        state: outcome.state,
        outcome: outcome.outcome,
        error: outcome.error,
        recorded,
        ...(requeueAfterSeconds === null ? {} : { retryInSeconds: requeueAfterSeconds }),
        ms: Date.now() - started,
      };
      if (recorded === true) this.log.info(fields, requeueAfterSeconds === null ? "worker: job recorded" : `worker: requeued; retry in ${requeueAfterSeconds} s (backoff)`);
      else if (completion && !completion.recorded && completion.reason === "illegal_transition") {
        // A bug, not a lost lease (D41): the token is unchanged, so the state guard refused this
        // worker's own request. Nothing is written to the job; its lease expires and recovery takes it.
        (this.options.metrics ?? NO_METRICS).inc("illegal_transitions_total");
        this.log.error({ ...fields, illegal_transition: true, detail: completion.detail }, "worker: illegal_transition: the state guard refused this completion (a bug); job left for recovery");
      } else if (recorded === false) this.log.warn(fields, "worker: lease lost; outcome NOT recorded on the job");
      else this.log.error(fields, "worker: stopped before the outcome could be recorded; job stays running for recovery");
      this.options.onJobDone?.({ job, outcome, recorded, fencedOut, durationMs: Date.now() - started });
    } finally {
      heartbeat?.stop();
      if (this.current?.graceTimer) clearTimeout(this.current.graceTimer);
      this.current = null;
    }
  }

  /** T5, then (if it moved the job) this worker's verify phase on the new token. */
  private async completeIntoVerifyAndVerify(
    job: JobRow,
    outcome: JobOutcome,
    log: Record<string, unknown>,
    started: number,
  ): Promise<void> {
    const fault = this.options.fault ?? NO_FAULT;
    const moved = await retryTransient(
      () =>
        completeIntoVerify(this.options.pool, {
          jobId: job.id,
          fencingToken: job.fencing_token,
          workerId: this.options.workerId,
          leaseSeconds: this.options.leaseSeconds,
          outcome,
        }),
      {
        signal: this.hard.signal,
        random: this.options.random,
        onTransientError: (err, n) =>
          this.log.warn({ ...log, err: this.describe(err), retry: n }, "worker: Postgres unavailable while moving the job into verify; retrying"),
      },
    );
    if (moved?.recorded) fault.at("after-complete"); // T5 committed
    const recorded = moved === null ? null : moved.recorded;
    const fencedOut = moved && !moved.recorded ? moved.reason : undefined;
    const fields = { ...log, state: outcome.state, outcome: outcome.outcome, error: outcome.error, recorded, ms: Date.now() - started };
    if (moved?.recorded) this.log.info({ ...fields, fencingToken: moved.fencingToken }, "worker: commit uncertain; verifying (T5)");
    else if (moved && !moved.recorded && moved.reason === "illegal_transition") {
      (this.options.metrics ?? NO_METRICS).inc("illegal_transitions_total");
      this.log.error({ ...fields, illegal_transition: true, detail: moved.detail }, "worker: illegal_transition: T5 refused (a bug); job left for recovery");
    } else if (recorded === false) this.log.warn(fields, "worker: lease lost; the job was not moved into verify (recovery verifies it)");
    else this.log.error(fields, "worker: stopped before T5 could be recorded; the job is recovered after its lease expires");
    this.options.onJobDone?.({ job, outcome, recorded, fencedOut, durationMs: Date.now() - started });
    if (!moved?.recorded) return;
    if (this.current?.graceTimer) clearTimeout(this.current.graceTimer);
    this.current = null;
    await this.verifyPhase({
      job: { id: job.id, tenant_id: job.tenant_id, params: job.params, memo_key: job.memo_key, attempt: job.attempt, max_attempts: job.max_attempts },
      fencingToken: moved.fencingToken,
      label: "T5",
      priorStatus: outcome.priorStatus ?? null,
    });
  }

  /** One reconcile run on a job this worker claimed with R1, abortable by stop() like a job. */
  private async reconcilePhase(claim: ReconcileClaim): Promise<void> {
    if (!this.options.reconcile) {
      this.log.error({ workerId: this.options.workerId, jobId: claim.job.id }, "worker: holds a job to reconcile but has no reconciler; its lease expires and another worker reconciles it");
      return;
    }
    const controller = new AbortController();
    const current: { controller: AbortController; graceTimer?: NodeJS.Timeout } = { controller };
    this.current = current;
    if (this.stopping) current.graceTimer = setTimeout(() => controller.abort(new ShutdownAbortError()), this.options.shutdownGraceMs ?? 30_000);
    try {
      const done = await this.options.reconcile(claim, controller, this.hard.signal);
      this.options.onReconcileDone?.(done);
    } finally {
      if (current.graceTimer) clearTimeout(current.graceTimer);
      if (this.current === current) this.current = null;
    }
  }

  /** One verify phase on a job this worker holds in `verifying`, abortable by stop() like a job. */
  private async verifyPhase(claim: VerifyClaim): Promise<void> {
    if (!this.options.verify) {
      this.log.error(
        { workerId: this.options.workerId, jobId: claim.job.id, label: claim.label },
        "worker: holds a job to verify but has no verifier; its lease expires and another worker's recovery re-verifies it",
      );
      return;
    }
    const controller = new AbortController();
    const current: { controller: AbortController; graceTimer?: NodeJS.Timeout } = { controller };
    this.current = current;
    if (this.stopping) {
      // Stopping already: the verify gets the same grace as a job would.
      current.graceTimer = setTimeout(() => controller.abort(new ShutdownAbortError()), this.options.shutdownGraceMs ?? 30_000);
    }
    try {
      const done = await this.options.verify(claim, controller, this.hard.signal);
      this.options.onVerifyDone?.(done);
    } finally {
      if (current.graceTimer) clearTimeout(current.graceTimer);
      if (this.current === current) this.current = null;
    }
  }
}
