# Settle period vs history lag: 2026-11-14T07:25:30.248Z

- runs: crash-lag-3000, crash-lag-8000, crash-lag-30000, t5-lag-3000, t5-lag-8000, t5-lag-15000
- settle 5000 ms; lease 5 s / heartbeat 2 s; tenant-a; one transfer per run; workers: child processes (node --import tsx src/worker/main.ts)
- judge: a lookup counts the row iff the bank rendered its count >= lag after the write (render window = the step-07 .. step-08 records, +/- 250 ms)

| Run | Path | Lag | Write -> lookup #1 render | Write -> lookup #2 render | Lookups | Decision | Job | Attempt | Ledger rows | Oracle | Plan predicted | Consistent |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `crash-lag-3000` | crash | 3.0 s | 6.0-6.1 s | - | [1] | already_done | succeeded / already_done | 1 | 1 | ok | [0, 1] -> already_done, 1 row | yes |
| `crash-lag-8000` | crash | 8.0 s | 6.3-6.4 s | 12.3-12.4 s | [0,1] | already_done | succeeded / already_done | 1 | 1 | ok | [0, 0] -> resubmitted -> 2 rows, DUPLICATE | yes |
| `crash-lag-30000` | crash | 30.0 s | 6.2-6.3 s | 12.2-12.3 s | [0,0] | resubmitted | succeeded / success | 2 | 2 | DUPLICATE | - | yes |
| `t5-lag-3000` | t5 | 3.0 s | 0.9-1.0 s | 6.7-6.9 s | [0,1] | already_done | succeeded / already_done | 1 | 1 | ok | - | yes |
| `t5-lag-8000` | t5 | 8.0 s | 1.1-1.2 s | 7.1-7.2 s | [0,0] | resubmitted | succeeded / success | 2 | 2 | DUPLICATE | - | yes |
| `t5-lag-15000` | t5 | 15.0 s | 2.0-2.2 s | 8.3-8.4 s | [0,0] | resubmitted | succeeded / success | 2 | 2 | DUPLICATE | - | yes |

[0, 1] path seen: yes; [0, 0] duplicate seen: yes; credential values in the evidence: none

RESULT: PASS
