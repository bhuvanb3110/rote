// Counters the worker increments (step-09 reviewer decision A1; Day 3 exports them to Prometheus).
// Until then each increment is an in-process number, and every one is ALSO a structured log line at
// the call site, so nothing counted here is invisible today.
//
//   illegal_transitions_total   a fenced write matched 0 rows with the fencing token UNCHANGED: the
//                               worker asked for a transition the state guard forbids (a bug), not a
//                               lost lease (docs/DECISIONS.md D41)
//   verify_decisions_total      one per finished verify phase, by decision (already_done, resubmitted,
//                               deferred, ...); Step 9
//
// Labels are a small fixed set per counter (the decision name), never a job id.
export type WorkerCounter = "illegal_transitions_total" | "verify_decisions_total";

export interface WorkerMetrics {
  inc(name: WorkerCounter, labels?: Record<string, string>): void;
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

  snapshot(): Record<string, number> {
    return Object.fromEntries([...this.values.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}
