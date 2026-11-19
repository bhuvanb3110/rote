# Day-2 exit: chaos at scale, the 20-seed batch

**RESULT: PASS WITH 1 ESCALATION BY CRASH CAP (ATTRIBUTED).** 20 of 20 seeds passed their family judge.
10,000 jobs, 1,582 kills, **0 DUPLICATE, 0 LOST**. 9,999 jobs succeeded and 1 ended `needs_human` /
`crash_limit` with **0 ledger rows**; every one of its 5 deaths is a scheduled kill. This is not reported as a
plain pass (the reviewer decision during 10b, decision 3).

## What the batch is

The builder's overnight run of the **standard family** on commit `9d38bb2`, with one command:

```
npm run chaos-seeds -- --seeds 20 --jobs 500 --out evidence/chaos/day2-exit-final
```

- **Each seed:** 500 transfer jobs, 4 workers, and an 800 s schedule. Workers are killed every 5–15 s
  (`docker kill --signal=KILL`, restarted 2 s later) and one is frozen once for 45 s (`docker pause`). There
  are no bank faults.
- **Draining:** each seed drains until every job is **settled** (D50: terminal, and its reconcile done if one
  was due). Then the ledger oracle (D32) judges every job by the mock bank's own ledger, and the family judge
  (D56, D58) runs.
- **The seeds:** all 20 were saved in `seeds.json` before the run (committed in `9d38bb2`). Seeds 1–2 are the
  same two as in [`../day2-exit/`](../day2-exit/README.md) (before D58) and
  [`../day2-exit-after-d58/`](../day2-exit-after-d58/README.md). None was re-drawn or dropped.
- **The run:** 2026-11-19 02:48–07:24 UTC (4 h 36 min), about 14 min per seed. It was not interrupted:
  `runner-log.jsonl` has one start and one end per seed and no set-aside run. Every seed exited 0 except
  seed 20, which exited 3 ("PASS with an attributed escalation").

The runner wrote everything in this folder **except this README** (`seeds.json` and the earlier version of
this README came from `9d38bb2`). Nothing it wrote was edited after the run.

- [`tally.md`](tally.md) and `tally.json` are the generated tally.
- Each `seed-NN-<seed>/` holds one seed's evidence: `check.txt` (the report), `summary.json`, the `jobs` /
  `attempts` / `verifications` tables, the bank's `ledger.json`, `oracle.json`, `events.jsonl` (each kill and
  pause, as executed), `schedule.json`, the container logs and `docker stats`.

**Checked before it was committed** by [`../../step-11/check-day2-exit-final.mjs`](../../step-11/check-day2-exit-final.mjs),
output in [`../../step-11/day2-exit-final-check.txt`](../../step-11/day2-exit-final-check.txt), `RESULT: PASS`.
The script checks that:

- the folder has 20 seed folders and no stray, `.interrupted` or `.rerun` folder, and every `summary.json` and
  `check.txt` is stamped `9d38bb2` (with no `+dirty`);
- every cell of `tally.md` matches its seed's `summary.json`, and `tally.json` and the recovery-kind table are
  the sums of the 20 summaries;
- a recount from the raw `jobs.json` and `ledger.json`, rather than `oracle.json`, gives the same verdicts and
  final states;
- each of the escalated job's 5 deaths appears again in `events.jsonl`, inside that holder's lease.

## The totals

| | |
| --- | --- |
| Jobs | **10,000** (20 × 500) |
| Kills | **1,582** (73–83 per seed), plus one 45 s pause per seed |
| Ledger rows | 9,999 |
| Oracle verdicts | ok 10,000; **DUPLICATE 0**; **LOST 0**; MISSING_COMMIT 0; UNRECORDED_COMMIT 0; MISMATCH 0; ORPHAN 0 |
| Final states | **9,999 `succeeded`** (9,910 `success`, 89 `already_done`); **1 `needs_human` / `crash_limit`, attributed**; 0 `failed`; 0 `business_outcome`; 0 not settled |
| Seeds | 19 PASS; 1 (seed 20) PASS with 1 escalation by crash cap (attributed) |

## Recovery kinds, across all 20 seeds (reviewer decision 8)

| Kind | Total | Seeds with it |
| --- | --- | --- |
| Requeued after a crash, no attempt used (T6.1, D57) | 548 | 20 |
| Requeued after a failure, with a backoff (T4, D49) | 0 | 0 |
| Failed by recovery at the crash cap (T6.2 `crash_limit`) | 0 | 0 |
| Expired commit claimed to verify (T6.4) | 99 | 20 |
| Dead verifier re-claimed (T6.5) | 6 | 4 |
| Deferred verify resumed (T6.7) | 0 | 0 |
| Escalated at the crash cap after the intent (T6.6 `crash_limit`, D58) | 1 | 1 |
| Own uncertain run verified (T5) | 0 | 0 |
| Verify: `already_done` | 89 | 20 |
| Verify: `resubmitted` | 9 | 7 |
| Verify: `not_committed_final` / deferred / escalated | 0 / 0 / 0 | 0 |
| Reconcile: `reconciled` | 9 | 7 |
| Reconcile: `duplicate_suspected` / `unrecorded_commit_suspected` / `reconcile_unreadable` / `reconcile_deferred` | 0 / 0 / 0 / 0 | 0 |

The rows with 0 are expected:

- **No requeue with a backoff, no deferral:** the standard family has no bank faults, so no job failed on
  its own and the bank never became unavailable.
- **No T5:** no run that survived its Submit came back uncertain.

**The resubmit path was exercised:** 9 verifies read `[0, 0]` and resubmitted, in 7 seeds. Each of those 9
jobs then succeeded with exactly 1 ledger row, and its reconcile read `[1]`. 99 workers died
after their commit intent. 89 of those jobs had already committed (`already_done`) and 9 had not
(`resubmitted`). The remaining one is the escalation below.

## The escalation: seed 20, job `9e1d23f4-853e-4e32-a662-23e03f7d1e95`

A `tenant-b` transfer of $1.00 from member 10001 to 10002, memo key `rote-9e1d23f4-853e-4e32-a662-23e03f7d1e95`.

| # | Who held the job | Held from | Killed at | Into the hold | Recovery that found it |
| --- | --- | --- | --- | --- | --- |
| 1 | attempt 1, `rote-worker-1` | 07:14:06.070 (intent at 07:14:07.875) | 07:14:08.486 (t = 164.8 s) | 2.4 s, **0.6 s after the intent** | T6.4: verify |
| 2 | verify phase, `rote-worker-1` | 07:14:38.059 | 07:14:41.611 (197.9 s) | 3.6 s | T6.5: re-claim |
| 3 | verify phase, `rote-worker-2` | 07:15:08.625 | 07:15:13.854 (230.2 s) | 5.2 s | T6.5: re-claim |
| 4 | verify phase, `rote-worker-2` | 07:15:38.746 | 07:15:39.814 (256.1 s) | 1.1 s | T6.5: re-claim |
| 5 | verify phase, `rote-worker-3` | 07:16:09.407 | 07:16:13.843 (290.2 s) | 4.4 s | T6.6: **crash cap 5/5 → `needs_human` / `crash_limit`** |

(UTC, 2026-11-19. Sources: `seed-20-1374298332/jobs.json`, `attempts.json`, `verifications.json`,
`events.jsonl`, and the attribution in `check.txt` / `summary.json`.)

**What it means.** The worker that ran the transfer died 0.6 s after writing its commit intent, so the Submit
may or may not have reached the bank. The fleet did what D38/D42 say: it did not retry. It tried to verify in
the bank's history instead. A verify phase needs about 7 s (a lookup, the 5 s settle, a second lookup), but
each of the four verifiers was killed 1.1–5.2 s into its phase, before it had recorded a single lookup
(`lookups: null` on all four rows).

That made five worker deaths on one job, which is the crash cap (D58). Past its intent, a job at the cap is
never `failed`, because money may have moved. The fleet stops and parks it **`needs_human` / `crash_limit`**,
with the reason in `error`: "the Submit may have committed; check the bank's history for memo_key". It does
not loop and it does not guess.

**Why it is chaos-level bad luck, not a poison job.** Every death matches a scheduled `docker kill` of that
worker's container in `events.jsonl`. No worker died on this job of its own accord. Between t = 160 s and
295 s the schedule put 16 kills on the fleet, 15 of them on workers 1–3, because worker 4 was paused from
191.7 s to 236.7 s and kills drawn for it were redirected (`src/chaos/schedule.ts`). In that window each of
workers 1–3 was killed about every 27 s, against about every 40 s per worker over the whole run. The 10b plan estimated 0.05–0.16
such escalations per 20 seeds under the cap of 5 (P(at least one) ≈ 5–15%). One was observed. The standard
family accepts it only because the attribution is complete and the ledger has at most 1 row (D58). Any
unattributed death, or a second row, would have failed the seed.

**Its ledger count is 0.** The bank never recorded the transfer: no row carries its memo key in the ledger read
at the end of the run, about 8 minutes after the intent (no history lag is injected in this family). So no
money moved, and the job is not a duplicate. Counted against the bank, it is a transfer that has **not yet
happened**.

**What a human would do with it.** In production the operator cannot read `/control/ledger` (it is the test
oracle's), so they would go through the bank:

1. Look in tenant-b's transfer history for member 10001, for the memo `rote-9e1d23f4-…` (the job's
   `memoKey`). Here they would find none, which agrees with the ledger.
2. Hand the job back to verify rather than re-run it by hand:

   ```
   npm run jobs -- reverify 9e1d23f4-853e-4e32-a662-23e03f7d1e95 --tenant tenant-b --by <operator>
   ```

   `crash_limit` after an intent is reverifiable (D58). The next worker's recovery verifies the job in the
   bank's history. With no transfer there, it would read `[0, 0]` and resubmit once (T7). The job would then
   succeed with exactly 1 row, and the reconcile pass would read it again.
3. Check the job is healthy before reverifying it. `reverify` does not reset the crash count (5/5), so one
   more worker death on this job would escalate it again at once. That is right for a real poison job. Here,
   the deaths were the chaos schedule's.

If the operator had found one matching transfer in step 1, the reverify would end it `succeeded` /
`already_done` with nothing resubmitted. Two or more matches would be `ambiguous`, which only a person can
resolve.

This run did not reverify the job: the chaos harness stops the fleet when it finishes, and the batch records
the state the fleet left. The reverify path itself is tested (`src/worker/verifySql.db.test.ts`,
`src/worker/verify.db.test.ts`).
