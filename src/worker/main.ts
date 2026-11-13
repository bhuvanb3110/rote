// Fleet worker entry point (docs/plans/step-06.md section 1). In Docker this is the image's CMD:
//   node dist/src/worker/main.js
//
// Order: Playwright version check -> bank forwarder (ROTE_BANK_FORWARD) -> wait for Postgres ->
// migrate (advisory lock, D17) -> credentials check (refuse to start if any is missing) -> launch
// Chromium -> poll loop (recovery of expired leases before every dequeue, T6; a heartbeat on every job,
// T2; the fenced commit intent before every Submit, T3) -> on SIGTERM/SIGINT a graceful stop (a second
// signal aborts) -> exit 0.
// A fatal error exits 1, loudly.
//
// Environment (defaults in brackets):
//   ROTE_DATABASE_URL        [postgres://rote:…@127.0.0.1:55432/rote]
//   ROTE_WORKER_ID           [<hostname>-<pid>-<4 hex>]  (hostname = container id in Docker)
//   ROTE_LEASE_SECONDS       [30]    the lease (D36); every dequeue, heartbeat and commit intent sets now() + this
//   ROTE_HEARTBEAT_SECONDS   [10]    heartbeat interval; refused unless heartbeat * 2 < lease
//   ROTE_VERIFY_SETTLE_MS    [5000]  verify: wait this long after a 0-match lookup before looking again.
//                                    MUST exceed the bank's history visibility delay (D47)
//   ROTE_VERIFY_DEFER_BUDGET_SECONDS  [600]  verify: give up deferring (bank unavailable) this long
//                                    after the first deferral -> needs_human / verify_unavailable (D44)
//   ROTE_VERIFY_DEFER_BACKOFF_SECONDS [5]    verify: first backoff after a deferral; doubles, capped at 60 s
//   ROTE_SHUTDOWN_GRACE_MS   [30000]
//   ROTE_EVIDENCE_DIR        [<tmpdir>/rote-worker-evidence]  never the repo's evidence/
//   ROTE_BANK_FORWARD        [unset]  e.g. bank:4100 -> forward 127.0.0.1:4100 there
//   ROTE_HEALTH_FILE         [unset]  touched after every loop iteration (Compose healthcheck)
//   ROTE_CRED_<TENANT>_<INPUT>        per-tenant credentials (credentials.ts)
//   PLAYWRIGHT_VERSION       [unset]  baked into the image; must equal the installed playwright
//   ROTE_FAULT / ROTE_FAULT_ENABLE   [unset]  TEST-ONLY crash point (fault.ts, D34); refused unless both
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { chromium, type Browser } from "playwright";
import { loadCapabilities } from "../catalog/registry.js";
import { createPool, databaseUrlFromEnv, migrate, redactDatabaseUrl, type Pool } from "../queue/index.js";
import { createBackoff, sleep } from "./backoff.js";
import { parseHostPort, startTcpForwarder, type Forwarder } from "./bankForward.js";
import { createRedactor, loadTenantCredentials, redactInputNames } from "./credentials.js";
import { isTransientDbError } from "../queue/index.js";
import { Worker } from "./loop.js";
import { createRecoverySweep } from "./recover.js";
import { checkPlaywrightVersion } from "./playwrightVersion.js";
import { createFaultInjector, parseFaultConfig } from "./fault.js";
import { DEFAULT_HEARTBEAT_SECONDS, DEFAULT_LEASE_SECONDS, validateLeaseTiming } from "./heartbeat.js";
import { runJob } from "./runJob.js";
import { InMemoryCounters } from "./metrics.js";
import { DEFAULT_VERIFY_SETTLE_MS, runVerifyPhase } from "./verify.js";
import { DEFAULT_DEFER_CONFIG, type DeferConfig } from "../fleet/stateMachine.js";

const log = pino({ base: { service: "worker" } });

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer (got "${raw}")`);
  return n;
}

async function waitForPostgres(pool: Pool, url: string, stop: AbortSignal): Promise<void> {
  const backoff = createBackoff({ baseMs: 250, capMs: 5000 });
  for (let attempt = 1; !stop.aborted; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (err) {
      if (!isTransientDbError(err)) throw err;
      log.warn({ db: redactDatabaseUrl(url), attempt, err: (err as Error).message }, "worker: waiting for Postgres");
      await sleep(backoff.next(), stop);
    }
  }
  throw new Error("stopped while waiting for Postgres");
}

async function main(): Promise<void> {
  // First: a bad fault flag refuses the start before anything is touched (D34).
  const faultPoint = parseFaultConfig(process.env);
  const fault = createFaultInjector(faultPoint);
  const playwrightVersion = checkPlaywrightVersion(process.env.PLAYWRIGHT_VERSION);
  const workerId = process.env.ROTE_WORKER_ID || `${os.hostname()}-${process.pid}-${randomBytes(2).toString("hex")}`;
  const leaseSeconds = intEnv("ROTE_LEASE_SECONDS", DEFAULT_LEASE_SECONDS);
  const heartbeatSeconds = intEnv("ROTE_HEARTBEAT_SECONDS", DEFAULT_HEARTBEAT_SECONDS);
  validateLeaseTiming(leaseSeconds, heartbeatSeconds); // refuse to start on a lease one missed beat could lose
  const shutdownGraceMs = intEnv("ROTE_SHUTDOWN_GRACE_MS", 30_000);
  const settleMs = intEnv("ROTE_VERIFY_SETTLE_MS", DEFAULT_VERIFY_SETTLE_MS);
  const backoffBase = intEnv("ROTE_VERIFY_DEFER_BACKOFF_SECONDS", DEFAULT_DEFER_CONFIG.backoffBaseSeconds);
  const defer: DeferConfig = {
    budgetSeconds: intEnv("ROTE_VERIFY_DEFER_BUDGET_SECONDS", DEFAULT_DEFER_CONFIG.budgetSeconds),
    backoffBaseSeconds: Math.max(1, backoffBase),
    backoffCapSeconds: Math.max(backoffBase, DEFAULT_DEFER_CONFIG.backoffCapSeconds),
  };
  const evidenceBaseDir = process.env.ROTE_EVIDENCE_DIR || path.join(os.tmpdir(), "rote-worker-evidence");
  const healthFile = process.env.ROTE_HEALTH_FILE;
  const dbUrl = databaseUrlFromEnv();

  let worker: Worker | null = null;
  const early = new AbortController();
  const onSignal = (signal: string) => {
    log.info({ workerId, signal }, "worker: signal received");
    if (worker) worker.stop();
    else early.abort();
  };
  process.on("SIGTERM", () => onSignal("SIGTERM"));
  process.on("SIGINT", () => onSignal("SIGINT"));

  // 1. Bank forwarder first: Chromium must find http://localhost:4100 (reviewer decision B1).
  let forwarder: Forwarder | null = null;
  if (process.env.ROTE_BANK_FORWARD) {
    const target = parseHostPort(process.env.ROTE_BANK_FORWARD);
    forwarder = await startTcpForwarder({
      listenHost: "127.0.0.1",
      listenPort: 4100,
      targetHost: target.host,
      targetPort: target.port,
      onError: (err) => log.warn({ err: err.message }, "worker: bank forwarder connection error"),
    });
    log.info({ listen: "127.0.0.1:4100", target: process.env.ROTE_BANK_FORWARD }, "worker: bank forwarder listening");
  }

  // 2. Postgres, migrations.
  const pool = createPool({
    connectionString: dbUrl,
    max: 4,
    onIdleError: (err) => log.warn({ err: err.message }, "worker: idle Postgres connection dropped"),
  });
  await waitForPostgres(pool, dbUrl, early.signal);
  await migrate(pool);

  // 3. Credentials for every tenant x every redact input of every committed capability.
  const tenants = (await pool.query<{ id: string }>("SELECT id FROM tenants ORDER BY id")).rows.map((r) => r.id);
  const capabilities = await loadCapabilities();
  const credentials = loadTenantCredentials(process.env, tenants, redactInputNames(capabilities));
  const redact = createRedactor(credentials);

  // 4. One Chromium per worker, relaunched if it dies.
  let browser: Browser | null = null;
  const getBrowser = async (): Promise<Browser> => {
    if (!browser || !browser.isConnected()) {
      if (browser) log.warn({ workerId }, "worker: Chromium disconnected; relaunching");
      browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] });
    }
    return browser;
  };
  await getBrowser();

  if (faultPoint) log.warn({ workerId, faultPoint }, "worker: FAULT INJECTION ENABLED: this worker SIGKILLs itself at the point (test-only)");
  log.info(
    { workerId, playwrightVersion, leaseSeconds, heartbeatSeconds, shutdownGraceMs, settleMs, defer, evidenceBaseDir, db: redactDatabaseUrl(dbUrl), tenants },
    "worker: ready",
  );

  // In-process counters (illegal_transitions_total, verify_decisions_total); Day 3 exports them (D41).
  const metrics = new InMemoryCounters();
  worker = new Worker({
    pool,
    workerId,
    leaseSeconds,
    heartbeatSeconds,
    shutdownGraceMs,
    getBrowser,
    redact,
    log,
    fault,
    metrics,
    runJob: (job, options) => runJob({ credentials, evidenceBaseDir, fault }, job, options),
    // Step 9: a job that may have committed is verified in the bank's history (T5/T6.4-T6.7 -> T7/T8).
    verify: (claim, controller, hardSignal) =>
      runVerifyPhase(
        { pool, workerId, leaseSeconds, heartbeatSeconds, settleMs, defer, getBrowser, credentials, evidenceBaseDir, fault, log, metrics, redact },
        claim,
        controller,
        hardSignal,
      ),
    // Seam 4: every loop iteration recovers up to 10 expired leases before it dequeues (T6, D38); a
    // claim to verify (T6.4/T6.5/T6.7) is the iteration's work.
    beforeDequeue: createRecoverySweep({ pool, workerId, leaseSeconds, log, fault }),
    onTick: healthFile
      ? () => {
          writeFile(healthFile, new Date().toISOString()).catch(() => undefined);
        }
      : undefined,
  });
  if (early.signal.aborted) worker.stop();

  try {
    await worker.run();
  } finally {
    await (browser as Browser | null)?.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
    await forwarder?.close();
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    log.fatal({ err: err instanceof Error ? { name: err.name, message: err.message, stack: err.stack } : String(err) }, "worker: fatal");
    process.exit(1);
  },
);
