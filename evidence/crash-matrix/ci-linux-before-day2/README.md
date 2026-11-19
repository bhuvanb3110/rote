# Crash-point matrix on Linux CI, before Day 2 (report-only job, first run)

The first run of CI's report-only **crash-matrix** job (Step 8 reviewer decision A3, D35 amendment):
run [43141869146](https://github.com/bhuvanb3110/rote/actions/runs/43141869146), commit `8eb5e55`
(migration 0002 only: no heartbeat, no commit intent, no recovery yet), ubuntu-24.04, Node 22,
`postgres:17`, `npm run crash-matrix -- --lease-seconds 5 --drain-timeout 30s`. Downloaded from the
run's `crash-matrix-report` artifact (`gh run download 43141869146 -n crash-matrix-report`); `matrix.md`,
`check.txt` and the console (`stdout.txt`) copied here unchanged.

**Result: 1/16 green, RESULT: FAIL**, the same as the Windows run in `../before-day2/`: every point but
`after-complete` is LOST (nothing recovers a dead worker's job), with 1 ledger row from `after-submit` on.

What this run adds over `../before-day2/`: the **Fault worker** column reads `signal SIGKILL` at every
point. On Windows the same self-kill shows as `exit 1` (`TerminateProcess`); on Linux it is a real
signal, as a container kill is. The job was `continue-on-error`, so the workflow stayed green.
