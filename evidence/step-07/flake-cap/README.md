# The browser-test concurrency cap (D31): measurement and proof

## Measurement (sampled runs: Chromium processes counted every 500 ms; comparable with each other)

| Log | Browser cap | Result | Wall | Peak Chromium processes / working set |
| --- | --- | --- | --- | --- |
| `before-uncapped-run1-no-samples.txt` | none | 39 files, 372/372 | 89.8 s | not sampled (the sampler job got a relative path; fixed) |
| `before-uncapped-run2.txt` (+ `.samples.csv`) | none | 39 files, 372/372 | 119.8 s | 28 / 1965 MB |
| `measure-browser-workers-2.txt` | 2 | 40 files, 374/374 | 126.0 s | 11 / 714 MB |
| `measure-browser-workers-3.txt` | 3 | 41 files, 386/386 | 113.5 s | 15 / 1098 MB |
| `measure-browser-workers-4.txt` | 4 | 41 files, 386/386 | 103.8 s | 19 / 1378 MB |

(Wall here is the runner's stopwatch; D31's table quotes vitest's own "Duration" line, a second or
two less.) These four logs were written by PowerShell 5.1 as UTF-16 and re-encoded to UTF-8
afterwards, text unchanged; the scripts now let `cmd.exe` redirect, so later logs are vitest's raw
bytes.

## Proof: 10 full runs at cap 3 (unsampled), `npm-test-x10-run01..10.txt`

Filled in below by the runs themselves; durations before the change (unsampled, same machine):
`../npm-test-baseline.txt` 90.6 s, `../npm-test-commit-a1.txt` 88.7 s, `../npm-test-commit-a3.txt`
94.1 s, `before-uncapped-run1-no-samples.txt` 89.8 s (mean 90.8 s).
