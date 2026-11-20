// Fleet telemetry (Day 3, docs/plans/step-13a.md): the one seam. Everything outside src/telemetry/ imports from
// here, never from @opentelemetry/* (step-13.md section 2 rule 1).
export * from "./names.js";
export * from "./types.js";
export { createTelemetry, telemetrySettingsFromEnv, telemetryShutdownCapMs, DEFAULT_METRICS_HOST, TELEMETRY_FLUSH_CAP_MS, type TelemetrySettings } from "./config.js";
export { OtelTelemetry, syntheticRootSpanId, allowedAttributes, DEFAULT_BATCH, type SpanSink, type SpanRecord, type TraceSinkConfig, type OtelTelemetryConfig } from "./otel.js";
export { startMetricsServer, type MetricsServer } from "./metricsServer.js";
export { forwardingMetrics } from "./workerMetrics.js";
export { createGaugeReader, GAUGE_CONNECT_TIMEOUT_MS, GAUGE_READ_CAP_MS, GAUGE_STATEMENT_TIMEOUT_MS } from "./apiGauges.js";
export { stepObserver } from "./stepObserver.js";
