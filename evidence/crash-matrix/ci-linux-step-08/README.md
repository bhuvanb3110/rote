# Crash-point matrix on Linux CI, Step 8: 16/16

CI's report-only **crash-matrix** job on the Step 8 head: run
[43149346126](https://github.com/bhuvanb3110/rote/actions/runs/43149346126), commit `79bd152`,
ubuntu-24.04, Node 22, `postgres:17`:

```
npm run crash-matrix -- --lease-seconds 5 --heartbeat-seconds 2 --expect step-08 --drain-timeout 30s --out crash-matrix-report
```

Downloaded from the run's `crash-matrix-report` artifact (`gh run download 43149346126 -n
crash-matrix-report`); `matrix.md`, `check.txt` and the console (`stdout.txt`) copied here unchanged.

**Result: 16/16, RESULT: PASS**, the same per-point outcomes as the Windows run (`../step-08/`), with the
fault worker dying by a real `signal SIGKILL` at every point (Windows reports `exit 1`). Before Step 8 the
same job on Linux gave 1/16 (`../ci-linux-before-day2/`). The job is still `continue-on-error` and becomes
required in Step 10.
