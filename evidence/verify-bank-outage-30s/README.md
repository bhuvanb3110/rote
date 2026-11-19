# Verify during a 30 s bank outage (step-09 reviewer addition 5): bank unavailable ≠ ambiguous

```
npm run verify-scenarios -- --family outage --outage 30s --jobs 4 --out evidence/verify-bank-outage-30s
```

The run was on 2026-11-14 (UTC), 122 s wall, on the builder's Windows machine. Postgres came from Compose
and the bank ran in-process on :4100. Each worker was a child process (`node --import tsx
src/worker/main.ts`). Lease 5 s / heartbeat 2 s, as in the crash matrix. Settle 5 s, deferral backoff 5 s
doubling to a 60 s cap, and a 600 s budget: all the defaults (D44).

**Result (`summary.md`, `check.txt`): RESULT: PASS.** Every verify met the outage, deferred, and completed
after it. No job ended `needs_human`, and no phase was escalated or exhausted. The oracle passed: 4 jobs,
4 ledger rows, `ok=4`, 0 DUPLICATE, 0 LOST.

## What the run did

1. Four transfer jobs (tenant-a, tenant-b, tenant-a, tenant-b). Four fault workers ran **in parallel**: two
   SIGKILLed themselves right after Submit (`after-submit`: the bank wrote the row) and two between the commit
   intent and the click (`before-submit`: nothing written). All four fired, leaving 2 ledger rows and four
   jobs in `committing` with running leases.
2. **The bank went down** (`/control/errors/on`: every tenant page except /login answers 503 "System
   unavailable") at 07:28:46.4, and two clean workers started.
3. As each lease expired, a clean worker claimed the job to verify (T6.4). Its lookup hit the 503 page:
   the lookup's `BANK_UNAVAILABLE` outcome, classified **unavailable**, not unreadable (D42, D44). The
   phase ended `deferred` (T8). The job stayed `verifying`, its token was bumped, and its lease was set to
   the backoff. After each backoff, recovery resumed it (T6.7) as a new phase.
4. **The bank came back** at 07:29:16.5 (30.1 s on the database clock). The next resumed phase of each job
   read the history and decided.

| Job | Died at | Phases (reason → decision [lookups]) | Decided after the bank came back | Final |
| --- | --- | --- | --- | --- |
| `cd7f283d` | before-submit | `lease_expired_in_committing`→deferred, resumed→deferred, resumed→deferred, resumed→**resubmitted [0, 0]** | 19.4 s | `succeeded` / `success`, attempt 2 |
| `8554f33a` | before-submit | same, then **resubmitted [0, 0]** | 20.9 s | `succeeded` / `success`, attempt 2 |
| `10870776` | after-submit | same, then **already_done [1]** | 13.4 s | `succeeded` / `already_done`, attempt 1 |
| `737f08e5` | after-submit | same, then **already_done [1]** | 20.5 s | `succeeded` / `already_done`, attempt 1 |

## What it shows

- **An outage is deferred, not escalated.** Before reviewer decision 5, each of these verifies would have
  ended `needs_human` / `unreadable` on its first lookup: four human pages for a 30 s blip.
- **Deferrals do not count toward the crash cap.** Every job went through 4 verify phases. That is more than
  T6.6's cap of 3, which counts only *dead* phases (crashed, lease lost, illegal transition). None of these
  died, so none escalated to `verify_exhausted`.
- **No decision without a readable history.** No `[0, 0]` was read during the outage. Both resubmits
  happened after the bank came back and read 0 twice, and the two `already_done` jobs read their rows.
  The oracle confirms exactly one row per job.
- **The cost is up to one backoff of latency.** With the defaults the third deferral backs off 20 s, so
  jobs were decided 13–21 s after the bank came back. A deployment that needs faster resumption can lower
  `ROTE_VERIFY_DEFER_BACKOFF_SECONDS`. The budget (600 s from the first deferral) bounds how long an outage
  is waited out before a human is asked (`verify_unavailable`); the DB tests cover that path.

The script checks all of this, per job: the fault fired; attempt 1 belonged to a distinct fault worker;
the job ends as its fault point implies; there is at least one deferral; the first verify phase started
inside the outage window and the deciding phase ended after it (database clock); no phase was escalated or
exhausted. Run-wide, it checks the oracle and one ledger row per job. It also scans every text file for
the three fake passwords: none found.

The integration test `verify.db.test.ts` runs the same pattern with an 8 s outage on every `npm test`.
This folder is the 30 s run the reviewer asked for, with child-process workers.

## Files

`summary.md` (the table, generated), `check.txt` (the harness's timeline, the oracle report and the
summary), `stdout.txt`, `jobs.json`, `attempts.json`, `verifications.json` (every phase with its reason,
decision, lookups and times), `ledger.json`, `oracle.json` / `oracle.txt`, the worker logs
(`worker-fault-<i>.log`, `worker-clean-<i>.log`), and `worker-evidence/` (every transfer and lookup run,
the 503 pages included).
