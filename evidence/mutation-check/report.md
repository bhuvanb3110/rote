# Mutation check: 2026-11-14T16:30:36.583Z

Each planted bug is a patch in `scripts/mutations/`; it must turn its tests red, and the tree must be exactly as before afterwards.

| Mutant | What it plants | Tests run | Verdict | Failing tests |
| --- | --- | --- | --- | --- |
| 01 `01-t6-requeues-committing.patch` | Step 8 / Step 9's M2: recovery requeues an expired `committing` job (a blind retry after the intent) | `stateMachine.property.test.ts`, `stateMachine.test.ts` | caught | 18 |
| 02 `02-t2-revives-expired-lease.patch` | Step 8: the heartbeat (T2) extends a lease that already expired (no `lease_expires_at > now()`) | `modelVsReal.db.test.ts` | caught | 2 |
| 03 `03-t6-no-token-bump.patch` | Step 8: recovery (T6.1/T6.2/T6.6) does not bump the fencing token | `modelVsReal.db.test.ts` | caught | 2 |
| 04 `04-m1-single-zero-decides.patch` | Step 9's M1: one 0-match lookup decides (no settle, no second lookup) | `stateMachine.property.test.ts` | caught | 10 |
| 05 `05-m3-zero-one-not-committed.patch` | Step 9's M3: lookups [0, 1] read as not committed | `stateMachine.property.test.ts` | caught | 3 |
| 06 `06-m4-refusal-retried.patch` | Step 9's M4: a refusal shown after Submit is retried instead of final | `stateMachine.property.test.ts` | caught | 1 |
| 07 `07-reconcile-ignores-duplicates.patch` | Step 10: the reconcile pass reads 2+ matches as reconciled (the duplicate stays silent) | `stateMachine.property.test.ts`, `stateMachine.test.ts` | caught | 8 |
| 08 `08-t4-requeue-without-not-before.patch` | Step 10: T4's requeue after a failure sets no not_before (retries do not back off) | `modelVsReal.db.test.ts`, `complete.db.test.ts` | caught | 3 |

Caught: 8/8.

RESULT: PASS
