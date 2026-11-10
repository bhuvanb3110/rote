// Forward-only SQL migrations (docs/DECISIONS.md D17): numbered .sql files in db/migrations/, never
// edited once applied, each applied in its own transaction together with its schema_migrations row.
//
// - Concurrency: a session advisory lock keyed on the current schema serializes runners (several
//   containers starting at once, or two test files), while files in different schemas never wait
//   on each other.
// - Checksums ignore line endings (CRLF -> LF before SHA-256), so a Windows checkout and a Linux CI
//   checkout agree; .gitattributes also pins *.sql to LF.
// - An applied file that was edited, or that disappeared, fails the run loudly.
// - Files must not contain their own BEGIN/COMMIT: the runner owns the transaction.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { Pool } from "./db.js";

/** cwd-relative, like status/ and artifacts/ (run from the repo root, or the container's /app). */
export const DEFAULT_MIGRATIONS_DIR = path.join("db", "migrations");

const FILE_PATTERN = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface Migration {
  /** File name without ".sql", e.g. "0001_init". Stored in schema_migrations.version. */
  version: string;
  sql: string;
  checksum: string;
}

export interface MigrateResult {
  applied: string[];
  alreadyApplied: string[];
}

export class MigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationError";
  }
}

export function checksumSql(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n"), "utf8").digest("hex");
}

export async function loadMigrations(dir: string = DEFAULT_MIGRATIONS_DIR): Promise<Migration[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const seen = new Map<string, string>();
  const migrations: Migration[] = [];
  for (const file of files) {
    const match = FILE_PATTERN.exec(file);
    if (!match) {
      throw new MigrationError(`Migration file name "${file}" must look like 0001_snake_case.sql`);
    }
    const number = match[1]!;
    if (seen.has(number)) {
      throw new MigrationError(`Two migrations share number ${number}: ${seen.get(number)} and ${file}`);
    }
    seen.set(number, file);
    const sql = await readFile(path.join(dir, file), "utf8");
    migrations.push({ version: file.replace(/\.sql$/, ""), sql, checksum: checksumSql(sql) });
  }
  return migrations;
}

/** Applies every pending migration in `dir` to the pool's current schema. */
export async function migrate(pool: Pool, options: { dir?: string } = {}): Promise<MigrateResult> {
  const migrations = await loadMigrations(options.dir ?? DEFAULT_MIGRATIONS_DIR);
  const client = await pool.connect();
  let broken: Error | undefined;
  try {
    await client.query("SELECT pg_advisory_lock(hashtext(current_schema() || ':migrations'))");
    try {
      await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version    text PRIMARY KEY,
          checksum   text NOT NULL,
          applied_at timestamptz NOT NULL DEFAULT now()
        )`);
      const { rows } = await client.query<{ version: string; checksum: string }>(
        "SELECT version, checksum FROM schema_migrations ORDER BY version",
      );
      const byVersion = new Map(migrations.map((m) => [m.version, m]));
      for (const row of rows) {
        const file = byVersion.get(row.version);
        if (!file) {
          throw new MigrationError(`Applied migration ${row.version} is missing from the migrations directory`);
        }
        if (file.checksum !== row.checksum) {
          throw new MigrationError(
            `Migration ${row.version} was edited after it was applied (checksum ${row.checksum.slice(0, 12)}… ` +
              `applied, ${file.checksum.slice(0, 12)}… on disk). Applied migrations are never edited; add a new one.`,
          );
        }
      }

      const appliedVersions = new Set(rows.map((r) => r.version));
      const result: MigrateResult = { applied: [], alreadyApplied: [...appliedVersions] };
      for (const migration of migrations) {
        if (appliedVersions.has(migration.version)) continue;
        await client.query("BEGIN");
        try {
          await client.query(migration.sql);
          await client.query("INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)", [
            migration.version,
            migration.checksum,
          ]);
          await client.query("COMMIT");
        } catch (err) {
          await client.query("ROLLBACK").catch((rollbackErr: Error) => {
            broken = rollbackErr;
          });
          throw new MigrationError(`Migration ${migration.version} failed and was rolled back: ${(err as Error).message}`);
        }
        result.applied.push(migration.version);
      }
      return result;
    } finally {
      if (!broken) {
        await client.query("SELECT pg_advisory_unlock(hashtext(current_schema() || ':migrations'))").catch((err: Error) => {
          broken = err;
        });
      }
    }
  } finally {
    // A destroyed connection also drops its session advisory lock.
    client.release(broken);
  }
}
