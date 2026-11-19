# Test flakes seen during fleet Step 5

CLAUDE.md: if a test flakes, rerun to confirm and report it, never hide it. Each entry: when, what
failed, the rerun, and what is known about the cause.

## 1. 13 browser-driven tests failed once, right after `docker compose up -d postgres` (commit 1)

- **When:** the first `npm test` after `docker compose pull postgres` + `up -d` (2026-11-10 ~01:56Z),
  with the container about 20 s old.
- **What failed:** 13 of 205, all of them tests that drive Chromium against the mock bank:
  `confidenceGate.test.ts` (1), `fleet.test.ts` (2), `replay.test.ts` (a)–(d) (4),
  `transfer.test.ts` (5), `multiTenant.test.ts` (1). No pure unit test failed.
- **Rerun:** `replay.test.ts` alone → 8/8 passed; the full suite immediately after → **21 files,
  205/205 passed**.
- **Cause: not established.** The failure text was not kept: the command filtered the output down
  to the `FAIL` lines, which was a mistake; since then every full run's log is kept in full. The
  timing points at host load: image extraction and the Docker Desktop VM's first container start
  on the 8 GB laptop, while vitest runs ~20 headless Chromiums in parallel. It did not recur in any
  later run in this step (see `npm-test-x3.txt` and the commit messages).
