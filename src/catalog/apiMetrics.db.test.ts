// The API's /metrics and its DB gauges (step-13.md section 5; reviewer decision 2, 2026-11-19): the gauges are
// read on every scrape from a SMALL, DEDICATED pool with a short statement_timeout, so a slow metrics query never
// delays or fails a real API request. The reviewer's example, done here: a gauge query held up by a lock while
// API requests run, and each request still answers within its usual time. Uses the committed artifacts/ and
// status/ (transfer is approved), like asyncApi.db.test.ts.
import { createServer, type Server } from "node:http";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
import { createTestSchema, resetQueueTables, testDatabaseUrl, type TestSchema } from "../queue/testDb.js";
import type { Pool } from "../queue/index.js";
import { listenOnSafePort } from "../testing/listen.js";
import { GAUGE_STATEMENT_TIMEOUT_MS, OtelTelemetry } from "../telemetry/index.js";
import { createApiGaugePool, createCatalogApp, registerApiGauges } from "./http.js";

const PARAMS = { memberId: "10001", toMemberId: "10002", amount: "1.00" };

let db: TestSchema;
let gaugePool: Pool;
let telemetry: OtelTelemetry;
let server: Server;
let base: string;

beforeAll(async () => {
  db = await createTestSchema("api_metrics");
  const url = new URL(testDatabaseUrl());
  url.searchParams.set("options", `-c search_path=${db.schema}`);
  gaugePool = createApiGaugePool(url.toString());
  telemetry = new OtelTelemetry({ serviceName: "rote-api", traces: null, metrics: true });
  registerApiGauges(telemetry, gaugePool);
  server = createServer(createCatalogApp({ queue: { pool: db.pool }, metrics: { telemetry } }));
  base = `http://127.0.0.1:${await listenOnSafePort(server, "127.0.0.1")}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await telemetry?.shutdown(1000);
  await gaugePool?.end();
  await db?.drop();
});
beforeEach(async () => {
  await resetQueueTables(db.pool);
});

async function enqueue(tenant: string, key: string): Promise<{ status: number; jobId: string }> {
  const res = await fetch(`${base}/capabilities/transfer/invoke?mode=async`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify({ tenant, params: PARAMS }),
  });
  const json = (await res.json()) as { jobId: string };
  return { status: res.status, jobId: json.jobId };
}

async function scrape(): Promise<string> {
  const res = await fetch(`${base}/metrics`);
  expect(res.status).toBe(200);
  return res.text();
}

describe("GET /metrics on the API", () => {
  it("the three DB gauges: queue depth per tenant (0 included), breaker state, the crash budget in use", async () => {
    const a1 = await enqueue("tenant-a", "m-1");
    await enqueue("tenant-a", "m-2");
    await enqueue("tenant-b", "m-3");
    await db.pool.query("UPDATE jobs SET crashes = 2 WHERE id = $1", [a1.jobId]);
    await db.pool.query("INSERT INTO breakers (capability_id, state, opened_at) VALUES ('transfer', 'open', now()), ('transfer-history-lookup', 'half_open', NULL)");
    const text = await scrape();
    expect(text).toMatch(/^rote_queue_depth\{tenant="tenant-a"\} 2$/m);
    expect(text).toMatch(/^rote_queue_depth\{tenant="tenant-b"\} 1$/m);
    expect(text).toMatch(/^rote_queue_depth\{tenant="tenant-c"\} 0$/m);
    expect(text).toMatch(/^rote_breaker_state\{capability="transfer"\} 2$/m);
    expect(text).toMatch(/^rote_breaker_state\{capability="transfer-history-lookup"\} 1$/m);
    expect(text).toMatch(/^rote_jobs_crashes_sum 2$/m);
    // Draining a tenant reads 0 at the next scrape, not its last value.
    await db.pool.query("UPDATE jobs SET state = 'failed', outcome = 'test' WHERE tenant_id = 'tenant-b'");
    expect(await scrape()).toMatch(/^rote_queue_depth\{tenant="tenant-b"\} 0$/m);
  });

  it("a gauge query held by a lock: the scrape waits ~the statement timeout and keeps the stale value; every API request answers within its usual time", async () => {
    const { jobId } = await enqueue("tenant-a", "lock-1");
    await db.pool.query("INSERT INTO breakers (capability_id, state, opened_at) VALUES ('transfer', 'open', now())");
    expect(await scrape()).toMatch(/^rote_breaker_state\{capability="transfer"\} 2$/m);

    const requests = [
      () => fetch(`${base}/healthz`),
      () => fetch(`${base}/jobs/${jobId}?tenant=tenant-a`),
      () => fetch(`${base}/capabilities/transfer/invoke?mode=async`, { method: "POST", headers: { "content-type": "application/json", "Idempotency-Key": `lock-${Math.random()}` }, body: JSON.stringify({ tenant: "tenant-a", params: PARAMS }) }),
    ];
    const timeAll = async () => {
      const ms: number[] = [];
      for (const r of requests) {
        const t0 = performance.now();
        const res = await r();
        await res.text();
        expect(res.status).toBeLessThan(300);
        ms.push(performance.now() - t0);
      }
      return ms;
    };
    // The usual time: the slowest of three warm rounds without the lock.
    let baseline = 0;
    for (let i = 0; i < 3; i += 1) baseline = Math.max(baseline, ...(await timeAll()));

    // A transaction holds an ACCESS EXCLUSIVE lock on `breakers`: the breaker_state query blocks, nothing else does.
    const locker: pg.PoolClient = await db.pool.connect();
    try {
      await locker.query("BEGIN");
      await locker.query("LOCK TABLE breakers IN ACCESS EXCLUSIVE MODE");
      const scrapeStarted = performance.now();
      const scraping = scrape().then((text) => ({ text, ms: performance.now() - scrapeStarted }));
      await new Promise((resolve) => setTimeout(resolve, 100)); // the scrape is now waiting on the lock
      const during = await timeAll();
      const scraped = await scraping;
      for (const ms of during) expect(ms, `a request during the blocked scrape (baseline ${baseline.toFixed(0)} ms)`).toBeLessThan(baseline + 250);
      // The scrape gave up on breakers at the statement timeout, kept the last value, and counted it.
      expect(scraped.ms).toBeGreaterThanOrEqual(GAUGE_STATEMENT_TIMEOUT_MS - 50);
      expect(scraped.ms).toBeLessThan(GAUGE_STATEMENT_TIMEOUT_MS + 3000);
      expect(scraped.text).toMatch(/^rote_breaker_state\{capability="transfer"\} 2$/m);
      expect(scraped.text).toMatch(/^rote_telemetry_errors_total\{kind="gauge_query"\} 1$/m);
      // The other gauges still updated in that scrape: two more jobs were enqueued during it.
      expect(scraped.text).toMatch(/^rote_queue_depth\{tenant="tenant-a"\} [3-9]$/m);
    } finally {
      await locker.query("ROLLBACK").catch(() => undefined);
      locker.release();
    }
    // The lock is gone: the gauges read fresh again.
    await db.pool.query("UPDATE breakers SET state = 'closed', opened_at = NULL");
    expect(await scrape()).toMatch(/^rote_breaker_state\{capability="transfer"\} 0$/m);
  }, 30_000);

  it("without the metrics option the app has no /metrics (every existing caller is unchanged)", async () => {
    const plain = createServer(createCatalogApp({ queue: { pool: db.pool } }));
    const port = await listenOnSafePort(plain, "127.0.0.1");
    try {
      expect((await fetch(`http://127.0.0.1:${port}/metrics`)).status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => plain.close(() => resolve()));
    }
  });
});
