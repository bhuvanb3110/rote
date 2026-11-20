// The one seam all fleet telemetry goes through (step-13.md section 2 rule 1, docs/plans/step-13a.md section 3).
// Like WorkerMetrics/NO_METRICS: the default is a no-op, and the OpenTelemetry implementation (otel.ts) is chosen
// at startup by configuration (config.ts).
//
// The contract every implementation keeps (rules 2, 6, 8):
//   - every method but flush/shutdown is synchronous, returns at once, and NEVER throws;
//   - fleet code never awaits a telemetry call in the job path; flush/shutdown are for process exit only, resolve
//     within `capMs` (plus a few ms), and never reject;
//   - nothing returned is ever used for a decision: a span handle can only be ended or annotated.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ApiGaugeName, CounterName, HistogramName, SpanName, UpDownName } from "./names.js";

/** One gauge value the API read from Postgres (apiGauges.ts). */
export interface GaugeReading {
  name: ApiGaugeName;
  labels?: Labels;
  value: number;
}

export type Labels = Record<string, string>;
/** Attribute values a span may carry; anything else, and any key off the span's allowlist, is dropped. */
export type SpanAttributeValue = string | number | boolean;
export type SpanAttributes = Record<string, unknown>;

export interface TelemetrySpan {
  setAttributes(attributes: SpanAttributes): void;
  /** A span event (lease.lost, illegal_transition, screenshot.retry...): its attributes are not allowlisted, so pass none that could carry data. */
  addEvent(name: string): void;
  end(endTime?: number): void;
}

export interface StartSpanOptions {
  /** The job's trace id (jobs.trace_id): 32 lower-case hex. Anything else gets a fresh random trace. */
  traceId: string;
  attributes?: SpanAttributes;
  /** Epoch ms; default now. */
  startTime?: number;
}

export type MetricsHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface Telemetry {
  /** What is on: spans exported somewhere, metrics recorded. Both false for NO_TELEMETRY. */
  readonly enabled: { readonly traces: boolean; readonly metrics: boolean };
  count(name: CounterName, labels?: Labels, by?: number): void;
  observe(name: HistogramName, value: number, labels?: Labels): void;
  adjust(name: UpDownName, delta: number): void;
  startSpan(name: SpanName, options: StartSpanOptions): TelemetrySpan;
  /** Serves /metrics (Prometheus text); null when metrics are off. */
  metricsHandler(): MetricsHandler | null;
  /**
   * Observable gauges read on every scrape (the API's DB gauges): `read` is capped at `capMs`; a read that fails
   * or times out leaves the last values (stale) and counts gauge_query. A no-op when metrics are off.
   */
  registerGauges(read: () => Promise<GaugeReading[]>, capMs: number): void;
  /** Exports what is queued; resolves within capMs, never rejects. */
  flush(capMs: number): Promise<void>;
  /** Flush, then release everything; resolves within capMs, never rejects. Calls after it are no-ops. */
  shutdown(capMs: number): Promise<void>;
}

const NO_SPAN: TelemetrySpan = { setAttributes() {}, addEvent() {}, end() {} };

export const NO_TELEMETRY: Telemetry = {
  enabled: { traces: false, metrics: false },
  count() {},
  observe() {},
  adjust() {},
  startSpan: () => NO_SPAN,
  metricsHandler: () => null,
  registerGauges() {},
  flush: async () => {},
  shutdown: async () => {},
};

/** The log sink telemetry warns through (pino and WorkerLogger both fit). */
export interface TelemetryLog {
  warn(obj: Record<string, unknown>, msg: string): void;
}
