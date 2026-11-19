-- 0002_day2: Day 2 crash safety (docs/plans/step-08.md section 1, approved 2026-11-11).
-- Forward-only: 0001_init.sql is never edited. One migration for all of Day 2 (Steps 8-10): Step 8
-- uses the index and job_attempts.commit_intent_at; job_verifications is written from Step 9 on.

-- Recovery (T6) scans expired leases by state, oldest first. Partial, so it holds only active rows.
CREATE INDEX jobs_lease_expiry ON jobs (lease_expires_at, id)
  WHERE state IN ('running', 'committing', 'verifying');

-- Which attempt wrote a commit intent (evidence; recovery decides from jobs.commit_intent_at).
ALTER TABLE job_attempts ADD COLUMN commit_intent_at timestamptz;

-- One row per verify phase (Step 9). A verify is not a new attempt of the transfer (attempt counts
-- clicks of Submit), so it gets its own table; each verify phase has its own fencing token.
CREATE TABLE job_verifications (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id         uuid   NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  fencing_token  bigint NOT NULL CHECK (fencing_token >= 1),
  worker_id      text   NOT NULL,
  -- Why the job is being verified.
  reason         text   NOT NULL CHECK (reason IN ('lease_expired_in_committing', 'lease_expired_in_verifying', 'commit_uncertain')),
  -- The ReplayResult status the transfer attempt ended with, when it ended at all (decides what 0 matches means).
  prior_status   text   CHECK (prior_status IN ('business_outcome', 'failure', 'needs_human')),
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- Matches seen by each lookup, in order: {1} or {0,0} or {0,1} ...; a NULL entry = unreadable.
  lookups        int[],
  decision       text CHECK (decision IN ('already_done', 'resubmitted', 'not_committed_final', 'escalated', 'exhausted', 'lease_lost', 'crashed')),
  error          text,
  CONSTRAINT job_verifications_job_token_key UNIQUE (job_id, fencing_token)
);
