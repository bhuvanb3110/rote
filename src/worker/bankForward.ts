// A plain TCP forwarder (reviewer decision B1, D26). In Docker, every committed artifact and override
// targets http://localhost:4100, which inside a worker container is the container itself. The worker
// entrypoint starts this forwarder on 127.0.0.1:4100 -> bank:4100 BEFORE the worker, so Chromium
// still talks to http://localhost:4100: artifacts, approvals (version + digest) and the policy
// allowlist stay byte-identical. Node's node:net only; no socat, no extra packages.
//
// Half-close is honored (allowHalfOpen on both sides, pipe() propagates each FIN), so a peer that
// finishes sending can still receive the reply. Either side erroring destroys both.
import net from "node:net";

export interface ForwarderOptions {
  listenHost: string;
  listenPort: number;
  targetHost: string;
  targetPort: number;
  onError?: (err: Error) => void;
}

export interface Forwarder {
  /** The bound port (useful with listenPort 0). */
  readonly port: number;
  /** Open client connections right now. */
  readonly connections: number;
  /** Stop listening and destroy every open connection. */
  close(): Promise<void>;
}

/** "bank:4100" -> { host: "bank", port: 4100 }. */
export function parseHostPort(value: string): { host: string; port: number } {
  const match = /^([^:\s]+):(\d{1,5})$/.exec(value.trim());
  const port = match ? Number(match[2]) : NaN;
  if (!match || port < 1 || port > 65535) throw new Error(`expected host:port, got "${value}"`);
  return { host: match[1]!, port };
}

export async function startTcpForwarder(options: ForwarderOptions): Promise<Forwarder> {
  const open = new Set<net.Socket>();
  const server = net.createServer({ allowHalfOpen: true }, (client) => {
    const upstream = net.connect({ host: options.targetHost, port: options.targetPort, allowHalfOpen: true });
    open.add(client);
    const teardown = (err?: Error) => {
      if (err) options.onError?.(err);
      client.destroy();
      upstream.destroy();
    };
    client.on("error", teardown);
    upstream.on("error", teardown);
    client.on("close", () => {
      open.delete(client);
      upstream.destroy();
    });
    upstream.on("close", () => {
      // Upstream fully closed: let anything already queued for the client flush, then end it.
      if (!client.destroyed) client.end();
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.listenPort, options.listenHost, () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", (err) => options.onError?.(err));
  const port = (server.address() as net.AddressInfo).port;

  return {
    port,
    get connections() {
      return open.size;
    },
    close() {
      return new Promise<void>((resolve) => {
        for (const socket of open) socket.destroy();
        server.close(() => resolve());
      });
    },
  };
}
