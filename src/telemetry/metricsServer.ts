// A worker's /metrics listener (step-13.md section 2 rules 4 and 5). Prometheus pulls; a Prometheus that is down
// means nobody reads, and the worker does nothing differently. If the port can't be bound (in use, no
// permission...), the worker logs ONE warning and runs on without /metrics: it never exits over telemetry.
import { createServer, type Server } from "node:http";
import type { MetricsHandler, TelemetryLog } from "./types.js";

export interface MetricsServer {
  /** The bound port (useful with port 0). */
  port: number;
  close(): Promise<void>;
}

/** Resolves with the server, or null after one warning if it could not listen. Never rejects. */
export function startMetricsServer(
  handler: MetricsHandler,
  listen: { port: number; host: string },
  options: { log?: TelemetryLog; onError?: (err: unknown) => void } = {},
): Promise<MetricsServer | null> {
  return new Promise((resolve) => {
    let server: Server;
    try {
      server = createServer((req, res) => {
        const path = (req.url ?? "").split("?")[0];
        if (req.method === "GET" && path === "/metrics") {
          handler(req, res);
          return;
        }
        res.statusCode = 404;
        res.end("not found\n");
      });
    } catch (err) {
      fail(err);
      return;
    }
    function fail(err: unknown) {
      options.onError?.(err);
      const code = typeof err === "object" && err !== null ? (err as { code?: unknown }).code : undefined;
      options.log?.warn(
        { port: listen.port, host: listen.host, code: typeof code === "string" ? code : undefined },
        "telemetry: metrics port unavailable; running WITHOUT /metrics (jobs are unaffected)",
      );
      resolve(null);
    }
    server.once("error", fail);
    try {
      server.listen(listen.port, listen.host, () => {
        server.off("error", fail);
        // A later server error (a bad socket) must not crash the worker.
        server.on("error", (err) => options.onError?.(err));
        server.unref();
        const address = server.address();
        resolve({
          port: typeof address === "object" && address ? address.port : listen.port,
          close: () => new Promise<void>((done) => server.close(() => done())),
        });
      });
    } catch (err) {
      fail(err);
    }
  });
}
