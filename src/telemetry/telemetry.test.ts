// The Telemetry contract (step-13.md section 7 row 1; docs/plans/step-13a.md section 4): the no-op and the
// OpenTelemetry implementation behave the same to their callers. With an exporter that THROWS, one that HANGS
// forever, and one that REJECTS after 10 s, every call returns at once and never throws, and flush/shutdown
// resolve within their cap and never reject. The span queue drops at its bound and counts it. The degraded
// warning is rate-limited and never carries an error's message.
//
// "Returns at once": every call is timed. The broken exporters here give up only after 5 s, so a call that waited
// for an export would take seconds. The median must be under 1 ms and EVERY call under 1 s. Not "p99 under 5 ms":
// the first full run measured p99s of 8 and 22 ms under the suite's parallel load, which is CPU contention, not
// waiting (evidence/step-13a/flakes.md).
import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import {
  NO_TELEMETRY,
  OtelTelemetry,
  syntheticRootSpanId,
  telemetrySettingsFromEnv,
  telemetryShutdownCapMs,
  createTelemetry,
  type SpanSink,
  type Telemetry,
  type CounterName,
  type SpanName,
} from "./index.js";

const TRACE = "0123456789abcdef0123456789abcdef";
const SECRET = "secret-in-an-error-message-77";

/** Each kind of broken collector, as a span sink. */
function throwingSink(): SpanSink {
  return {
    export() {
      throw new Error(`exporter exploded: ${SECRET}`);
    },
    shutdown: async () => {
      throw new Error(`shutdown exploded: ${SECRET}`);
    },
  };
}
function hangingSink(): SpanSink {
  return { export() {}, shutdown: () => new Promise<void>(() => undefined) };
}
function rejectsAfter10sSink(): SpanSink {
  return {
    export(_spans, done) {
      setTimeout(() => done({ code: 1, error: new Error(`rejected late: ${SECRET}`) }), 10_000).unref();
    },
    shutdown: () => new Promise<void>((_, reject) => setTimeout(() => reject(new Error(SECRET)), 10_000).unref()),
  };
}

interface Logged {
  obj: Record<string, unknown>;
  msg: string;
}
function logSpy() {
  const lines: Logged[] = [];
  return { lines, log: { warn: (obj: Record<string, unknown>, msg: string) => void lines.push({ obj, msg }) } };
}

/** Times every call; returns the durations in ms. */
function exercise(t: Telemetry, n: number): number[] {
  const times: number[] = [];
  const timed = (fn: () => void) => {
    const start = performance.now();
    fn();
    times.push(performance.now() - start);
  };
  for (let i = 0; i < n; i += 1) {
    let span = NO_TELEMETRY.startSpan("capability.step", { traceId: TRACE });
    timed(() => {
      span = t.startSpan("capability.step", { traceId: TRACE, attributes: { step_index: i, step_id: `step-${i}` } });
    });
    timed(() => span.setAttributes({ retries: 0, locator_strategy: "roleName" }));
    timed(() => span.addEvent("screenshot.retry"));
    timed(() => span.end());
    timed(() => t.count("rote_jobs_completed_total", { outcome: "success" }));
    timed(() => t.observe("rote_job_duration_seconds", 1.5));
    timed(() => t.adjust("rote_browser_contexts_in_use", 1));
    timed(() => t.adjust("rote_browser_contexts_in_use", -1));
  }
  return times;
}

function expectFast(times: number[]): void {
  const sorted = [...times].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)]!;
  expect(median, `median of ${times.length} calls`).toBeLessThan(1);
  expect(sorted[sorted.length - 1]!, "slowest call (a call that waited for the 5 s export would exceed this)").toBeLessThan(1000);
}

async function within<T>(p: Promise<T>, ms: number): Promise<{ value: T; ms: number }> {
  const start = performance.now();
  const value = await p;
  const took = performance.now() - start;
  expect(took, "resolved within its cap").toBeLessThan(ms);
  return { value, ms: took };
}

describe("one contract: the no-op and the OpenTelemetry implementation", () => {
  const impls: [string, () => Telemetry][] = [
    ["NO_TELEMETRY", () => NO_TELEMETRY],
    ["OtelTelemetry (memory, metrics on)", () => new OtelTelemetry({ serviceName: "t", traces: { kind: "memory" }, metrics: true })],
    ["OtelTelemetry (traces off, metrics off)", () => new OtelTelemetry({ serviceName: "t", traces: null, metrics: false })],
  ];
  for (const [label, make] of impls) {
    it(`${label}: every call returns at once, nothing throws, even on nonsense input; flush/shutdown resolve`, async () => {
      const t = make();
      expectFast(exercise(t, 50));
      expect(() => {
        t.count("no_such_counter" as CounterName, { outcome: "x" });
        t.count("rote_jobs_completed_total", { outcome: "has spaces and ${SECRET}", extra: "dropped" }, Number.NaN);
        t.count("rote_job_retries_total", undefined, -3);
        t.observe("rote_job_duration_seconds", Number.POSITIVE_INFINITY);
        t.adjust("rote_browser_contexts_in_use", Number.NaN);
        const s = t.startSpan("no.such.span" as SpanName, { traceId: "not-a-trace-id", attributes: { password: SECRET } });
        s.setAttributes({ [SECRET]: SECRET });
        s.addEvent(`event with ${SECRET}`);
        s.end(Number.NaN);
        s.end();
        t.registerGauges(async () => {
          throw new Error(SECRET);
        }, 10);
        t.metricsHandler();
      }).not.toThrow();
      await within(t.flush(500), 1000);
      await within(t.shutdown(500), 1000);
      // After shutdown: still callable, still silent.
      expect(() => exercise(t, 2)).not.toThrow();
      await within(t.flush(100), 500);
    });
  }
});

describe("an exporter that throws, hangs, or rejects after 10 s", () => {
  // The export timeout is 5 s: a call that waited on the broken exporter would take that long.
  const small = { maxQueueSize: 64, maxExportBatchSize: 64, scheduledDelayMillis: 60_000, exportTimeoutMillis: 5000 };
  const cases: [string, () => SpanSink][] = [
    ["throws", throwingSink],
    ["hangs forever", hangingSink],
    ["rejects after 10 s", rejectsAfter10sSink],
  ];
  for (const [label, sink] of cases) {
    it(`${label}: calls return at once and never throw; flush and shutdown resolve within their cap and never reject; the failure is counted`, async () => {
      const spy = logSpy();
      const t = new OtelTelemetry({ serviceName: "t", traces: { kind: "sink", sink: sink() }, metrics: true, batch: small, log: spy.log });
      expectFast(exercise(t, 20)); // 20 spans sit in the queue (batch 64, delay 60 s)
      // The flush hands them to the broken exporter: it must still come back within the cap, and never reject.
      await expect(within(t.flush(1000), 1500)).resolves.toBeDefined();
      expectFast(exercise(t, 20));
      await expect(within(t.shutdown(1000), 1500)).resolves.toBeDefined();
      const errors = t.errors();
      expect((errors.span_export ?? 0) + (errors.flush ?? 0), JSON.stringify(errors)).toBeGreaterThan(0);
      // The warning names the kind and the error's class, never its message.
      expect(spy.lines.length).toBeGreaterThanOrEqual(1);
      expect(spy.lines.every((l) => l.msg === "telemetry: degraded")).toBe(true);
      expect(JSON.stringify(spy.lines)).not.toContain(SECRET);
    }, 15_000);
  }

  it("a throwing exporter's error reaches flush() (it rejects forceFlush) and is swallowed there: counted as flush, never rethrown", async () => {
    const t = new OtelTelemetry({ serviceName: "t", traces: { kind: "sink", sink: throwingSink() }, metrics: false, batch: small });
    t.startSpan("capability.step", { traceId: TRACE }).end();
    let rejected: unknown = null;
    await t.flush(1000).catch((err: unknown) => (rejected = err));
    expect(rejected).toBeNull();
    expect(t.errors()).toMatchObject({ span_export: 1, flush: 1 });
  });

  it("a hanging export is given up after the export timeout: the queue's count is released, so later spans still flow", async () => {
    const t = new OtelTelemetry({ serviceName: "t", traces: { kind: "sink", sink: hangingSink() }, metrics: false, batch: { ...small, maxQueueSize: 4, maxExportBatchSize: 4, exportTimeoutMillis: 300 } });
    for (let i = 0; i < 4; i += 1) t.startSpan("capability.step", { traceId: TRACE }).end(); // a full batch: exported now, and hangs
    expect(t.pendingSpans).toBe(4);
    await new Promise((resolve) => setTimeout(resolve, 600)); // past the 300 ms export timeout
    expect(t.pendingSpans).toBe(0);
    expect(t.errors().span_export).toBe(1);
    await t.shutdown(200);
  });
});

describe("the bounded queue", () => {
  it("drops at its bound instead of growing, and counts every dropped span (rote_telemetry_errors_total{kind=span_dropped})", async () => {
    const t = new OtelTelemetry({
      serviceName: "t",
      traces: { kind: "sink", sink: hangingSink() },
      metrics: true,
      batch: { maxQueueSize: 5, maxExportBatchSize: 5, scheduledDelayMillis: 60_000, exportTimeoutMillis: 60_000 },
    });
    for (let i = 0; i < 20; i += 1) t.startSpan("capability.step", { traceId: TRACE }).end();
    expect(t.pendingSpans).toBe(5);
    expect(t.errors().span_dropped).toBe(15);
    expect(await t.metricsText()).toMatch(/^rote_telemetry_errors_total\{kind="span_dropped"\} 15$/m);
    await t.shutdown(100);
  });
});

describe("the degraded warning", () => {
  it("is rate-limited: one line per interval however many failures, with the counts since", async () => {
    const spy = logSpy();
    const t = new OtelTelemetry({
      serviceName: "t",
      traces: { kind: "sink", sink: throwingSink() },
      metrics: false,
      batch: { maxQueueSize: 64, maxExportBatchSize: 1, scheduledDelayMillis: 60_000, exportTimeoutMillis: 300 },
      log: spy.log,
      degradedLogIntervalMs: 60_000,
    });
    for (let i = 0; i < 30; i += 1) t.startSpan("capability.step", { traceId: TRACE }).end(); // batch 1: 30 failed exports
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(t.errors().span_export).toBe(30);
    expect(spy.lines).toHaveLength(1);
    expect(spy.lines[0]!.obj).toMatchObject({ kind: "span_export", error: "Error" });
    expect(JSON.stringify(spy.lines)).not.toContain(SECRET);
    await t.shutdown(100);
  });
});

describe("configuration: off unless configured, and never fatal", () => {
  it("nothing set -> NO_TELEMETRY; an endpoint -> traces; a port -> metrics and a listener; bad values -> warnings, that part off", () => {
    expect(createTelemetry(telemetrySettingsFromEnv({}, { serviceName: "rote-worker" }).settings)).toBe(NO_TELEMETRY);
    const on = telemetrySettingsFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://jaeger:4318/", ROTE_METRICS_PORT: "9464", OTEL_SERVICE_NAME: "w" }, { serviceName: "rote-worker", instanceId: "w-1" });
    expect(on.settings).toEqual({
      serviceName: "w",
      instanceId: "w-1",
      traces: { kind: "otlp", url: "http://jaeger:4318/v1/traces" },
      metrics: true,
      listen: { port: 9464, host: "127.0.0.1" },
    });
    expect(on.warnings).toEqual([]);
    const bad = telemetrySettingsFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: "jaeger:4318", ROTE_METRICS_PORT: "lots" }, { serviceName: "rote-worker" });
    expect(bad.settings).toMatchObject({ traces: null, metrics: false, listen: null });
    expect(bad.warnings).toHaveLength(2);
    // The API: metrics on by flag, never a listener of its own.
    expect(telemetrySettingsFromEnv({ ROTE_METRICS_PORT: "9464" }, { serviceName: "rote-api", metrics: "on" }).settings).toMatchObject({ metrics: true, listen: null });
  });

  it("the exit flush is taken from inside the grace: min(2 s, what is left), never more", () => {
    expect(telemetryShutdownCapMs(null, 30_000)).toBe(2000);
    expect(telemetryShutdownCapMs(1000, 30_000, 2000)).toBe(2000);
    expect(telemetryShutdownCapMs(1000, 30_000, 30_000)).toBe(1000);
    expect(telemetryShutdownCapMs(1000, 30_000, 40_000)).toBe(0);
  });

  it("the synthetic root span id is a stable 16-hex id per trace, never all zeros", () => {
    expect(syntheticRootSpanId(TRACE)).toMatch(/^[0-9a-f]{16}$/);
    expect(syntheticRootSpanId(TRACE)).toBe(syntheticRootSpanId(TRACE));
    expect(syntheticRootSpanId(TRACE)).not.toBe(syntheticRootSpanId("f".repeat(32)));
  });
});

describe("spans", () => {
  it("live in the job's trace, under its synthetic root, with only allowlisted attributes", async () => {
    const t = new OtelTelemetry({ serviceName: "t", traces: { kind: "memory" }, metrics: false });
    const span = t.startSpan("capability.step", { traceId: TRACE, attributes: { step_index: 3, step_id: "step-03", irreversible: false, memo: "rent", url: "http://x/?q=1" } });
    span.setAttributes({ locator_strategy: "roleName", retries: 0, error: "boom" });
    span.addEvent("screenshot.retry");
    span.end();
    await t.flush(1000);
    const [s] = t.finishedSpans();
    expect(s).toMatchObject({ name: "capability.step", traceId: TRACE, parentSpanId: syntheticRootSpanId(TRACE), events: ["screenshot.retry"] });
    expect(s!.attributes).toEqual({ step_index: 3, step_id: "step-03", irreversible: false, locator_strategy: "roleName", retries: 0 });
    await t.shutdown(100);
  });
});

describe("metrics", () => {
  it("every rote_ counter, the histogram and the gauge are in the Prometheus text from the start (seeded at 0)", async () => {
    const t = new OtelTelemetry({ serviceName: "t", traces: null, metrics: true });
    t.count("rote_jobs_completed_total", { outcome: "success" });
    t.observe("rote_job_duration_seconds", 3);
    const text = await t.metricsText();
    for (const name of [
      "rote_jobs_completed_total",
      "rote_job_retries_total",
      "rote_recoveries_total",
      "rote_worker_crashes_total",
      "rote_screenshot_retries_total",
      "rote_illegal_transitions_total",
      "rote_verify_decisions_total",
      "rote_reconcile_decisions_total",
      "rote_duplicates_detected_total",
      "rote_unrecorded_commits_detected_total",
      "rote_reconcile_abandoned_total",
      "rote_telemetry_errors_total",
      "rote_job_duration_seconds",
      "rote_browser_contexts_in_use",
    ]) {
      expect(text, name).toMatch(new RegExp(`^# TYPE ${name} `, "m"));
    }
    expect(text).toMatch(/^rote_jobs_completed_total\{outcome="success"\} 1$/m);
    expect(text).toMatch(/^rote_recoveries_total\{result="already_done"\} 0$/m);
    expect(text).toMatch(/^rote_job_duration_seconds_count 1$/m);
    await t.shutdown(100);
  });

  it("a label value that is not a plain identifier is exported as 'other'; unknown label keys are dropped", async () => {
    const t = new OtelTelemetry({ serviceName: "t", traces: null, metrics: true });
    t.count("rote_jobs_completed_total", { outcome: `a b ${SECRET}!`, jobId: "123" });
    const text = await t.metricsText();
    expect(text).toMatch(/^rote_jobs_completed_total\{outcome="other"\} 1$/m);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("jobId");
    await t.shutdown(100);
  });
});
