# Crash-point matrix on Linux CI, Step 10a: 23/23 (now a failing job when red)

CI's **crash-matrix** job, no longer report-only (D54), on the Step 10a head `3ff342a`: run
[43616704578](https://github.com/bhuvanb3110/rote/actions/runs/43616704578), ubuntu-24.04, Node 22, `postgres:17`:

```
npm run crash-matrix -- --lease-seconds 5 --heartbeat-seconds 2 --expect step-10 --reconcile-margin-seconds 5 --drain-timeout 90s --out crash-matrix-report
```

Downloaded from the run's `crash-matrix-report` artifact (`gh run download 43616704578 -n crash-matrix-report`).
`matrix.md`, `check.txt` and the console (`crash-matrix-stdout.txt`, saved here as `stdout.txt`) are copied
unchanged; the per-scenario folders stay in the artifact (the Windows run `../step-10a/` has the same layout
committed in full).

**Result: 23/23, RESULT: PASS**, with the same per-scenario outcomes as the Windows run: every scenario
drained until settled; the four resubmit paths (first fault `before-submit`) reconciled `[1]`; no other
reconcile due. Every fault worker, both faults of each two-fault scenario included, died by a real
`signal SIGKILL`. A scan for the three fake passwords found 0 hits.

| Run | Expectations | Green |
| --- | --- | --- |
| `../ci-linux-before-day2/` | (Step 7) | 1/16 |
| `../ci-linux-step-08/` | step-08 | 16/16 |
| `../ci-linux-step-09/` | step-09 | 23/23 |
| this run | step-10 | **23/23** |
