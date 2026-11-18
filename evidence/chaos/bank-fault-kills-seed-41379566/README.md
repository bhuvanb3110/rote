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

## After: the same seeds on the D57 code

Re-run on `90009c0` (2026-11-18), 100 jobs each, into `../bank-fault-kills-seed-41379566-after-d57/` and
`../bank-fault-only-seed-2130356189-after-d57/`. The same seed means the same schedule: the same 16 kills (times
and victims), the same 45 s pause of replica 2, the same outage (91.9–121.9 s into the schedule) and slow period.
Which job a kill lands on differs (job ids are new each run, and timing moves).

| | bank-fault-kills 41379566, **before** (`3c2426e`) | bank-fault-kills 41379566, **after** (`90009c0`) | bank-fault-only 2130356189, before | bank-fault-only 2130356189, after |
| --- | --- | --- | --- | --- |
| **RESULT** | **FAIL** | **PASS** | PASS | PASS |
| succeeded | 98 | **100** | 100 | 100 |
| **failed** | **2** (`failure`, `lease_expired`) | **0** | 0 | 0 |
| needs_human | 0 | 0 | 0 | 0 |
| oracle: DUPLICATE / LOST / UNRECORDED_COMMIT | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 | 0 / 0 / 0 |
| ledger rows | 98 | 100 | 100 | 100 |
| kills / restarts / bank controls applied | 16 / 16 / 4 of 4 | 16 / 16 / 4 of 4 | 0 / 0 / 4 of 4 | 0 / 0 / 4 of 4 |
| crash requeues (T6.1) / failed by recovery (T6.2) | 6 / **1** (`lease_expired`) | 14 (15: see below) / 0 | 0 / 0 | 0 / 0 |
| requeued after a failure, with the backoff (T4) | 54 | 65 | 110 | 101 |
| jobs leased past `max_attempts` | 0 (impossible before D57) | **3** | 0 | 0 |
| crash budget (`check.txt`, from `jobs`) | n/a | 15 crashes on 12 jobs, at most 2 on one; 0 at the cap | n/a | 0 crashes |
| verify phases + reconciles (`job_verifications`) | 11 + 2 (T6.4 x3; already_done x2, resubmitted x2, each reconciled) | 0 + 0 | 4 + 1 (one job's verify deferred through the outage, resubmitted, reconciled) | 0 + 0 |
| settled / drain | 100/100, 89 s | 100/100, 37 s | 100/100, 37 s | 100/100, 45 s |

**The two histories that failed before succeed now.** The three jobs the after-run leased past `max_attempts`
(`attempts.json`):

| job | attempts | ended |
| --- | --- | --- |
| `d87af936` | 1:crashed 2:crashed 3:failure **4:success** | succeeded: the history of `076e7ccd`, which failed before |
| `5397e46f` | 1:crashed 2:failure 3:crashed **4:success** | succeeded: the history of `93c77857`, which failed / `lease_expired` before |
| `fd8fae4f` | 1:crashed 2:failure 3:failure **4:success** | succeeded: two own failures (the outage) and one crash; Step 8's rule failed it at attempt 3 |

**15 crashes, 14 T6.1 rows.** `jobs.crashes` sums to 15, the tally's "requeued after a crash" says 14: one crash is
the paused replica's job (`ab54dcc5`). T6.1 recovered it (and counted the crash); when the replica was unpaused its
worker's heartbeat found the lease gone and re-labelled its own attempt `lease_lost`, keeping recovery's note
(`[recovery had recorded: ... (T6.1 requeue)]`). The tally counted only `crashed` rows; that is fixed in the
commit after this evidence (it now also counts a `lease_lost` row that recovery requeued).

**What this run did not exercise.** No kill landed after a commit intent in the after-run (the before-run had
three), so it says nothing new about verify; that path is covered by the crash matrix, `crashSubmit.db.test.ts`
and `verify-scenarios` (D52), and D57 does not change it.
