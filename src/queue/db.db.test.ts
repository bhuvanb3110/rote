// Against the real Postgres in Compose (docker compose up -d postgres). If it is down, beforeAll
// throws PostgresUnreachableError and every test here FAILS -- by design, never skipped.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "./db.js";
import { createTestSchema, type TestSchema } from "./testDb.js";

let a: TestSchema;
let b: TestSchema;

beforeAll(async () => {
  a = await createTestSchema("db_a");
  b = await createTestSchema("db_b");
});

afterAll(async () => {
  await a?.drop();
  await b?.drop();
});

describe("Postgres connectivity and transactions", () => {
  it("connects to the test database (not the dev one) as PostgreSQL 17", async () => {
    const { rows } = await a.pool.query("SELECT current_database() AS db, current_setting('server_version_num')::int AS v");
    expect(rows[0].db).toBe("rote_test");
    expect(rows[0].v).toBeGreaterThanOrEqual(170000);
    expect(rows[0].v).toBeLessThan(180000);
  });

  it("int8 comes back as a number", async () => {
    const { rows } = await a.pool.query("SELECT 9007199254740991::int8 AS big, count(*) AS n FROM generate_series(1, 3)");
    expect(rows[0]).toEqual({ big: Number.MAX_SAFE_INTEGER, n: 3 });
  });

  it("an int8 above 2^53 - 1 is refused, not rounded", async () => {
    await expect(a.pool.query("SELECT 9007199254740993::int8 AS big")).rejects.toThrow(/MAX_SAFE_INTEGER/);
  });

  it("each pool is confined to its own schema", async () => {
    await a.pool.query("CREATE TABLE only_in_a (x int)");
    const inA = await a.pool.query("SELECT to_regclass('only_in_a') IS NOT NULL AS present");
    const inB = await b.pool.query("SELECT to_regclass('only_in_a') IS NOT NULL AS present");
    expect(inA.rows[0].present).toBe(true);
    expect(inB.rows[0].present).toBe(false);
  });

  it("withTransaction commits on success and rolls back on a throw, rethrowing the original error", async () => {
    await a.pool.query("CREATE TABLE tx_probe (x int)");
    await withTransaction(a.pool, (c) => c.query("INSERT INTO tx_probe VALUES (1)"));
    const boom = new Error("boom");
    await expect(
      withTransaction(a.pool, async (c) => {
        await c.query("INSERT INTO tx_probe VALUES (2)");
        throw boom;
      }),
    ).rejects.toBe(boom);
    const { rows } = await a.pool.query("SELECT array_agg(x ORDER BY x) AS xs FROM tx_probe");
    expect(rows[0].xs).toEqual([1]);
    // The pool is still healthy after the rollback.
    expect((await a.pool.query("SELECT 1 AS one")).rows[0].one).toBe(1);
  });
});
