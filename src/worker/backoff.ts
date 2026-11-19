// Exponential backoff with FULL jitter (docs/plans/step-06.md section 1): the n-th wait is a uniform
// random draw in [0, min(cap, base * 2^n)]. Full jitter, not "base * 2^n ± a bit", so idle workers
// that went to sleep together don't wake and poll in lockstep. The RNG is injectable for tests.

export interface BackoffOptions {
  /** First ceiling, ms. */
  baseMs: number;
  /** Largest ceiling, ms. */
  capMs: number;
  /** [0, 1) like Math.random (the default). */
  random?: () => number;
}

export interface Backoff {
  /** The next wait in ms (and advances the exponent). */
  next(): number;
  /** Back to the base ceiling, after a success. */
  reset(): void;
  /** The ceiling the next call to next() draws under (for logs and tests). */
  readonly ceilingMs: number;
}

export function createBackoff(options: BackoffOptions): Backoff {
  const { baseMs, capMs } = options;
  if (!(baseMs > 0 && capMs >= baseMs)) {
    throw new RangeError(`backoff: need 0 < baseMs <= capMs (got base ${baseMs}, cap ${capMs})`);
  }
  const random = options.random ?? Math.random;
  let n = 0;
  const ceiling = () => Math.min(capMs, baseMs * 2 ** n);
  return {
    next() {
      const wait = Math.floor(random() * ceiling());
      // Stop growing once at the cap, so n can't overflow over a long idle period.
      if (baseMs * 2 ** n < capMs) n += 1;
      return wait;
    },
    reset() {
      n = 0;
    },
    get ceilingMs() {
      return ceiling();
    },
  };
}

/** Resolves after `ms`, or as soon as `signal` aborts (never rejects). */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}
