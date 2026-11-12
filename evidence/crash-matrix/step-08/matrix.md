# Crash-point matrix: 2026-11-12T03:13:55.670Z

- points: after-dequeue, after-step-01, after-step-02, after-step-03, after-step-04, after-step-05, after-step-06, after-step-07, after-step-08, after-step-09, after-step-10, before-submit, after-submit, after-step-12, before-complete, after-complete
- expectations: step-08 (src/chaos/crashExpected.ts)
- tenant: tenant-a; lease: 5 s; heartbeat: 2 s; drain timeout per point: 60000 ms; workers: child processes (node --import tsx src/worker/main.ts)

| Point | Fault fired | Fault worker | Expected | Final state | Attempt | Ledger rows | Oracle | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `after-dequeue` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-01` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-02` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-03` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-04` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-05` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-06` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-07` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-08` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-09` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `after-step-10` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | ok | ok |
| `before-submit` | yes | exit 1 | needs_human (T6.3), 0 rows | needs_human / commit_uncertain | 1 | 0 | ok | ok |
| `after-submit` | yes | exit 1 | needs_human (T6.3), 1 row | needs_human / commit_uncertain | 1 | 1 | ok | ok |
| `after-step-12` | yes | exit 1 | needs_human (T6.3), 1 row | needs_human / commit_uncertain | 1 | 1 | ok | ok |
| `before-complete` | yes | exit 1 | needs_human (T6.3), 1 row | needs_human / commit_uncertain | 1 | 1 | ok | ok |
| `after-complete` | yes | exit 1 | succeeded before the kill, 1 row | succeeded / success | 1 | 1 | ok | ok |

Green points: 16/16.

RESULT: PASS
