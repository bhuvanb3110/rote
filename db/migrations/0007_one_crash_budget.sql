-- 0007_one_crash_budget: one crash budget per job (docs/plans/step-10.md, "Reviewer decision during 10b: one
-- crash budget, and the attributed escalation", 2026-11-18; D58). Forward-only: 0001-0006 are never edited.
--
-- 0006 counted only the deaths BEFORE the commit intent (T6.1 / T6.2) in jobs.crashes, and a verify cycle had its
-- own cap of 3 dead phases (T6.6). The first chaos batch at 500 jobs escalated a job whose 3 verifiers were all
-- killed: at chaos's kill rate that is ~1% of verify cycles. Now every worker death counts against ONE budget:
--   jobs.crashes        every worker death on the job: a lease that expired in `running` (T6.1 / T6.2), in
--                       `committing` (T6.4) or in a verify phase that died (T6.5 / T6.6). Capped by max_crashes:
--                       before any intent the job fails / crash_limit; after one it goes to needs_human /
--                       crash_limit (the Submit may have committed).
--   jobs.lease_crashes  the deaths BEFORE the intent only (T6.1 / T6.2): the leases that are not the job's own
--                       attempts. Own attempts = attempt - lease_crashes.
-- A death after the intent is still one of the job's own attempts (verify decides whether it is retried).

ALTER TABLE jobs ADD COLUMN lease_crashes int NOT NULL DEFAULT 0 CHECK (lease_crashes >= 0);
-- Until 0007 every crash was a death before the intent.
UPDATE jobs SET lease_crashes = crashes;

-- 0006's "every crash is a lease" holds for lease_crashes only: a verifier's death is not one of the job's leases.
ALTER TABLE jobs DROP CONSTRAINT jobs_crashes_are_leases;
ALTER TABLE jobs ADD CONSTRAINT jobs_lease_crashes_are_leases CHECK (lease_crashes <= attempt);
ALTER TABLE jobs ADD CONSTRAINT jobs_lease_crashes_are_crashes CHECK (lease_crashes <= crashes);

-- Own attempts are counted on lease_crashes now (same name as 0001 / 0006); jobs_queued_under_crash_cap
-- (crashes < max_crashes) is unchanged and now covers every death.
ALTER TABLE jobs DROP CONSTRAINT jobs_queued_has_attempts_left;
ALTER TABLE jobs ADD CONSTRAINT jobs_queued_has_attempts_left CHECK (state <> 'queued' OR attempt - lease_crashes < max_attempts);
