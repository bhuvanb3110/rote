// Stand-in OTLP collectors for the telemetry tests (docs/plans/step-13a.md section 4; step-13.md section 7 row 3):
//   closedPort()         a port nothing listens on (bound once, then closed): every export is refused at once
//   blackHole()          a TCP server that ACCEPTS every connection and never sends a byte: every export hangs
//                        until the exporter's own timeout
//   receivingCollector() an HTTP server that answers 200 to POST /v1/traces and counts what arrived (the child
//                        worker's "in-memory" mode: an in-memory exporter cannot cross a process boundary)
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";
import { listenOnSafePort } from "./listen.js";

export async function closedPort(): Promise<number> {
  const server = createTcpServer();
  const port = await listenOnSafePort(server, "127.0.0.1");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface BlackHole {
  port: number;
  /** Connections accepted so far. */
  readonly connections: number;
  close(): Promise<void>;
}

export async function blackHole(): Promise<BlackHole> {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server = createTcpServer((socket) => {
    connections += 1;
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    // Read and discard; never write, never end.
    socket.resume();
  });
  const port = await listenOnSafePort(server, "127.0.0.1");
  return {
    port,
    get connections() {
      return connections;
    },
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

export interface ReceivingCollector {
  port: number;
  /** POST /v1/traces requests answered so far. */
  readonly requests: number;
  /** Their bodies, concatenated (OTLP/JSON). */
  readonly bodies: string;
  close(): Promise<void>;
}

export async function receivingCollector(): Promise<ReceivingCollector> {
  let requests = 0;
  let bodies = "";
  const server = createHttpServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (req.method === "POST" && req.url?.startsWith("/v1/traces")) {
        requests += 1;
        bodies += Buffer.concat(chunks).toString("utf8");
      }
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end("{}");
    });
  });
  const port = await listenOnSafePort(server, "127.0.0.1");
  return {
    port,
    get requests() {
      return requests;
    },
    get bodies() {
      return bodies;
    },
    close: async () => {
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
