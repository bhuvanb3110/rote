# Verify during a 30 s bank outage: 2026-11-14T07:28:39.426Z

- 4 jobs (tenant-a / tenant-b); fault workers died right after Submit (even) or between the intent and the click (odd)
- bank down (/control/errors/on) 2026-11-14T07:28:46.420Z .. 2026-11-14T07:29:16.511Z (database clock); two clean workers
- lease 5 s / heartbeat 2 s; settle 5000 ms; deferral backoff 5 s doubling (cap 60 s), budget 600 s (the defaults)

| Job | Tenant | Died at | Verify phases | Deferrals | Phases (reason -> decision [lookups]) | Decided after the outage | Final | Attempt | As expected |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `cd7f283d` | tenant-a | before-submit | 4 | 3 | lease_expired_in_committing->deferred[null], resumed->deferred[null], resumed->deferred[null], resumed->resubmitted[0,0] | 19.4 s | succeeded / success | 2 | yes |
| `8554f33a` | tenant-b | before-submit | 4 | 3 | lease_expired_in_committing->deferred[null], resumed->deferred[null], resumed->deferred[null], resumed->resubmitted[0,0] | 20.9 s | succeeded / success | 2 | yes |
| `10870776` | tenant-a | after-submit | 4 | 3 | lease_expired_in_committing->deferred[null], resumed->deferred[null], resumed->deferred[null], resumed->already_done[1] | 13.4 s | succeeded / already_done | 1 | yes |
| `737f08e5` | tenant-b | after-submit | 4 | 3 | lease_expired_in_committing->deferred[null], resumed->deferred[null], resumed->deferred[null], resumed->already_done[1] | 20.5 s | succeeded / already_done | 1 | yes |

Ledger rows: 4; oracle: PASS (ok=4); most phases on one job: 4 (the crash cap is 3 dead phases; deferrals do not count); credential values in the evidence: none

RESULT: PASS
