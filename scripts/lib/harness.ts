// In-process harness pieces shared by scripts/crash-matrix.ts and scripts/verify-scenarios.ts: the mock
// bank on :4100 in this process (so its knobs and ledger are the harness's), a fresh Postgres test
// schema per scenario, and real worker CHILD PROCESSES (`node --import tsx src/worker/main.ts`) pointed
// at that schema -- a fault worker SIGKILLs itself for real (D34), and every worker runs the same code
// path as in Docker.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { createServer, type Server } from "node:http";
import app from "../../mock-app/app.js";
import { testDatabaseUrl, type TestSchema } from "../../src/queue/testDb.js";
import { FAKE_CREDS } from "./compose.js";

export const BANK_PORT = 4100;
export const BANK = `http://127.0.0.1:${BANK_PORT}`;
export const TERMINAL = new Set(["succeeded", "business_outcome", "failed", "needs_human"]);

export interface Child {
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  pid: number | undefined;
  stop(): void;
  kill(): void;
}

/** A worker child process; stdout + stderr go to `logFile`. */
export function startWorker(env: Record<string, string>, logFile: string): Child {
  const out = createWriteStream(logFile);
  const child = spawn(process.execPath, ["--import", "tsx", "src/worker/main.ts"], {
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.pipe(out, { end: false });
  child.stderr.pipe(out, { end: false });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.on("exit", (code, signal) => {
      // Let the pipes drain into the log before closing it.
      setTimeout(() => {
        out.end();
        resolve({ code, signal });
      }, 200);
    }),
  );
  return { exited, pid: child.pid, stop: () => child.kill("SIGTERM"), kill: () => child.kill("SIGKILL") };
}

export function within<T>(p: Promise<T>, ms: number): Promise<T | "timeout"> {
  return Promise.race([p, new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), ms))]);
}

/** The mock bank (this process's module state: its knobs and ledger) on :4100. */
export async function listenBank(): Promise<Server> {
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) =>
      reject(err.code === "EADDRINUSE" ? new Error(`port ${BANK_PORT} is in use: stop the Compose bank (docker compose stop bank) first`) : err),
    );
    server.listen(BANK_PORT, () => resolve());
  });
  return server;
}

export async function closeBank(bank: Server): Promise<void> {
  await new Promise<void>((resolve) => bank.close(() => resolve()));
  bank.closeAllConnections?.();
}

export async function control(route: string): Promise<void> {
  const res = await fetch(`${BANK}/control/${route}`);
  if (res.status !== 200) throw new Error(`/control/${route} -> HTTP ${res.status}`);
}

/** The environment of a worker child on this schema (fake credentials, the given lease timing). */
export function workerEnv(db: TestSchema, extra: Record<string, string>): Record<string, string> {
  const url = new URL(testDatabaseUrl());
  url.searchParams.set("options", `-c search_path=${db.schema}`);
  return { ...FAKE_CREDS, ROTE_DATABASE_URL: url.toString(), ROTE_SHUTDOWN_GRACE_MS: "10000", ...extra };
}

/** "signal SIGKILL" on Linux; Windows' process.kill(SIGKILL) is TerminateProcess (exit code 1). */
export function describeExit(end: { code: number | null; signal: NodeJS.Signals | null } | "timeout", timeoutMs: number): string {
  if (end === "timeout") return `still alive after ${timeoutMs} ms (killed)`;
  return end.signal ? `signal ${end.signal}` : `exit ${end.code}`;
}
