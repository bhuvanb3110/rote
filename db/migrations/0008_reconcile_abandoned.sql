-- 0008_reconcile_abandoned: the reviewer's confirmation of the D58 readings (2026-11-18), reading 2
-- (docs/plans/step-10.md, D59).
--
-- A reconciler's death (its reconcile lease expired with its phase still open) is NOT one of the job's
-- crashes: jobs.crashes (D58) is the budget of the job's own work, which is over; a reconcile only reads the
-- bank's history. It is counted apart, in reconcile_crashes, by the claim that closes the dead phase
-- `crashed` (the workers' pass, R1, or the end-of-day batch). Once reconcile_crashes reaches the job's crash
-- cap (max_crashes, default 5), the workers' pass stops reconciling the job (R3): it keeps its terminal state
-- (and its outcome, result and error) and gets reconcile_abandoned_at; the worker logs it at error level and
-- counts it (reconcile_abandoned_total). The end-of-day batch, `rote reconcile --since`, still re-reads it.
ALTER TABLE jobs ADD COLUMN reconcile_crashes int NOT NULL DEFAULT 0 CHECK (reconcile_crashes >= 0);
ALTER TABLE jobs ADD COLUMN reconcile_abandoned_at timestamptz;
-- Abandoned only at the cap, and only a job the reconcile pass was marked for.
ALTER TABLE jobs ADD CONSTRAINT jobs_reconcile_abandoned_at_cap CHECK (reconcile_abandoned_at IS NULL OR reconcile_crashes >= max_crashes);
ALTER TABLE jobs ADD CONSTRAINT jobs_reconcile_abandoned_was_marked CHECK (reconcile_abandoned_at IS NULL OR reconcile_after IS NOT NULL);

-- The pass's claim (RECONCILE_CLAIM_SQL) now skips an abandoned job: the due index says so too.
DROP INDEX jobs_reconcile_due;
CREATE INDEX jobs_reconcile_due ON jobs (reconcile_after, id)
  WHERE state IN ('succeeded', 'failed', 'business_outcome') AND reconcile_after IS NOT NULL
    AND reconciled_at IS NULL AND reconcile_abandoned_at IS NULL;
