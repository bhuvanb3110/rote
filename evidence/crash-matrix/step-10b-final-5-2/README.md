# Crash-point matrix, 5 s / 2 s, on the Step 10b code

`npm run crash-matrix -- --lease-seconds 5 --heartbeat-seconds 2 --expect step-10 --reconcile-margin-seconds 5
--drain-timeout 120s --out evidence/crash-matrix/step-10b-final-5-2`. It ran 2026-11-18, 18:25–18:31 UTC, on a
clean `b3892d4`: D55, D57 (two budgets), D58 (one crash budget) and D59 (reconciler deaths counted apart). The
worker children run from the source tree and each scenario's schema is built by the real migration runner, so
the run used that commit's code and all eight migrations. `matrix.md` and `check.txt` are the script's own
output, not edited.

**RESULT: PASS, 23/23**, 1 ledger row in every scenario.

- The 11 points before the intent: a crash before the intent is requeued at once (T6.1) and uses no attempt
  (D57). `Attempt` 2 is the second lease, and the job's own attempts used are 1.
- `before-submit` and its three two-fault variants: verified `[0, 0]`, then resubmitted. Attempt 2 succeeded
  and the reconcile pass read 1 row (`reconcile:reconciled[1]`). The variants kill the verifier too (`crashed`),
  a death that D58 now counts, well under the cap of 5.
- `after-submit`, `after-step-12`, `before-complete` and the `after-submit` variants: verified `[1]`, ending
  `succeeded` / `already_done` on attempt 1.
- The same 23 scenarios passed at Step 10a ([`../step-10a/`](../step-10a/)). These are the same expectations
  (`--expect step-10`) on the code that changed how deaths are counted.
