// The async API (docs/plans/step-06.md section 4, reviewer decisions B4, B5, B7) over real Postgres:
// 201 / 200 / 409 / 400 / 404 / 422 / 503, GET /jobs/:id shape and tenant scoping, and no credential
// value in any response or stored row. Uses the committed artifacts/ and status/ (transfer is
// approved for its current version and content).
import { mkdtemp, rm } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "../queue/index.js";
import { createTestSchema, resetQueueTables, type TestSchema } from "../queue/testDb.js";
import { createCatalogApp, type CatalogAppOptions } from "./http.js";

const SECRET_USER = "api-test-user-q7";
const SECRET_PASS = "api-test-pass-q8";
const PARAMS = { memberId: "10001", toMemberId: "10002", amount: "1.00" };

let db: TestSchema;
let pool: Pool;
let base: string;
let server: Server;
const servers: Server[] = [];
const responses: string[] = [];

async function serve(options: CatalogAppOptions): Promise<string> {
  const s = createCatalogApp(options).listen(0);
  await new Promise<void>((resolve) => s.once("listening", () => resolve()));
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

async function call(url: string, init: { method?: string; key?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (init.key !== undefined) headers["Idempotency-Key"] = init.key;
  const res = await fetch(url, {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  responses.push(text);
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : undefined };
}

const invoke = (body: unknown, key?: string, b = base) =>
  call(`${b}/capabilities/transfer/invoke?mode=async`, { key, body });

beforeAll(async () => {
  db = await createTestSchema("async_api");
  pool = db.pool;
  base = await serve({ queue: { pool } });
  server = servers[0]!;
});
afterAll(async () => {
  for (const s of servers) await new Promise<void>((resolve) => s.close(() => resolve()));
  await db?.drop();
  // Never echoed: no response in this whole file contains a credential value.
  for (const text of responses) {
    expect(text).not.toContain(SECRET_USER);
    expect(text).not.toContain(SECRET_PASS);
  }
});
beforeEach(async () => {
  await resetQueueTables(pool);
});

describe("POST /capabilities/:id/invoke?mode=async", () => {
  it("201: a new job, with Location, memoKey and a tenant-scoped self link", async () => {
    const res = await invoke({ tenant: "tenant-a", params: PARAMS }, "key-1");
    expect(res.status).toBe(201);
    expect(res.json).toMatchObject({ state: "queued", tenant: "tenant-a", capabilityId: "transfer" });
    expect(res.json.memoKey).toBe(`rote-${res.json.jobId}`);
    expect(res.json.links.self).toBe(`/jobs/${res.json.jobId}?tenant=tenant-a`);
    expect(res.headers.get("location")).toBe(res.json.links.self);
    const { rows } = await pool.query("SELECT params FROM jobs WHERE id = $1", [res.json.jobId]);
    expect(rows[0].params).toEqual(PARAMS);
  });

  it("200: the same tenant + key + request returns the existing job; 409 on a different request", async () => {
    const first = await invoke({ tenant: "tenant-a", params: PARAMS }, "key-2");
    const again = await invoke({ tenant: "tenant-a", params: PARAMS }, "key-2");
    expect(again.status).toBe(200);
    expect(again.json.jobId).toBe(first.json.jobId);
    const conflict = await invoke({ tenant: "tenant-a", params: { ...PARAMS, amount: "2.00" } }, "key-2");
    expect(conflict.status).toBe(409);
    expect(conflict.json.jobId).toBe(first.json.jobId);
    // Keys are per tenant (D19): the same key in another tenant is a new job.
    const other = await invoke({ tenant: "tenant-b", params: PARAMS }, "key-2");
    expect(other.status).toBe(201);
    expect(other.json.jobId).not.toBe(first.json.jobId);
    expect((await pool.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n).toBe(2);
  });

  it("400: credentials in params (named, never echoed), nothing stored", async () => {
    const res = await invoke({ tenant: "tenant-a", params: { ...PARAMS, username: SECRET_USER, password: SECRET_PASS } }, "key-3");
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/must not contain credentials \(username, password are marked redact: true\)/);
    expect((await pool.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n).toBe(0);
  });

  it("400: the memo of an irreversible capability is reserved (D23, reviewer decision B7)", async () => {
    const res = await invoke({ tenant: "tenant-a", params: { ...PARAMS, memo: "client memo" } }, "key-4");
    expect(res.status).toBe(400);
    expect(res.json.error).toMatch(/must not contain memo/);
  });

  it("400: missing or oversized Idempotency-Key", async () => {
    expect((await invoke({ tenant: "tenant-a", params: PARAMS })).status).toBe(400);
    const long = await invoke({ tenant: "tenant-a", params: PARAMS }, "k".repeat(256));
    expect(long.status).toBe(400);
    expect(long.json.error).toMatch(/Idempotency-Key header is required/);
  });

  it("400: run-time approvals, an entryUrl, a missing tenant, bad params", async () => {
    for (const extra of [{ approveRisky: true }, { approveUnattended: true }, { entryUrl: "http://evil.example/" }]) {
      const res = await invoke({ tenant: "tenant-a", params: PARAMS, ...extra }, `key-x-${Object.keys(extra)[0]}`);
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(res.json.error).toMatch(/accepts only "tenant" and "params"/);
    }
    expect((await invoke({ params: PARAMS }, "key-5")).status).toBe(400);
    expect((await invoke({ tenant: "tenant-a", params: [1] }, "key-6")).status).toBe(400);
    const unknown = await invoke({ tenant: "tenant-a", params: { ...PARAMS, pwd: "x" } }, "key-7");
    expect(unknown.status).toBe(400);
    expect(unknown.json.error).toMatch(/Invalid params/);
    const missing = await invoke({ tenant: "tenant-a", params: { memberId: "10001" } }, "key-8");
    expect(missing.status).toBe(400);
    expect((await pool.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n).toBe(0);
  });

  it("404: unknown capability; unknown tenant", async () => {
    const cap = await call(`${base}/capabilities/nope/invoke?mode=async`, { key: "k", body: { tenant: "tenant-a", params: {} } });
    expect(cap.status).toBe(404);
    const tenant = await invoke({ tenant: "tenant-z", params: PARAMS }, "key-9");
    expect(tenant.status).toBe(404);
    expect(tenant.json.error).toBe(`No tenant "tenant-z".`);
  });

  it("422: a capability not approved for its current version/content is refused at enqueue", async () => {
    const emptyStatus = await mkdtemp(path.join(tmpdir(), "rote-api-status-"));
    try {
      const b = await serve({ queue: { pool, statusDir: emptyStatus } });
      const res = await invoke({ tenant: "tenant-a", params: PARAMS }, "key-10", b);
      expect(res.status).toBe(422);
      expect(res.json.error).toMatch(/draft status/);
      expect((await pool.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n).toBe(0);
    } finally {
      await rm(emptyStatus, { recursive: true, force: true });
    }
  });

  it("503 with Retry-After when Postgres is unreachable (POST, GET /jobs/:id, /healthz)", async () => {
    const deadPool = createPool({ connectionString: "postgres://rote:x@127.0.0.1:1/rote", connectionTimeoutMillis: 500 });
    try {
      const b = await serve({ queue: { pool: deadPool } });
      const res = await invoke({ tenant: "tenant-a", params: PARAMS }, "key-11", b);
      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("2");
      const get = await call(`${b}/jobs/00000000-0000-4000-8000-000000000000?tenant=tenant-a`, { method: "GET" });
      expect(get.status).toBe(503);
      expect((await call(`${b}/healthz`, { method: "GET" })).status).toBe(503);
    } finally {
      await deadPool.end().catch(() => undefined);
    }
  });

  it("mode: an unknown mode is 400; async without a queue is 501 (never run synchronously)", async () => {
    expect((await call(`${base}/capabilities/transfer/invoke?mode=later`, { key: "k", body: {} })).status).toBe(400);
    const noQueue = await serve({});
    const res = await invoke({ tenant: "tenant-a", params: PARAMS }, "key-12", noQueue);
    expect(res.status).toBe(501);
  });
});

describe("GET /jobs/:id?tenant=", () => {
  it("returns the job's public shape; another tenant, a bad id, or no ?tenant= never reveals it", async () => {
    const created = await invoke({ tenant: "tenant-b", params: PARAMS }, "key-g");
    const id = created.json.jobId;
    const res = await call(`${base}/jobs/${id}?tenant=tenant-b`, { method: "GET" });
    expect(res.status).toBe(200);
    expect(Object.keys(res.json).sort()).toEqual(
      ["attempt", "capabilityId", "createdAt", "error", "id", "maxAttempts", "memoKey", "outcome", "result", "state", "tenant", "traceId", "updatedAt"].sort(),
    );
    expect(res.json).toMatchObject({ id, tenant: "tenant-b", state: "queued", attempt: 0, maxAttempts: 3, memoKey: `rote-${id}` });
    expect(res.json.traceId).toMatch(/^[0-9a-f]{32}$/);

    const other = await call(`${base}/jobs/${id}?tenant=tenant-a`, { method: "GET" });
    const missing = await call(`${base}/jobs/00000000-0000-4000-8000-000000000000?tenant=tenant-b`, { method: "GET" });
    expect(other.status).toBe(404);
    expect(missing.status).toBe(404);
    expect(Object.keys(other.json)).toEqual(["error"]);
    expect((await call(`${base}/jobs/not-a-uuid?tenant=tenant-b`, { method: "GET" })).status).toBe(404);
    expect((await call(`${base}/jobs/${id}`, { method: "GET" })).status).toBe(400);
  });

  it("GET /healthz is 200 when Postgres answers", async () => {
    expect((await call(`${base}/healthz`, { method: "GET" })).json).toEqual({ ok: true });
    expect(server.listening).toBe(true);
  });
});
