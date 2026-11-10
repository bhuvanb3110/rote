# Day-1 exit, attempt 1: the checker crashed (not counted)

`run-output.txt` / `check.txt` are the unedited output of the first run (2026-11-10T05:02Z).

- The fleet part completed and every ledger check that ran passed: 100 x 201, 100 idempotent replays
  (200, same id), all 100 jobs `succeeded` on attempt 1, 100 ledger rows, 0 duplicates, 0 lost,
  0 orphans, confirmationRef = row id, 4 workers x 25 attempts, max 2 active per tenant over 515
  samples.
- Then the script itself crashed in `dockerJson` (`SyntaxError: Unexpected end of JSON input`):
  `docker inspect` prints a multi-line JSON array and the helper parsed line by line. The container
  checks, the credential grep, docker stats, the evidence files and the graceful-stop check never ran,
  so the run ended `RESULT: FAIL (the run did not complete)`.
- Fix: `dockerJson` parses the whole output first, then falls back to JSON lines. No fleet code and no
  fleet setting changed. The whole run was then repeated from scratch (tables truncated, ledger
  reset): see `../check.txt`.
