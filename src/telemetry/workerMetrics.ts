// The worker's existing counters (src/worker/metrics.ts, WorkerMetrics) forwarded to telemetry (step-13.md
// section 5: "InMemoryCounters stays the test double. The OTel implementation forwards the same inc() calls, so
// every existing call site is unchanged"). The in-memory totals still feed the log lines (value()).
import type { InMemoryCounters, WorkerCounter, WorkerMetrics } from "../worker/metrics.js";
import { WORKER_COUNTER_EXPORT } from "./names.js";
import type { Telemetry } from "./types.js";

export function forwardingMetrics(counters: InMemoryCounters, telemetry: Telemetry): WorkerMetrics {
  return {
    inc(name: WorkerCounter, labels?: Record<string, string>): void {
      counters.inc(name, labels);
      const exported = WORKER_COUNTER_EXPORT[name];
      if (exported) telemetry.count(exported, labels);
    },
    value(name: WorkerCounter, labels?: Record<string, string>): number {
      return counters.value(name, labels);
    },
  };
}
