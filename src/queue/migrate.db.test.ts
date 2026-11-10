// The migration runner against real Postgres: applies once, idempotent rerun, edited file fails,
// CRLF and LF checkouts agree, concurrent runners apply once, a failing file rolls back whole.
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPool, type Pool } from "./db.js";
import { DEFAULT_MIGRATIONS_DIR, MigrationError, migrate } from "./migrate.js";
import { createTestSchema, testDatabaseUrl, type TestSchema } from "./testDb.js";

let db: TestSchema;
let dir: string;
const extraPools: Pool[] = [];

beforeEach(async () => {
  db = await createTestSchema("migrate", { migrate: false });
  dir = await mkdtemp(path.join(tmpdir(), "rote-migrations-"));
  await cp(DEFAULT_MIGRATIONS_DIR, dir, { recursive: true });
});

afterEach(async () => {
  await Promise.all(extraPools.splice(0).map((p) => p.end()));
  await db.drop();
  await rm(dir, { recursive: true, force: true });
});

async function tables(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ t: string }>(
    "SELECT table_name AS t FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY 1",
  );
  return rows.map((r) => r.t);
}

describe("migrate()", () => {
  it("applies 0001_init once into an empty schema", async () => {
    const result = await migrate(db.pool, { dir });
    expect(result).toEqual({ applied: ["0001_init"], alreadyApplied: [] });
    expect(await tables(db.pool)).toEqual(["breakers", "job_attempts", "jobs", "schema_migrations", "tenants"]);
    const { rows } = await db.pool.query("SELECT version, length(checksum) AS len FROM schema_migrations");
    expect(rows).toEqual([{ version: "0001_init", len: 64 }]);
    const seeded = await db.pool.query("SELECT id, max_concurrent FROM tenants ORDER BY id");
    expect(seeded.rows).toEqual([
      { id: "tenant-a", max_concurrent: 2 },
      { id: "tenant-b", max_concurrent: 2 },
      { id: "tenant-c", max_concurrent: 2 },
    ]);
  });

  it("a rerun applies nothing", async () => {
    await migrate(db.pool, { dir });
    expect(await migrate(db.pool, { dir })).toEqual({ applied: [], alreadyApplied: ["0001_init"] });
    expect((await db.pool.query("SELECT count(*) AS n FROM schema_migrations")).rows[0].n).toBe(1);
  });

  it("an applied file that was edited fails loudly, naming it", async () => {
    await migrate(db.pool, { dir });
    const file = path.join(dir, "0001_init.sql");
    await writeFile(file, (await readFile(file, "utf8")) + "\n-- an innocent-looking edit\n");
    await expect(migrate(db.pool, { dir })).rejects.toThrow(/Migration 0001_init was edited after it was applied/);
  });

  it("a CRLF checkout of an applied file is NOT an edit (same checksum)", async () => {
    await migrate(db.pool, { dir });
    const file = path.join(dir, "0001_init.sql");
    await writeFile(file, (await readFile(file, "utf8")).replace(/\n/g, "\r\n"));
    expect(await migrate(db.pool, { dir })).toEqual({ applied: [], alreadyApplied: ["0001_init"] });
  });

  it("an applied migration missing from the directory fails loudly", async () => {
    await migrate(db.pool, { dir });
    await rm(path.join(dir, "0001_init.sql"));
    await expect(migrate(db.pool, { dir })).rejects.toThrow(/0001_init is missing/);
  });

  it("two concurrent runners on separate connections apply it exactly once", async () => {
    const other = createPool({ connectionString: testDatabaseUrl(), max: 2, searchPath: db.schema });
    extraPools.push(other);
    const [r1, r2] = await Promise.all([migrate(db.pool, { dir }), migrate(other, { dir })]);
    expect([r1.applied, r2.applied].flat()).toEqual(["0001_init"]);
    expect([r1.alreadyApplied, r2.alreadyApplied].flat()).toEqual(["0001_init"]);
    expect((await db.pool.query("SELECT count(*) AS n FROM schema_migrations")).rows[0].n).toBe(1);
  });

  it("a failing migration rolls back whole: no partial tables, no schema_migrations row, earlier ones kept", async () => {
    await writeFile(path.join(dir, "0002_broken.sql"), "CREATE TABLE half_done (x int);\nSELECT 1 / 0;\n");
    await expect(migrate(db.pool, { dir })).rejects.toThrow(MigrationError);
    await expect(migrate(db.pool, { dir })).rejects.toThrow(/0002_broken failed and was rolled back: division by zero/);
    expect(await tables(db.pool)).not.toContain("half_done");
    const { rows } = await db.pool.query("SELECT version FROM schema_migrations ORDER BY 1");
    expect(rows).toEqual([{ version: "0001_init" }]);
    // The runner released its advisory lock: a fixed file applies on the next run.
    await writeFile(path.join(dir, "0002_broken.sql"), "CREATE TABLE half_done (x int);\n");
    expect((await migrate(db.pool, { dir })).applied).toEqual(["0002_broken"]);
  });
});
