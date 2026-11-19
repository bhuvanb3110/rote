# Crash-point matrix, Step 9: 23/23 green against the Step 9 expectations

```
npm run crash-matrix -- --lease-seconds 5 --heartbeat-seconds 2 --expect step-09 --drain-timeout 90s --out evidence/crash-matrix/step-09
```

Run on the builder's Windows machine on 2026-11-14 (UTC), 394 s wall. The code was the Step 9 verify commit
(`7337661`) plus the matrix's two-fault scenarios and `step-09` expectations (`src/chaos/crashExpected.ts`,
`scripts/lib/harness.ts`), committed with this folder. Postgres came from Compose, the bank ran in-process on
:4100, and each worker was a child process (`node --import tsx src/worker/main.ts`). Lease 5 s / heartbeat
2 s (D40), with the verify settle period at its default of 5 s (`ROTE_VERIFY_SETTLE_MS`).

**Result (`matrix.md`, `check.txt`): RESULT: PASS, 23/23.** A scenario passes only if every fault fired
where it should (both faults in a two-fault scenario), the oracle says `ok`, **and** the job ended as
Step 9 expects. Exactly 1 ledger row in every scenario. No scenario ends `needs_human`.

## The 16 transfer points

| Points | Expected (Step 9) | Observed |
| --- | --- | --- |
| `after-dequeue`, `after-step-01` … `after-step-10` (11) | requeued (T6.1), attempt 2 `succeeded`, 1 row | all 11: `succeeded`, attempt 2, 1 row, no verify phase |
| `before-submit` (intent committed, no click) | T6.4 claims it to verify, `[0, 0]`, resubmitted, attempt 2 `succeeded`, 1 row | `succeeded` / `success`, attempt 2, 1 row; phase `resubmitted [0,0]` |
| `after-submit`, `after-step-12`, `before-complete` (3) | T6.4 verify, `[1]`, `succeeded` / `already_done`, attempt 1, 1 row | all 3: `succeeded` / `already_done`, attempt 1, 1 row; phase `already_done [1]` |
| `after-complete` | `succeeded` before the kill, 1 row | `succeeded`, attempt 1, 1 row |

## The 7 recovery-internal scenarios (two faults: X, then the recovering worker dies at Y)

| Scenario (X > Y) | Expected | Verify phases observed | Final |
| --- | --- | --- | --- |
| `after-submit > verify-after-login` | re-verify (T6.5), `[1]`, `already_done` | `crashed`, `already_done [1]` | `succeeded` / `already_done`, attempt 1, 1 row |
| `after-submit > verify-after-count` | same | `crashed`, `already_done [1]` | same |
| `after-submit > verify-before-result` | same | `crashed`, `already_done [1]` | same |
| `before-submit > verify-after-count` | re-verify (T6.5), `[0, 0]`, requeued, attempt 2 | `crashed`, `resubmitted [0,0]` | `succeeded` / `success`, attempt 2, 1 row |
| `before-submit > verify-before-requeue` | same | `crashed`, `resubmitted [0,0]` | same |
| `before-submit > verify-after-requeue` | T7 (queued) already committed; dequeued normally, attempt 2 | `resubmitted [0,0]` (the dead verifier's own phase) | same |
| `after-dequeue > recover-in-transaction` | the T6 rollback releases the lock; another recoverer requeues (T6.1) | none | `succeeded` / `success`, attempt 2, 1 row |

How each one played out, from the per-scenario `verifications.json` and `attempts.json`:
- **A verifier killed mid-phase** (`verify-after-login`, `verify-after-count`, `verify-before-result`,
  `verify-before-requeue`): its phase row is closed `crashed` by the next worker's T6.5 ("lease expired in
  verifying; recovered by clean-… (T6.5 verify)"), and that worker's phase decides. The token goes up by 1
  per phase (2 → 3).
- **`verify-after-requeue`**: the dead verifier's T7 had committed (`resubmitted [0,0]`), so nothing was
  left to recover. The clean worker dequeued attempt 2 like any queued job.
- **`recover-in-transaction`**: the recovering worker died inside T6 after its writes and before
  `COMMIT`. The rollback left no trace: attempt 1 was closed `crashed` by the *clean* worker's T6.1
  ("recovered by clean-…"), not by the worker that died, and attempt 2 succeeded.

## Before / after

| Run | Green | After-intent points |
| --- | --- | --- |
| `../before-day2/` (Step 7) | 1/16 | LOST (left `running` forever; 1 row from `after-submit` on) |
| `../step-08/` (Step 8) | 16/16 against Step 8's interim | `needs_human` / `commit_uncertain` (T6.3), 0 or 1 row |
| **this run (Step 9)** | **23/23** | **verified**: `[0, 0]` → resubmitted (attempt 2), or `[1]` → `already_done` (attempt 1); 1 row |

**Fault worker "exit 1":** on Windows, `process.kill(pid, "SIGKILL")` is `TerminateProcess`, which Node
reports as exit code 1. The log line `ROTE_FAULT firing at <point>` in `worker-fault.log` (and in
`worker-fault-2.log` for the second fault) proves where each worker died. On Linux CI the same matrix shows
`signal SIGKILL`; the CI job switches to `--expect step-09` with this commit and stays report-only until
Step 10.

Files: `matrix.md`, `check.txt` (every scenario's oracle report), `stdout.txt` (the console), and one folder
per scenario (`X__Y` for two faults) with `worker-fault.log`, `worker-fault-2.log`, `worker-clean.log`,
`job.json`, `attempts.json`, `verifications.json`, `ledger.json`, `oracle.json`, `check.txt`, and
`worker-evidence/` screenshots. No credential value appears in any log, JSON, text or Markdown file (a scan
for the three fake passwords found 0 hits).
