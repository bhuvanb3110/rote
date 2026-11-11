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

### Results

**10 of 10 full runs passed** at cap 3: 41 files, 378/378 each, exit 0. No log contains
`ERR_INSUFFICIENT_RESOURCES`, `ERR_UNSAFE_PORT` or `Unable to capture screenshot`.

| Run | 01 | 02 | 03 | 04 | 05 | 06 | 07 | 08 | 09 | 10 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Wall (s) | 85.7 | 98.9 | 96.8 | 95.0 | 101.6 | 103.2 | 94.6 | 110.1 | 106.0 | 107.3 |

Mean 99.9 s. **This is not a fair "after" figure**: the builder (Claude Code) was writing code and the
editor's TypeScript server was busy during these runs, and the "before" runs above (mean 90.8 s)
were taken with less going on. So the before/after duration comparison was redone as an interleaved
A/B with nothing else running (`ab/`, `scripts/ab-timing.ps1`): the pre-D31 configuration
(`vitest.uncapped.config.ts`, one project, default parallelism) and the committed one, alternately, on
the same commit:

| Round | Uncapped (before) wall / vitest Duration | Capped at 3 (after) wall / vitest Duration |
| --- | --- | --- |
| 1 | 100.1 s / 97.9 s | 86.3 s / 84.8 s |
| 2 | 92.5 s / 90.8 s | 86.1 s / 84.4 s |
| 3 | 90.4 s / 89.3 s | 80.8 s / 79.4 s |
| **mean** | **94.3 s** | **84.4 s** |

The cap is about 10 s (10%) faster per full run, every round. vitest's summed per-test time ("tests")
fell from 399–439 s to 221–240 s: uncapped, the browser files slow each other down far more than
running them three at a time costs.
