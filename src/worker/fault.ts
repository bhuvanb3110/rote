// Fault injection for the crash-point matrix (docs/plans/step-07.md section 3, D34). DOUBLY GATED:
// ROTE_FAULT=<point> is refused (the worker will not start) unless ROTE_FAULT_ENABLE=1 is also set, so
// one stray variable can never make a real deployment kill itself. An unknown point is refused too.
//
// At its point the worker writes one line to stderr, synchronously, then SIGKILLs itself: no cleanup,
// no finally blocks, no completion -- the same as `docker kill --signal=KILL` (on Windows,
// process.kill(pid, "SIGKILL") is TerminateProcess, equivalent for this purpose; CI runs on Linux).
//
// Points (where they fire):
//   after-dequeue      lease taken, before any browser work                     (Worker.process)
//   after-step-NN      replay's onStep.after for step-NN (its checkpoint passed) (runJob)
//   before-submit      onIrreversible.before (Day 2: after the commit intent)    (runJob)
//   after-submit       onIrreversible.after: the bank has answered the click     (runJob)
//   before-complete    outcome computed, completion transaction not started      (Worker.process)
//   after-complete     the completion transaction (T4, or T5 into verify) committed (Worker.process)
// Recovery-internal points (Step 9, step-08 section 9's second table), fired in the RECOVERING worker:
//   verify-after-login     the lookup's step-03 (credentials submitted)           (verify.ts onStep)
//   verify-after-count     the lookup's step-09 (count read, not yet acted on)    (verify.ts onStep)
//   verify-before-result   a decision computed, T7/T8 not started                  (verify.ts)
//   verify-before-requeue  the decision is "resubmitted", T7 not started           (verify.ts)
//   verify-after-requeue   T7 (queued) committed                                   (verify.ts)
//   recover-in-transaction inside T6 after the claim's writes, before COMMIT       (recover.ts)
//
// One STALL point (Step 10, docs/plans/step-10.md section 3; reviewer decision 4; D52): it does not kill.
//   stall-after-intent     right after T3 committed, the worker STOPS ITS HEARTBEAT (a frozen process runs
//                          no timers), sleeps ROTE_FAULT_STALL_MS with no way to be woken, then returns, so
//                          the click goes out the moment it "wakes": the zombie window's worst case, by
//                          construction (Worker.process, the commit-intent hook)
// It needs ROTE_FAULT_STALL_MS (1..600000) as well, and ROTE_FAULT_STALL_MS is refused with any other point.
import { writeSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";

export const FAULT_POINT_RE =
  /^(after-dequeue|after-step-\d{2}|before-submit|after-submit|before-complete|after-complete|verify-after-login|verify-after-count|verify-before-result|verify-before-requeue|verify-after-requeue|recover-in-transaction|stall-after-intent)$/;

/** Points that stall instead of killing (they need ROTE_FAULT_STALL_MS). */
export const STALL_FAULT_POINTS = ["stall-after-intent"] as const;
export const MAX_STALL_MS = 600_000;

/** The recovery-internal points (fired by the worker that recovers or verifies the job). */
export const RECOVERY_FAULT_POINTS = [
  "verify-after-login",
  "verify-after-count",
  "verify-before-result",
  "verify-before-requeue",
  "verify-after-requeue",
  "recover-in-transaction",
] as const;

/** The transfer's boundaries, in order (12 steps; step-11 is Submit, step-12 reads the reference). */
export const TRANSFER_FAULT_POINTS = [
  "after-dequeue",
  ...Array.from({ length: 10 }, (_, i) => `after-step-${String(i + 1).padStart(2, "0")}`),
  "before-submit",
  "after-submit",
  "after-step-12",
  "before-complete",
  "after-complete",
] as const;

export class FaultConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FaultConfigError";
  }
}

/** null = no fault (the normal case). Throws FaultConfigError on any misconfiguration. */
export function parseFaultConfig(env: NodeJS.ProcessEnv): string | null {
  const point = env.ROTE_FAULT;
  const stall = env.ROTE_FAULT_STALL_MS;
  if (point === undefined || point === "") {
    if (env.ROTE_FAULT_ENABLE !== undefined && env.ROTE_FAULT_ENABLE !== "") {
      throw new FaultConfigError("ROTE_FAULT_ENABLE is set but ROTE_FAULT is not; unset both for a normal worker");
    }
    if (stall !== undefined && stall !== "") throw new FaultConfigError("ROTE_FAULT_STALL_MS is set but ROTE_FAULT is not; unset it for a normal worker");
    return null;
  }
  if (env.ROTE_FAULT_ENABLE !== "1") {
    throw new FaultConfigError(
      `ROTE_FAULT=${point} is set but ROTE_FAULT_ENABLE is not "1": refusing to start (fault injection is test-only)`,
    );
  }
  if (!FAULT_POINT_RE.test(point)) {
    throw new FaultConfigError(`ROTE_FAULT=${point} is not a known fault point (${FAULT_POINT_RE.source})`);
  }
  const isStall = (STALL_FAULT_POINTS as readonly string[]).includes(point);
  if (isStall && (stall === undefined || stall === "")) {
    throw new FaultConfigError(`ROTE_FAULT=${point} stalls and needs ROTE_FAULT_STALL_MS (1..${MAX_STALL_MS})`);
  }
  if (!isStall && stall !== undefined && stall !== "") {
    throw new FaultConfigError(`ROTE_FAULT_STALL_MS is only for a stall point (${STALL_FAULT_POINTS.join(", ")}), not ${point}`);
  }
  return point;
}

/** ROTE_FAULT_STALL_MS for a stall point (parseFaultConfig accepted the pair); 0 otherwise. */
export function parseStallMs(env: NodeJS.ProcessEnv, point: string | null): number {
  if (point === null || !(STALL_FAULT_POINTS as readonly string[]).includes(point)) return 0;
  const ms = Number(env.ROTE_FAULT_STALL_MS);
  if (!(Number.isInteger(ms) && ms >= 1 && ms <= MAX_STALL_MS)) {
    throw new FaultConfigError(`ROTE_FAULT_STALL_MS must be an integer in 1..${MAX_STALL_MS} (got "${env.ROTE_FAULT_STALL_MS}")`);
  }
  return ms;
}

export interface FaultInjector {
  readonly point: string | null;
  /** Kills the process if `name` is the configured (kill) point; otherwise a no-op. */
  at(name: string): void;
  /** How long a stall at `name` lasts (ms): the configured stall for the configured stall point, else 0. */
  stallMs(name: string): number;
  /** Stalls at `name` if it is the configured stall point: a line to stderr, the sleep, a line. */
  stall(name: string): Promise<void>;
}

export const NO_FAULT: FaultInjector = { point: null, at() {}, stallMs: () => 0, stall: async () => {} };

export function createFaultInjector(
  point: string | null,
  options: { kill?: () => void; write?: (line: string) => void; stallMs?: number; sleep?: (ms: number) => Promise<unknown> } = {},
): FaultInjector {
  if (point === null) return NO_FAULT;
  const write = options.write ?? ((line: string) => writeSync(2, line));
  const kill = options.kill ?? (() => process.kill(process.pid, "SIGKILL"));
  const isStall = (STALL_FAULT_POINTS as readonly string[]).includes(point);
  const stallFor = isStall ? (options.stallMs ?? 0) : 0;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  return {
    point,
    at(name: string) {
      if (isStall || name !== point) return;
      write(`ROTE_FAULT firing at ${point} (pid ${process.pid})\n`);
      kill();
    },
    stallMs: (name: string) => (name === point ? stallFor : 0),
    async stall(name: string) {
      if (name !== point || stallFor <= 0) return;
      write(`ROTE_FAULT stalling at ${point} for ${stallFor} ms, heartbeat suspended (pid ${process.pid}) ${new Date().toISOString()}\n`);
      await sleep(stallFor); // no abort signal: a frozen process cannot be woken by its own timers
      write(`ROTE_FAULT stall over at ${point}: clicking Submit now (pid ${process.pid}) ${new Date().toISOString()}\n`);
    },
  };
}
