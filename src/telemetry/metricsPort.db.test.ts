// The worker's /metrics listener (step-13.md section 2 rule 5, section 7 row 5): a port already taken costs ONE
// warning and the worker completes its jobs; a free one serves the Prometheus text format with every worker
// metric of section 5 (renamed rote_*, reviewer decision 4). The settings come from the same environment
// variables the worker reads (telemetrySettingsFromEnv), and the listener is the one main.ts starts.
import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listenOnSafePort } from "../testing/listen.js";
import { createWorkerTestEnv, type WorkerTestEnv } from "../worker/testEnv.js";
import { COUNTERS, HISTOGRAMS, UP_DOWN, createTelemetry, startMetricsServer, telemetrySettingsFromEnv } from "./index.js";

let env: WorkerTestEnv;
let squatter: Server;
let takenPort: number;

beforeAll(async () => {
  env = await createWorkerTestEnv("telemetry_metrics_port");
  squatter = createServer((_req, res) => void res.end("someone else"));
  takenPort = await listenOnSafePort(squatter, "127.0.0.1");
}, 60_000);
afterAll(async () => {
  await new Promise<void>((resolve) => squatter.close(() => resolve()));
  await env?.close();
});

function logSpy() {
  const lines: { obj: Record<string, unknown>; msg: string }[] = [];
  return { lines, log: { warn: (obj: Record<string, unknown>, msg: string) => void lines.push({ obj, msg }) } };
}

/** The Prometheus text exposition format, line by line: comments, or `name{labels} value`. */
const COMMENT = /^# (HELP|TYPE|UNIT) [a-zA-Z_:][a-zA-Z0-9_:]* .*$/;
const SAMPLE = /^[a-zA-Z_:][a-zA-Z0-9_:]*(\{([a-zA-Z_][a-zA-Z0-9_]*="(?:[^"\\]|\\.)*",?)*\})? (-?[0-9.]+(e[+-]?[0-9]+)?|NaN|\+Inf|-Inf)( -?[0-9]+)?$/;

describe("the worker's /metrics port", () => {
  it("already taken: one warning, no listener, and the worker completes its job as usual", async () => {
    await env.reset();
    const spy = logSpy();
    const { settings, warnings } = telemetrySettingsFromEnv({ ROTE_METRICS_PORT: String(takenPort), ROTE_METRICS_HOST: "127.0.0.1" }, { serviceName: "rote-worker", instanceId: "w-port" });
    expect(warnings).toEqual([]);
    const telemetry = createTelemetry(settings, { log: spy.log });
    const server = await startMetricsServer(telemetry.metricsHandler()!, settings.listen!, {
      log: spy.log,
      onError: () => telemetry.count("rote_telemetry_errors_total", { kind: "metrics_port" }),
    });
    expect(server).toBeNull();
    expect(spy.lines).toEqual([{ obj: expect.objectContaining({ port: takenPort, code: "EADDRINUSE" }), msg: expect.stringMatching(/^telemetry: metrics port unavailable; running WITHOUT \/metrics/) }]);
    const [job] = await env.enqueueTransfers(1, {}, ["tenant-a"]);
    expect(await env.newWorker({ telemetry }).tick()).toBe("ran");
    expect((await env.jobs()).find((j) => j.id === job!.id)).toMatchObject({ state: "succeeded", outcome: "success", attempt: 1 });
    expect(await env.ledger()).toHaveLength(1);
    // The squatter still owns its port.
    expect(await (await fetch(`http://127.0.0.1:${takenPort}/metrics`)).text()).toBe("someone else");
    await telemetry.shutdown(1000);
  }, 120_000);

  it("free: /metrics is Prometheus text with every worker metric (rote_*), and counts the job it ran; other paths 404", async () => {
    await env.reset();
    const { settings } = telemetrySettingsFromEnv({ ROTE_METRICS_PORT: "0", ROTE_METRICS_HOST: "127.0.0.1" }, { serviceName: "rote-worker", instanceId: "w-free" });
    const telemetry = createTelemetry(settings);
    const server = (await startMetricsServer(telemetry.metricsHandler()!, settings.listen!))!;
    expect(server.port).toBeGreaterThan(0);
    try {
      await env.enqueueTransfers(1, {}, ["tenant-a"]);
      expect(await env.newWorker({ telemetry }).tick()).toBe("ran");
      const res = await fetch(`http://127.0.0.1:${server.port}/metrics`);
      expect(res.status).toBe(200);
      const text = await res.text();
      const lines = text.split("\n").filter((l) => l.trim() !== "");
      for (const line of lines) expect(COMMENT.test(line) || SAMPLE.test(line), `not Prometheus text: ${line}`).toBe(true);
      const worker = [...Object.keys(COUNTERS), ...Object.keys(HISTOGRAMS), ...Object.keys(UP_DOWN)];
      for (const name of worker) expect(text, name).toMatch(new RegExp(`^# TYPE ${name} (counter|histogram|gauge)$`, "m"));
      expect(text).toMatch(/^rote_jobs_completed_total\{outcome="success"\} 1$/m);
      expect(text).toMatch(/^rote_job_duration_seconds_count 1$/m);
      expect(text).toMatch(/^rote_browser_contexts_in_use 0$/m);
      expect(text).toMatch(/^rote_telemetry_errors_total\{kind="metrics_port"\} 0$/m);
      expect(text).toMatch(/^target_info\{.*service_name="rote-worker".*\} 1$/m);
      expect((await fetch(`http://127.0.0.1:${server.port}/other`)).status).toBe(404);
    } finally {
      await server.close();
      await telemetry.shutdown(1000);
    }
  }, 120_000);
});
