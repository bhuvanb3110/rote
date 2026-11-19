-- 0003_verify: Step 9, verify (docs/plans/step-09.md, reviewer decisions 2026-11-11; D42-D46).
-- Forward-only: 0001_init.sql and 0002_day2.sql are never edited. 0002 created job_verifications for
-- Step 9; Step 9 adds the values the reviewer's "bank unavailable is not ambiguous" decision and the
-- reverify hand-off need, and one consistency rule.

-- Why a phase started. New: 'resumed' -- a phase that resumes a deferred verify (T6.7) or one handed
-- over by `rote jobs reverify`. ('commit_uncertain' and 'lease_expired_in_committing' start a verify
-- cycle; 'lease_expired_in_verifying' and 'resumed' continue one.)
ALTER TABLE job_verifications DROP CONSTRAINT job_verifications_reason_check;
ALTER TABLE job_verifications ADD CONSTRAINT job_verifications_reason_check CHECK (reason IN (
  'lease_expired_in_committing', 'lease_expired_in_verifying', 'commit_uncertain', 'resumed'));

-- How a phase ended. New:
--   'deferred'           the bank was unavailable: the job stays verifying and is resumed after a
--                        backoff (T8, then T6.7); never counts toward the 3-phase crash cap (T6.6)
--   'handed_off'         written by `rote jobs reverify`: the job is handed to recovery, which resumes it
--   'illegal_transition' the verifier's own T7/T8 was refused with its token unchanged (a bug, D41)
ALTER TABLE job_verifications DROP CONSTRAINT job_verifications_decision_check;
ALTER TABLE job_verifications ADD CONSTRAINT job_verifications_decision_check CHECK (decision IN (
  'already_done', 'resubmitted', 'not_committed_final', 'escalated', 'exhausted', 'lease_lost', 'crashed',
  'deferred', 'handed_off', 'illegal_transition'));

-- A phase is open (no decision, no end) or ended (both). Recovery's 'crashed', a verifier's
-- 'lease_lost', T7, T8 and the reverify hand-off all set the two together.
ALTER TABLE job_verifications ADD CONSTRAINT job_verifications_decided_has_end CHECK ((decision IS NULL) = (ended_at IS NULL));
