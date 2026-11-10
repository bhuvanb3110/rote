# Step 6 test flakes (recorded, not hidden)

## 1. `net::ERR_INSUFFICIENT_RESOURCES` in `src/replay/fleet.test.ts` (commit 3, run 1)

- Log: `npm-test-commit-worker-3-run1-FAILED.txt` (full, unfiltered). 15 tests failed, all in
  `src/replay/fleet.test.ts` (a file this step did not change in that commit), plus 4 unhandled
  errors: two Playwright-internal `Assertion error` in `_CRSession._onMessage`, one
  `browser.newContext: Target page, context or browser has been closed`, and
  `[vitest-pool]: Worker forks emitted error … Worker exited unexpectedly`.
- First failure: `page.goto: net::ERR_INSUFFICIENT_RESOURCES at http://localhost:56914/`: Chromium
  could not allocate a resource for a navigation.
- The immediate rerun (`npm-test-commit-worker-3-run2.txt`) passed: 36 files, 338/338.
- Context: this commit added two more browser test files (`worker.db.test.ts`,
  `faults.db.test.ts`), each with its own Chromium running several transfer jobs, so vitest's
  parallel files now run more Chromium instances at once on the Windows host. Cause not proven; the
  working theory is host resource pressure (memory or handles) from parallel browsers, the same family
  as the Step-3 screenshot flake (D8), but a different symptom that the screenshot retry does not cover.
- Not mitigated in this step (no test-concurrency change made silently). Tracked across the remaining
  full runs below; open question for the reviewer.

## Later full runs in Step 6

See the handoff report; every full run's log is in this folder.
