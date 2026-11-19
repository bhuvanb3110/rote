// Guards `npm run test:unit` (and CI's Node 25 job): with vitest projects, a CLI `--exclude` does not
// reach a project's own exclude list, so the old `vitest run --exclude "**/*.db.test.ts"` silently ran
// the DB files anyway (CI's unit-node25 job failed on them, Step 7). vitest.config.ts now drops them
// itself when npm_lifecycle_event is "test:unit" or ROTE_SKIP_DB_TESTS=1. This lists the files vitest
// would run in each mode, in a child process, and checks.
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");

async function listedFiles(extraEnv: Record<string, string>): Promise<string[]> {
  // Start from this process's env minus the flags under test and the VITEST* variables vitest sets
  // for its own workers (a child vitest that inherits them misbehaves).
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(VITEST|ROTE_SKIP_DB_TESTS$|npm_lifecycle_event$)/i.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, extraEnv);
  const { stdout } = await run(process.execPath, [VITEST, "list", "--filesOnly"], {
    cwd: ROOT,
    env,
    maxBuffer: 16 * 1024 * 1024,
  });
  return stdout.split(/\r?\n/).filter((line) => line.includes(".test.ts"));
}

const isDb = (line: string) => /\.db\.test\.ts/.test(line);

describe("test:unit leaves out the *.db.test.ts files", () => {
  it("plain run lists DB files; npm_lifecycle_event=test:unit and ROTE_SKIP_DB_TESTS=1 list none", async () => {
    const [all, viaNpm, viaEnv] = await Promise.all([
      listedFiles({}),
      listedFiles({ npm_lifecycle_event: "test:unit" }),
      listedFiles({ ROTE_SKIP_DB_TESTS: "1" }),
    ]);
    expect(all.filter(isDb).length).toBeGreaterThan(5);
    for (const listing of [viaNpm, viaEnv]) {
      expect(listing.filter(isDb)).toEqual([]);
      expect(listing.length).toBe(all.length - all.filter(isDb).length);
    }
  }, 120_000);
});
