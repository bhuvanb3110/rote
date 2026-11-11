// Two projects (docs/DECISIONS.md D31). "unit-db": every test file that does not launch Chromium,
// fully parallel (vitest's default worker count). "browser": the files in vitest.browser-files.ts,
// at most BROWSER_TEST_WORKERS at a time, run as a second group (vitest requires a distinct
// sequence.groupOrder for projects with different maxWorkers). Parallel Chromium instances on one
// host caused net::ERR_INSUFFICIENT_RESOURCES (evidence/step-06/flakes.md); unit and DB tests never
// launch a browser, so they keep full parallelism.
import { defineConfig } from "vitest/config";
import { BROWSER_TEST_FILES, BROWSER_TEST_WORKERS } from "./vitest.browser-files.js";

const browserWorkers = Number(process.env.ROTE_BROWSER_TEST_WORKERS ?? BROWSER_TEST_WORKERS);
if (!Number.isInteger(browserWorkers) || browserWorkers < 1) {
  throw new Error(`ROTE_BROWSER_TEST_WORKERS must be a positive integer, got ${process.env.ROTE_BROWSER_TEST_WORKERS}`);
}

// `npm run test:unit` (or ROTE_SKIP_DB_TESTS=1) drops every *.db.test.ts. This must live here, not
// on the command line: with projects, a CLI `--exclude` does not reach a project's own exclude list,
// so `vitest run --exclude "**/*.db.test.ts"` silently kept the DB files (found by CI in Step 7).
const skipDb = process.env.npm_lifecycle_event === "test:unit" || process.env.ROTE_SKIP_DB_TESTS === "1";
const dbExclude = skipDb ? ["**/*.db.test.ts"] : [];

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit-db",
          include: ["**/*.test.ts"],
          exclude: ["**/node_modules/**", "dist/**", ...BROWSER_TEST_FILES, ...dbExclude],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: BROWSER_TEST_FILES,
          exclude: dbExclude,
          maxWorkers: browserWorkers,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
