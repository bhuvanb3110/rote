-- 0005_reconcile_terminal: the reviewer decisions on Step 10a, decision 2 (docs/plans/step-10.md, D55).
-- Forward-only: 0001-0004 are never edited (0004 is applied on every database that ran Step 10a).
--
-- The reconcile pass (D50) re-read only a job that SUCCEEDED after a resubmit. A zombie's late click can
-- also land on a job that ended FAILED or BUSINESS_OUTCOME after a [0, 0] verify (1 row against a job that
-- says no money moved: the oracle's UNRECORDED_COMMIT). So every terminal transition to succeeded, failed
-- or business_outcome of a job on which a verify read [0, 0] (resubmitted, exhausted, not_committed_final)
-- sets reconcile_after, and the reconcile expects 1 row for succeeded and 0 for the other two:
--   'unrecorded_commit_suspected'  a failed / business_outcome job whose history shows 1+ rows: needs_human,
--                                  unrecorded_commits_detected_total + 1, an error-level log line
-- The reconcile lease on a failed / business_outcome row works as on a succeeded one (jobs_lease_pair
-- holds; jobs_active_has_owner does not apply to terminal states; T6 only looks at active states).

-- R1's due scan now covers the three reconcilable terminal states.
DROP INDEX jobs_reconcile_due;
CREATE INDEX jobs_reconcile_due ON jobs (reconcile_after, id)
  WHERE state IN ('succeeded', 'failed', 'business_outcome') AND reconcile_after IS NOT NULL AND reconciled_at IS NULL;

ALTER TABLE job_verifications DROP CONSTRAINT job_verifications_decision_check;
ALTER TABLE job_verifications ADD CONSTRAINT job_verifications_decision_check CHECK (decision IN (
  'already_done', 'resubmitted', 'not_committed_final', 'escalated', 'exhausted', 'lease_lost', 'crashed',
  'deferred', 'handed_off', 'illegal_transition',
  'reconciled', 'duplicate_suspected', 'unrecorded_commit_suspected', 'reconcile_unreadable', 'reconcile_deferred'));

-- 0004's rule, with the new decision: a reconcile decision only on a reconcile row; a reconcile row ends with
-- one of them, or dead like any phase (crashed, lease_lost, illegal_transition).
ALTER TABLE job_verifications DROP CONSTRAINT job_verifications_reconcile_decisions;
ALTER TABLE job_verifications ADD CONSTRAINT job_verifications_reconcile_decisions CHECK (
  CASE WHEN reason = 'reconcile'
       THEN decision IS NULL OR decision IN ('reconciled', 'duplicate_suspected', 'unrecorded_commit_suspected', 'reconcile_unreadable',
                                             'reconcile_deferred', 'crashed', 'lease_lost', 'illegal_transition')
       ELSE decision IS NULL OR decision NOT IN ('reconciled', 'duplicate_suspected', 'unrecorded_commit_suspected', 'reconcile_unreadable',
                                                 'reconcile_deferred')
  END);
