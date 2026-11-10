// Test-only helper (docs/DECISIONS.md D20): DB tests run against Postgres in Compose, in a separate
// `rote_test` database (created on demand, never the dev `rote` database), with ONE SCHEMA PER TEST
// FILE so parallel vitest files never see each other's rows. All queue SQL is unqualified, so it
// runs in whichever schema the pool's search_path points at.
//
// No Postgres -> a loud, explanatory failure, never a skip: from Step 5 on, `npm test` requires
// `docker compose up -d postgres`. (`npm run test:unit` runs everything except *.db.test.ts.)
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createPool, quoteIdent, redactDatabaseUrl, sqlState, type Pool } from "./db.js";

export const DEFAULT_TEST_DATABASE_URL = "postgres://rote:rote_dev_only@127.0.0.1:55432/rote_test";

export function testDatabaseUrl(): string {
  return process.env.ROTE_TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
}

export class PostgresUnreachableError extends Error {
  constructor(url: string, cause: unknown) {
    const parsed = safeUrl(url);
    const where = parsed ? `${parsed.hostname}:${parsed.port || "5432"}` : redactDatabaseUrl(url);
    super(
      `Postgres not reachable at ${where} (${redactDatabaseUrl(url)}): run "docker compose up -d postgres". ` +
        `From fleet Step 5 on, npm test needs it; npm run test:unit runs the tests that don't. ` +
        `Cause: ${(cause as Error)?.message ?? String(cause)}`,
    );
    this.name = "PostgresUnreachableError";
  }
}

function safeUrl(url: string): URL | undefined {
  try {
    return new URL(url);
  } catch {
    return undefined;
  }
}

/** Connects once with a short timeout; throws PostgresUnreachableError (password redacted) on failure. */
export async function assertReachable(url: string, timeoutMs = 5000): Promise<void> {
  const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: timeoutMs });
  try {
    await client.connect();
    await client.query("SELECT 1");
  } catch (err) {
    throw new PostgresUnreachableError(url, err);
  } finally {
    await client.end().catch(() => undefined);
  }
}

/**
 * CREATE DATABASE <test db> if it doesn't exist. Several test files race to do this: a loser sees
 * 42P04 duplicate_database, or 23505 unique_violation on pg_database's name index when the two
 * CREATEs overlap; both mean "it exists now".
 */
export async function ensureTestDatabase(url = testDatabaseUrl()): Promise<void> {
  const target = new URL(url);
  const dbName = decodeURIComponent(target.pathname.replace(/^\//, ""));
  const maintenance = new URL(url);
  maintenance.pathname = "/postgres";
  await assertReachable(maintenance.toString());

  const client = new pg.Client({ connectionString: maintenance.toString(), connectionTimeoutMillis: 5000 });
  await client.connect();
  try {
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (exists.rowCount === 0) {
      try {
        await client.query(`CREATE DATABASE ${quoteIdent(dbName)}`);
      } catch (err) {
        const code = sqlState(err);
        if (code !== "42P04" && code !== "23505") throw err;
      }
    }
  } finally {
    await client.end();
  }
}

export interface TestSchema {
  /** Pool whose sessions use search_path = this schema. */
  pool: Pool;
  schema: string;
  /** DROP SCHEMA … CASCADE and end the pool (afterAll). */
  drop(): Promise<void>;
}

/**
 * A fresh schema `t_<tag>_<random>` in the test database and a pool pointed at it. `setup` runs
 * once on that pool (the migration runner, from commit 3 on).
 */
export async function createTestSchema(
  tag: string,
  options: { max?: number; setup?: (pool: Pool) => Promise<void> } = {},
): Promise<TestSchema> {
  const url = testDatabaseUrl();
  await ensureTestDatabase(url);
  const schema = `t_${tag.replace(/[^a-z0-9_]/gi, "_").toLowerCase()}_${randomBytes(4).toString("hex")}`;

  const admin = createPool({ connectionString: url, max: 1 });
  try {
    await admin.query(`CREATE SCHEMA ${quoteIdent(schema)}`);
  } finally {
    await admin.end();
  }

  const pool = createPool({ connectionString: url, max: options.max ?? 24, searchPath: schema });
  try {
    await options.setup?.(pool);
  } catch (err) {
    await pool.end().catch(() => undefined);
    throw err;
  }
  return {
    pool,
    schema,
    async drop() {
      await pool.query(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`);
      await pool.end();
    },
  };
}
