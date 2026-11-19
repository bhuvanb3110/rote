// Three projects (docs/DECISIONS.md D31, D48), in two groups that run one after the other:
//   group 0  "unit-db": every test file that does not launch Chromium, fully parallel (vitest's default
//            worker count).
//   group 1  "browser" (BROWSER_TEST_FILES) and "slow" (SLOW_TEST_FILES: the integration files that
//            mostly wait on leases, a deliberately slow bank or worker child processes), sharing ONE pool
//            of at most BROWSER_TEST_WORKERS files at a time (vitest gives a group one maxWorkers), in one
//            longest-first queue across both projects (vitest.sequencer.ts; vitest's default would run
//            the slow files after every browser file). Parallel Chromium instances on one host caused
//            net::ERR_INSUFFICIENT_RESOURCES (evidence/step-06/flakes.md). Running the slow files in
//            group 0 instead, to overlap their waiting with the unit/DB CPU work, was measured and
//            rejected (D48, evidence/step-10/slow-project/): no wall-time gain, and one of three runs
//            failed under load.
// All three run in `npm test` and in CI; nothing is skipped (step-10 reviewer decision 6). `npm run
// test:fast` runs unit-db and browser only, for a quick local loop (never before a commit).
import { defineConfig } from "vitest/config";
import { BROWSER_TEST_FILES, BROWSER_TEST_WORKERS, SLOW_TEST_FILES } from "./vitest.browser-files.js";
import { GroupDurationSequencer } from "./vitest.sequencer.js";

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
    // The slow project is all *.db.test.ts files, so `npm run test:unit` leaves it empty.
    passWithNoTests: true,
    sequence: { sequencer: GroupDurationSequencer },
    projects: [
      {
        extends: true,
        test: {
          name: "unit-db",
          include: ["**/*.test.ts"],
          exclude: ["**/node_modules/**", "dist/**", ...BROWSER_TEST_FILES, ...SLOW_TEST_FILES, ...dbExclude],
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
      {
        extends: true,
        test: {
          name: "slow",
          include: SLOW_TEST_FILES,
          exclude: dbExclude,
          maxWorkers: browserWorkers,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
