-- 0006_crash_budget: crashes stop using attempts (docs/plans/step-10.md, "Reviewer decision during 10b: the
-- bank-fault+kills failure", 2026-11-17; D57). Forward-only: 0001-0005 are never edited.
--
-- A job now has TWO budgets:
--   attempts  the job's OWN failures: a run that ended badly before its intent (T4: requeued with a backoff,
--             or failed), or an attempt that reached its intent and was verified not committed (T7:
--             resubmitted / exhausted). max_attempts, as before (default 3).
--   crashes   worker deaths BEFORE the commit intent: a lease that expired in `running`, recovered by T6.1
--             (requeued at once) or, on reaching the cap, T6.2 (failed / crash_limit). max_crashes, default 5,
--             so a poison job (one that kills every worker that runs it) ends visibly instead of looping.
-- A lease that expires AFTER the intent is not a crash: it is verified (T6.4) exactly as before, and its
-- attempt stays one of the job's own.
--
-- `attempt` still counts every lease (job_attempts.attempt is UNIQUE per job: it is the lease's number), so
-- the job's own attempts are attempt - crashes (src/fleet/stateMachine.ts ownAttempts).

ALTER TABLE jobs ADD COLUMN crashes int NOT NULL DEFAULT 0 CHECK (crashes >= 0);
ALTER TABLE jobs ADD COLUMN max_crashes int NOT NULL DEFAULT 5 CHECK (max_crashes BETWEEN 1 AND 20);
-- Every crash is a lease that died: never more crashes than leases.
ALTER TABLE jobs ADD CONSTRAINT jobs_crashes_are_leases CHECK (crashes <= attempt);

-- 0001's reviewer decision 6 (every queued job is dequeueable), in the two budgets: a queued job has an own
-- attempt left AND is under its crash cap. The first keeps 0001's name (the tests and the docs refer to it).
ALTER TABLE jobs DROP CONSTRAINT jobs_queued_has_attempts_left;
ALTER TABLE jobs ADD CONSTRAINT jobs_queued_has_attempts_left CHECK (state <> 'queued' OR attempt - crashes < max_attempts);
ALTER TABLE jobs ADD CONSTRAINT jobs_queued_under_crash_cap CHECK (state <> 'queued' OR crashes < max_crashes);
