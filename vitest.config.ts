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

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "unit-db",
          include: ["**/*.test.ts"],
          exclude: ["**/node_modules/**", "dist/**", ...BROWSER_TEST_FILES],
          sequence: { groupOrder: 0 },
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: BROWSER_TEST_FILES,
          maxWorkers: browserWorkers,
          sequence: { groupOrder: 1 },
        },
      },
    ],
  },
});
