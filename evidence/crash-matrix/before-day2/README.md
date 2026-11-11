# Crash-point matrix, before Day 2: EXPECTED TO FAIL

`npm run crash-matrix -- --lease-seconds 30 --drain-timeout 40s --out evidence/crash-matrix/before-day2`
on the builder's Windows machine, Step 7 code. `matrix.md` is the table, `check.txt` every point's full
oracle report, one folder per point with both workers' logs (`worker-fault.log`, `worker-clean.log`),
`job.json`, `attempts.json`, `ledger.json`, `oracle.json` and the replay evidence (screenshots of the
fake mock bank).

**Result: 1 of 16 points green, `RESULT: FAIL`, as expected.**

- **Every fault fired exactly where named** (`ROTE_FAULT firing at <point>` in each `worker-fault.log`,
  just after the step or hook it names). `exit 1` is how Windows reports `process.kill(pid, "SIGKILL")`
  (TerminateProcess); on Linux it is `signal SIGKILL`.
- `after-dequeue` … `before-submit`: the job stays `running` (attempt 1, 0 ledger rows) → **LOST**.
- `after-submit`, `after-step-12`, `before-complete`: the bank committed (1 row), the job still says
  `running` → **LOST after commit**: money moved and nothing will ever record it.
- `after-complete`: the completion committed before the kill → `succeeded`, 1 row, ok. It was green
  before Day 2 and will stay green.

**Why it fails, and why the drain is 40 s.** The lease is 30 s here (the Day-2 value), so by the end of
each 40 s drain the dead worker's lease **has expired**, and the clean worker was running the whole
time: `worker-clean.log` shows it ready and polling, never leasing. Nothing expires a lease, recovers
a job or verifies a commit yet: `dequeue` only takes `queued` jobs, and an expired `running` job also
keeps holding its tenant slot. A longer drain would change nothing (the reviewer's reasoning for the
chaos run, decision B1). Day 2 (docs/plans/step-08.md section 9) lists the expected outcome per point.
