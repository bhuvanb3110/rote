// listenOnSafePort (D31): a blocked ephemeral port (the 2049 a real run got) is closed and replaced.
import { EventEmitter } from "node:events";
import { createServer, type Server } from "node:net";
import { describe, expect, it } from "vitest";
import { BLOCKED_PORTS, listenOnSafePort } from "./listen.js";

/** A server stand-in whose successive listen(0) calls get the given ports. */
function stubServer(ports: number[]) {
  const emitter = new EventEmitter();
  let current: number | null = null;
  const calls = { listen: 0, close: 0 };
  const server = Object.assign(emitter, {
    listen(_port: number, ...rest: unknown[]) {
      calls.listen += 1;
      current = ports.shift()!;
      (rest.find((a) => typeof a === "function") as () => void)();
      return server;
    },
    address: () => ({ address: "::", family: "IPv6", port: current! }),
    close(cb: (err?: Error) => void) {
      calls.close += 1;
      current = null;
      cb();
      return server;
    },
  });
  return { server: server as unknown as Server, calls };
}

describe("listenOnSafePort", () => {
  it("knows the ports that broke a run: 2049 (NFS), 6000 (X11), 10080", () => {
    for (const p of [2049, 6000, 10080, 22, 25]) expect(BLOCKED_PORTS.has(p)).toBe(true);
    expect(BLOCKED_PORTS.has(4100)).toBe(false);
  });

  it("closes a server that got a blocked port and listens again", async () => {
    const { server, calls } = stubServer([2049, 6667, 51234]);
    expect(await listenOnSafePort(server)).toBe(51234);
    expect(calls).toEqual({ listen: 3, close: 2 });
  });

  it("gives up loudly after 20 blocked ports", async () => {
    const { server } = stubServer(Array(25).fill(2049));
    await expect(listenOnSafePort(server)).rejects.toThrow(/no unblocked ephemeral port after 20 tries/);
  });

  it("works on a real server, on a host", async () => {
    const server = createServer();
    const port = await listenOnSafePort(server, "127.0.0.1");
    expect(port).toBeGreaterThan(0);
    expect(BLOCKED_PORTS.has(port)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
