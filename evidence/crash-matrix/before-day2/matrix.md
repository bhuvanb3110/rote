# Crash-point matrix: 2026-11-11T18:21:55.610Z

- points: after-dequeue, after-step-01, after-step-02, after-step-03, after-step-04, after-step-05, after-step-06, after-step-07, after-step-08, after-step-09, after-step-10, before-submit, after-submit, after-step-12, before-complete, after-complete
- tenant: tenant-a; lease: 30 s; drain timeout per point: 40000 ms; workers: child processes (node --import tsx src/worker/main.ts)

| Point | Fault fired | Fault worker | Final state | Attempt | Ledger rows | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `after-dequeue` | yes | exit 1 | running | 1 | 0 | **LOST** |
| `after-step-01` | yes | exit 1 | running | 1 | 0 | **LOST** |
| `after-step-02` | yes | exit 1 | running | 1 | 0 | **LOST** |
| `after-step-03` | yes | exit 1 | running | 1 | 0 | **LOST** |
| `after-step-04` | yes | exit 1 | running | 1 | 0 | **LOST** |
| `after-step-05` | yes | exit 1 | running | 1 | 0 | **LOST** |
| `after-step-06` | yes | exit 1 | running | 1 | 0 | **LOST** |
| `after-step-07` | yes | exit 1 | running | 1 | 0 | **LOST** |
| `after-step-08` | yes | exit 1 | running | 1 | 0 | **LOST** |
| `after-step-09` | yes | exit 1 | running | 1 | 0 | **LOST** |
| `after-step-10` | yes | exit 1 | running | 1 | 0 | **LOST** |
| `before-submit` | yes | exit 1 | running | 1 | 0 | **LOST** |
| `after-submit` | yes | exit 1 | running | 1 | 1 | **LOST** |
| `after-step-12` | yes | exit 1 | running | 1 | 1 | **LOST** |
| `before-complete` | yes | exit 1 | running | 1 | 1 | **LOST** |
| `after-complete` | yes | exit 1 | succeeded | 1 | 1 | ok |

Green points: 1/16.

RESULT: FAIL
