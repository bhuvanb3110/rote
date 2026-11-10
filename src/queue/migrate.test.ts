// Unit tests for the migration runner's file handling (no Postgres needed).
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MigrationError, checksumSql, loadMigrations } from "./migrate.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "rote-migrations-unit-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("migration files", () => {
  it("checksums ignore CRLF vs LF, but not any other change", () => {
    const lf = "CREATE TABLE a (x int);\nCREATE TABLE b (y int);\n";
    const crlf = lf.replace(/\n/g, "\r\n");
    expect(checksumSql(crlf)).toBe(checksumSql(lf));
    expect(checksumSql(lf.replace("int", "bigint"))).not.toBe(checksumSql(lf));
    expect(checksumSql(lf)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("loads files in numeric order and names them by file name", async () => {
    await writeFile(path.join(dir, "0002_second.sql"), "SELECT 2;");
    await writeFile(path.join(dir, "0001_first.sql"), "SELECT 1;");
    await writeFile(path.join(dir, "README.md"), "not a migration");
    const loaded = await loadMigrations(dir);
    expect(loaded.map((m) => m.version)).toEqual(["0001_first", "0002_second"]);
  });

  it("rejects a badly named file and a duplicate number", async () => {
    await writeFile(path.join(dir, "1_bad.sql"), "SELECT 1;");
    await expect(loadMigrations(dir)).rejects.toThrow(MigrationError);
    await rm(path.join(dir, "1_bad.sql"));
    await writeFile(path.join(dir, "0001_a.sql"), "SELECT 1;");
    await writeFile(path.join(dir, "0001_b.sql"), "SELECT 1;");
    await expect(loadMigrations(dir)).rejects.toThrow(/share number 0001/);
  });

  it("the committed 0001_init.sql is LF on disk (.gitattributes) and loads", async () => {
    const [init] = await loadMigrations();
    expect(init!.version).toBe("0001_init");
    expect(init!.sql.includes("\r\n")).toBe(false);
  });
});
