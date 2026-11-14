# Step 10 plan — the Day-2 exit (proposed, not built)

Branch `fleet/day-1`. Reads `docs/plans/step-08.md` (sections 6, 8, 9, 9a and its reviewer decisions) and
`docs/plans/step-09.md` (its reviewer decisions and "Built"). Status: **for review**; nothing here is built.

The brief's Day-2 exit is "all chaos scenarios pass with 0 duplicates and 0 lost jobs, across 5 random-kill
runs", with integration tests for crash-before and crash-after Submit. Amendments 2–3 add: 20+ seeds, 4
workers, the crash-point matrix, the property tests and CI. Step 10 builds what is still missing, runs every
judge at scale, and ends with the checklist that has to be green before the PR from `fleet/day-1` to `main`
opens. Nothing is called done until a script says so and its output is committed.

## 0. What Step 9 changed that Step 10 must account for

- **Migration numbers:** 0003 is verify, so the reconcile migration of step-08 section 9a becomes
  **0004**. One migration carries all of Step 10's schema (sections 1 and 2).
- **`job_verifications`' CHECKs** (reason, decision) were redefined in 0003; 0004 widens them again.
- **The settle rule (D47)** feeds into the reconcile delay (lease + settle + margin).
- **Chaos PASS requires 0 `needs_human`** (no bank faults). The bank-fault runs keep that condition: the
  deferral budget (600 s) far exceeds a 30 s outage.
- **No requeue backoff** (found while writing this plan; step-09 "Built"). A failure before the intent is
  requeued for immediate pickup, so in a 30 s bank outage each attempt fails in about a second and a job
  burns all 3 attempts and ends `failed`. That is safe (0 rows), but it misses the brief's "retries back
  off". Section 1 designs the fix.
- **Suite time is usually 162–176 s, but two of Step 9's nine runs took 243–246 s:** the verify commit's
  run and final run 1, with 591–682 s of cumulative test time against 485–514 s, spread across all tests
  (machine contention). So the 3-minute line of step-09 section 2 is already crossed on a busy machine,
  and the Step 10 crash tests add about 60 s more. The slow integration files move to a `slow` vitest
  project: a reviewed change, never a skip (open question 6).
- **The CI matrix job** runs `--expect step-09` with a 60 s drain, report-only.
- **`scripts/lib/harness.ts` and `scripts/verify-scenarios.ts`** exist; the zombie scenario reuses them.
- **Fixed predictions can be wrong by a lease** (step-09 "Built", reviewer addition 4). Step 10's
  timing-sensitive evidence (the zombie) is judged against measured timings, as the lag runs were.

## 1. Requeue backoff: retries back off (the brief's bank-slow/down row)

**Recommended design (open question 2):** a queued job carries `not_before`, and a requeue after a failure
backs off. Each retry still consumes an attempt (D21 unchanged).

```sql
-- 0004_day2_exit.sql
ALTER TABLE jobs ADD COLUMN not_before timestamptz;      -- a queued job is not dequeued before this; NULL = at once
```

- **Dequeue:** `CLAIM_TENANT_SQL`'s `EXISTS` and its `ORDER BY` subquery, and `PICK_JOB_SQL`, each gain
  `AND (q.not_before IS NULL OR q.not_before <= now())`. Otherwise a tenant whose only queued jobs are not
  yet due would be claimed and then excluded on every loop. Database clock (D22).
- **T4 requeue** (`COMPLETE_JOB_SQL`) gains
  `not_before = CASE WHEN $4 = 'queued' THEN now() + make_interval(secs => $8) END`, where `$8` comes from
  the pure `requeueBackoffSeconds(attempt, random)` = `min(120, 10 · 3^(attempt−1))` × a jitter in
  [0.8, 1.2]. With 3 attempts the retries come at about +10 s and +40 s, which covers a 30 s outage.
- **T6.1** (a crash requeue) and **T7** (a verified `[0, 0]` resubmit) set `not_before = NULL`: neither
  failure was the bank's.
- The model, the property tests (a "bank down for D seconds" event; new property: an outage shorter than
  the backoff schedule fails no job) and the model-vs-real test gain `not_before`.

**Alternatives (for the reviewer):**
- **A.** A bank-unavailable failure before Submit does not consume an attempt. This needs the transfer
  to recognize the 503 page (transfer 1.2.0, re-approval with override digests) and a
  free-attempt count in D21's CHECK (`attempt − free_attempts < max_attempts`). It survives outages of
  any length within a time budget, as verify's deferral does (D44).
- **C.** Bring Day 4's circuit breaker forward (the `breakers` table exists): an open breaker stops
  dequeues for that bank.

B is the smallest change that meets the brief's 30 s scenario. A and C handle long outages; C is Day 4 work
either way.

## 2. The reconcile pass (R3; step-08 section 9a, with exact SQL)

Only a job that **succeeded after a resubmit** can carry a zombie's late second transfer. Each such job is
re-read once, after lease + settle + margin.

```sql
-- 0004_day2_exit.sql (continued)
ALTER TABLE jobs ADD COLUMN reconcile_after timestamptz;  -- set when a job that was resubmitted succeeds
ALTER TABLE jobs ADD COLUMN reconciled_at   timestamptz;
CREATE INDEX jobs_reconcile_due ON jobs (reconcile_after, id)
  WHERE state = 'succeeded' AND reconcile_after IS NOT NULL AND reconciled_at IS NULL;
ALTER TABLE job_verifications DROP CONSTRAINT job_verifications_reason_check;
ALTER TABLE job_verifications ADD CONSTRAINT job_verifications_reason_check CHECK (reason IN (
  'lease_expired_in_committing', 'lease_expired_in_verifying', 'commit_uncertain', 'resumed', 'reconcile'));
ALTER TABLE job_verifications DROP CONSTRAINT job_verifications_decision_check;
ALTER TABLE job_verifications ADD CONSTRAINT job_verifications_decision_check CHECK (decision IN (
  'already_done', 'resubmitted', 'not_committed_final', 'escalated', 'exhausted', 'lease_lost', 'crashed',
  'deferred', 'handed_off', 'illegal_transition',
  'reconciled', 'duplicate_suspected', 'reconcile_unreadable', 'reconcile_deferred'));
```

- **Marking:** T4 (to `succeeded`) and T7 (`already_done`) set
  `reconcile_after = CASE WHEN EXISTS (SELECT 1 FROM job_verifications v WHERE v.job_id = $1 AND
  v.decision = 'resubmitted') THEN now() + make_interval(secs => $due) END`. `$due` = lease + settle +
  margin: 30 + 5 + 25 = 60 s in production (`ROTE_RECONCILE_MARGIN_SECONDS`, 25).
- **R1, the claim.** It runs in `beforeDequeue` after the recovery sweep, at most once per iteration. The
  state stays `succeeded`; the reconcile lease lives in `lease_owner`/`lease_expires_at`
  (`jobs_lease_pair` holds; `jobs_active_has_owner` does not apply to `succeeded`). An expired reconcile
  lease is simply claimable again here, because T6 only looks at active states:

  ```sql
  BEGIN;
  SELECT id, fencing_token, tenant_id, params, memo_key FROM jobs
  WHERE state = 'succeeded' AND reconciled_at IS NULL AND reconcile_after <= now()
    AND (lease_expires_at IS NULL OR lease_expires_at < now())
  ORDER BY reconcile_after, id LIMIT 1 FOR UPDATE SKIP LOCKED;
  UPDATE job_verifications SET ended_at = now(), decision = 'crashed', error = 'reconcile lease expired'
  WHERE job_id = $1 AND fencing_token = $2 AND ended_at IS NULL;          -- a dead reconciler's phase
  UPDATE jobs SET fencing_token = fencing_token + 1, lease_owner = $me,
         lease_expires_at = now() + make_interval(secs => $lease), updated_at = now()
  WHERE id = $1 AND fencing_token = $2 AND state = 'succeeded' RETURNING fencing_token;
  INSERT INTO job_verifications (job_id, fencing_token, worker_id, reason) VALUES ($1, $new, $me, 'reconcile');
  COMMIT;
  ```

- **One lookup** (lookup 1.2.0, the same invocation as verify, with one retry if transient). No heartbeat:
  a lookup takes about 1 s against a 30 s lease, and a reconcile whose lease expires is fenced out and
  simply runs again (it is read-only).
- **Decide** with the pure `reconcileDecision(reading)`:
  - 1 match → `reconciled`;
  - 2+ matches → `duplicate_suspected`: `needs_human`, `result.reconcile = {matches, refs, evidenceRef}`,
    `duplicates_detected_total` + 1, and one error-level log line;
  - 0 matches or unreadable → `reconcile_unreadable`: `needs_human` (a succeeded job whose transfer the
    history cannot show is itself an alarm);
  - unavailable → `reconcile_deferred`: `reconcile_after = now() + backoff` (D44's backoff and budget; past
    the budget → `reconcile_unreadable`).
- **R2, the result** (fenced):

  ```sql
  UPDATE jobs
  SET state = CASE WHEN $4 IN ('reconciled', 'reconcile_deferred') THEN 'succeeded' ELSE 'needs_human' END,
      outcome = CASE WHEN $4 IN ('duplicate_suspected', 'reconcile_unreadable') THEN $4 ELSE outcome END,
      reconciled_at = CASE WHEN $4 = 'reconciled' THEN now() END,
      reconcile_after = CASE WHEN $4 = 'reconcile_deferred' THEN now() + make_interval(secs => $6) ELSE reconcile_after END,
      result = CASE WHEN $4 IN ('duplicate_suspected', 'reconcile_unreadable')
                    THEN result || jsonb_build_object('reconcile', $5::jsonb) ELSE result END,
      lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
  WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND state = 'succeeded'
  RETURNING id;
  -- + END_PHASE_SQL (decision, lookups); 0 rows -> readFence (lease_lost / illegal_transition, D41)
  ```

- **Property 4 changes** (open question 3): terminal states stay final, with one exception, reconcile's
  `succeeded` → `needs_human` (`duplicate_suspected` / `reconcile_unreadable`). The model, the property tests
  and the model-vs-real test gain R1/R2. A new property: every duplicate in a sequence that drains past the
  reconcile delay is flagged, unless the zombie clicked after the reconcile ran (open question 5).

## 3. The zombie window, measured and made loud (step-08 sections 6 and 9a; reviewer decision 7)

- **Fault point `stall-after-intent`** (`ROTE_FAULT_STALL_MS`, doubly gated like every fault): after T3
  commits, the worker **stops its heartbeat timer** (in a real freeze no timer runs), sleeps for the stall,
  then returns, so the click goes out at once. This is the window's worst case by construction (open
  question 4).
- **`npm run verify-scenarios -- --family zombie`** → `evidence/zombie-window-limit/`. The run uses one job,
  lease 5 s / heartbeat 2 s, and a stall of 30 s (longer than lease + settle + a verify + attempt 2). It
  expects, and checks:
  1. T6.4 → verify `[0, 0]` → resubmitted;
  2. attempt 2 `succeeded` (1 row);
  3. the zombie wakes and clicks (**2 rows**, oracle **DUPLICATE**, the honest limit);
  4. the reconcile pass runs (due 5 + 5 + 10 s at this timing) and finds 2 matches: the job goes to
     `needs_human` / `duplicate_suspected` with both references, and `duplicates_detected_total = 1` (from
     the worker's log line).

  The README states plainly that the window is not closed, it is made loud. The judge checks the order of
  events from the timestamps (zombie click after attempt 2's row and before the reconcile read), so a run
  whose timing differs fails loudly instead of passing by luck.
- **In chaos:** the 45 s pause in every seed keeps exercising the realistic case (the heartbeat usually
  wins on waking). The tally counts how often that happened.

## 4. The bank-slow / bank-down scenario (brief, "Chaos scenarios")

`scripts/chaos.ts --bank-fault <seeded>` adds seeded bank events to the schedule: `/control/errors/on` for
30 s at a seeded time, and `/control/latency/2000` for 60 s at another. Two runs:
- `bank-fault-only` (no kills): isolates "retries back off";
- `bank-fault+kills`: everything at once.

Judge: 0 DUPLICATE, 0 LOST, 0 `needs_human`, and **0 `failed`**: the outage must not exhaust attempts,
which is what section 1 delivers. The report lists requeues with their `not_before` delays and verify
deferrals. Evidence: `evidence/chaos/bank-fault-*-seed-<n>/`.

## 5. Chaos at scale and the snapshot fix

- **20 seeds** (amendment 3), **4 workers** (amendment 2), **500 jobs each** (the brief's number; Steps 7–9
  used 100, open question 1). The schedule must span the work (`--duration` about 480 s for 500 jobs, so
  about 40–60 kills per seed, plus the 45 s pause). About 10 min per seed, so roughly 3.5 h in total,
  sequentially, with nothing else running.
- `scripts/chaos-seeds.ts --seeds 20 --jobs 500` draws the seeds up front (printed and saved), runs each into
  `evidence/chaos/day2-exit/seed-<n>/`, and writes a generated tally (`tally.md`: per seed the kills,
  recoveries by label, verify decisions incl. resubmits, ok/DUPLICATE/LOST/needs_human, wall time;
  RESULT: PASS only if every seed passes). No seed is ever re-drawn or dropped; a failing seed stays in the
  tally and is investigated.
- **Snapshot re-read fix** (REPO_NOTES Step 8): `heldJobs` is read before `docker kill`, which takes a
  second or two on Docker Desktop. The harness also re-reads it right after the kill returns (a dead
  container cannot move its rows, and recovery needs a full lease) and records both; `orphanedBy` uses the
  post-kill read.

## 6. The matrix at production timing, and the crash tests in CI

- `npm run crash-matrix -- --lease-seconds 30 --heartbeat-seconds 10 --expect step-09 --drain-timeout 120s`
  → `evidence/crash-matrix/step-10-production-30-10/` (step-08 reviewer decision 6). About 25–30 min.
  These are the same expectations as at 5 / 2.
- **Crash before / after Submit in `npm test`** (the brief's deliverable): `src/worker/crashSubmit.db.test.ts`
  runs a real child-process worker with `ROTE_FAULT=before-submit` / `after-submit` (SIGKILL), then a clean
  child worker, then the oracle. Expected: exactly 1 row and `succeeded` in both (resubmitted on attempt 2 /
  `already_done` on attempt 1). The worker spawner moves from `scripts/lib/harness.ts` to `src/testing/`
  (the scripts import it from there). Linux CI sends a real SIGKILL; Windows locally uses
  TerminateProcess.
- **The CI `crash-matrix` job becomes required** (`continue-on-error` removed).
- **The `slow` project:** the integration files that wait on leases or a slow bank (`lease`, `verify`,
  `faults`, `crashSubmit`) move to a third vitest project that still runs in `npm test` and CI. Wall time
  is measured before and after.

## 7. `scripts/mutation-check` (step-09 reviewer addition 6)

`scripts/mutation-check.ts` with one patch per planted bug in `scripts/mutations/NN-<name>.patch`. For each
patch the script:
- runs `git apply --check` (a patch that no longer applies fails the script with "update the mutant");
- applies it, runs its tests, and expects a non-zero exit with at least one named test failing;
- runs `git apply -R`, then `git diff --exit-code` on the touched file.

The mutants:
- Step 8: T6 requeueing an expired `committing` job; T2 without `lease_expires_at > now()`; T6 without the
  token bump. The last two are caught by model-vs-real, so they need Postgres.
- Step 9: M1–M4 (`evidence/step-09/mutation-check-property-tests.txt`).
- Step 10: reconcile ignoring 2+ matches; T4 requeue without `not_before`.

Output: `evidence/mutation-check/`. A required CI job `mutation-check` (ubuntu, Postgres service) runs it.

## 8. README "Fleet (Day 2)" and docs

- **A case-study section, "Fleet (Day 2): crash safety".** It covers:
  - the problem: exactly-once clicks on a UI with no idempotency key;
  - the design: the state machine as a diagram, leases + fencing, the intent, verify, deferral, reconcile;
  - the guarantees, and the one window;
  - the results: a table linking every judge;
  - the limits: the zombie window (now detected), settle ≥ history lag, single machine, a mock bank.

  It replaces the per-step "Day 2, Step 8/9" subsections.
- **D-entries:** requeue backoff; reconcile; the stall fault and the zombie evidence; chaos at scale (size,
  duration); the `slow` project; mutation-check and the required CI jobs. Plus REPO_NOTES, the evidence
  index and the before/after table.

## 9. The Day-2 exit criteria (each with the evidence that closes it)

| Criterion | Source | Closed by |
| --- | --- | --- |
| Random kills: 0 duplicates, 0 lost, across 20+ seeds, 4 workers | brief Day-2 exit; amendments 2–3 | `evidence/chaos/day2-exit/tally.md` RESULT: PASS |
| Crash right after Submit: the worst case tested every time | brief scenario table | matrix `after-submit` (5/2 and 30/10) + `crashSubmit.db.test.ts` in CI |
| Crash right before Submit: recovery retries safely | brief scenario table | matrix `before-submit` + `crashSubmit.db.test.ts` in CI |
| Paused (zombie) worker: fencing stops a stale worker | brief scenario table | the pause in every chaos seed; `evidence/zombie-window-limit/` (the honest limit, detected) |
| Bank slow or down 30 s: retries back off, nothing duplicates | brief scenario table | `evidence/chaos/bank-fault-*` (0 failed, 0 duplicates) |
| Crash-before/after tests run in CI; all existing tests pass | brief deliverables | CI run on the head, `npm test` ×3 logs |
| Crash-point matrix | amendment 3 | `crash-matrix/step-09/` (done) + `step-10-production-30-10/`; required CI job |
| fast-check property tests | amendment 3 | in `npm test`; `mutation-check` CI job |
| CI on every push: unit + crash integration against Postgres | amendment 3 | `ci.yml`: test, unit-node25, docker, crash-matrix, mutation-check, all required |
| `needs_human` listed with its reason; 0 or 1 transfers, never 2 | brief oracle | the oracle (D32); `duplicate_suspected` is the one deliberate 2-row `needs_human`, in its own folder |

## 10. Before the PR from `fleet/day-1` to `main` opens

1. Every row of section 9 is green, with committed, script-checked evidence.
2. CI is green on the branch head, with `crash-matrix` and `mutation-check` required.
3. `npm test` ×3 locally, logs unfiltered, no unexplained flake.
4. `docker compose up -d --build` from a clean clone, then the README's one-command chaos run, works as
   written (the brief's "reproduce it with one command").
5. DECISIONS, REPO_NOTES, the README and the evidence index are current. Step 10's "Built" section is
   written and approved by the reviewer, with no open questions.
6. The known follow-ups are listed in the PR description, not hidden: the `npm audit` dependency upgrades
   (their own step, step-08 A5); Days 3–4.
7. The PR description summarizes Days 1–2, links the evidence and states the honest limits. The branch
   history is kept (no squash, no force-push) unless the reviewer asks otherwise. The PR is opened on the
   reviewer's go-ahead.

## 11. Tests

- **Unit:** `requeueBackoffSeconds`; `reconcileDecision` rows; the stall fault parses; the chaos tally.
- **Property:** an outage shorter than the backoff schedule fails no job; terminal finality with the
  reconcile exception; the reconcile flags every duplicate that lands before it runs. 10 000 runs each.
- **Model vs real:** + `not_before`, R1, R2.
- **DB:** dequeue respects `not_before` (and the tenant claim skips not-yet-due tenants); T4 sets it, T6.1/T7
  clear it; R1 due-time selection, SKIP LOCKED, re-claim after an expired reconcile lease; R2 per decision; a
  stale R2 writes nothing; the 0004 constraints.
- **Integration:**
  - two ledger rows for one memo → `duplicate_suspected`;
  - a 30 s `errors/on` before Submit → retried after the backoff, `succeeded`, 1 row;
  - `crashSubmit.db.test.ts`.

## 12. Commits

1. 0004 + requeue backoff (pure, SQL, model, property, model-vs-real, DB, integration).
2. Reconcile pass (pure, R1/R2, model, property 4, DB, integration).
3. `stall-after-intent` + `--family zombie` → `evidence/zombie-window-limit/`.
4. `crashSubmit.db.test.ts` + `src/testing` spawner + the `slow` project.
5. `scripts/mutation-check` + mutants + CI job; `crash-matrix` required.
6. Chaos: snapshot fix, `--bank-fault`, `chaos-seeds.ts`; the two bank-fault runs.
7. 20 seeds → `evidence/chaos/day2-exit/`.
8. Matrix at 30 / 10; the matrix at 5 / 2 re-run on the final code.
9. Docs (section 8); full suite ×3; push; CI checked; the section-10 checklist filled in.

`npm test` before every commit; never commit or push on red; never run the suite with the fleet up; stop
the fleet when not in use (8 GB laptop).

## Open questions for the reviewer

1. **Chaos size:** 500 jobs per seed (the brief's number; about 3.5 h for 20 seeds) or 100 as in Steps 7–9?
   Recommended: 500.
2. **Retries back off:** B (`not_before`, 10 s × 3, recommended), A (a bank-unavailable failure before
   Submit costs no attempt; transfer 1.2.0 + a D21 CHECK change), or C (Day 4's circuit breaker now)?
3. **Reconcile moves a `succeeded` job to `needs_human`**, the one exception to terminal finality. OK, or
   keep `succeeded` with outcome `duplicate_suspected` plus the alert (gentler for API clients, but the
   brief's `needs_human` list would not show it)?
4. **`stall-after-intent` suspends the heartbeat** to stand in for a process freeze (the deterministic worst
   case). OK as the evidence, or also a Linux-only real `SIGSTOP` variant in CI (its timing between T3 and
   the click cannot be aimed from outside)?
5. **Reconcile's own limit:** a zombie frozen longer than the reconcile delay (60 s in production) that also
   beats its overdue heartbeat on waking produces a duplicate after reconcile ran, which is silent again.
   State it as the limit (recommended), or add a second, late reconcile (e.g., +15 min)?
6. **The `slow` project:** the move was not made in Step 9, because step-09 section 2 calls it a reviewed
   change. The suite usually runs 162–176 s, two runs took 243–246 s, and Step 10 adds about 60 s. Move the
   slow files as the first commit of Step 10 (recommended now that 3 minutes has been crossed twice), or with
   commit 4?

## Reviewer decisions (2026-11-14)

The reviewer **approved** this plan with the decisions below. Where they differ from the sections above,
these win; everything else in this file stands.

The reviewer re-ran Step 9 on Postgres 16: 570/571, only the version-17 assertion failing, as expected. The
corrected history-lag results (step-09 "Built") are **accepted** and close step-09 reviewer addition 4: a
crashed worker's job is verified only after its lease expires, so the crash path's lookups start later than
the reviewer's prediction assumed.

### The split: Step 10a, then Step 10b

Step 10 is built in two halves, each in its own session.

- **10a** (this half): section 12's commits 1–5, plus decisions 3 and 5 below:
  - the `slow` vitest project (the first code commit, decision 6);
  - 0004 + requeue backoff: pure, SQL, model, property, model-vs-real, DB and integration tests;
  - the reconcile pass R1/R2, the `settled` field (decision 3) and `rote reconcile --since` (decision 5);
  - `stall-after-intent` → `evidence/zombie-window-limit/`, showing the duplicate AND its detection
    (`duplicate_suspected`, `duplicates_detected_total = 1`);
  - `crashSubmit.db.test.ts` in `npm test`;
  - `scripts/mutation-check` and its CI job;
  - `crash-matrix` made required in CI.

  At the end of 10a: run the crash matrix (5 / 2) and `verify-scenarios` on the 10a code. Then **stop**: no
  chaos changes. The handoff report adds "What 10b must do", so the next session can pick it up from this
  file.
- **10b**: section 12's commits 6–9 (the chaos snapshot fix, `--bank-fault`, `chaos-seeds.ts` with the
  batch runner proven on 2 seeds, the two bank-fault runs, the matrix at 30 / 10, the docs and the PR
  checklist), with decisions 1, 7 and 8.

### Open questions answered

1. **Chaos size: 500 jobs per seed, 20 seeds.** Claude Code builds the batch runner and proves it on 2 seeds
   (in 10b). The **builder** runs the 20-seed batch himself, overnight, with ONE command (for example
   `npm run chaos-seeds -- --seeds 20 --jobs 500`). The runner must:
   - run unattended;
   - save each seed's evidence as soon as that seed finishes;
   - resume after an interruption, skipping the seeds already finished;
   - write the tally at the end;
   - never run the test suite;
   - stop the fleet when done.
2. **Retry backoff: option B** (`not_before`, 10 s × 3^(attempt−1) with jitter): approved. Long outages are
   Day 4's circuit breaker.
3. **Reconcile moves `succeeded` → `needs_human`** (`duplicate_suspected` / `reconcile_unreadable`):
   approved. **Added:** `GET /jobs/:id` returns `settled: boolean`, true when the job is terminal and either
   no reconcile is due or it was reconciled. The README documents that a succeeded job can still change to
   `needs_human` until it is settled.
4. **`stall-after-intent` with the heartbeat suspended:** approved as the evidence. No `SIGSTOP` variant.
5. **Reconcile's own limit:** state it as the honest limit, **and** add a batch command
   `rote reconcile --since <duration>` (end-of-day reconciliation, as banks do). It re-runs the lookup for
   every job in the window that succeeded after a resubmit, regardless of `reconciled_at`, and flags 2+
   matches exactly like R2. Read-only toward the bank. Tested. A D-entry.
6. **The `slow` test project is the FIRST code commit.** It still runs in `npm test` and in CI.

### Reviewer additions

7. **Chaos expectations per scenario family.** The standard family fails on ANY job left for a human. The
   zombie and bank-fault families state their expected escalations and outcomes explicitly, and the judge
   checks exactly those.
8. **The 20-seed tally counts each recovery kind** (requeued, already_done, resubmitted, deferred,
   escalated, duplicate_suspected) across all seeds, so it is visible whether chaos exercised the resubmit
   path at all. If it did not, the tally says so; the matrix and `verify-scenarios` cover that path.

### Also required

- Memory: 8 GB laptop. Never run the full suite while the fleet is up; stop the fleet containers when not
  in use.
- `npm test` before every commit; never commit or push on red. The full suite 3 times at the end of each
  half, logs unfiltered. Push, then check CI with `gh` and report it; if it is red, fix it in that half.
- Each half ends with the usual handoff report (10a adds "What 10b must do").
