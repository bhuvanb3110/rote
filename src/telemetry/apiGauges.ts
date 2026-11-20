// The API's DB gauges (step-13.md section 5; reviewer decision 2, 2026-11-19): read from Postgres on every
// scrape, on a SMALL, DEDICATED pool with a short statement_timeout, so a slow metrics query can never delay or
// fail a real API request (those use the API's own pool, which this never touches).
//
//   rote_queue_depth{tenant}       queued jobs per tenant (every tenant, 0 included, so a drained queue reads 0)
//   rote_breaker_state{capability} 0 closed, 1 half-open, 2 open, from `breakers` (no rows until Day 4: no series)
//   rote_jobs_crashes_sum          sum(crashes) over non-terminal jobs: the crash budget in use
//
// Each query runs on its own; one that fails or times out keeps ITS gauge at the last value (stale) and counts
// rote_telemetry_errors_total{kind="gauge_query"}; the others still update.
import type { Pool } from "../queue/index.js";
import type { GaugeReading, Telemetry } from "./types.js";

export const GAUGE_STATEMENT_TIMEOUT_MS = 1000;
export const GAUGE_CONNECT_TIMEOUT_MS = 1000;
/** The whole read's cap per scrape (each statement is already capped by statement_timeout). */
export const GAUGE_READ_CAP_MS = 4000;

export const QUEUE_DEPTH_SQL = `
SELECT t.id AS tenant, count(j.id)::int AS n
FROM tenants t LEFT JOIN jobs j ON j.tenant_id = t.id AND j.state = 'queued'
GROUP BY t.id ORDER BY t.id`;

export const BREAKER_STATE_SQL = `SELECT capability_id AS capability, state FROM breakers ORDER BY capability_id`;

export const CRASHES_SUM_SQL = `
SELECT COALESCE(sum(crashes), 0)::int AS n FROM jobs WHERE state IN ('queued', 'running', 'committing', 'verifying')`;

const BREAKER_VALUE: Record<string, number> = { closed: 0, half_open: 1, open: 2 };

/** One read of the three gauges on `pool` (the dedicated one). Never rejects. */
export function createGaugeReader(pool: Pool, telemetry: Telemetry): () => Promise<GaugeReading[]> {
  const last: Record<"queue" | "breakers" | "crashes", GaugeReading[]> = { queue: [], breakers: [], crashes: [] };
  const read = async (key: keyof typeof last, sql: string, map: (rows: Record<string, unknown>[]) => GaugeReading[]) => {
    try {
      last[key] = map((await pool.query(sql)).rows);
    } catch {
      telemetry.count("rote_telemetry_errors_total", { kind: "gauge_query" });
    }
  };
  return async () => {
    // One after another: the dedicated pool has one connection, and a scrape is not a hot path.
    await read("queue", QUEUE_DEPTH_SQL, (rows) => rows.map((r) => ({ name: "rote_queue_depth", labels: { tenant: String(r.tenant) }, value: Number(r.n) })));
    await read("breakers", BREAKER_STATE_SQL, (rows) =>
      rows.map((r) => ({ name: "rote_breaker_state", labels: { capability: String(r.capability) }, value: BREAKER_VALUE[String(r.state)] ?? 0 })),
    );
    await read("crashes", CRASHES_SUM_SQL, (rows) => [{ name: "rote_jobs_crashes_sum", value: Number(rows[0]?.n ?? 0) }]);
    return [...last.queue, ...last.breakers, ...last.crashes];
  };
}
