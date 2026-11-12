# Crash-point matrix, Step 8: 16/16 green against the Step 8 expectations

```
npm run crash-matrix -- --lease-seconds 5 --heartbeat-seconds 2 --expect step-08 --drain-timeout 60s --out evidence/crash-matrix/step-08
```

Run on the builder's Windows machine on 2026-11-12 (UTC), code at the Step 8 recovery commit plus the
matrix's Expected column (`src/chaos/crashExpected.ts`, committed with this folder). Postgres from
Compose; the bank in-process on :4100; each worker a child process (`node --import tsx
src/worker/main.ts`). Lease 5 s / heartbeat 2 s so a point costs seconds (D40, reviewer decision 6);
Compose runs 30 / 10, which chaos exercises, and Step 10 adds a matrix run at 30 / 10.

**Result (`matrix.md`, `check.txt`): RESULT: PASS, 16/16.** A point passes only if the fault fired
there, the oracle passes, **and** the job ended as Step 8 expects:

| Points | Expected (Step 8) | Observed |
| --- | --- | --- |
| `after-dequeue`, `after-step-01` … `after-step-10` (11) | the dead worker's lease expires; the clean worker's loop requeues it (T6.1) and runs attempt 2: `succeeded`, 1 row | all 11: `succeeded`, attempt 2, 1 row |
| `before-submit` (the intent committed, no click) | `needs_human` / `commit_uncertain` (T6.3), 0 rows | `needs_human` / `commit_uncertain`, attempt 1, 0 rows |
| `after-submit`, `after-step-12`, `before-complete` (3) | `needs_human` / `commit_uncertain` (T6.3), 1 row | all 3: `needs_human` / `commit_uncertain`, attempt 1, 1 row |
| `after-complete` | `succeeded` before the kill, 1 row | `succeeded`, attempt 1, 1 row |

Never 2 rows at any point. Each point's `attempts.json` shows the mechanism: attempt 1 `crashed` with
"lease expired in running; recovered by clean-… (T6.1 requeue)" (or "in committing … (T6.3 escalate)"),
then attempt 2 `success` for the pre-intent points.

**Before / after** (`../before-day2/`, Step 7, same 16 points): 1/16 green; every point but
`after-complete` LOST, the job left `running` forever with its lease (1 row from `after-submit` on).

**Still not green until Step 9:** the after-intent rows are *correct for Step 8* but not the brief's
final answer. `before-submit` ends `needs_human` with 0 rows (Step 9: verify sees `[0, 0]`, resubmits,
attempt 2 `succeeded`, 1 row); `after-submit` / `after-step-12` / `before-complete` end `needs_human`
with 1 row (Step 9: verify sees `[1]`, `succeeded` / `already_done`, attempt 1). The recovery-internal
crash points (a worker dying inside verify or inside T6) do not exist yet; Step 9 adds them.

**Fault worker "exit 1":** on Windows `process.kill(pid, "SIGKILL")` is `TerminateProcess`, which Node
reports as exit code 1; the log line `ROTE_FAULT firing at <point>` proves where it died. On Linux CI the
same run shows `signal SIGKILL` (`../ci-linux-before-day2/`; the report-only CI job runs this matrix on
every push).

Files: `matrix.md`, `check.txt` (every point's oracle report), `stdout.txt` (the console), one folder
per point (`worker-fault.log`, `worker-clean.log`, `job.json`, `attempts.json`, `ledger.json`,
`oracle.json`, `check.txt`, `worker-evidence/` screenshots). No credential value appears in any log or
JSON (scanned for the three fake passwords).
