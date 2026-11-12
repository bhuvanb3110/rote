// The test files that launch Chromium (directly, through WebSurface.launch, through runReplay /
// invokeCapability against the mock bank, or through the worker test env). vitest.config.ts runs
// them in the "browser" project with a low maxWorkers (docs/DECISIONS.md D31); every other test file
// stays in the fully parallel "unit-db" project. src/testing/browserProject.test.ts fails if a test
// file that launches a browser is missing from this list, or a listed file no longer exists.
export const BROWSER_TEST_FILES = [
  "mock-app/transfer.browser.test.ts",
  "src/catalog/catalog.test.ts",
  "src/catalog/invoke.test.ts",
  "src/replay/confidenceGate.test.ts",
  "src/replay/fleet.test.ts",
  "src/replay/replay.test.ts",
  "src/replay/transfer.test.ts",
  "src/surface/locate.test.ts",
  "src/tenant/multiTenant.test.ts",
  "src/worker/faults.db.test.ts",
  "src/worker/lease.db.test.ts",
  "src/worker/worker.db.test.ts",
];

/**
 * Max concurrent browser test files, chosen by measurement (D31,
 * evidence/step-07/flake-cap/). ROTE_BROWSER_TEST_WORKERS overrides it for measuring.
 */
export const BROWSER_TEST_WORKERS = 3;
