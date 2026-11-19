# Crash-point matrix: 2026-11-14T07:11:21.065Z

- scenarios: after-dequeue, after-step-01, after-step-02, after-step-03, after-step-04, after-step-05, after-step-06, after-step-07, after-step-08, after-step-09, after-step-10, before-submit, after-submit, after-step-12, before-complete, after-complete, after-submit>verify-after-login, after-submit>verify-after-count, after-submit>verify-before-result, before-submit>verify-after-count, before-submit>verify-before-requeue, before-submit>verify-after-requeue, after-dequeue>recover-in-transaction
- expectations: step-09 (src/chaos/crashExpected.ts)
- tenant: tenant-a; lease: 5 s; heartbeat: 2 s; verify settle: the worker default (5 s); drain timeout per scenario: 90000 ms; workers: child processes (node --import tsx src/worker/main.ts)

| Scenario | Fault(s) fired | Fault worker(s) | Expected | Final state | Attempt | Ledger rows | Verify phases | Oracle | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `after-dequeue` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | - | ok | ok |
| `after-step-01` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | - | ok | ok |
| `after-step-02` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | - | ok | ok |
| `after-step-03` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | - | ok | ok |
| `after-step-04` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | - | ok | ok |
| `after-step-05` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | - | ok | ok |
| `after-step-06` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | - | ok | ok |
| `after-step-07` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | - | ok | ok |
| `after-step-08` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | - | ok | ok |
| `after-step-09` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | - | ok | ok |
| `after-step-10` | yes | exit 1 | requeued (T6.1), attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | - | ok | ok |
| `before-submit` | yes | exit 1 | T6.4 verify [0, 0] -> resubmitted -> attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | resubmitted[0,0] | ok | ok |
| `after-submit` | yes | exit 1 | T6.4 verify [1] -> succeeded / already_done, attempt 1, 1 row | succeeded / already_done | 1 | 1 | already_done[1] | ok | ok |
| `after-step-12` | yes | exit 1 | T6.4 verify [1] -> succeeded / already_done, attempt 1, 1 row | succeeded / already_done | 1 | 1 | already_done[1] | ok | ok |
| `before-complete` | yes | exit 1 | T6.4 verify [1] -> succeeded / already_done, attempt 1, 1 row | succeeded / already_done | 1 | 1 | already_done[1] | ok | ok |
| `after-complete` | yes | exit 1 | succeeded before the kill, 1 row | succeeded / success | 1 | 1 | - | ok | ok |
| `after-submit>verify-after-login` | yes / yes | exit 1; then exit 1 | re-verify (T6.5) [1] -> succeeded / already_done, 1 row | succeeded / already_done | 1 | 1 | crashed, already_done[1] | ok | ok |
| `after-submit>verify-after-count` | yes / yes | exit 1; then exit 1 | re-verify (T6.5) [1] -> succeeded / already_done, 1 row | succeeded / already_done | 1 | 1 | crashed, already_done[1] | ok | ok |
| `after-submit>verify-before-result` | yes / yes | exit 1; then exit 1 | re-verify (T6.5) [1] -> succeeded / already_done, 1 row | succeeded / already_done | 1 | 1 | crashed, already_done[1] | ok | ok |
| `before-submit>verify-after-count` | yes / yes | exit 1; then exit 1 | re-verify (T6.5) [0, 0] -> requeued -> attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | crashed, resubmitted[0,0] | ok | ok |
| `before-submit>verify-before-requeue` | yes / yes | exit 1; then exit 1 | re-verify (T6.5) -> requeued -> attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | crashed, resubmitted[0,0] | ok | ok |
| `before-submit>verify-after-requeue` | yes / yes | exit 1; then exit 1 | already requeued; dequeued normally -> attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | resubmitted[0,0] | ok | ok |
| `after-dequeue>recover-in-transaction` | yes / yes | exit 1; then exit 1 | rollback releases the lock; another recoverer requeues (T6.1) -> attempt 2 succeeded, 1 row | succeeded / success | 2 | 1 | - | ok | ok |

Green: 23/23.

RESULT: PASS
