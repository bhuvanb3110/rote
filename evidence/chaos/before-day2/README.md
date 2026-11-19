# Chaos run, before Day 2: EXPECTED TO FAIL

`npm run chaos -- --drain-timeout 3m --out evidence/chaos/before-day2`, seed **2024306878** (drawn and
printed; reproduce the same schedule with `npm run chaos -- --seed 2024306878`). Step 7 code: leases
(300 s in Compose) but **no heartbeat, no lease expiry, no recovery, no commit intent**.

100 transfer jobs (tenants a/b/c round-robin), 4 workers, 15 `docker kill --signal=KILL`s 5–15 s apart
over 150 s, each victim restarted with `docker start` 2 s later by the harness (the supervisor), one
45 s `docker pause` of `rote-worker-3` (26.8 s → 71.7 s). Drain timeout 3 min (reviewer decision B1:
these jobs are expected to be lost, and waiting 10 min would prove nothing).

**Result (`check.txt`): RESULT: FAIL.** Oracle: `ok=61, DUPLICATE=0, LOST=39` (of which 1 lost after
commit), no other finding; 62 ledger rows. 15 kills, 15 restarts, 0 Docker errors, no worker
OOM-killed, no credential value in any job, attempt, API response or container log.

| Tenant | succeeded | `running` forever (orphaned by a kill) | `queued` forever |
| --- | --- | --- | --- |
| tenant-a | 2 | 2 (`12037bf9` killed at 7.5 s, `b52bffb9` at 15.9 s) | 30 |
| tenant-b | 26 | 2 (`b44c059a` killed at 23.6 s, `67bb92d5` at 101.0 s: **1 ledger row**) | 5 |
| tenant-c | 33 | 0 | 0 |

**Why it fails.** A killed worker's job stays `running` with its lease: nothing expires it, nothing
recovers it (`dequeue` only takes `queued` jobs). An orphaned job also keeps counting against its
tenant's `max_concurrent` (2): tenant-a lost both slots in the first 16 s, so its other 30 jobs were
never dequeued again, and tenant-b lost both by 101 s. `67bb92d5` is the worst case: the bank
committed it (ledger row present) and the job will never say so.

**Why "0 duplicates" proves nothing yet.** A duplicate needs a *second* runner of the same job, and
today nothing ever re-runs a job whose worker died: the orphan just sits there. 0 duplicates here is a
consequence of losing jobs, not of crash safety. Day 2 adds the recovery that creates second runners
(docs/plans/step-08.md), and only from then on does 0 duplicates under chaos mean anything.

**The pause (zombie scenario) exercised no protection.** `rote-worker-3` was frozen holding `bd5e6bcf`
(at step-08). On unpause, Playwright's own 30 s action timeout, which counts wall time across the
freeze, fired immediately: a `failure` before Submit, so `jobOutcomeFor` requeued it (D25), and the
same worker ran attempt 2 to `succeeded` (`attempts.json`). Nothing expired its lease meanwhile (300
s), so no other worker could have taken the job. Day 2's 30 s lease makes this the real zombie test.

**A reporting flaw found in this run (fixed in the script afterwards, not in this evidence).** A
restarted replica keeps its hostname, so every later kill of `rote-worker-4` still found
`12037bf9`/`b44c059a` "held" (their `lease_owner` starts with that hostname), and this `check.txt`
lists all those kills next to each job. The first kill listed is the one that orphaned it
(`events.jsonl` is the raw record). `scripts/chaos.ts` now names only the first and counts the rest.

Files: `seed.txt`, `schedule.json` (the seeded schedule), `events.jsonl` (every kill/start/pause with
the jobs the victim held), `check.txt`, `oracle.json`, `jobs.json`, `attempts.json`, `ledger.json`,
`submitted.json`, `docker-stats.jsonl`, `compose-logs.txt`, `worker-inspect.json`, `compose-ps-*.txt`,
`stdout.txt` (the console). Workers, API and bank were stopped at the end.
