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
//   after-complete     the completion transaction committed                      (Worker.process)
import { writeSync } from "node:fs";

export const FAULT_POINT_RE = /^(after-dequeue|after-step-\d{2}|before-submit|after-submit|before-complete|after-complete)$/;

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
  if (point === undefined || point === "") {
    if (env.ROTE_FAULT_ENABLE !== undefined && env.ROTE_FAULT_ENABLE !== "") {
      throw new FaultConfigError("ROTE_FAULT_ENABLE is set but ROTE_FAULT is not; unset both for a normal worker");
    }
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
  return point;
}

export interface FaultInjector {
  readonly point: string | null;
  /** Kills the process if `name` is the configured point; otherwise a no-op. */
  at(name: string): void;
}

export const NO_FAULT: FaultInjector = { point: null, at() {} };

export function createFaultInjector(
  point: string | null,
  options: { kill?: () => void; write?: (line: string) => void } = {},
): FaultInjector {
  if (point === null) return NO_FAULT;
  const write = options.write ?? ((line: string) => writeSync(2, line));
  const kill = options.kill ?? (() => process.kill(process.pid, "SIGKILL"));
  return {
    point,
    at(name: string) {
      if (name !== point) return;
      write(`ROTE_FAULT firing at ${point} (pid ${process.pid})\n`);
      kill();
    },
  };
}
