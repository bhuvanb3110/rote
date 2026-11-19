# Chaos run, Step 9 (verify): RESULT: PASS, nothing left for a human

```
npm run chaos -- --seed 14449393 --out evidence/chaos/step-09-seed-14449393
```

Seed **14449393** was drawn with the harness's own `drawSeed()` before the run. The same seed reproduces
the same schedule, not the same interleaving (D33). The code was Step 9 (`5416f60` plus the harness's
Step 9 report lines, committed with this folder), and the harness rebuilt the image. Settings: lease 30 s,
heartbeat 10 s, settle 5 s; 100 transfer jobs (tenants a/b/c round-robin) on 4 workers. The schedule:
**14** `docker kill --signal=KILL`s 5–15 s apart over 150 s, each victim restarted 2 s later by the
harness, and one 45 s `docker pause` of `rote-worker-3` (69.6 s → 113.7 s). Drain timeout 10 min. Wall
time 265 s. Workers, API and bank were stopped at the end.

**Result (`check.txt`): RESULT: PASS.**
- Oracle: `ok=100`; DUPLICATE, LOST, MISSING_COMMIT, UNRECORDED_COMMIT, MISMATCH and ORPHAN all 0.
- 100 ledger rows for 100 jobs.
- **`needs_human` jobs: 0**, a new condition of PASS since Step 9: no bank faults are injected, so every
  job is decidable.
- Final states: 97 `succeeded` / `success`, 3 `succeeded` / `already_done`.
- No worker was OOM-killed (peak 332 MiB), and no credential value appears in any job, attempt, API
  response or container log.

## Before / after

| | Step 8 (`../step-08-seed-848183018/`) | this run (Step 9) |
| --- | --- | --- |
| Kills / pause | 18 kills, 45 s pause | 14 kills, 45 s pause |
| Oracle | PASS: 100 ok, 0 LOST, 0 duplicates | PASS: 100 ok, 0 LOST, 0 duplicates |
| A job killed after its intent | parked `needs_human` / `commit_uncertain` (T6.3): 1 job waited for a person | **verified** (T6.4): 3 jobs, each `[1]` → `succeeded` / `already_done` with the bank's row as `confirmationRef`; 0 waiting for a person |
| The pause (zombie) | its lease expired, the job was requeued; on waking its heartbeat aborted the run | the same, see below |

## What happened, from the evidence

- **Recoveries** (`attempts.json`, `verifications.json`): `T6.1 requeue x9` (killed before the intent; requeued
  and finished by another worker on a later attempt) and `T6.4 verify x3`. In the three T6.4 cases a worker
  was killed after its commit intent. Each job's lease expired, a recovering worker claimed it to verify, and
  one lookup found the transfer: `already_done [1]` (phases of 1.4 s, 4.5 s and 8.9 s). No job was retried,
  and each has exactly 1 ledger row.
- **No `resubmitted` this seed.** A resubmit needs a kill between the commit intent and the click: T3's
  COMMIT returning and the Submit dispatch are milliseconds apart (docs/plans/step-08.md section 6), and none
  of the 14 kills landed there. The `[0, 0]` → resubmit path is exercised end to end by
  `../../crash-matrix/step-09/` (`before-submit` and three two-fault scenarios) and
  `../../verify-bank-outage-30s/`. Step 10's 20+ seeds will show how often random kills reach it. This seed
  was not re-drawn to find one.
- **The pause:** `rote-worker-3` was frozen at 69.6 s holding job `0014be44` (running, attempt 1). Its 30 s
  lease expired while it was frozen. `c27d4d21` requeued the job (T6.1) and took it as attempt 2, then was
  itself killed. `8f460f09` requeued it again and finished it as attempt 3 (`success`, 1 row). When the
  container was unpaused at 113.7 s, its overdue heartbeat matched 0 rows 0.18 s later and aborted the run
  ("heartbeat lease lost x1, run aborted on a lost lease x1"), so there was no click. Its attempt row says
  `lease_lost` and keeps recovery's note (`[recovery had recorded: … (T6.1 requeue)]`), which is why that
  first recovery does not appear in the T6.1 tally of 9 (the tally counts rows closed `crashed`).

Files: `check.txt` (the report and the oracle), `stdout.txt`, `seed.txt`, `schedule.json`, `events.jsonl`
(every kill, restart and pause with the jobs the victim held), `jobs.json`, `attempts.json`,
`verifications.json` (new in Step 9), `ledger.json`, `oracle.json`, `submitted.json`, `compose-logs.txt`,
`docker-stats.jsonl`, `worker-inspect.json`, `compose-ps-up.txt` and `compose-ps-end.txt`.
