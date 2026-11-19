// Enqueue against real Postgres: idempotency under concurrency, the forced interleaving that
// motivates ON CONFLICT DO UPDATE (and the DO NOTHING idiom failing it), per-tenant keys, request
// conflicts, and credentials never reaching the table.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deserializeCapability, type Capability } from "../artifact/index.js";
import { sqlState, type Pool, type PoolClient } from "./db.js";
import {
  CredentialsInParamsError,
  ENQUEUE_SQL,
  IdempotencyKeyConflict,
  InvalidParamsError,
  ReservedParamError,
  computeRequestHash,
  enqueue,
  newTraceId,
} from "./enqueue.js";
import { createTestSchema, resetQueueTables, type TestSchema } from "./testDb.js";

let db: TestSchema;
let pool: Pool;
let transfer: Capability;
let lookup: Capability;

const PARAMS = { memberId: "10001", toMemberId: "10002", amount: "12.34" };

beforeAll(async () => {
  db = await createTestSchema("enqueue", { max: 24 });
  pool = db.pool;
  transfer = deserializeCapability(await readFile("artifacts/transfer.json", "utf8"));
  lookup = deserializeCapability(await readFile("artifacts/transfer-history-lookup.json", "utf8"));
});
afterAll(async () => {
  await db?.drop();
});
beforeEach(async () => {
  await resetQueueTables(pool);
});

const count = async (sql = "SELECT count(*) AS n FROM jobs", args: unknown[] = []) =>
  (await pool.query(sql, args)).rows[0].n as number;

/** Waits until backend `pid` is blocked on a lock (pg_stat_activity), or fails after 5 s. */
async function waitUntilBlockedOnLock(pid: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query("SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1", [pid]);
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`backend ${pid} never blocked on a lock`);
}

async function backendPid(client: PoolClient): Promise<number> {
  return (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
}

describe("enqueue", () => {
  it("creates a queued job: attempt 0, token 0, a trace id, memo_key, the request hash", async () => {
    const { job, created } = await enqueue(pool, {
      capability: transfer,
      tenantId: "tenant-a",
      idempotencyKey: "k1",
      params: PARAMS,
    });
    expect(created).toBe(true);
    expect(job).toMatchObject({
      tenant_id: "tenant-a",
      capability_id: "transfer",
      idempotency_key: "k1",
      params: PARAMS,
      state: "queued",
      attempt: 0,
      max_attempts: 3,
      fencing_token: 0,
      lease_owner: null,
      lease_expires_at: null,
    });
    expect(job.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(job.memo_key).toBe(`rote-${job.id}`);
    expect(job.request_hash).toBe(computeRequestHash("tenant-a", "transfer", PARAMS));
  });

  it("the same key and request again returns the same job, created = false", async () => {
    const first = await enqueue(pool, { capability: transfer, tenantId: "tenant-a", idempotencyKey: "k1", params: PARAMS });
    const again = await enqueue(pool, {
      capability: transfer,
      tenantId: "tenant-a",
      idempotencyKey: "k1",
      params: { amount: "12.34", toMemberId: "10002", memberId: "10001" }, // key order is irrelevant
    });
    expect(again.created).toBe(false);
    expect(again.job.id).toBe(first.job.id);
    expect(await count()).toBe(1);
  });

  it("concurrent same key: 20 clients x 25 rounds -> one job per round, all 20 get its id, exactly one created", async () => {
    const clients = await Promise.all(Array.from({ length: 20 }, () => pool.connect()));
    try {
      for (let round = 0; round < 25; round += 1) {
        const key = `race-${round}-${randomUUID()}`;
        const results = await Promise.all(
          clients.map((c) => enqueue(c, { capability: transfer, tenantId: "tenant-b", idempotencyKey: key, params: PARAMS })),
        );
        expect(new Set(results.map((r) => r.job.id)).size).toBe(1);
        expect(results.filter((r) => r.created)).toHaveLength(1);
        expect(await count("SELECT count(*) AS n FROM jobs WHERE idempotency_key = $1", [key])).toBe(1);
      }
    } finally {
      clients.forEach((c) => c.release());
    }
    expect(await count()).toBe(25);
  }, 60_000);

  it("forced interleaving: B blocks on A's uncommitted insert, A commits, B returns A's id", async () => {
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("BEGIN");
      const fromA = await enqueue(a, { capability: transfer, tenantId: "tenant-a", idempotencyKey: "same", params: PARAMS });
      const bPid = await backendPid(b);
      const fromB = enqueue(b, { capability: transfer, tenantId: "tenant-a", idempotencyKey: "same", params: PARAMS });
      await waitUntilBlockedOnLock(bPid);
      await a.query("COMMIT");
      const resolved = await fromB;
      expect(resolved.job.id).toBe(fromA.job.id);
      expect(resolved.created).toBe(false);
      expect(fromA.created).toBe(true);
    } finally {
      a.release();
      b.release();
    }
  });

  it("why not DO NOTHING: the same interleaving against the CTE idiom returns ZERO rows to B", async () => {
    const DO_NOTHING_SQL = `
      WITH ins AS (
        INSERT INTO jobs (idempotency_key, request_hash, tenant_id, capability_id, params, trace_id)
        VALUES ($1, $2, $3, 'transfer', '{}', $4)
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        RETURNING id
      )
      SELECT id FROM ins
      UNION ALL
      SELECT id FROM jobs WHERE tenant_id = $3 AND idempotency_key = $1`;
    const hash = computeRequestHash("tenant-a", "transfer", {});
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      await a.query("BEGIN");
      const fromA = await a.query(DO_NOTHING_SQL, ["cte-key", hash, "tenant-a", newTraceId()]);
      expect(fromA.rows).toHaveLength(1);
      const bPid = await backendPid(b);
      const fromB = b.query(DO_NOTHING_SQL, ["cte-key", hash, "tenant-a", newTraceId()]);
      await waitUntilBlockedOnLock(bPid);
      await a.query("COMMIT");
      // B's SELECT reads the statement snapshot taken before A committed: the row is invisible.
      expect((await fromB).rows).toHaveLength(0);
      // ...although the row exists, and the real enqueue SQL finds it.
      expect(await count("SELECT count(*) AS n FROM jobs WHERE idempotency_key = 'cte-key'")).toBe(1);
    } finally {
      a.release();
      b.release();
    }
  });

  it("the same key with a different request -> IdempotencyKeyConflict; the stored job is unchanged", async () => {
    const { job } = await enqueue(pool, { capability: transfer, tenantId: "tenant-a", idempotencyKey: "k1", params: PARAMS });
    const err = await enqueue(pool, {
      capability: transfer,
      tenantId: "tenant-a",
      idempotencyKey: "k1",
      params: { ...PARAMS, amount: "99.00" },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IdempotencyKeyConflict);
    expect((err as IdempotencyKeyConflict).existingJobId).toBe(job.id);
    const stored = (await pool.query("SELECT params, request_hash, updated_at FROM jobs WHERE id = $1", [job.id])).rows[0];
    expect(stored.params).toEqual(PARAMS);
    expect(stored.request_hash).toBe(job.request_hash);
    expect(stored.updated_at).toEqual(job.updated_at);
    expect(await count()).toBe(1);
  });

  it("reviewer decision 3: the same key in two tenants -> two different jobs, both created, no conflict", async () => {
    const a = await enqueue(pool, { capability: transfer, tenantId: "tenant-a", idempotencyKey: "shared", params: PARAMS });
    // A different request in tenant B under A's key: no 409 (B learns nothing about A's keys).
    const b = await enqueue(pool, {
      capability: transfer,
      tenantId: "tenant-b",
      idempotencyKey: "shared",
      params: { ...PARAMS, amount: "1.00" },
    });
    expect(a.created && b.created).toBe(true);
    expect(a.job.id).not.toBe(b.job.id);
    expect(await count()).toBe(2);
  });

  it("reviewer decision 1: credentials in params -> CredentialsInParamsError, nothing stored, values never echoed", async () => {
    const err = await enqueue(pool, {
      capability: transfer,
      tenantId: "tenant-a",
      idempotencyKey: "creds",
      params: { ...PARAMS, username: "op-user-x", password: "hunter2-secret" },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CredentialsInParamsError);
    expect((err as CredentialsInParamsError).fields).toEqual(["username", "password"]);
    expect((err as Error).message).not.toMatch(/hunter2-secret|op-user-x/);
    // One secret alone is enough, also for the read-only capability.
    await expect(
      enqueue(pool, { capability: lookup, tenantId: "tenant-a", idempotencyKey: "c2", params: { memberId: "1", memo: "m", password: "p" } }),
    ).rejects.toBeInstanceOf(CredentialsInParamsError);
    expect(await count()).toBe(0);
  });

  it("request_hash covers only non-secret params (the hash input is the stored params)", async () => {
    const { job } = await enqueue(pool, { capability: transfer, tenantId: "tenant-a", idempotencyKey: "h", params: PARAMS });
    expect(job.request_hash).toBe(computeRequestHash("tenant-a", "transfer", job.params));
    expect(Object.keys(job.params).sort()).toEqual(["amount", "memberId", "toMemberId"]);
  });

  it("the memo of an irreversible capability is reserved for memo_key; a read-only capability keeps it", async () => {
    await expect(
      enqueue(pool, { capability: transfer, tenantId: "tenant-a", idempotencyKey: "m1", params: { ...PARAMS, memo: "client memo" } }),
    ).rejects.toBeInstanceOf(ReservedParamError);
    const { job } = await enqueue(pool, {
      capability: lookup,
      tenantId: "tenant-a",
      idempotencyKey: "m2",
      params: { memberId: "10001", memo: "rote-something" },
    });
    expect(job.params).toEqual({ memberId: "10001", memo: "rote-something" });
  });

  it("params are validated strictly: unknown key, missing required, wrong type -> InvalidParamsError", async () => {
    const base = { capability: transfer, tenantId: "tenant-a", idempotencyKey: "v" };
    await expect(enqueue(pool, { ...base, params: { ...PARAMS, pwd: "x" } })).rejects.toBeInstanceOf(InvalidParamsError);
    await expect(enqueue(pool, { ...base, params: { memberId: "10001", amount: "1" } })).rejects.toBeInstanceOf(InvalidParamsError);
    await expect(enqueue(pool, { ...base, params: { ...PARAMS, amount: 12.34 } })).rejects.toBeInstanceOf(InvalidParamsError);
    expect(await count()).toBe(0);
  });

  it("an unknown tenant fails at the foreign key; an over-long key at the check constraint", async () => {
    const fk = await enqueue(pool, { capability: transfer, tenantId: "tenant-z", idempotencyKey: "k", params: PARAMS }).catch(
      (e: unknown) => e,
    );
    expect(sqlState(fk)).toBe("23503");
    const long = await enqueue(pool, {
      capability: transfer,
      tenantId: "tenant-a",
      idempotencyKey: "k".repeat(256),
      params: PARAMS,
    }).catch((e: unknown) => e);
    expect(sqlState(long)).toBe("23514");
  });

  it("ENQUEUE_SQL conflicts on (tenant_id, idempotency_key), never on the key alone", () => {
    expect(ENQUEUE_SQL).toMatch(/ON CONFLICT \(tenant_id, idempotency_key\) DO UPDATE/);
  });
});
