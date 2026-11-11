# Step 7 test flakes and environment failures (recorded, not hidden)

## 1. `net::ERR_UNSAFE_PORT` (A2 commit, run 1)

- Log: `npm-test-commit-a2-run1-FAILED-unsafe-port.txt` (full, unfiltered). 25 tests failed, all in
  `src/replay/fleet.test.ts`, first error `page.goto: net::ERR_UNSAFE_PORT at http://localhost:2049/`.
- Cause, proven by the message: `server.listen(0)` got ephemeral port **2049** (NFS) for the file's
  in-process mock bank, and Chromium refuses to load ports on its restricted list. Node's `fetch`
  refuses the same "bad ports" (Fetch standard). Latent in every test that listened on port 0 and was
  reached by Chromium or `fetch`; not caused by the concurrency cap, which was in the run only by
  coincidence (it changes which file starts when, not which ports the OS hands out).
- Fix (same commit): `src/testing/listen.ts` `listenOnSafePort()` closes and re-listens while the port
  is on the union of Chromium's restricted list and the Fetch bad-port list; every such test server
  uses it (12 call sites). Unit-tested with a stub server that is handed 2049 first.

## 2. "Vitest failed to find the runner" (baseline, first attempt)

- Log: `npm-test-baseline-gitbash-runner-error.txt`. Every file failed before running a test.
- Cause: the run was started from Git Bash, which gives vitest a lower-case `c:/` working directory on
  Windows, so vitest's runner module is loaded under two different paths. Environment, not a test.
  Every later run is started from PowerShell (`scripts/npm-test-log.ps1`).

## Every full `npm test` run in Step 7

See `README.md` in this folder; every log is kept.
