// Postgres access for the fleet queue (docs/DECISIONS.md D16: `pg`, an explicit Pool, one
// checked-out client per transaction). Every multi-statement transaction goes through
// withTransaction so BEGIN/COMMIT/ROLLBACK live in exactly one place.
import pg from "pg";

/** The dev database in docker-compose.yml. 127.0.0.1, not localhost: the port is bound to IPv4. */
export const DEFAULT_DATABASE_URL = "postgres://rote:rote_dev_only@127.0.0.1:55432/rote";

export function databaseUrlFromEnv(): string {
  return process.env.ROTE_DATABASE_URL ?? DEFAULT_DATABASE_URL;
}

/** For logs and error messages: the password never appears. */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "(unparseable database URL)";
  }
}

/**
 * int8 (bigint: fencing_token, identity ids, count(*)) arrives from `pg` as a string. Parse it to a
 * number, and refuse rather than silently round anything above 2^53 - 1: a rounded fencing token
 * could compare equal to a different token.
 */
export function parseInt8(value: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`int8 value ${value} is outside Number.MAX_SAFE_INTEGER; refusing to round it`);
  }
  return n;
}

function typeOverrides(): pg.TypeOverrides {
  const overrides = new pg.TypeOverrides();
  overrides.setTypeParser(pg.types.builtins.INT8, parseInt8);
  return overrides;
}

export interface CreatePoolOptions {
  connectionString?: string;
  /** Pool size. Default 10. */
  max?: number;
  /** Fail a connect after this long instead of hanging. Default 5000 ms. */
  connectionTimeoutMillis?: number;
  /** Session search_path (tests point each file's pool at its own schema). */
  searchPath?: string;
  /** Errors on IDLE pooled clients (e.g. Postgres restarted). Without a listener `pg` would crash the process. */
  onIdleError?: (err: Error) => void;
}

export type Pool = pg.Pool;
export type PoolClient = pg.PoolClient;
export type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

export function createPool(options: CreatePoolOptions = {}): pg.Pool {
  const pool = new pg.Pool({
    connectionString: options.connectionString ?? databaseUrlFromEnv(),
    max: options.max ?? 10,
    connectionTimeoutMillis: options.connectionTimeoutMillis ?? 5000,
    types: typeOverrides(),
    ...(options.searchPath ? { options: `-c search_path=${quoteIdent(options.searchPath)}` } : {}),
  });
  pool.on("error", options.onIdleError ?? (() => undefined));
  return pool;
}

/** Quote an SQL identifier (schema names built at runtime by the tests). */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Runs `fn` inside BEGIN … COMMIT on one checked-out client. Any throw rolls back and rethrows the
 * original error. If even the ROLLBACK fails (the connection is gone), the client is destroyed
 * instead of being returned to the pool in an unknown state.
 */
export async function withTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch (rollbackErr) {
      broken = rollbackErr as Error;
    }
    throw err;
  } finally {
    client.release(broken);
  }
}

/** Postgres SQLSTATE of a driver error, if any. */
export function sqlState(err: unknown): string | undefined {
  return typeof err === "object" && err !== null && "code" in err && typeof err.code === "string"
    ? err.code
    : undefined;
}
