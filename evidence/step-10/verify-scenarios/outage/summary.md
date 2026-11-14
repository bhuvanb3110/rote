# Verify during a 30 s bank outage: 2026-11-14T17:08:34.485Z

- 4 jobs (tenant-a / tenant-b); fault workers died right after Submit (even) or between the intent and the click (odd)
- bank down (/control/errors/on) 2026-11-14T17:08:41.142Z .. 2026-11-14T17:09:11.212Z (database clock); two clean workers
- lease 5 s / heartbeat 2 s; settle 5000 ms; deferral backoff 5 s doubling (cap 60 s), budget 600 s (the defaults)

| Job | Tenant | Died at | Verify phases | Deferrals | Phases (reason -> decision [lookups]) | Decided after the outage | Reconcile | Final | Attempt | As expected |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `b5985cd0` | tenant-a | after-submit | 4 | 3 | lease_expired_in_committing->deferred[null], resumed->deferred[null], resumed->deferred[null], resumed->already_done[1] | 14.0 s | - | succeeded / already_done | 1 | yes |
| `d30aa02c` | tenant-b | before-submit | 4 | 3 | lease_expired_in_committing->deferred[null], resumed->deferred[null], resumed->deferred[null], resumed->resubmitted[0,0] | 21.2 s | reconciled[1] | succeeded / success | 2 | yes |
| `ea149f58` | tenant-a | after-submit | 4 | 3 | lease_expired_in_committing->deferred[null], resumed->deferred[null], resumed->deferred[null], resumed->already_done[1] | 21.3 s | - | succeeded / already_done | 1 | yes |
| `f44f475a` | tenant-b | before-submit | 4 | 3 | lease_expired_in_committing->deferred[null], resumed->deferred[null], resumed->deferred[null], resumed->resubmitted[0,0] | 20.2 s | reconciled[1] | succeeded / success | 2 | yes |

Ledger rows: 4; oracle: PASS (ok=4); most phases on one job: 4 (the crash cap is 3 dead phases; deferrals do not count); credential values in the evidence: none

RESULT: PASS
