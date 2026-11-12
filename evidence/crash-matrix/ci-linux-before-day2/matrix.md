# Crash-point matrix: 2026-11-12T02:31:01.983Z

- points: after-dequeue, after-step-01, after-step-02, after-step-03, after-step-04, after-step-05, after-step-06, after-step-07, after-step-08, after-step-09, after-step-10, before-submit, after-submit, after-step-12, before-complete, after-complete
- tenant: tenant-a; lease: 5 s; drain timeout per point: 30000 ms; workers: child processes (node --import tsx src/worker/main.ts)

| Point | Fault fired | Fault worker | Final state | Attempt | Ledger rows | Verdict |
| --- | --- | --- | --- | --- | --- | --- |
| `after-dequeue` | yes | signal SIGKILL | running | 1 | 0 | **LOST** |
| `after-step-01` | yes | signal SIGKILL | running | 1 | 0 | **LOST** |
| `after-step-02` | yes | signal SIGKILL | running | 1 | 0 | **LOST** |
| `after-step-03` | yes | signal SIGKILL | running | 1 | 0 | **LOST** |
| `after-step-04` | yes | signal SIGKILL | running | 1 | 0 | **LOST** |
| `after-step-05` | yes | signal SIGKILL | running | 1 | 0 | **LOST** |
| `after-step-06` | yes | signal SIGKILL | running | 1 | 0 | **LOST** |
| `after-step-07` | yes | signal SIGKILL | running | 1 | 0 | **LOST** |
| `after-step-08` | yes | signal SIGKILL | running | 1 | 0 | **LOST** |
| `after-step-09` | yes | signal SIGKILL | running | 1 | 0 | **LOST** |
| `after-step-10` | yes | signal SIGKILL | running | 1 | 0 | **LOST** |
| `before-submit` | yes | signal SIGKILL | running | 1 | 0 | **LOST** |
| `after-submit` | yes | signal SIGKILL | running | 1 | 1 | **LOST** |
| `after-step-12` | yes | signal SIGKILL | running | 1 | 1 | **LOST** |
| `before-complete` | yes | signal SIGKILL | running | 1 | 1 | **LOST** |
| `after-complete` | yes | signal SIGKILL | succeeded | 1 | 1 | ok |

Green points: 1/16.

RESULT: FAIL
