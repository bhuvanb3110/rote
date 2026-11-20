// The OpenTelemetry implementation of Telemetry (step-13.md section 2; docs/plans/step-13a.md section 3). THE ONLY
// FILE THAT IMPORTS @opentelemetry/* (rule 1). Wired by hand: no sdk-node, no auto-instrumentation, no global
// registration (no global tracer/meter provider, no context manager, no diag logger), so nothing outside this
// object is patched or changed (rule 7).
//
// How each rule is kept here:
//   2 fire and forget  every public method body is in try/catch; an error is swallowed, counted in
//                      rote_telemetry_errors_total{kind} and reported by one rate-limited "telemetry: degraded"
//                      warning (its class and code only, never its message)
//   3 bounded export   spans -> GuardProcessor (counts spans in flight; at the bound it DROPS and counts the drop:
//                      the batch processor would drop silently) -> BatchSpanProcessor (queue 2048, 500 ms delay)
//                      -> SafeExporter (turns a synchronous throw into a failed result, gives up after the export
//                      timeout even if the exporter never answers, counts failures) -> the OTLP/HTTP exporter (2 s)
//   4 metrics pulled   a Prometheus MetricReader that never starts its own server: /metrics is mounted by the
//                      caller (metricsServer.ts for a worker, the API's Express app)
//   5 no network I/O   constructing all of this opens no socket; the exporter connects on its first export
//   6 bounded shutdown flush/shutdown race a timer of capMs and never reject
//   8 one-way          nothing here returns data to the caller except the /metrics text and test helpers
//  10 redaction        span attributes pass the per-span allowlist (names.ts): unknown keys, and values that are
//                      not numbers, booleans or plain identifiers, are dropped
import { createHash } from "node:crypto";
import { ROOT_CONTEXT, TraceFlags, trace, type Attributes, type Counter, type Histogram, type ObservableGauge, type UpDownCounter } from "@opentelemetry/api";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { PrometheusExporter, PrometheusSerializer } from "@opentelemetry/exporter-prometheus";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { MeterProvider } from "@opentelemetry/sdk-metrics";
import {
  AlwaysOnSampler,
  BatchSpanProcessor,
  InMemorySpanExporter,
  TracerProvider,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace";
import { ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions";
import {
  API_GAUGES,
  ATTRIBUTE_STRING_RE,
  COUNTERS,
  HISTOGRAMS,
  SEEDED_LABELS,
  SPAN_ATTRIBUTES,
  UP_DOWN,
  labelValue,
  type ApiGaugeName,
  type CounterName,
  type HistogramName,
  type SpanName,
  type TelemetryErrorKind,
  type UpDownName,
} from "./names.js";
import type { GaugeReading, Labels, MetricsHandler, SpanAttributes, StartSpanOptions, Telemetry, TelemetryLog, TelemetrySpan } from "./types.js";

/** A span sink with OTel's SpanExporter shape, so tests can plant one that throws or hangs without importing OTel. */
export interface SpanSink {
  export(spans: unknown[], resultCallback: (result: { code: number; error?: Error }) => void): void;
  shutdown(): Promise<void>;
  forceFlush?(): Promise<void>;
}

export type TraceSinkConfig =
  | { kind: "otlp"; url: string }
  | { kind: "memory" }
  | { kind: "sink"; sink: SpanSink };

export interface BatchConfig {
  maxQueueSize: number;
  maxExportBatchSize: number;
  scheduledDelayMillis: number;
  exportTimeoutMillis: number;
}

export const DEFAULT_BATCH: BatchConfig = { maxQueueSize: 2048, maxExportBatchSize: 512, scheduledDelayMillis: 500, exportTimeoutMillis: 2000 };
export const DEGRADED_LOG_INTERVAL_MS = 60_000;

export interface OtelTelemetryConfig {
  serviceName: string;
  /** service.instance.id: the worker id. */
  instanceId?: string;
  traces: TraceSinkConfig | null;
  metrics: boolean;
  batch?: Partial<BatchConfig>;
  log?: TelemetryLog;
  degradedLogIntervalMs?: number;
}

/** A finished span as the tests see it (memory sink only). */
export interface SpanRecord {
  name: string;
  traceId: string;
  spanId: string;
  parentSpanId: string | undefined;
  attributes: Record<string, unknown>;
  events: string[];
}

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const EVENT_NAME_RE = /^[a-z][a-z0-9_.]{0,63}$/;
const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$.]{0,63}$/;
const SUCCESS = 0;
const FAILED = 1;
const TIMED_OUT = Symbol("timed out");

/**
 * The span id of the synthetic remote parent every span of a job hangs under until migration 0009 gives the
 * job a real root (step-13.md section 4, reviewer decision 1's fallback): derived from the trace id, so every
 * worker that touches the job picks the same one. Never all zeros (an invalid span id).
 */
export function syntheticRootSpanId(traceId: string): string {
  const id = createHash("sha256").update(`rote-root:${traceId}`).digest("hex").slice(0, 16);
  return /^0+$/.test(id) ? "0000000000000001" : id;
}

/** The allowlisted attributes of `name`: known keys only, values that are numbers, booleans or plain identifiers. */
export function allowedAttributes(name: SpanName, attributes: SpanAttributes | undefined): Attributes {
  const out: Attributes = {};
  if (!attributes) return out;
  const allowed: readonly string[] = SPAN_ATTRIBUTES[name] ?? [];
  for (const key of Object.keys(attributes)) {
    if (!allowed.includes(key)) continue;
    const value = attributes[key];
    if (typeof value === "boolean") out[key] = value;
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
    else if (typeof value === "string" && ATTRIBUTE_STRING_RE.test(value)) out[key] = value;
  }
  return out;
}

function errorClass(err: unknown): string {
  const e = Array.isArray(err) ? err[0] : err;
  const name = typeof e === "object" && e !== null ? (e as { name?: unknown }).name : undefined;
  return typeof name === "string" && IDENTIFIER_RE.test(name) ? name : typeof e === "object" && e !== null ? "Error" : "NonError";
}

function errorCode(err: unknown): string | undefined {
  const e = Array.isArray(err) ? err[0] : err;
  const code = typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined;
  if (typeof code === "number") return String(code);
  return typeof code === "string" && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? code : undefined;
}

class TelemetryTimeoutError extends Error {
  constructor(what: string, ms: number) {
    super(`${what} did not finish within ${ms} ms`);
    this.name = "TelemetryTimeoutError";
  }
}

/** Counts spans between onEnd and their export's end; at the bound it drops instead of queueing (rule 3). */
class GuardProcessor implements SpanProcessor {
  private inFlight = 0;
  constructor(
    private readonly inner: SpanProcessor,
    private readonly bound: number,
    private readonly onDrop: () => void,
  ) {}
  onStart(span: Parameters<SpanProcessor["onStart"]>[0], parentContext: Parameters<SpanProcessor["onStart"]>[1]): void {
    this.inner.onStart(span, parentContext);
  }
  onEnd(span: ReadableSpan): void {
    if (this.inFlight >= this.bound) {
      this.onDrop();
      return;
    }
    this.inFlight += 1;
    this.inner.onEnd(span);
  }
  release(n: number): void {
    this.inFlight = Math.max(0, this.inFlight - n);
  }
  get pending(): number {
    return this.inFlight;
  }
  forceFlush(): Promise<void> {
    return this.inner.forceFlush();
  }
  shutdown(): Promise<void> {
    return this.inner.shutdown();
  }
}

/** Never throws into the batch processor, always answers within `timeoutMs`, and releases the guard's count. */
class SafeExporter implements SpanExporter {
  constructor(
    private readonly inner: SpanSink,
    private readonly timeoutMs: number,
    private readonly release: (n: number) => void,
    private readonly onFailure: (err: unknown) => void,
  ) {}
  export(spans: ReadableSpan[], resultCallback: (result: { code: number; error?: Error }) => void): void {
    let done = false;
    const finish = (ok: boolean, error?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      this.release(spans.length);
      if (!ok) this.onFailure(error);
      try {
        resultCallback(ok ? { code: SUCCESS } : { code: FAILED, error: error instanceof Error ? error : new Error("span export failed") });
      } catch {
        // The batch processor's own callback; nothing to do if it throws.
      }
    };
    const timer = setTimeout(() => finish(false, new TelemetryTimeoutError("span export", this.timeoutMs)), this.timeoutMs);
    timer.unref?.();
    try {
      this.inner.export(spans, (result) => finish(result.code === SUCCESS, result.error));
    } catch (err) {
      finish(false, err);
    }
  }
  async shutdown(): Promise<void> {
    await this.inner.shutdown();
  }
  async forceFlush(): Promise<void> {
    await this.inner.forceFlush?.();
  }
}

export class OtelTelemetry implements Telemetry {
  readonly enabled: { traces: boolean; metrics: boolean };
  private readonly log?: TelemetryLog;
  private readonly warnIntervalMs: number;
  private lastWarnAt = Number.NEGATIVE_INFINITY;
  private suppressed = 0;
  private readonly errorTotals = new Map<TelemetryErrorKind, number>();
  private closed = false;

  private readonly tracerProvider: TracerProvider | null = null;
  private readonly tracer: ReturnType<TracerProvider["getTracer"]> | null = null;
  private readonly guard: GuardProcessor | null = null;
  private readonly memory: InMemorySpanExporter | null = null;

  private readonly meterProvider: MeterProvider | null = null;
  private readonly reader: PrometheusExporter | null = null;
  private readonly counters = new Map<CounterName, Counter>();
  private readonly histograms = new Map<HistogramName, Histogram>();
  private readonly upDowns = new Map<UpDownName, UpDownCounter>();
  private readonly gauges = new Map<ApiGaugeName, ObservableGauge>();
  private readonly meter: ReturnType<MeterProvider["getMeter"]> | null = null;

  constructor(config: OtelTelemetryConfig) {
    this.log = config.log;
    this.warnIntervalMs = config.degradedLogIntervalMs ?? DEGRADED_LOG_INTERVAL_MS;
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      ...(config.instanceId ? { "service.instance.id": config.instanceId } : {}),
    });
    const batch: BatchConfig = { ...DEFAULT_BATCH, ...config.batch };

    if (config.traces) {
      let sink: SpanSink;
      if (config.traces.kind === "otlp") {
        sink = new OTLPTraceExporter({ url: config.traces.url, timeoutMillis: batch.exportTimeoutMillis }) as unknown as SpanSink;
      } else if (config.traces.kind === "memory") {
        this.memory = new InMemorySpanExporter();
        sink = this.memory as unknown as SpanSink;
      } else {
        sink = config.traces.sink;
      }
      let guard: GuardProcessor | null = null;
      const exporter = new SafeExporter(
        sink,
        batch.exportTimeoutMillis,
        (n) => guard?.release(n),
        (err) => this.degraded("span_export", err),
      );
      const bsp = new BatchSpanProcessor({
        exporter,
        maxQueueSize: batch.maxQueueSize,
        maxExportBatchSize: Math.min(batch.maxExportBatchSize, batch.maxQueueSize),
        scheduledDelayMillis: batch.scheduledDelayMillis,
        exportTimeoutMillis: batch.exportTimeoutMillis,
      });
      guard = new GuardProcessor(bsp, batch.maxQueueSize, () => this.degraded("span_dropped", new TelemetryTimeoutError("span queue full", 0)));
      this.guard = guard;
      this.tracerProvider = new TracerProvider({ resource, sampler: new AlwaysOnSampler(), spanProcessors: [guard] });
      this.tracer = this.tracerProvider.getTracer("rote");
    }

    if (config.metrics) {
      this.reader = new PrometheusExporter({ preventServerStart: true, withoutScopeInfo: true });
      this.meterProvider = new MeterProvider({ resource, readers: [this.reader] });
      const meter = this.meterProvider.getMeter("rote");
      this.meter = meter;
      for (const [name, def] of Object.entries(COUNTERS) as [CounterName, (typeof COUNTERS)[CounterName]][]) {
        const counter = meter.createCounter(name, { description: def.help });
        this.counters.set(name, counter);
        // A series exists from the start: unlabeled counters at 0, closed label sets at 0 for each value.
        if (def.labels.length === 0) counter.add(0);
        for (const [label, values] of Object.entries(SEEDED_LABELS[name] ?? {})) for (const v of values) counter.add(0, { [label]: v });
      }
      for (const [name, def] of Object.entries(HISTOGRAMS) as [HistogramName, (typeof HISTOGRAMS)[HistogramName]][]) {
        this.histograms.set(name, meter.createHistogram(name, { description: def.help, advice: { explicitBucketBoundaries: [...def.buckets] } }));
      }
      for (const [name, def] of Object.entries(UP_DOWN) as [UpDownName, (typeof UP_DOWN)[UpDownName]][]) {
        const upDown = meter.createUpDownCounter(name, { description: def.help });
        upDown.add(0);
        this.upDowns.set(name, upDown);
      }
    }
    this.enabled = { traces: this.tracer !== null, metrics: this.meterProvider !== null };
  }

  /** Swallows, counts and (rate-limited) warns. Never throws. */
  private degraded(kind: TelemetryErrorKind, err: unknown): void {
    try {
      this.errorTotals.set(kind, (this.errorTotals.get(kind) ?? 0) + 1);
      this.counters.get("rote_telemetry_errors_total")?.add(1, { kind });
      if (!this.log) return;
      const now = Date.now();
      if (now - this.lastWarnAt < this.warnIntervalMs) {
        this.suppressed += 1;
        return;
      }
      this.lastWarnAt = now;
      const code = errorCode(err);
      this.log.warn(
        { kind, error: errorClass(err), ...(code ? { code } : {}), suppressedSinceLastWarning: this.suppressed, errorsByKind: Object.fromEntries(this.errorTotals) },
        "telemetry: degraded",
      );
      this.suppressed = 0;
    } catch {
      // Even the warning path must not throw.
    }
  }

  private guarded(fn: () => void): void {
    try {
      if (!this.closed) fn();
    } catch (err) {
      this.degraded("call", err);
    }
  }

  count(name: CounterName, labels?: Labels, by = 1): void {
    this.guarded(() => {
      const counter = this.counters.get(name);
      if (!counter || !(by >= 0)) return;
      const out: Record<string, string> = {};
      for (const key of COUNTERS[name].labels as readonly string[]) if (labels && key in labels) out[key] = labelValue(labels[key]);
      counter.add(by, out);
    });
  }

  observe(name: HistogramName, value: number): void {
    this.guarded(() => {
      if (Number.isFinite(value) && value >= 0) this.histograms.get(name)?.record(value);
    });
  }

  adjust(name: UpDownName, delta: number): void {
    this.guarded(() => {
      if (Number.isFinite(delta)) this.upDowns.get(name)?.add(delta);
    });
  }

  startSpan(name: SpanName, options: StartSpanOptions): TelemetrySpan {
    let span: ReturnType<NonNullable<OtelTelemetry["tracer"]>["startSpan"]> | null = null;
    this.guarded(() => {
      if (!this.tracer) return;
      const parent = TRACE_ID_RE.test(options.traceId) && !/^0+$/.test(options.traceId)
        ? trace.setSpanContext(ROOT_CONTEXT, { traceId: options.traceId, spanId: syntheticRootSpanId(options.traceId), traceFlags: TraceFlags.SAMPLED, isRemote: true })
        : ROOT_CONTEXT;
      span = this.tracer.startSpan(name, { attributes: allowedAttributes(name, options.attributes), startTime: options.startTime }, parent);
    });
    const live = span as ReturnType<NonNullable<OtelTelemetry["tracer"]>["startSpan"]> | null;
    if (!live) return { setAttributes() {}, addEvent() {}, end() {} };
    return {
      setAttributes: (attributes) => this.guarded(() => void live.setAttributes(allowedAttributes(name, attributes))),
      addEvent: (eventName) => this.guarded(() => {
        if (EVENT_NAME_RE.test(eventName)) live.addEvent(eventName);
      }),
      end: (endTime) => this.guarded(() => live.end(endTime)),
    };
  }

  metricsHandler(): MetricsHandler | null {
    const reader = this.reader;
    if (!reader) return null;
    return (req, res) => {
      try {
        reader.getMetricsRequestHandler(req, res);
      } catch (err) {
        this.degraded("call", err);
        try {
          res.statusCode = 500;
          res.end("# metrics unavailable\n");
        } catch {
          // The response is gone; nothing more to do.
        }
      }
    };
  }

  /**
   * The API's DB gauges (apiGauges.ts): `read` runs on every scrape, capped at `capMs`. A read that fails or
   * times out keeps the last values (the gauge goes stale) and counts gauge_query.
   */
  registerGauges(read: () => Promise<GaugeReading[]>, capMs: number): void {
    this.guarded(() => {
      if (!this.meter) return;
      for (const [name, def] of Object.entries(API_GAUGES) as [ApiGaugeName, (typeof API_GAUGES)[ApiGaugeName]][]) {
        if (!this.gauges.has(name)) this.gauges.set(name, this.meter.createObservableGauge(name, { description: def.help }));
      }
      let last: GaugeReading[] = [];
      this.meter.addBatchObservableCallback(async (result) => {
        try {
          const readings = await this.capped(read, capMs, "gauge_query");
          if (readings !== undefined) last = readings;
          for (const r of last) {
            const gauge = this.gauges.get(r.name);
            if (!gauge || !Number.isFinite(r.value)) continue;
            const labels: Record<string, string> = {};
            for (const key of API_GAUGES[r.name].labels as readonly string[]) if (r.labels && key in r.labels) labels[key] = labelValue(r.labels[key]);
            result.observe(gauge, r.value, labels);
          }
        } catch (err) {
          this.degraded("gauge_query", err);
        }
      }, [...this.gauges.values()]);
    });
  }

  /**
   * Runs `work`, but gives up waiting after `capMs`: resolves with its value, or undefined after a timeout or an
   * error (counted as `kind`). Never rejects.
   */
  private async capped<T>(work: () => Promise<T>, capMs: number, kind: TelemetryErrorKind): Promise<T | undefined> {
    let timer: NodeJS.Timeout | undefined;
    const cap = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, capMs));
      timer.unref?.();
    });
    try {
      const result = await Promise.race([Promise.resolve().then(work), cap]);
      if (result === TIMED_OUT) {
        this.degraded(kind, new TelemetryTimeoutError(kind, capMs));
        return undefined;
      }
      return result as T;
    } catch (err) {
      // An exporter or query error surfaced here (a forceFlush whose export failed, a gauge query): swallowed (rule 2).
      this.degraded(kind, err);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  async flush(capMs: number): Promise<void> {
    if (this.closed || !this.tracerProvider) return;
    const provider = this.tracerProvider;
    // timeoutMillis: the provider's own timer (default 30 s, not unref'd) must not outlive the cap either.
    await this.capped(() => provider.forceFlush({ timeoutMillis: Math.max(1, capMs) }), capMs, "flush");
  }

  async shutdown(capMs: number): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const tracerProvider = this.tracerProvider;
    const meterProvider = this.meterProvider;
    await this.capped(
      () => Promise.all([tracerProvider?.shutdown(), meterProvider?.shutdown()]),
      capMs,
      "flush",
    );
  }

  // --- Test helpers (never used by fleet code for a decision, rule 8) ---------------------------------------

  /** The memory sink's finished spans (after flush). Empty for other sinks. */
  finishedSpans(): SpanRecord[] {
    return (this.memory?.getFinishedSpans() ?? []).map((s) => ({
      name: s.name,
      traceId: s.spanContext().traceId,
      spanId: s.spanContext().spanId,
      parentSpanId: s.parentSpanContext?.spanId,
      attributes: { ...s.attributes },
      events: s.events.map((e) => e.name),
    }));
  }

  /** Telemetry's own errors so far, by kind. */
  errors(): Record<string, number> {
    return Object.fromEntries(this.errorTotals);
  }

  /** Spans ended and not yet through an export (the guard's count). */
  get pendingSpans(): number {
    return this.guard?.pending ?? 0;
  }

  /** The /metrics text, as a scrape would get it. */
  async metricsText(): Promise<string> {
    if (!this.reader) return "";
    const { resourceMetrics } = await this.reader.collect();
    return new PrometheusSerializer("", false, undefined, false, true).serialize(resourceMetrics);
  }
}
