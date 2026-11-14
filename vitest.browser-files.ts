// The test files that launch Chromium (directly, through WebSurface.launch, through runReplay /
// invokeCapability against the mock bank, through the worker test env, or in worker child processes),
// split in two lists (docs/DECISIONS.md D31, D48). Both run after the unit/DB files, in ONE pool of at
// most BROWSER_TEST_WORKERS files at a time, because parallel Chromium caused
// net::ERR_INSUFFICIENT_RESOURCES (evidence/step-06/flakes.md):
//   BROWSER_TEST_FILES  the "browser" project
//   SLOW_TEST_FILES     the "slow" project: integration files that mostly WAIT (leases expiring, a
//                       deliberately slow bank, a 30 s outage, worker child processes). Still part of
//                       `npm test` and CI, never skipped; `npm run test:fast` leaves them out for a quick
//                       local loop.
// Every other test file stays in the fully parallel "unit-db" project. src/testing/browserProject.test.ts
// fails if a test file that launches a browser is in neither list, a file is in both, or a listed file no
// longer exists.
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
  "src/worker/worker.db.test.ts",
];

export const SLOW_TEST_FILES = [
  "src/worker/faults.db.test.ts",
  "src/worker/lease.db.test.ts",
  "src/worker/reconcileBank.db.test.ts",
  "src/worker/verify.db.test.ts",
];

/**
 * Max concurrent browser test files, chosen by measurement (D31,
 * evidence/step-07/flake-cap/). ROTE_BROWSER_TEST_WORKERS overrides it for measuring.
 */
export const BROWSER_TEST_WORKERS = 3;
