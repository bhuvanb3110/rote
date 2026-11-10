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

## Every full `npm test` run in Step 6

| # | When | Log | Result |
| --- | --- | --- | --- |
| 1 | baseline, before any code | `npm-test-baseline.txt` | 29 files, 271/271 |
| 2 | Part A, first try | **overwritten (not kept)** | RED: 50 failed in 5 files: existing browser tests replaying port-relaxed artifact copies against the committed approvals, refused by the new digest check (expected; the tests were then fixed) |
| 3 | Part A, second try | **overwritten (not kept)** | RED: catalog.test.ts `beforeAll` failed (my bug: `statusDir` pointed at the artifacts temp dir); 3 tests not run |
| 4 | Part A, commit | `npm-test-part-a.txt` | 30 files, 285/285 |
| 5 | worker commit 1 | `npm-test-commit-worker-1.txt` | 31 files, 297/297 |
| 6 | worker commit 2 | `npm-test-commit-worker-2.txt` | 33 files, 319/319 |
| 7 | worker commit 3 | `npm-test-commit-worker-3-run1-FAILED.txt` | **FLAKE**: 15 failed in fleet.test.ts, `ERR_INSUFFICIENT_RESOURCES` (above) |
| 8 | worker commit 3, rerun | `npm-test-commit-worker-3-run2.txt` | 36 files, 338/338 |
| 9 | API commit | `npm-test-commit-api.txt` | 37 files, 350/350 |
| 10 | Docker commit | `npm-test-commit-docker.txt` | 37 files, 350/350 |
| 11-12 | Day-1 exit commit (run twice; the second after a script edit) | `npm-test-commit-day1.txt` (second run; the first was overwritten, it was also 350/350) | 37 files, 350/350 |
| 13-15 | final x3 | `npm-test-final-x3-run1..3.txt` | 37 files, 350/350 each |

Runs 2 and 3 were written to `npm-test-part-a.txt` and overwritten by the next run; that broke the
rule "keep full, unfiltered logs of every full test run". Their results above are from the output I
read at the time. From run 4 on, every log is kept (run 11's log was overwritten by run 12, both
green). Flakes: 1 in 15 runs (run 7).
