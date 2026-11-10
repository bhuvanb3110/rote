// The in-container bank forwarder (reviewer decision B1): bytes both ways, half-close, clean close.
import { createServer, request } from "node:http";
import net from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { parseHostPort, startTcpForwarder, type Forwarder } from "./bankForward.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function echoServer(): Promise<net.Server> {
  // Echoes everything; on the client's FIN, sends "|bye" and closes its side.
  const server = net.createServer({ allowHalfOpen: true }, (socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("end", () => socket.end("|bye"));
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise((resolve) => server.close(() => resolve())));
  return server;
}

async function forwarderTo(server: net.Server): Promise<Forwarder> {
  const fwd = await startTcpForwarder({
    listenHost: "127.0.0.1",
    listenPort: 0,
    targetHost: "127.0.0.1",
    targetPort: (server.address() as net.AddressInfo).port,
  });
  cleanups.push(() => fwd.close());
  return fwd;
}

describe("startTcpForwarder", () => {
  it("carries bytes both ways (1 MiB through), honors half-close, and closes cleanly", async () => {
    const fwd = await forwarderTo(await echoServer());
    const payload = Buffer.alloc(1024 * 1024, 7);
    payload.write("hello", 0);
    const received: Buffer[] = [];
    const socket = net.connect({ port: fwd.port, host: "127.0.0.1", allowHalfOpen: true });
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    socket.on("data", (c: Buffer) => received.push(c));
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    socket.end(payload); // write everything, then FIN: the reply must still arrive
    await closed;
    const all = Buffer.concat(received);
    expect(all.length).toBe(payload.length + 4);
    expect(all.subarray(0, payload.length).equals(payload)).toBe(true);
    expect(all.subarray(payload.length).toString()).toBe("|bye");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fwd.connections).toBe(0);
  });

  it("forwards HTTP like the bank's (request and response bodies intact)", async () => {
    const http = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => res.end(`echo:${req.method}:${req.url}:${body}`));
    });
    await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
    cleanups.push(() => new Promise((resolve) => http.close(() => resolve())));
    const fwd = await forwarderTo(http as unknown as net.Server);
    const text = await new Promise<string>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port: fwd.port, method: "POST", path: "/member/10001/transfer" }, (res) => {
        let out = "";
        res.on("data", (c) => (out += c));
        res.on("end", () => resolve(out));
      });
      req.on("error", reject);
      req.end("amount=1.00");
    });
    expect(text).toBe("echo:POST:/member/10001/transfer:amount=1.00");
  });

  it("an unreachable target closes the client connection instead of hanging", async () => {
    const dead = net.createServer();
    await new Promise<void>((resolve) => dead.listen(0, "127.0.0.1", resolve));
    const deadPort = (dead.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => dead.close(() => resolve()));
    const errors: Error[] = [];
    const fwd = await startTcpForwarder({ listenHost: "127.0.0.1", listenPort: 0, targetHost: "127.0.0.1", targetPort: deadPort, onError: (e) => errors.push(e) });
    cleanups.push(() => fwd.close());
    const socket = net.connect(fwd.port, "127.0.0.1");
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.on("close", () => resolve()));
    expect(errors.some((e) => /ECONNREFUSED/.test(e.message))).toBe(true);
  });

  it("close() stops listening and drops open connections", async () => {
    const fwd = await startTcpForwarder({
      listenHost: "127.0.0.1",
      listenPort: 0,
      targetHost: "127.0.0.1",
      targetPort: ((await echoServer()).address() as net.AddressInfo).port,
    });
    const socket = net.connect(fwd.port, "127.0.0.1");
    socket.on("error", () => undefined);
    await new Promise<void>((resolve) => socket.on("connect", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fwd.connections).toBe(1);
    const closed = new Promise<void>((resolve) => socket.on("close", () => resolve()));
    await fwd.close();
    await closed;
    await expect(
      new Promise((resolve, reject) => net.connect(fwd.port, "127.0.0.1").on("connect", resolve).on("error", reject)),
    ).rejects.toMatchObject({ code: "ECONNREFUSED" });
  });

  it("parseHostPort", () => {
    expect(parseHostPort("bank:4100")).toEqual({ host: "bank", port: 4100 });
    expect(() => parseHostPort("bank")).toThrow();
    expect(() => parseHostPort("bank:99999")).toThrow();
  });
});
