// Test-only harness for the worker integration tests (not re-exported): an in-process mock bank on an
// ephemeral port, the committed transfer artifacts and overrides copied to a temp dir with only the
// port relaxed (as invoke.test.ts does), a test-only approval of exactly those copies in a temp
// statusDir (D24), one shared Chromium, fake per-tenant credentials, and a Postgres schema.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser } from "playwright";
import app from "../../mock-app/app.js";
import { deserializeCapability, type Capability } from "../artifact/index.js";
import { approvalKeyWithOverrides, approveCapability } from "../confidence/index.js";
import { enqueue, TERMINAL_STATES, type JobRow, type Pool } from "../queue/index.js";
import { createTestSchema, resetQueueTables, type TestSchema } from "../queue/testDb.js";
import { createRedactor, loadTenantCredentials } from "./credentials.js";
import { Worker, type WorkerOptions } from "./loop.js";
import { runJob, type RunJobContext } from "./runJob.js";
import { createRecoverySweep } from "./recover.js";
import { runVerifyPhase, type VerifyContext } from "./verify.js";
import { listenOnSafePort } from "../testing/listen.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "../..");

export const TENANT_PREFIX: Record<string, string> = { "tenant-a": "", "tenant-b": "/tenant-b", "tenant-c": "/tenant-c" };

/** Fake, distinctive values so a test can grep every stored row and response for them. */
export const FAKE_ENV = {
  ROTE_CRED_TENANT_A_USERNAME: "fleet-op-a-x91",
  ROTE_CRED_TENANT_A_PASSWORD: "pw-a-Zq83-fake",
  ROTE_CRED_TENANT_B_USERNAME: "fleet-op-b-x92",
  ROTE_CRED_TENANT_B_PASSWORD: "pw-b-Zq84-fake",
  ROTE_CRED_TENANT_C_USERNAME: "fleet-op-c-x93",
  ROTE_CRED_TENANT_C_PASSWORD: "pw-c-Zq85-fake",
};
export const CREDENTIAL_VALUES = Object.values(FAKE_ENV);

export interface LedgerRow {
  id: string;
  tenantId: string;
  fromMemberId: string;
  toMemberId: string;
  amount: number;
  memo: string;
}

export interface WorkerTestEnv {
  db: TestSchema;
  pool: Pool;
  baseUrl: string;
  browser: Browser;
  workDir: string;
  transfer: Capability;
  ctx: RunJobContext;
  credentials: ReturnType<typeof loadTenantCredentials>;
  control(route: string): Promise<void>;
  ledger(): Promise<LedgerRow[]>;
  newWorker(overrides?: Partial<WorkerOptions> & { ctx?: Partial<RunJobContext>; verifyCtx?: Partial<VerifyContext> }): Worker;
  enqueueTransfers(n: number, fields?: Record<string, string>, tenants?: string[]): Promise<JobRow[]>;
  jobs(): Promise<JobRow[]>;
  waitForTerminal(ids: string[], timeoutMs: number): Promise<JobRow[]>;
  reset(): Promise<void>;
  close(): Promise<void>;
}

async function relaxedCopy(id: string, dir: string): Promise<Capability> {
  const raw = JSON.parse(await readFile(path.join(repo, "artifacts", `${id}.json`), "utf8"));
  raw.target.entryUrlPattern = "^http://localhost:\\d+/";
  await writeFile(path.join(dir, `${id}.json`), JSON.stringify(raw, null, 2));
  return deserializeCapability(JSON.stringify(raw));
}

export async function createWorkerTestEnv(tag: string): Promise<WorkerTestEnv> {
  const db = await createTestSchema(tag);
  const pool = db.pool;
  const server: Server = createServer(app);
  await listenOnSafePort(server); // never a port Chromium/fetch refuse (D31)
  const baseUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ headless: true });

  const workDir = await mkdtemp(path.join(tmpdir(), `rote-${tag}-`));
  const artifactsDir = path.join(workDir, "artifacts");
  const overridesDir = path.join(workDir, "overrides");
  const statusDir = path.join(workDir, "status");
  const evidenceBaseDir = path.join(workDir, "evidence");
  await Promise.all([artifactsDir, overridesDir, statusDir, evidenceBaseDir].map((d) => mkdir(d)));

  const transfer = await relaxedCopy("transfer", artifactsDir);
  // The verify's read-only lookup (Step 9), relaxed and approved the same way.
  const lookup = await relaxedCopy("transfer-history-lookup", artifactsDir);
  for (const id of ["transfer", "transfer-history-lookup"]) {
    for (const tenant of Object.keys(TENANT_PREFIX)) {
      const override = JSON.parse(await readFile(path.join(repo, "overrides", `${id}.${tenant}.json`), "utf8"));
      override.entryUrl = `${baseUrl}${TENANT_PREFIX[tenant]}/`;
      await writeFile(path.join(overridesDir, `${id}.${tenant}.json`), JSON.stringify(override));
    }
  }
  // Approves the relaxed copies AND the relaxed per-tenant overrides the jobs run with (D30).
  for (const capability of [transfer, lookup]) {
    await approveCapability(capability.id, {
      ...(await approvalKeyWithOverrides(capability, overridesDir)),
      statusDir,
      reason: "test-only approval of the relaxed copy",
    });
  }

  const credentials = loadTenantCredentials(FAKE_ENV, Object.keys(TENANT_PREFIX), ["password", "username"]);
  const redact = createRedactor(credentials);
  const ctx: RunJobContext = { credentials, evidenceBaseDir, artifactsDir, overridesDir, statusDir };

  const control = async (route: string) => {
    const res = await fetch(`${baseUrl}/control/${route}`, { redirect: "manual" });
    if (res.status !== 200) throw new Error(`/control/${route} -> HTTP ${res.status}`);
  };
  const ledger = async () => ((await (await fetch(`${baseUrl}/control/ledger`)).json()) as { entries: LedgerRow[] }).entries;
  const jobs = async () => (await pool.query<JobRow>("SELECT * FROM jobs ORDER BY created_at, id")).rows;
  let seq = 0;

  return {
    db,
    pool,
    baseUrl,
    browser,
    workDir,
    transfer,
    ctx,
    credentials,
    control,
    ledger,
    jobs,
    newWorker(overrides = {}) {
      const { ctx: ctxOverrides, verifyCtx, ...rest } = overrides;
      const runCtx = { ...ctx, ...ctxOverrides };
      const workerId = rest.workerId ?? `test-worker-${++seq}`;
      const leaseSeconds = rest.leaseSeconds ?? 300;
      const workerPool = rest.pool ?? pool;
      return new Worker({
        pool,
        workerId,
        leaseSeconds,
        getBrowser: async () => browser,
        runJob: (job, options) => runJob(runCtx, job, options),
        redact,
        shutdownGraceMs: 30_000,
        // Like the entrypoint: verify a job that may have committed (Step 9), with a short settle by
        // default so tests do not wait 5 s for every 0-match lookup.
        verify: (claim, controller, hardSignal) =>
          runVerifyPhase(
            {
              pool: workerPool,
              workerId,
              leaseSeconds,
              heartbeatSeconds: rest.heartbeatSeconds,
              settleMs: 300,
              getBrowser: async () => browser,
              credentials,
              evidenceBaseDir,
              artifactsDir,
              overridesDir,
              statusDir: runCtx.statusDir,
              redact,
              fault: runCtx.fault,
              ...verifyCtx,
            },
            claim,
            controller,
            hardSignal,
          ),
        // Like the entrypoint: recover expired leases before every dequeue (T6).
        beforeDequeue: createRecoverySweep({ pool: workerPool, workerId, leaseSeconds }),
        ...rest,
      });
    },
    async enqueueTransfers(n, fields = {}, tenants = Object.keys(TENANT_PREFIX)) {
      const out: JobRow[] = [];
      for (let i = 0; i < n; i += 1) {
        const { job } = await enqueue(pool, {
          capability: transfer,
          tenantId: tenants[i % tenants.length]!,
          idempotencyKey: `k-${Date.now()}-${i}-${Math.random()}`,
          params: { memberId: "10001", toMemberId: "10002", amount: "1.00", ...fields },
        });
        out.push(job);
      }
      return out;
    },
    async waitForTerminal(ids, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const rows = (await pool.query<JobRow>("SELECT * FROM jobs WHERE id = ANY($1::uuid[])", [ids])).rows;
        if (rows.length === ids.length && rows.every((r) => (TERMINAL_STATES as readonly string[]).includes(r.state))) return rows;
        if (Date.now() > deadline) {
          throw new Error(`jobs not terminal after ${timeoutMs} ms: ${rows.map((r) => `${r.id}=${r.state}`).join(", ")}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
    async reset() {
      await resetQueueTables(pool);
      await control("errors/off");
      await control("latency/0");
      await control("transient/off");
      await control("history-lag/0");
      await control("ledger/reset");
    },
    async close() {
      await browser.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await db.drop();
      await rm(workDir, { recursive: true, force: true });
    },
  };
}

/** Every stored row (jobs + attempts) as JSON, for "no credential value anywhere" checks. */
export async function dumpQueue(pool: Pool): Promise<string> {
  const jobs = (await pool.query("SELECT * FROM jobs")).rows;
  const attempts = (await pool.query("SELECT * FROM job_attempts")).rows;
  return JSON.stringify({ jobs, attempts });
}
