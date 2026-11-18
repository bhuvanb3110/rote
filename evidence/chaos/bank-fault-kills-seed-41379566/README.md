# bank-fault-kills, seed 41379566: RESULT: FAIL (kept as evidence)

The first run of the `bank-fault-kills` chaos family (D56): 100 jobs, 4 workers, a 150 s schedule with 16 kills
and one 45 s `docker pause`, the bank down for 30 s and slow (2 s per request) for 60 s. Code `3c2426e`, run
2026-11-17. Reproduce the schedule with `npm run chaos -- --bank-fault --seed 41379566 --jobs 100`.

This folder is the run exactly as it finished. Nothing in it was edited; this README was added afterwards.

## What the run found

| | |
| --- | --- |
| Ledger oracle (D32) | PASS: 100 ok, 0 DUPLICATE, 0 LOST, 0 UNRECORDED_COMMIT, 98 ledger rows |
| needs_human | 0 |
| **failed** | **2**, each with 0 ledger rows: the family requires 0 |
| settled | 100/100 (drain 89 s) |
| Family judge | **FAIL**: `1 job(s) ended failed/failure`, `1 job(s) ended failed/lease_expired` |

The two failed jobs (`check.txt`, `summary.json`, `attempts.json`; times are seconds since the run started, the
schedule began at 20 s, the outage covered about 112–142 s):

| job | attempt 1 | attempt 2 | attempt 3 | ended |
| --- | --- | --- | --- | --- |
| `076e7ccd` | crashed (its worker killed; T6.1 requeue) | crashed (T6.1 requeue) | **failure** at 113 s: the bank's 503 page has no "Transfer button" | `failed / failure`, "attempt 3/3 (attempts exhausted)" |
| `93c77857` | crashed (T6.1 requeue) | **failure** at 125 s: no "Member ID textbox" (the 503 page) | crashed (T6.2 fail) | `failed / lease_expired`, "lease expired on the last attempt (3/3)" |

## Why it failed

Each job failed **once** on its own, during the outage, exactly as a bank outage is supposed to be survived: the
requeue backoff (D49) gives a job 3 attempts spread over at least 32 s. But since Step 8 **every crash requeue
(T6.1) also used one of those 3 attempts** (D21: `attempt < max_attempts` or failed / `lease_expired`). Two kills
plus one outage failure added up to 3, so a job that had failed once was failed for good. Nothing was lost or
duplicated (the oracle passed), but the family requires 0 failed jobs, and the cause was the fleet's own
accounting, not the job.

The outage alone fails nothing: `bank-fault-only`, seed 2130356189, on the same code
(`evidence/chaos/bank-fault-only-seed-2130356189/`): 100/100 succeeded, 0 failed, RESULT: PASS.

## What changed

Reviewer decision during 10b (`docs/plans/step-10.md`, 2026-11-17): option 1, **crashes stop using attempts**.
Built in `04ee739` as **D57** (`docs/DECISIONS.md`):

- **Two budgets.** *Attempts* (`max_attempts`, 3) are the job's own failures. *Crashes* (`max_crashes`, default 5)
  are worker deaths before the commit intent: a lease that expired in `running`, recovered by T6.1. A crash uses
  no attempt; the job's own attempts are `attempt − crashes`.
- **The cap.** The crash that reaches `max_crashes` fails the job with outcome **`crash_limit`** (T6.2), so a
  poison job is visible as such. `lease_expired` is no longer produced.
- Only a lease that dies **before** the intent is a crash. A lease that expires after the intent is verified
  exactly as before.
- Migration `0006_crash_budget.sql`; property 11 (*a job is never failed by fewer than `max_attempts` own
  failures unless it hit the crash cap*), with deterministic replays of these two jobs (both now stay queued after
  their third lease and succeed on the fourth); mutant 11 in the mutation check.

Under D57 the two jobs above would have gone on: `076e7ccd` after its third lease had used 1 of its 3 attempts,
`93c77857` after its third lease had used 1.

## After

The re-runs on the D57 code are in `../bank-fault-kills-seed-41379566-after-d57/` (the same seed, so the same
kills, pause and bank events) and `../bank-fault-only-seed-2130356189-after-d57/`. The before / after table is
added below once they have run.
