# Crash-point matrix: 2026-11-12T03:37:10.787Z

- points: after-dequeue, after-step-01, after-step-02, after-step-03, after-step-04, after-step-05, after-step-06, after-step-07, after-step-08, after-step-09, after-step-10, before-submit, after-submit, after-step-12, before-complete, after-complete
- expectations: step-08 (src/chaos/crashExpected.ts)
- tenant: tenant-a; lease: 5 s; heartbeat: 2 s; drain timeout per point: 30000 ms; workers: child processes (node --import tsx src/worker/main.ts)

| Point | Fault fired | Fault worker | Expected | Final state | Attempt | Ledger rows | Oracle | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `after-dequeue` | yes | signal SIGKILL | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-01` | yes | signal SIGKILL | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-02` | yes | signal SIGKILL | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-03` | yes | signal SIGKILL | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-04` | yes | signal SIGKILL | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-05` | yes | signal SIGKILL | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-06` | yes | signal SIGKILL | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-07` | yes | signal SIGKILL | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-08` | yes | signal SIGKILL | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-09` | yes | signal SIGKILL | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-10` | yes | signal SIGKILL | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `before-submit` | yes | signal SIGKILL | needs_human (T6.3), 0 rows | needs_human / commit_uncertain | 1 | 0 | ok | ok |
| `after-submit` | yes | signal SIGKILL | needs_human (T6.3), 1 row | needs_human / commit_uncertain | 1 | 1 | ok | ok |
| `after-step-12` | yes | signal SIGKILL | needs_human (T6.3), 1 row | needs_human / commit_uncertain | 1 | 1 | ok | ok |
| `before-complete` | yes | signal SIGKILL | needs_human (T6.3), 1 row | needs_human / commit_uncertain | 1 | 1 | ok | ok |
| `after-complete` | yes | signal SIGKILL | succeeded before the kill, 1 row | succeeded / success | 1 | 1 | ok | ok |

Green points: 16/16.

RESULT: PASS
