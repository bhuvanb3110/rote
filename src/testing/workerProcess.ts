// Real worker CHILD PROCESSES for tests and harnesses (moved from scripts/lib/harness.ts in Step 10,
// docs/plans/step-10.md section 6; D53): `node --import tsx src/worker/main.ts`, pointed at a Postgres
// test schema, with the mock bank on :4100 in THIS process (so its knobs and ledger are the caller's). A
// fault worker (ROTE_FAULT=<point>, ROTE_FAULT_ENABLE=1) SIGKILLs itself for real at its point (D34): a
// real signal on Linux (CI), TerminateProcess on Windows (exit code 1). Every worker runs the same code
// path as in Docker. Used by src/worker/crashSubmit.db.test.ts (npm test), scripts/crash-matrix.ts and
// scripts/verify-scenarios.ts.
//
// The bank binds :4100 because the committed transfer artifacts and tenant overrides point there; stop
// the Compose bank first (docker compose stop bank), and never run two of these at once.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import app from "../../mock-app/app.js";
import { testDatabaseUrl, type TestSchema } from "../queue/testDb.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export const BANK_PORT = 4100;
export const BANK = `http://127.0.0.1:${BANK_PORT}`;
export const TERMINAL = new Set(["succeeded", "business_outcome", "failed", "needs_human"]);

/**
 * Fake mock-bank credentials (the same defaults as .env.example). Harnesses grep their evidence for
 * exactly these values. (scripts/lib/compose.ts re-exports them for the Compose harnesses.)
 */
export const FAKE_CREDS: Record<string, string> = {
  ROTE_CRED_TENANT_A_USERNAME: process.env.ROTE_CRED_TENANT_A_USERNAME || "fleet-op-a",
  ROTE_CRED_TENANT_A_PASSWORD: process.env.ROTE_CRED_TENANT_A_PASSWORD || "fake-pass-a",
  ROTE_CRED_TENANT_B_USERNAME: process.env.ROTE_CRED_TENANT_B_USERNAME || "fleet-op-b",
  ROTE_CRED_TENANT_B_PASSWORD: process.env.ROTE_CRED_TENANT_B_PASSWORD || "fake-pass-b",
  ROTE_CRED_TENANT_C_USERNAME: process.env.ROTE_CRED_TENANT_C_USERNAME || "fleet-op-c",
  ROTE_CRED_TENANT_C_PASSWORD: process.env.ROTE_CRED_TENANT_C_PASSWORD || "fake-pass-c",
};

export interface Child {
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  pid: number | undefined;
  stop(): void;
  kill(): void;
}

/** A worker child process; stdout + stderr go to `logFile`. Runs from the repo root. */
export function startWorker(env: Record<string, string>, logFile: string): Child {
  const out = createWriteStream(logFile);
  const child = spawn(process.execPath, ["--import", "tsx", path.join("src", "worker", "main.ts")], {
    cwd: REPO,
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

/** Stops a worker gracefully (SIGTERM), and kills it if it is still alive after `graceMs`. */
export async function stopWorker(child: Child, graceMs = 30_000): Promise<void> {
  child.stop();
  if ((await within(child.exited, graceMs)) === "timeout") child.kill();
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

/** The environment of a worker child on this schema (fake credentials, plus `extra`: lease timing...). */
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

/**
 * Runs a fault worker (ROTE_FAULT=<point>, ROTE_FAULT_ENABLE=1) until it SIGKILLs itself at the point, or
 * kills it after `timeoutMs`. Returns whether it fired THERE (its log line) and how it exited.
 */
export async function runFaultWorker(
  base: Record<string, string>,
  point: string,
  logFile: string,
  timeoutMs: number,
  workerId = `fault-${point}`,
): Promise<{ fired: boolean; exit: string }> {
  const child = startWorker({ ...base, ROTE_FAULT: point, ROTE_FAULT_ENABLE: "1", ROTE_WORKER_ID: workerId }, logFile);
  const first = await within(child.exited, timeoutMs);
  if (first === "timeout") child.kill();
  const end = first === "timeout" ? await child.exited : first;
  const text = await readFile(logFile, "utf8");
  return { fired: text.includes(`ROTE_FAULT firing at ${point}`), exit: first === "timeout" ? describeExit("timeout", timeoutMs) : describeExit(end, 0) };
}
