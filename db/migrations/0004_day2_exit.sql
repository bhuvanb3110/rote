-- 0004_day2_exit: Step 10, the Day-2 exit (docs/plans/step-10.md sections 1 and 2, reviewer decisions
-- 2026-11-14; D49-D50). Forward-only: 0001-0003 are never edited. One migration for all of Step 10's
-- schema: the requeue backoff and the reconcile pass.

-- Requeue backoff (section 1, reviewer decision 2: option B). A queued job is not dequeued before
-- not_before (database clock, D22); NULL = at once. Only T4's requeue after a failure sets it
-- (10 s x 3^(attempt-1), jittered, capped at 120 s); a crash requeue (T6.1) and a verified resubmit (T7)
-- leave it NULL, and the dequeue that leases the job clears it.
ALTER TABLE jobs ADD COLUMN not_before timestamptz;
ALTER TABLE jobs ADD CONSTRAINT jobs_not_before_only_queued CHECK (state = 'queued' OR not_before IS NULL);

-- The reconcile pass (section 2, R1/R2; reviewer decisions 3 and 5). A job that SUCCEEDED AFTER A
-- RESUBMIT (it has a 'resubmitted' verify phase) is the only one that can carry a zombie's late second
-- transfer, so it is re-read in the bank's history once, after lease + settle + margin:
--   reconcile_after  set by T4 / T7 when such a job succeeds (now() + the delay); moved by a deferral
--   reconciled_at    set when the reconcile pass DECIDED (reconciled, duplicate_suspected or
--                    reconcile_unreadable); a job is "settled" once it is terminal and either has no
--                    reconcile_after or a reconciled_at (GET /jobs/:id `settled`)
-- The reconcile lease lives in lease_owner / lease_expires_at on the succeeded row (jobs_lease_pair
-- holds; jobs_active_has_owner does not apply to succeeded); T6 only looks at active states.
ALTER TABLE jobs ADD COLUMN reconcile_after timestamptz;
ALTER TABLE jobs ADD COLUMN reconciled_at   timestamptz;
CREATE INDEX jobs_reconcile_due ON jobs (reconcile_after, id)
  WHERE state = 'succeeded' AND reconcile_after IS NOT NULL AND reconciled_at IS NULL;

-- A reconcile run is a job_verifications row with reason 'reconcile' (its own fencing token, like a
-- verify phase), and four decisions:
--   'reconciled'           exactly 1 match: the job stays succeeded
--   'duplicate_suspected'  2+ matches: needs_human, duplicates_detected_total + 1, an error-level log line
--   'reconcile_unreadable' 0 matches, or a history it cannot read: needs_human (a succeeded job whose
--                          transfer the history cannot show is itself an alarm)
--   'reconcile_deferred'   the bank was unavailable: reconcile_after moves by a backoff (D44's backoff and
--                          budget; past the budget -> reconcile_unreadable)
ALTER TABLE job_verifications DROP CONSTRAINT job_verifications_reason_check;
ALTER TABLE job_verifications ADD CONSTRAINT job_verifications_reason_check CHECK (reason IN (
  'lease_expired_in_committing', 'lease_expired_in_verifying', 'commit_uncertain', 'resumed', 'reconcile'));
ALTER TABLE job_verifications DROP CONSTRAINT job_verifications_decision_check;
ALTER TABLE job_verifications ADD CONSTRAINT job_verifications_decision_check CHECK (decision IN (
  'already_done', 'resubmitted', 'not_committed_final', 'escalated', 'exhausted', 'lease_lost', 'crashed',
  'deferred', 'handed_off', 'illegal_transition',
  'reconciled', 'duplicate_suspected', 'reconcile_unreadable', 'reconcile_deferred'));
-- A reconcile decision only on a reconcile row; a reconcile row ends with one of them, or dead like any
-- phase (crashed: its reconciler's lease expired; lease_lost; illegal_transition).
ALTER TABLE job_verifications ADD CONSTRAINT job_verifications_reconcile_decisions CHECK (
  CASE WHEN reason = 'reconcile'
       THEN decision IS NULL OR decision IN ('reconciled', 'duplicate_suspected', 'reconcile_unreadable', 'reconcile_deferred',
                                             'crashed', 'lease_lost', 'illegal_transition')
       ELSE decision IS NULL OR decision NOT IN ('reconciled', 'duplicate_suspected', 'reconcile_unreadable', 'reconcile_deferred')
  END);
