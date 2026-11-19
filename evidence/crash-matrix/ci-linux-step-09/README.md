# Crash-point matrix on Linux CI, Step 9: 23/23

This is CI's report-only **crash-matrix** job on the Step 9 head: run
[43573913163](https://github.com/bhuvanb3110/rote/actions/runs/43573913163), commit `c303ec9`,
ubuntu-24.04, Node 22, `postgres:17`:

```
npm run crash-matrix -- --lease-seconds 5 --heartbeat-seconds 2 --expect step-09 --drain-timeout 60s --out crash-matrix-report
```

The files were downloaded from the run's `crash-matrix-report` artifact (`gh run download 43573913163 -n
crash-matrix-report`). `matrix.md`, `check.txt` and the console (`crash-matrix-stdout.txt`, saved here as
`stdout.txt`) are copied unchanged. The per-scenario folders (about 800 files, mostly screenshots) stay in
the artifact; the Windows run `../step-09/` has the same layout committed in full.

**Result: 23/23, RESULT: PASS** (the 16 transfer points and the 7 two-fault recovery scenarios), with the
same per-scenario outcomes as the Windows run (`../step-09/`). Every fault worker, the second fault of each
two-fault scenario included, died by a real `signal SIGKILL`; none reported an exit code (Windows reports
`exit 1`). A scan for the three fake passwords found 0 hits.

| Run | Expectations | Green |
| --- | --- | --- |
| `../ci-linux-before-day2/` | (Step 7) | 1/16 |
| `../ci-linux-step-08/` | step-08 | 16/16 |
| this run | step-09 | **23/23** |

The job is still `continue-on-error`; Step 10 makes it required (`docs/plans/step-10.md` section 6).
