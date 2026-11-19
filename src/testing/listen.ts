// Test servers listen on an ephemeral port (`listen(0)`). Chromium refuses to load some ports
// (net::ERR_UNSAFE_PORT) and Node's fetch refuses the same "bad ports" (the Fetch standard's list),
// and the OS can hand one out: on 2026-11-11 a full run got port 2049 (NFS) for the in-process mock
// bank, and 25 browser tests failed with ERR_UNSAFE_PORT
// (evidence/step-07/npm-test-commit-a2-run1-FAILED-unsafe-port.txt; D31). listenOnSafePort retries
// until the port is one both will connect to.
import type { Server } from "node:net";

/**
 * The union of Chromium's restricted ports (net/base/port_util.cc) and the Fetch standard's bad
 * ports. Over-inclusion is harmless (the server just takes another port).
 */
export const BLOCKED_PORTS: ReadonlySet<number> = new Set([
  0, 1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69, 77, 79, 87, 95, 101, 102, 103, 104, 109, 110,
  111, 113, 115, 117, 119, 123, 135, 137, 139, 143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540,
  548, 554, 556, 563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566,
  6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080,
]);

const MAX_TRIES = 20;

async function listenOnce(server: Server, host: string | undefined): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    const done = () => {
      server.off("error", reject);
      resolve();
    };
    if (host === undefined) server.listen(0, done);
    else server.listen(0, host, done);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error(`unexpected server address ${String(address)}`);
  return address.port;
}

/** listen(0) on `host` (default: all interfaces), retrying while the port is blocked. Returns the port. */
export async function listenOnSafePort(server: Server, host?: string): Promise<number> {
  for (let i = 0; i < MAX_TRIES; i += 1) {
    const port = await listenOnce(server, host);
    if (!BLOCKED_PORTS.has(port)) return port;
    await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
  }
  throw new Error(`no unblocked ephemeral port after ${MAX_TRIES} tries`);
}
