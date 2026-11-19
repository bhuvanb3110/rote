// T2: the heartbeat (docs/plans/step-08.md section 2; reviewer decision 2: it never revives an expired
// lease). While a worker holds a job, in any active state, every `intervalMs` it runs ONE autocommit
// statement that extends the lease on the database clock (D22), only if the token and owner still
// match AND the lease has not already expired:
//
//   1 row   extended.
//   0 rows  the job is no longer this worker's (recovered: token bumped; or the lease expired before
//           the beat reached Postgres). The heartbeat stops and aborts the job's AbortController with a
//           LeaseLostError: runReplay closes the browser context at once, mid-action, and rejects with it
//           (D11). The worker records nothing on `jobs` and marks its attempt `lease_lost`.
//   transient DB error   logged; the next beat tries again. Three missed beats (30 s) and the lease is
//           gone: the next beat that reaches Postgres gets 0 rows and aborts. A worker that cannot reach
//           Postgres cannot write a commit intent either (T3), so it can never click while partitioned.
//   other DB error       a bug or a schema mismatch that will not go away: the worker cannot keep the
//           lease, so it gives the job up the same way (LeaseLostError carrying the cause).
//
// Defaults (Compose and the worker): lease 30 s, heartbeat 10 s. The worker refuses heartbeat * 2 >=
// lease, so one missed beat never loses a lease by itself.
import { isTransientDbError, type Queryable } from "../queue/index.js";
import { LeaseLostError } from "./leaseErrors.js";
import type { WorkerLogger } from "./loop.js";

export const DEFAULT_LEASE_SECONDS = 30;
export const DEFAULT_HEARTBEAT_SECONDS = 10;

export const HEARTBEAT_SQL = `
UPDATE jobs
SET lease_expires_at = now() + make_interval(secs => $4), updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3
  AND state IN ('running', 'committing', 'verifying')
  AND lease_expires_at > now()
RETURNING lease_expires_at`;

export interface LeaseArgs {
  jobId: string;
  fencingToken: number;
  workerId: string;
  leaseSeconds: number;
}

/** T2 once. true = extended; false = 0 rows (this worker no longer holds a live lease). */
export async function extendLease(db: Queryable, args: LeaseArgs): Promise<boolean> {
  const result = await db.query(HEARTBEAT_SQL, [args.jobId, args.fencingToken, args.workerId, args.leaseSeconds]);
  return result.rowCount === 1;
}

/** Throws a RangeError unless lease and heartbeat are whole seconds with heartbeat * 2 < lease. */
export function validateLeaseTiming(leaseSeconds: number, heartbeatSeconds: number): void {
  if (!(Number.isInteger(leaseSeconds) && leaseSeconds >= 1 && leaseSeconds <= 3600)) {
    throw new RangeError(`lease must be an integer number of seconds in 1..3600 (got ${leaseSeconds})`);
  }
  if (!(Number.isInteger(heartbeatSeconds) && heartbeatSeconds >= 1)) {
    throw new RangeError(`heartbeat must be a positive integer number of seconds (got ${heartbeatSeconds})`);
  }
  if (heartbeatSeconds * 2 >= leaseSeconds) {
    throw new RangeError(
      `heartbeat ${heartbeatSeconds} s x 2 must be less than the lease ${leaseSeconds} s, so that one missed beat never loses the lease by itself`,
    );
  }
}

export interface HeartbeatTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const realTimers: HeartbeatTimers = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (handle) => clearInterval(handle as NodeJS.Timeout),
};

export interface HeartbeatOptions {
  pool: Queryable;
  jobId: string;
  fencingToken: number;
  workerId: string;
  leaseSeconds: number;
  intervalMs: number;
  /** Aborted (with a LeaseLostError) when the lease is lost. */
  controller: AbortController;
  log?: WorkerLogger;
  /** Test seams. */
  extend?: (db: Queryable, args: LeaseArgs) => Promise<boolean>;
  timers?: HeartbeatTimers;
}

export class Heartbeat {
  private handle: unknown = null;
  private stopped = false;
  private inFlight: Promise<void> | null = null;
  private token: number;
  /** Successful extensions. */
  beats = 0;
  /** Beats that hit a transient DB error (each retried at the next interval). */
  transientMisses = 0;

  constructor(private readonly options: HeartbeatOptions) {
    this.token = options.fencingToken;
  }

  get fencingToken(): number {
    return this.token;
  }

  get isStopped(): boolean {
    return this.stopped;
  }

  /** Starts beating every intervalMs (the first beat one interval after start: the dequeue just set the lease). */
  start(): void {
    if (this.stopped || this.handle !== null) return;
    const timers = this.options.timers ?? realTimers;
    this.handle = timers.setInterval(() => {
      void this.beat();
    }, this.options.intervalMs);
  }

  /** Stops for good. A beat already in flight finishes, but its result is ignored (no abort after stop). */
  stop(): void {
    this.stopped = true;
    if (this.handle !== null) {
      (this.options.timers ?? realTimers).clearInterval(this.handle);
      this.handle = null;
    }
  }

  /** Step 9's verify phase continues under a new token (T5/T6.4). */
  setToken(token: number): void {
    this.token = token;
  }

  /** One beat (the timer calls it; tests call it directly). Never overlaps a beat still in flight. */
  beat(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.beatOnce().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private details() {
    return { jobId: this.options.jobId, fencingToken: this.token, workerId: this.options.workerId };
  }

  private async beatOnce(): Promise<void> {
    const { pool, jobId, workerId, leaseSeconds, log } = this.options;
    const extend = this.options.extend ?? extendLease;
    try {
      const extended = await extend(pool, { jobId, fencingToken: this.token, workerId, leaseSeconds });
      if (this.stopped) return;
      if (extended) {
        this.beats += 1;
        return;
      }
      this.lose(
        new LeaseLostError(
          `lease lost: the heartbeat matched 0 rows for job ${jobId} (token ${this.token}, owner ${workerId}); ` +
            "the job was recovered, or the lease expired before the beat reached Postgres",
          this.details(),
        ),
      );
    } catch (err) {
      if (this.stopped) return;
      if (isTransientDbError(err)) {
        this.transientMisses += 1;
        log?.warn({ jobId, workerId, misses: this.transientMisses, err: (err as Error).message }, "heartbeat: Postgres unavailable; retrying at the next beat");
        return;
      }
      this.lose(
        new LeaseLostError(
          `heartbeat failed with a non-transient error for job ${jobId}; giving the job up: ${(err as Error)?.message ?? String(err)}`,
          this.details(),
          { cause: err },
        ),
      );
    }
  }

  private lose(error: LeaseLostError): void {
    this.stop();
    this.options.log?.warn({ ...error.details, err: error.message }, "heartbeat: lease lost; aborting the job");
    this.options.controller.abort(error);
  }
}
