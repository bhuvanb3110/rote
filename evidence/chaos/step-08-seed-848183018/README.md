# Chaos run, Step 8 (leases, heartbeat, fenced intent, recovery): RESULT: PASS

```
npm run chaos -- --seed 848183018 --out evidence/chaos/step-08-seed-848183018
```

Seed **848183018** (drawn with `crypto.randomInt` before the run; the same seed reproduces the same
schedule, not the interleaving, D33). Step 8 code, the image rebuilt by the harness: lease 30 s,
heartbeat 10 s, recovery before every dequeue, the fenced commit intent before every Submit. 100
transfer jobs (tenants a/b/c round-robin), 4 workers, **18** `docker kill --signal=KILL`s 5–15 s apart
over 150 s (each victim restarted 2 s later by the harness), one 45 s `docker pause` of `rote-worker-1`
(47.2 s → 92.2 s), drain timeout 10 min (the default). Workers, API and bank were stopped at the end.

**Result (`check.txt`): RESULT: PASS.** Oracle: `ok=100`, DUPLICATE 0, LOST 0, MISSING_COMMIT 0,
UNRECORDED_COMMIT 0, MISMATCH 0, ORPHAN 0; 100 ledger rows for 100 jobs; the drain finished 8 s after
the schedule ended. 99 `succeeded`, 1 `needs_human` / `commit_uncertain` (with its 1 row). No worker
OOM-killed; no credential value in any job, attempt, API response or container log.

## Before / after

| | `../before-day2/` (Step 7, seed 2024306878) | this run (Step 8, seed 848183018) |
| --- | --- | --- |
| Kills / pause | 15 kills, 45 s pause | 18 kills, 45 s pause |
| Oracle | **FAIL**: 61 ok, **39 LOST** (1 after commit), 0 duplicates | **PASS**: 100 ok, 0 LOST, 0 duplicates |
| A killed worker's job | `running` forever, holding its tenant slot (tenant-a stalled at 16 s, 30 jobs never dequeued) | recovered within lease + one poll: 10 requeued (T6.1) and finished by another worker (attempt 2), 1 killed after its intent escalated (T6.3) |
| The pause (zombie) | no protection exercised: nothing expired the 300 s lease; Playwright's own timeout failed the frozen step on waking | the frozen worker's lease expired at 30 s, another worker requeued and finished its job; on waking, its heartbeat got 0 rows and aborted the run within 0.16 s: no second click |

## What happened, from the evidence

- **Recoveries** (`attempts.json`, rows closed by recovery): `T6.1 requeue x10`, `T6.3 escalate x1`.
  Attempt outcomes: 99 `success`, 11 `crashed`, 1 `lease_lost`. Every requeued job succeeded on
  attempt 2 with exactly one ledger row.
- **The one `needs_human`:** `fd1a73d8` (tenant-a). Its worker (`rote-worker-2`) wrote the commit intent
  at 03:21:09.270, the bank wrote `TXN-000018`, and the kill at 27.4 s (03:21:10.5) landed before the
  completion. 30 s after the intent its lease expired and `212b99934a5e` escalated it (T6.3):
  `needs_human` / `commit_uncertain`, "lease expired after the commit intent: the Submit may have
  committed; check the bank's history for memo_key". Exactly one row: the oracle lists it, ok. **This is
  the Step 8 interim, not the final answer**: Step 9's verify would find that row and record
  `succeeded` / `already_done`.
- **The zombie, frozen before its intent:** `rote-worker-1` leased `387b501a` at 03:21:30.493 (attempt 1,
  token 1) and was frozen at 03:21:30.634, mid-run, before any commit intent. Its lease expired at
  about 03:22:00; `7f1a495a0b76` recovered it (T6.1, token 2) and `212b99934a5e` ran attempt 2 (token 3):
  intent at 03:22:04.286, `TXN-000069`, `succeeded`. At 03:22:15.524 the harness unpaused worker-1; at
  03:22:15.685 its overdue heartbeat matched 0 rows, it aborted the run and wrote only `lease_lost` on
  its attempt row (keeping recovery's note: "… [recovery had recorded: lease expired in running;
  recovered by 7f1a495a0b76-6-37d4 (T6.1 requeue)]"). It then took a new job normally. One ledger row
  for `387b501a`. (Its fenced T3 would have refused too; the heartbeat got there first.)
- **The harness's `heldJobs` snapshots are taken just before `docker kill` / `docker pause`**, which
  take one or two seconds on Docker Desktop. So a snapshot can show a job one step behind: the pause
  event lists `39a407db` as `committing`, but that job completed (`succeeded`, 1 row) at 03:21:30.459,
  before the freeze took effect, and the kills at 85.8 s and 90.6 s list `405b1523` / `bc3e777b` as
  `committing` though both succeeded about a second before their kill. `jobs.json` and `attempts.json`
  are the record; `events.jsonl` is what the harness saw at the time.

## What is still not green until Step 9

- An expired `committing` job ends `needs_human` (here 1 of 100). It is safe (never retried, the oracle
  accepts 0 or 1 row) but it is a person's work; Step 9's verify reads the bank's history and decides.
- The zombie frozen **after** its intent and before the click (the plan's section-6 window) was not hit
  by this seed. In Step 8 it cannot duplicate (an expired `committing` job is never requeued); once
  Step 9 resubmits after a verify, it can, and that is measured deliberately in Step 10
  (`evidence/zombie-window-limit/`, with the reconcile pass that detects it).
- One seed proves little about rare interleavings; Step 10 runs 20+ seeds.

Files: `seed.txt`, `schedule.json`, `events.jsonl`, `check.txt`, `oracle.json`, `jobs.json`,
`attempts.json`, `ledger.json`, `submitted.json`, `docker-stats.jsonl` (peak worker memory 224–319 MiB),
`compose-logs.txt`, `worker-inspect.json`, `compose-ps-*.txt`, `stdout.txt` (the console).
