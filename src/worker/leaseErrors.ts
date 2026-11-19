// The two ways a worker learns it no longer holds a job (docs/plans/step-08.md sections 2 and 3).

/**
 * The heartbeat (T2) matched 0 rows: the job was recovered (token bumped), or the lease expired
 * before the beat reached Postgres. The heartbeat aborts the job's AbortController with this as the
 * reason, so runReplay closes the browser context and rejects with it (D11). The worker then records
 * NOTHING on `jobs` (the job is recovery's now) and marks its own attempt row `lease_lost`.
 */
export class LeaseLostError extends Error {
  constructor(
    message: string,
    readonly details: { jobId: string; fencingToken: number; workerId: string },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LeaseLostError";
  }
}

/**
 * The commit intent (T3) matched 0 rows: this worker is not the job's live holder (token bumped, owner
 * changed, state not `running`, or the lease is past now()). Thrown from onIrreversible.before, so the
 * Submit is NEVER clicked; runReplay rejects with it unchanged (D11). The intent was definitely not
 * written, so nothing irreversible happened in this run.
 */
export class FencingError extends Error {
  constructor(
    message: string,
    readonly details: { jobId: string; fencingToken: number; workerId: string },
  ) {
    super(message);
    this.name = "FencingError";
  }
}
