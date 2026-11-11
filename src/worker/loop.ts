// The worker's poll loop (docs/plans/step-06.md sections 1 and 6):
//
//   while not stopping:
//     beforeDequeue()                 # seam 4: Day-2 expired-lease recovery runs HERE (step-05 note 8)
//     job = dequeue(...)              # transient DB error -> log, back off (cap 5 s), never exit
//     if none: sleep(poll backoff)    # 100 ms base, x2, cap 2 s, full jitter
//     run it; record it (fenced; completion retried while Postgres is transiently down)
//
// Graceful stop (SIGTERM/SIGINT): stop dequeuing at once; let an in-flight job finish for up to
// shutdownGraceMs, then abort it (runReplay closes its context and rejects, D11) and record that per
// jobOutcomeFor's abort rows. A second stop() aborts at once and stops retrying a completion.
// SIGKILL / OOM: nothing runs; the job stays `running` with its lease until Day-2 recovery.
import type { Browser } from "playwright";
import { dequeue, type JobRow, type Pool } from "../queue/index.js";
import { createBackoff, sleep } from "./backoff.js";
import { completeJobWithRetry } from "./complete.js";
import { redactDeep, type Redactor } from "./credentials.js";
import { isTransientDbError } from "../queue/index.js";
import { jobOutcomeFor, type JobOutcome } from "./outcome.js";
import type { RunJobOptions, RunJobResult } from "./runJob.js";
import { NO_FAULT, type FaultInjector } from "./fault.js";

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
  durationMs: number;
}

export interface WorkerOptions {
  pool: Pool;
  workerId: string;
  /** Step 6: 300 s and no heartbeat (nothing recovers expired leases until Day 2). */
  leaseSeconds: number;
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
  /** Seam 4 (step-06 section 7). No-op in Step 6. */
  beforeDequeue?: () => Promise<void>;
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

  /** One iteration: dequeue at most one job and run + record it. */
  async tick(): Promise<TickResult> {
    await this.options.beforeDequeue?.();
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
    try {
      let run: RunJobResult;
      try {
        const browser = await this.options.getBrowser();
        run = await this.options.runJob(job, { browser, signal: controller.signal });
      } catch (error) {
        // getBrowser failed (Chromium would not start) or a bug escaped runJob: nothing irreversible ran.
        run = { end: { kind: "thrown", error, aborted: controller.signal.aborted }, irreversibleStarted: false };
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
      const completion = await completeJobWithRetry(
        this.options.pool,
        { jobId: job.id, fencingToken: job.fencing_token, workerId: this.options.workerId, outcome },
        {
          signal: this.hard.signal,
          random: this.options.random,
          onTransientError: (err, n) =>
            this.log.warn({ ...log, err: this.describe(err), retry: n }, "worker: Postgres unavailable while recording; outcome held in memory, retrying"),
        },
      );
      if (completion?.recorded) fault.at("after-complete"); // the completion transaction committed
      const recorded = completion === null ? null : completion.recorded;
      const fields = { ...log, state: outcome.state, outcome: outcome.outcome, error: outcome.error, recorded, ms: Date.now() - started };
      if (recorded === true) this.log.info(fields, "worker: job recorded");
      else if (recorded === false) this.log.warn(fields, "worker: lease lost; outcome NOT recorded on the job");
      else this.log.error(fields, "worker: stopped before the outcome could be recorded; job stays running for recovery");
      this.options.onJobDone?.({ job, outcome, recorded, durationMs: Date.now() - started });
    } finally {
      if (this.current?.graceTimer) clearTimeout(this.current.graceTimer);
      this.current = null;
    }
  }
}
