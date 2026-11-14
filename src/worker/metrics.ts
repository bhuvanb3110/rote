// Counters the worker increments (step-09 reviewer decision A1; Day 3 exports them to Prometheus).
// Until then each increment is an in-process number, and every one is ALSO a structured log line at
// the call site, so nothing counted here is invisible today.
//
//   illegal_transitions_total   a fenced write matched 0 rows with the fencing token UNCHANGED: the
//                               worker asked for a transition the state guard forbids (a bug), not a
//                               lost lease (docs/DECISIONS.md D41)
//   verify_decisions_total      one per finished verify phase, by decision (already_done, resubmitted,
//                               deferred, ...); Step 9
//   reconcile_decisions_total   one per recorded reconcile run, by decision (reconciled,
//                               duplicate_suspected, reconcile_unreadable, reconcile_deferred); Step 10 (D50)
//   duplicates_detected_total   a reconcile found 2+ transfers for one job (duplicate_suspected): the zombie
//                               window, made loud. Its error-level log line carries the process's total
//
// Labels are a small fixed set per counter (the decision name), never a job id.
export type WorkerCounter = "illegal_transitions_total" | "verify_decisions_total" | "reconcile_decisions_total" | "duplicates_detected_total";

export interface WorkerMetrics {
  inc(name: WorkerCounter, labels?: Record<string, string>): void;
  /** The current value, where the implementation keeps one (InMemoryCounters); for log lines. */
  value?(name: WorkerCounter, labels?: Record<string, string>): number;
}

export const NO_METRICS: WorkerMetrics = { inc() {} };

function keyOf(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${labels[k]}"`);
  return `${name}{${parts.join(",")}}`;
}

/** In-memory counters, keyed like Prometheus series: `name` or `name{label="value"}`. */
export class InMemoryCounters implements WorkerMetrics {
  private readonly values = new Map<string, number>();

  inc(name: WorkerCounter, labels?: Record<string, string>): void {
    const key = keyOf(name, labels);
    this.values.set(key, (this.values.get(key) ?? 0) + 1);
  }

  get(name: WorkerCounter, labels?: Record<string, string>): number {
    return this.values.get(keyOf(name, labels)) ?? 0;
  }

  value(name: WorkerCounter, labels?: Record<string, string>): number {
    return this.get(name, labels);
  }

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.values.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}
