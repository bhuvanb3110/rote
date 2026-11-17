# Mutation check: 2026-11-17T18:45:07.361Z

Each planted bug is a patch in `scripts/mutations/`; it must turn its tests red, and the tree must be exactly as before afterwards.

| Mutant | What it plants | Tests run | Verdict | Failing tests |
| --- | --- | --- | --- | --- |
| 01 `01-t6-requeues-committing.patch` | Step 8 / Step 9's M2: recovery requeues an expired `committing` job (a blind retry after the intent) | `stateMachine.property.test.ts`, `stateMachine.test.ts` | caught | 25 |
| 02 `02-t2-revives-expired-lease.patch` | Step 8: the heartbeat (T2) extends a lease that already expired (no `lease_expires_at > now()`) | `modelVsReal.db.test.ts` | caught | 2 |
| 03 `03-t6-no-token-bump.patch` | Step 8: recovery (T6.1/T6.2/T6.6) does not bump the fencing token | `modelVsReal.db.test.ts` | caught | 2 |
| 04 `04-m1-single-zero-decides.patch` | Step 9's M1: one 0-match lookup decides (no settle, no second lookup) | `stateMachine.property.test.ts` | caught | 13 |
| 05 `05-m3-zero-one-not-committed.patch` | Step 9's M3: lookups [0, 1] read as not committed | `stateMachine.property.test.ts` | caught | 2 |
| 06 `06-m4-refusal-retried.patch` | Step 9's M4: a refusal shown after Submit is retried instead of final | `stateMachine.property.test.ts` | caught | 1 |
| 07 `07-reconcile-ignores-duplicates.patch` | Step 10: the reconcile pass reads 2+ matches as reconciled (the duplicate stays silent) | `stateMachine.property.test.ts`, `stateMachine.test.ts` | caught | 9 |
| 08 `08-t4-requeue-without-not-before.patch` | Step 10: T4's requeue after a failure sets no not_before (retries do not back off) | `modelVsReal.db.test.ts`, `complete.db.test.ts` | caught | 3 |
| 09 `09-reconcile-ignores-unrecorded-commits.patch` | Step 10b (D55): the reconcile reads 1+ matches on a failed / business_outcome job as reconciled (the unrecorded commit stays silent) | `stateMachine.property.test.ts`, `stateMachine.test.ts` | caught | 9 |
| 10 `10-reconcile-marks-only-resubmitted.patch` | Step 10b (D55): only a `resubmitted` verify marks a terminal job for the reconcile pass (a T6.4 [0, 0] that fails the job outright, `exhausted`, is never re-read) | `stateMachine.property.test.ts` | caught | 3 |

Caught: 10/10.

RESULT: PASS
