# Day-2 exit: chaos at scale, seeds 1–2 again, after D58

`npm run chaos-seeds -- --seeds 2 --jobs 500 --out evidence/chaos/day2-exit-after-d58`, with the same two
seeds (the batch's `seeds.json`, copied from [`../day2-exit/`](../day2-exit/README.md)). It runs the standard
family: 500 transfer jobs, 4 workers, an 800 s schedule with a kill every 5–15 s and one 45 s `docker pause`,
drained until every job is settled, then the ledger oracle and the family judge. It ran 2026-11-18 on a clean
`d84b556`: D58 (one crash budget per job) and its 12/12 mutation check. `tally.md` is the runner's own tally,
not edited. The failing run before D58 stays committed in [`../day2-exit/`](../day2-exit/README.md).

**RESULT: PASS (2 of 2).**

| # | seed | run | kills | oracle | needs_human | failed | settled | result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 2080386450 | before D58 (`0a30ac0`) | 78 | ok=500, 0 DUPLICATE, 0 LOST | **1** (`verify_exhausted`) | 0 | 500/500 | **FAIL** |
| 1 | 2080386450 | **after D58** (`d84b556`) | 78 | ok=500, 0 DUPLICATE, 0 LOST | 0 | 0 | 500/500 | **PASS** |
| 2 | 1980443797 | before D58 (`0a30ac0+dirty`) | 83 | ok=500, 0 DUPLICATE, 0 LOST | 0 | 0 | 500/500 | PASS |
| 2 | 1980443797 | **after D58** (`d84b556`) | 83 | ok=500, 0 DUPLICATE, 0 LOST | 0 | 0 | 500/500 | **PASS** |

## What the re-run shows, and what it cannot

- **The same seed is the same schedule, not the same interleaving.** Each seed kills the same replicas at the
  same moments, but which job a kill lands on depends on timing. Seed 1's job `1ba81fdf` was not hit the same way
  again (41 T6.1 recoveries this time, 56 before). The proof that D58 decides **that** job differently is the
  deterministic replay of its exact history in `src/fleet/stateMachine.property.test.ts`: 4 deaths are under the
  cap of 5, so it is verified and `already_done`. That replay also catches mutant 12, the separate cap of 3. This
  run shows the batch passes on the new code under the same schedules.
- **Dead verifiers, decided this time.** In seed 2, 3 verify phases claimed after an expired commit (T6.4) were
  killed mid-verify. Each was re-claimed (T6.5) and decided `already_done` with 1 row. The crash budget counted
  every death: 68 crashes on 59 jobs, at most 3 on one job, none at the cap of 5.
- **D57 at work.** In seed 2, 2 jobs were leased past `max_attempts` (3): their crashes before the intent used
  no attempt. 0 jobs failed.
- **The resubmit path.** In seed 2, 1 verify read `[0, 0]` and resubmitted. Its job succeeded on attempt 2 and
  the reconcile pass read 1 row (`reconciled`).
- **No escalation by crash cap.** No job reached the cap. The tally's "escalated by crash cap (attributed)"
  section is empty, so this is a plain PASS and the runner exited 0.

## Notes

- Both seeds ran on a clean tree (`d84b556`, no `+dirty`). Nothing tracked was edited during the batch.
- The reconcile-pass change D59 (reconciler deaths counted apart, `reconcile_abandoned`) came after this run.
  It changes only how the pass behaves after `max_crashes` dead reconcilers on one job. This run had 1
  reconcile and 0 dead reconcilers, so it would have played out the same.
