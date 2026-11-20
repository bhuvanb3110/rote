// Telemetry is OFF unless configured (step-13.md section 2 rule 9), and a bad setting never stops a process
// (rule 5): it is reported as a warning and that part stays off.
//
//   OTEL_EXPORTER_OTLP_ENDPOINT  e.g. http://jaeger:4318 -> spans go to <endpoint>/v1/traces (OTLP/HTTP).
//                                Unset or empty: the tracer is the no-op.
//   OTEL_SERVICE_NAME            service.name (default: the caller's, rote-worker / rote-api)
//   ROTE_METRICS_PORT            the worker's /metrics listener (Compose: 9464). Unset: no listener, no metrics.
//   ROTE_METRICS_HOST            its bind address (default 127.0.0.1; Compose sets 0.0.0.0 so Prometheus reaches it)
//
// Nothing here opens a socket: the OTLP exporter connects on its first export, and the worker binds the metrics
// port itself (metricsServer.ts), after startup, logging one warning if it can't.
import { NO_TELEMETRY, type Telemetry, type TelemetryLog } from "./types.js";
import { OtelTelemetry, type TraceSinkConfig } from "./otel.js";

export interface TelemetrySettings {
  serviceName: string;
  instanceId?: string;
  traces: TraceSinkConfig | null;
  /** Record metrics (a worker with a port, or the API with --metrics). */
  metrics: boolean;
  /** Where a worker serves /metrics; null: nowhere (the API mounts the handler in its own app). */
  listen: { port: number; host: string } | null;
}

export const DEFAULT_METRICS_HOST = "127.0.0.1";

/** Settings from the environment, plus a warning for each setting that was ignored. Never throws. */
export function telemetrySettingsFromEnv(
  env: NodeJS.ProcessEnv,
  defaults: { serviceName: string; instanceId?: string; metrics?: "port" | "on" | "off" },
): { settings: TelemetrySettings; warnings: string[] } {
  const warnings: string[] = [];
  let traces: TraceSinkConfig | null = null;
  const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim();
  if (endpoint) {
    try {
      const url = new URL(endpoint);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("not http(s)");
      traces = { kind: "otlp", url: `${endpoint.replace(/\/+$/, "")}/v1/traces` };
    } catch {
      warnings.push("OTEL_EXPORTER_OTLP_ENDPOINT is not an http(s) URL; traces stay off");
    }
  }
  let listen: TelemetrySettings["listen"] = null;
  const rawPort = env.ROTE_METRICS_PORT?.trim();
  if ((defaults.metrics ?? "port") === "port" && rawPort) {
    const port = Number(rawPort);
    if (Number.isInteger(port) && port >= 0 && port <= 65535) listen = { port, host: env.ROTE_METRICS_HOST?.trim() || DEFAULT_METRICS_HOST };
    else warnings.push(`ROTE_METRICS_PORT must be an integer 0..65535 (got "${rawPort}"); metrics stay off`);
  }
  const metrics = defaults.metrics === "on" ? true : defaults.metrics === "off" ? false : listen !== null;
  const serviceName = env.OTEL_SERVICE_NAME?.trim() || defaults.serviceName;
  return { settings: { serviceName, instanceId: defaults.instanceId, traces, metrics, listen }, warnings };
}

/** Rule 6: the one flush at exit is capped at 2 s. */
export const TELEMETRY_FLUSH_CAP_MS = 2000;

/**
 * Rule 6: the exit flush is taken from INSIDE the shutdown grace, never added to it: min(2 s, what is left of the
 * grace since the stop signal), and 2 s when the loop ended without a signal.
 */
export function telemetryShutdownCapMs(stopRequestedAt: number | null, graceMs: number, now = Date.now()): number {
  if (stopRequestedAt === null) return TELEMETRY_FLUSH_CAP_MS;
  return Math.max(0, Math.min(TELEMETRY_FLUSH_CAP_MS, graceMs - (now - stopRequestedAt)));
}

/** The no-op when nothing is on, else the OpenTelemetry implementation. */
export function createTelemetry(settings: TelemetrySettings, options: { log?: TelemetryLog } = {}): Telemetry {
  if (!settings.traces && !settings.metrics) return NO_TELEMETRY;
  return new OtelTelemetry({
    serviceName: settings.serviceName,
    instanceId: settings.instanceId,
    traces: settings.traces,
    metrics: settings.metrics,
    log: options.log,
  });
}
