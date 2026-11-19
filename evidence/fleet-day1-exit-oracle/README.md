# Day-1 exit, re-run on the ledger oracle (Step 7)

`scripts/evidence-day1-exit.ts` after its ledger checks moved onto the shared oracle (`src/oracle`,
D32) and its Docker helpers onto `scripts/lib/compose.ts`; run once, unchanged otherwise
(`npm run evidence:day1 -- --out evidence/fleet-day1-exit-oracle`), on an image rebuilt from the
Step 7 code. The workers are now recreated when the image changed (Step 6 used `--no-recreate`).

Result: `check.txt` ends in **RESULT: PASS**, the same as Step 6's run (`../fleet-day1-exit/`): 100
jobs, all `succeeded` on attempt 1, 100 ledger rows, oracle `ok=100` and 0 of every failing verdict,
4 workers × 25 jobs, per-tenant cap 2 held, no credential in any row, response or log, graceful stop
exit 0. 84.0 s from first enqueue to last completion (Step 6: 102.6 s). `oracle.json` is the oracle's
full report; `run-stdout.txt` is the script's console output.
