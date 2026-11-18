# Day-2 exit: chaos at scale (seeds 1–2 of the batch)

`npm run chaos-seeds -- --seeds 2 --jobs 500` (reviewer decision 1): the proof run of the unattended batch. The
standard family (D56): 500 transfer jobs, 4 workers, an 800 s schedule with a kill every 5–15 s and one 45 s
`docker pause`, drained until every job is settled, then the ledger oracle and the family judge. The seeds were
drawn once into `seeds.json`; the builder's 20-seed run keeps these two as seeds 1–2 and appends 18. Run
2026-11-18 on `0a30ac0`. `tally.md` is the runner's own tally, not edited.

**RESULT: FAIL (1 of 2).** Seed 2 passed. Seed 1 failed the family judge on one job left for a human. Both stay
in the tally. The failure is investigated below and is with the reviewer.

| # | seed | kills | oracle | needs_human | failed | settled | result |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2080386450 | 78 | ok=500, 0 DUPLICATE, 0 LOST, 500 ledger rows | **1** (`verify_exhausted`) | 0 | 500/500 | **FAIL** |
| 2 | 1980443797 | 83 | ok=500, 0 DUPLICATE, 0 LOST, 500 ledger rows | 0 | 0 | 500/500 | PASS |

## Seed 1: one job escalated after three of its verifiers were killed

Job `1ba81fdf` (tenant-b), traced from `attempts.json`, `verifications.json` and `events.jsonl` (seconds on the
schedule's clock):

| | holder | from | to | how it ended |
| --- | --- | --- | --- | --- |
| attempt 1 | worker-3 (`d4dbfd1a450d`) | 116.4 s | 139.5 s (killed) | commit intent at 137.0 s, then the kill: the Submit may have gone through |
| verify phase 1 (T6.4) | worker-2 (`828771f3daa5`) | 167.6 s | 170.3 s (killed) | dead, 2.7 s in |
| verify phase 2 (T6.5) | worker-2, restarted | 201.0 s | 212.1 s (killed) | dead, 11.1 s in |
| verify phase 3 (T6.5) | worker-1 (`6c42b3e6387b`) | 231.4 s | 242.1 s (killed) | dead, 10.7 s in |
| T6.6 | worker-1, restarted | 261.8 s | | `needs_human` / `verify_exhausted`: 3 verify phases died without a decision |

Each re-claim waited for the dead phase's 30 s lease. The job's row is in the ledger (500 rows for 500 jobs), so
the transfer did happen once. The oracle lists it as `needs_human` with 1 row (ok). Nothing was duplicated or
lost. The code did what D45 specifies: a verifier that keeps dying is escalated after 3 dead phases, because the
Submit may have committed and only a human can then be sure.

**Why it is not a fluke.** The schedule kills one of 4 replicas every 5–15 s, so each replica dies about every
40 s. A verify phase runs about 3–14 s (decided phases: median 2.9–5.0 s, p90 10.7–14.0 s). In these two seeds
4 of 20 verify phases died (20%); in the first bank-fault+kills run, 3 of 11. Three dead phases in a row is then
about 1% of verify cycles. A 500-job seed has 7–10 verify cycles, so a 20-seed batch should expect one or two
such jobs. The standard family allows no `needs_human` at all (reviewer decision 7), so under the current rules
the 20-seed batch would fail on this alone, not on a duplicate or a lost job.

This is the same shape as the bank-fault+kills failure that D57 fixed (worker deaths consuming a budget meant
for the job's own trouble), on the other side of the intent: T6.6's cap of 3 dead verify phases is a crash cap
for verifiers. The options are with the reviewer (`docs/plans/step-10.md`); no code or expectation was changed
for this run.

## Notes

- **Seed 2's commit reads `0a30ac0+dirty`.** While it ran, `docs/REPO_NOTES.md` (a tracked file) had an
  uncommitted docs draft (27 added lines). No code was changed: `git diff` at the end of the batch shows that
  file only. Seed 1 ran on a clean `0a30ac0`.
- Seed 2 exercised the resubmit path: 2 verify `[0, 0]` → `resubmitted`, each reconciled with 1 row.
