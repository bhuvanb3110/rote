# Crash-point matrix at production timing: lease 30 s, heartbeat 10 s

`npm run crash-matrix -- --lease-seconds 30 --heartbeat-seconds 10 --expect step-10 --reconcile-margin-seconds 5
--drain-timeout 180s --out evidence/crash-matrix/step-10-production-30-10`. It ran 2026-11-18, 23:04–23:23 UTC,
on a clean `255f92f`, the Step 10b code with D55 and D57–D60. The worker children run from the source tree and
each scenario's schema is built by the real migration runner, so the run used that commit's code and all eight
migrations. `matrix.md` and `check.txt` are the script's own output, not edited.

**RESULT: PASS, 23/23**, 1 ledger row in every scenario, with the production lease and heartbeat (the 5 s / 2 s
runs exist only to be fast).

- **The 11 points before the intent** (`after-dequeue` … `after-step-10`): the kill's lease runs out after 30 s.
  The next recovery requeues the job at once (T6.1, no attempt used, D57), and attempt 2 succeeds.
- **`before-submit`** (the intent written, then the kill, before the click): the job is claimed to verify (T6.4)
  and reads `[0, 0]`, so it is resubmitted and attempt 2 succeeds. The reconcile pass reads 1 row
  (`reconcile:reconciled[1]`).
- **After the click** (`after-submit`, `after-step-12`, `before-complete`): verified `[1]`, ending `succeeded` /
  `already_done` on attempt 1. `after-complete` had already succeeded before the kill.
- **The 7 two-fault scenarios** kill the verifier or the recoverer too. Each dead verifier is re-claimed (T6.5)
  and decided. The 3 `before-submit` variants resubmit and reconcile `[1]`, the `after-submit` variants end
  `already_done`, and `recover-in-transaction` rolls back and is requeued by another recoverer. Each death
  counts against the job's crash budget (D58), well below its cap of 5.

**An earlier attempt was stopped, not kept.** A 30/10 run started on 2026-11-18 before D58 was built. It ran its
workers from the working tree while D58 was being written, so one run would have mixed two versions of the code.
It was stopped after 8 scenarios, with no orphan processes left and port 4100 free, and its partial output was
moved out of the repo. This run, on a clean commit, replaces it.
