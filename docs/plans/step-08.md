# Step 8 plan — Day 2 begins: crash safety (proposed, not built)

Branch `fleet/day-1` (Day 2 continues on it unless the reviewer wants `fleet/day-2`). Reads
`docs/plans/step-07.md` (built; see its "Reviewer decisions" and "Built" sections). Status: **for
review**; nothing here is built.

Day 2 is the brief's core: *a job is only ever retried blindly if it crashed before its commit intent
was saved; after that point, a second worker checks the bank's history first and escalates to a human
when it can't tell.* Step 7 built the judges (the ledger oracle, the chaos harness, the crash-point
matrix) and recorded them red. Day 2 builds what turns them green, and nothing is called green until
those same scripts say so.

Rules carried forward: extend replay, never fork it; every lease comparison on the database clock
(D22); a queued job always has an attempt left, so recovery moves exhausted jobs to `failed` (D21);
credentials never stored (D23); every claim backed by a script-checked run under `evidence/`.

## 0. Too big for one step: the split

Day 2 is three reviewable steps. Each leaves the fleet **safe** (it never retries a job that may have
committed) even before the next one lands.

| Step | Builds | Turns green | Interim rule until the next step |
| --- | --- | --- | --- |
| **8: leases that mean something** | migration 0002; heartbeat 10 s / lease 30 s; abort on a missed heartbeat; the fenced commit intent; completion over `running`/`committing`; recovery of expired `running` (→ `queued` / `failed`) and `committing` (→ `needs_human`, interim); the pure state machine (`src/fleet/stateMachine.ts`) and its fast-check property tests | crash-matrix points `after-dequeue` … `after-step-10` (blind retry, 1 row); every other point **safe** (`needs_human`, 0 or 1 row: oracle ok); chaos: 0 LOST, 0 DUPLICATE | an expired `committing` job and every `commit_uncertain` result go to `needs_human`, never `queued` (Step 6's rule, D25) |
| **9: verify** | `transfer-history-lookup` 1.2.0 (also reads the matching row's reference); `committing` → `verifying`; the history lookup with settle-and-recheck; `verifying` recovery; `commit_uncertain` → `verifying`; the `business_outcome` + `commitUncertain` rule; the recovery-internal crash points | the whole crash-point matrix including the recovery points, each with its **expected** Day-2 outcome (not just "oracle ok") | none |
| **10: Day-2 exit** | chaos at scale (20+ seeds, amendment 3), the zombie and bank-slow scenarios measured, the crash-before/after-submit integration tests in `npm test` (CI), README "Fleet (Day 2)" | the brief's Day-2 exit: every chaos scenario at 0 duplicates and 0 lost, across 20+ seeds, script-checked | |

This file plans all three in full (the reviewer asked for the exact SQL of every transaction now), and
**Step 8 is what gets built first**. Steps 9 and 10 get their own short plan files that point back
here and record anything Step 8 changed.

## 1. Schema: migration `0002_day2.sql` (forward-only; 0001 is never edited)

```sql
-- Recovery scans expired leases by state; tiny (only active rows), ordered by expiry.
CREATE INDEX jobs_lease_expiry ON jobs (lease_expires_at, id)
  WHERE state IN ('running', 'committing', 'verifying');

-- Which attempt wrote a commit intent (evidence; recovery reads jobs.commit_intent_at).
ALTER TABLE job_attempts ADD COLUMN commit_intent_at timestamptz;

-- One row per verify phase (Step 9). A verify is not a new attempt of the transfer (attempt counts
-- clicks of Submit), so it gets its own table; each verify phase has its own fencing token.
CREATE TABLE job_verifications (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id         uuid   NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  fencing_token  bigint NOT NULL CHECK (fencing_token >= 1),
  worker_id      text   NOT NULL,
  -- why the job is being verified
  reason         text   NOT NULL CHECK (reason IN ('lease_expired_in_committing', 'lease_expired_in_verifying', 'commit_uncertain')),
  -- the ReplayResult status the transfer attempt ended with, when it ended at all (decides what 0 matches means)
  prior_status   text   CHECK (prior_status IN ('business_outcome', 'failure', 'needs_human')),
  started_at     timestamptz NOT NULL DEFAULT now(),
  ended_at       timestamptz CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- matches seen by each lookup, in order: {1} or {0,0} or {0,1} ...; NULL entry = unreadable
  lookups        int[],
  decision       text CHECK (decision IN ('already_done', 'resubmitted', 'not_committed_final', 'escalated', 'exhausted', 'lease_lost', 'crashed')),
  error          text,
  CONSTRAINT job_verifications_job_token_key UNIQUE (job_id, fencing_token)
);
```

`job_attempts.outcome` gains `crashed` (set by recovery on the dead worker's attempt row; the column
is free text, the 0001 comment already lists it). Step 8 creates `job_verifications` too (one migration
for Day 2) but writes to it only from Step 9.

## 2. The lease: 30 s, heartbeat every 10 s (Step 8)

Step 6's lease is 300 s **because there was no heartbeat** (step-06 section 1; Step 7 reviewer decision
B4). Day 2 restores the brief's values: `ROTE_LEASE_SECONDS=30`, `ROTE_HEARTBEAT_SECONDS=10` (Compose
and the worker defaults; the worker refuses `heartbeat * 2 >= lease`, so one missed beat never loses a
lease by itself).

**T2: heartbeat** (one statement, autocommit), every 10 s while the worker holds the job, in any active
state:

```sql
UPDATE jobs
SET lease_expires_at = now() + make_interval(secs => $4), updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3
  AND state IN ('running', 'committing', 'verifying')
  AND lease_expires_at > now()          -- an expired lease is never revived: only recovery touches it
RETURNING lease_expires_at;
```

- **1 row:** extended (database clock, D22).
- **0 rows:** the job is no longer this worker's (recovered, token bumped, or the lease expired first).
  The heartbeat calls `controller.abort(new LeaseLostError(...))`. `runReplay` closes the browser
  context immediately, mid-action, and rejects with that reason (D11): the in-flight click, if any is
  still pending in Playwright, dies with the context. The worker records **nothing** on `jobs` (its
  completion would be fenced out anyway) and marks its own attempt row `lease_lost`.
- **Transient DB error:** logged, retried at the next beat. Three missed beats (30 s) and the lease is
  gone: the next beat that reaches Postgres returns 0 rows and aborts. A worker that cannot reach the
  database cannot write a commit intent either (T3), so it can never click while partitioned.

The heartbeat is a small class (`src/worker/heartbeat.ts`) owning a `setInterval`, the job's
`(id, token, owner)` and the `AbortController`; it stops before the completion transaction and on any
exit. Its token is replaceable (`setToken`) for Step 9's verify phase.

## 3. The commit intent (Step 8)

Inside `onIrreversible.before`, i.e. right before the irreversible click (seam 1, D11):

**T3: commit intent** (one transaction):

```sql
BEGIN;
UPDATE jobs
SET state = 'committing', commit_intent_at = now(),
    lease_expires_at = now() + make_interval(secs => $4),     -- a full lease for click + settle (<= 10 s)
    updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3
  AND state = 'running' AND lease_expires_at > now()
RETURNING commit_intent_at;
-- 0 rows: ROLLBACK and throw FencingError. The click never happens; runReplay rejects with it.
UPDATE job_attempts SET commit_intent_at = now() WHERE job_id = $1 AND fencing_token = $2;
COMMIT;
```

- The `UPDATE … WHERE` confirms the lease and the token and sets the state in one atomic step: under
  `READ COMMITTED` the row lock is taken first and the `WHERE` re-evaluated on the locked row, so a
  concurrent recovery (which bumps the token) either finished first (0 rows here) or waits for us.
- **Only a successful `COMMIT` lets the click happen.** If `COMMIT` fails, or its result is unknown
  (connection lost mid-commit), the hook throws: no click. If the intent did commit after all, the job
  sits in `committing` with no click; its lease expires and verify (Step 9) finds 0 matches and
  resubmits. Safe either way.
- `jobs_committing_has_intent` (0001) already guarantees no `committing` row without `commit_intent_at`.

**T4: completion** (Step 6's fenced transaction, widened from `state = 'running'` to the two states a
live owner can be in; seam 6):

```sql
BEGIN;
UPDATE jobs
SET state = $4, outcome = $5, error = $6, result = $7::jsonb,
    lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND state IN ('running', 'committing')
RETURNING id;
-- 0 rows: lease lost; nothing written to jobs; the attempt is lease_lost (unchanged from Step 6)
UPDATE job_attempts SET ended_at = now(), outcome = $8, commit_uncertain = $9, error = $6
WHERE job_id = $1 AND fencing_token = $2;
COMMIT;
```

A requeue (failure before the intent, attempts left) is T4 with `state = 'queued'`, and only from
`running`: `jobOutcomeFor` never requeues a run whose `onIrreversible.before` ran (D25); the
`jobs_queued_has_attempts_left` CHECK still guards exhaustion.

**Step 8's interim rule (until Step 9):** anything that may have committed (a `commitUncertain`
result; a throw or abort after the intent) is completed by T4 as `needs_human` / `commit_uncertain`,
exactly as in Step 6 (D25). Step 9 replaces it with T5.

## 4. Recovery inside the dequeue loop (Step 8: `running`, `committing`; Step 9: `verifying`)

Seam 4: `beforeDequeue()`, run by every worker on every loop iteration, before `dequeue`. It recovers
at most 10 expired jobs per iteration (bounded, so a backlog cannot starve dequeuing) and stops early
if it claimed a job to verify (that job is this iteration's work).

**T6: recovery** (one transaction per job):

```sql
BEGIN;
-- T6.0 claim one expired lease, oldest first; rows another recoverer holds are skipped, not waited on
SELECT id, state, attempt, max_attempts, fencing_token, lease_owner, commit_intent_at, outcome, result
FROM jobs
WHERE state IN ('running', 'committing', 'verifying') AND lease_expires_at < now()
ORDER BY lease_expires_at, id
LIMIT 1
FOR UPDATE SKIP LOCKED;
-- none: COMMIT; done.
```

Then, by the state the job was left in (the decision is the pure `recoveryAction(row)` of
`src/fleet/stateMachine.ts`; the SQL is fixed per action). Every recovery transition **bumps the
fencing token**, so "the token changed" means "the old holder is fenced" without exception, and
closes the dead worker's attempt row:

```sql
-- common to every action: the dead holder's attempt row
UPDATE job_attempts SET ended_at = now(), outcome = 'crashed',
       error = 'lease expired in ' || $state || '; recovered by ' || $me
WHERE job_id = $1 AND fencing_token = $2 AND ended_at IS NULL;
```

| Left in | Condition | Action (T6.x) | `jobs` update (all: `WHERE id = $1 AND fencing_token = $2 AND state = $state AND lease_expires_at < now()`) |
| --- | --- | --- | --- |
| `running` | `attempt < max_attempts` | **T6.1 requeue** (no intent: nothing irreversible happened) | `SET state = 'queued', fencing_token = fencing_token + 1, lease_owner = NULL, lease_expires_at = NULL, error = 'lease expired while running (attempt N); requeued', updated_at = now()` |
| `running` | `attempt >= max_attempts` | **T6.2 fail** (never `queued`, D21) | `SET state = 'failed', outcome = 'lease_expired', fencing_token = fencing_token + 1, lease_owner = NULL, lease_expires_at = NULL, error = 'lease expired on the last attempt; no commit intent, so nothing irreversible happened', updated_at = now()` |
| `committing` | Step 8 (interim) | **T6.3 escalate** | `SET state = 'needs_human', outcome = 'commit_uncertain', fencing_token = fencing_token + 1, lease_owner = NULL, lease_expires_at = NULL, error = 'lease expired after the commit intent: the Submit may have committed; check the history for memo_key', updated_at = now()` |
| `committing` | Step 9 | **T6.4 claim to verify** | `SET state = 'verifying', fencing_token = fencing_token + 1, lease_owner = $me, lease_expires_at = now() + make_interval(secs => $lease), updated_at = now() RETURNING fencing_token` + `INSERT INTO job_verifications (job_id, fencing_token, worker_id, reason) VALUES ($1, $new, $me, 'lease_expired_in_committing')` |
| `verifying` | Step 9, fewer than 3 verify phases | **T6.5 re-claim** (a verifier died) | as T6.4; the previous verification row gets `ended_at = now(), decision = 'crashed'`; reason `lease_expired_in_verifying` |
| `verifying` | Step 9, 3 phases already | **T6.6 escalate** | `SET state = 'needs_human', outcome = 'verify_exhausted', fencing_token = fencing_token + 1, lease_owner = NULL, lease_expires_at = NULL, …` |

```sql
COMMIT;
```

- **Database clock only** (D22): `lease_expires_at < now()` in the claim and again in each update (the
  row is locked, so the second check can't flip, but it keeps every statement self-contained).
- **Two recoverers** can never take the same job: `FOR UPDATE SKIP LOCKED` on the claim, and the
  token check on the update. Tested with 8 concurrent recoverers over 50 expired jobs.
- **The tenant cap** (seen in Step 7's chaos run: two orphaned tenant-a jobs held both of its slots and
  its other 30 jobs never ran): a `running` or `committing` job with an expired lease still counts as active
  (`ACTIVE_STATES`) until recovered; recovery runs before every dequeue, so a slot is held at most
  one poll interval past expiry. T6.4/T6.5 keep the job active (verifying), so the cap is never
  exceeded by recovery.
- A **kill in the middle of T6** rolls the transaction back and Postgres releases the row lock when the
  connection drops; the job is still expired and the next recoverer takes it (crash point
  `recover-in-transaction`, section 8).

## 5. Verify (Step 9)

**Who verifies:** the worker that claimed the job in T6.4/T6.5, or the worker whose own run ended
`commit_uncertain` (T5 below), immediately, under a heartbeat on the verify phase's token.

**T5: completion into verify** (replaces Step 8's interim `needs_human` for `commit_uncertain`; the
live owner moves straight into its own verify phase):

```sql
BEGIN;
UPDATE jobs
SET state = 'verifying', outcome = 'commit_uncertain', error = $5, result = $6::jsonb,
    fencing_token = fencing_token + 1, lease_expires_at = now() + make_interval(secs => $4), updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND state IN ('running', 'committing')
RETURNING fencing_token;
-- 0 rows: lease lost; nothing written (recovery will verify instead)
UPDATE job_attempts SET ended_at = now(), outcome = $7, commit_uncertain = true, error = $5
WHERE job_id = $1 AND fencing_token = $2;
INSERT INTO job_verifications (job_id, fencing_token, worker_id, reason, prior_status)
VALUES ($1, $new, $3, 'commit_uncertain', $8);      -- $8 = the ReplayResult status
COMMIT;
```

**The lookup.** `transfer-history-lookup` today outputs only `matchingCount`. A recovered job that
ends `succeeded` must still carry `result.outputs.confirmationRef` equal to the ledger row's id, or the
oracle reports MISMATCH (D32). So Step 9 adds version **1.2.0** of the lookup: after reading the count,
a `readText` of the first matching row's **Reference** column (the history page already shows it, all
three tenants), output `firstMatchRef`. It is a content change: version bump, `catalog approve` with
evidence, and the three override digests re-approved (D30 makes that impossible to forget). The verify
replay is `invokeCapability({ id: "transfer-history-lookup", tenant, params: { memberId, memo:
memo_key } + credentials, browser, signal })`, read-only, `approveRisky` not set.

**The procedure** (`src/worker/verify.ts`):
1. Lookup #1 → `n1` (or *unreadable*: the lookup's result is not `success`, its count isn't an integer,
   or it threw; one retry of the lookup on a `failure` with category `transient` or `session-timeout`,
   then unreadable).
2. If `n1 = 0`: wait the **settle period** (`ROTE_VERIFY_SETTLE_MS`, default 5 s, abortable by the
   heartbeat), lookup #2 → `n2`.
3. Decide with the pure `verifyDecision({ lookups, priorStatus, attempt, maxAttempts })`:

| Lookups | `prior_status` | Decision | Job state, `outcome` | Recovery label |
| --- | --- | --- | --- | --- |
| `[1]` or `[0, 1]` | any | the transfer happened | `succeeded`, `already_done`, `result = {status: "success", outputs: {confirmationRef: firstMatchRef}, recoveredBy: "verify"}` | `already_done` |
| `[0, 0]` | not `business_outcome`, `attempt < max_attempts` | it did not happen; retry | `queued` (lease cleared, `commit_intent_at = NULL`) | `resubmitted` |
| `[0, 0]` | not `business_outcome`, attempts exhausted | did not happen; no attempts left | `failed`, `not_committed_attempts_exhausted` | `exhausted` |
| `[0, 0]` | `business_outcome` | the bank's refusal stands (it refused after Submit; nothing moved) | `business_outcome` (the stored result kept), never retried | `not_committed_final` |
| `[2+]`, or `[0, 2+]` | any | ambiguous | `needs_human`, `ambiguous`, evidence refs of both lookups | `escalated` |
| unreadable at any lookup | any | can't tell | `needs_human`, `unreadable` | `escalated` |

**T7: the verify result** (one transaction, fenced on the verify token):

```sql
BEGIN;
UPDATE jobs
SET state = $4, outcome = $5, error = $6,
    result = COALESCE($7::jsonb, result),
    commit_intent_at = CASE WHEN $4 = 'queued' THEN NULL ELSE commit_intent_at END,
    lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND state = 'verifying'
RETURNING id;
-- 0 rows: this verifier lost the lease; record nothing on jobs; the verification row says lease_lost
UPDATE job_verifications SET ended_at = now(), lookups = $8::int[], decision = $9, error = $6
WHERE job_id = $1 AND fencing_token = $2;
COMMIT;
```

`queued` is only written with attempts left (the CHECK enforces it); the next dequeue starts attempt
N+1 with a fresh token, and its memo is the same `memo_key`, so a later verify still finds it.

**The `business_outcome` + `commitUncertain` rule**, stated once: a refusal the bank showed *after*
Submit is believed only if the history agrees: 1 match → the transfer did happen (`succeeded`,
`already_done`); 0 matches twice → the refusal is final (`business_outcome`, never retried).

**Step 6 compatibility:** jobs already parked as `needs_human` / `commit_uncertain` by Steps 6–8 are
left alone (a person may already be looking at them). A CLI `rote jobs reverify <id>` (Step 9) moves
one into `verifying` on request.

## 6. The zombie: what stops a paused worker, and what doesn't (stated honestly)

A **zombie** is a worker frozen (`docker pause`, a GC stall, a VM pause) past its lease, while another
worker recovers its job, that then wakes up and carries on.

What stops it, by where it was frozen:

| Frozen at | On waking, what stops it | Protected? |
| --- | --- | --- |
| before the commit intent (any step, a page load) | its next gate is T3, the fenced intent: the token was bumped by recovery (T6.1), or the lease is past `now()`, so 0 rows and it throws: **no click**. Also its overdue heartbeat timer fires, gets 0 rows and aborts the context. | **yes** |
| inside T3 (waiting on Postgres) | the row lock serializes T3 with recovery; whichever commits second sees the other's change: either T3 wins (intent written, lease extended to now+30 s, so recovery isn't due) or recovery wins (T3 updates 0 rows) | **yes** |
| after T3 committed, before the click reaches the bank | **nothing deterministic.** Its intent is valid; the click is the next thing it does. If recovery moved the job on (T6.4 at 30 s), the verifier looked twice (5 s settle), saw 0, and requeued (T7), and another worker transferred, then the zombie's click lands a **second transfer**. The heartbeat abort wins only if its timer callback runs before the click is dispatched. | **no: the window** |
| after the click, before T4 | its T4 is fenced (0 rows: the token changed); the verifier counted its row (1 match → `succeeded`, no resubmit) | **yes** |

**The window**, precisely: from T3's `COMMIT` returning to the bank receiving the Submit POST, *and*
the worker frozen inside it for longer than the lease (30 s) plus the settle period (5 s) plus the
time a verifier needs, *and* the requeued attempt committing before the zombie's late POST. In code
the window is one `await` (T3's `COMMIT`), Playwright's actionability checks on the Submit button and
the dispatch (milliseconds to tens of milliseconds); in Docker it also includes the POST in flight
through the worker's own forwarder (D26), which freezes with it. No design can close it from the
client side: the bank's UI has no API to fence on and no idempotency key (the brief's honest limit).

What shrinks it, all in Day 2:
- the intent and the click are adjacent (no awaits between T3 and `surface.act` except the hook's
  return), and T3 extends the lease to a full 30 s, so only a freeze longer than 30 s matters;
- the settle-and-recheck delays every resubmit by at least 5 s after verify starts;
- the heartbeat abort closes the context on waking, which kills a click that has not yet been
  dispatched in most interleavings;
- the memo is the job's own `memo_key` on every attempt, so a duplicate is always *detectable*: the
  oracle reports it and a human can reverse it (and a later verify would see 2 matches → escalate).

**Observed in Step 7's chaos run** (`evidence/chaos/before-day2/README.md`): a worker frozen mid-step
wakes into Playwright's own action timeout (30 s, counted in wall time across the freeze), so the step
fails at once and the run ends `failure` before Submit. Today that was requeued by its own worker
(nothing else had the job). On Day 2 the same wake-up meets a bumped token: its T4 requeue is fenced
(0 rows) and the recovered job is already someone else's. Useful, but not a protection to rely on: a
worker frozen *between* actions (e.g. right after T3) has no pending Playwright timeout to fire.

**Measured, not assumed (Step 10):** the chaos `pause` (45 s, random time) plus a targeted fault point
`stall-after-intent` (`ROTE_FAULT_STALL_MS`: the worker sleeps between T3 and the click, simulating a
freeze exactly in the window) run with a requeue forced; the README reports how often a duplicate
results, with the evidence. The expected result for `stall-after-intent` with a stall longer than lease
+ settle is **a duplicate**, and it is reported as the honest limit, not hidden.

## 7. The pure state machine and the fast-check property tests (Step 8; extended in Step 9)

`src/fleet/stateMachine.ts` holds every decision as a pure function, used by the worker code and by
the tests: `jobOutcomeFor` (Step 6, moved here), `recoveryAction(row)` (section 4), `verifyDecision`
(section 5). The SQL in sections 2–5 executes those decisions; nothing decides in SQL alone.

**Property tests** (`src/fleet/stateMachine.property.test.ts`, fast-check, a new devDependency, added
under amendment 3; not an upgrade of an existing one). A model of one job, a bank ledger, N workers
and a database clock; fast-check generates random sequences of events:
`dequeue(w)`, `step(w)`, `intent(w)` (T3's guard), `click(w)` (the bank appends a row with the memo, or
refuses), `crash(w)`, `pause(w)` / `resume(w)`, `tick(dt)`, `heartbeat(w)`, `recover(w)` (T6 with
`recoveryAction`), `lookup(w)` (reads the model ledger, possibly lagging), `complete(w)`. Guards are the
same predicates the SQL uses (token, owner, state, `lease_expires_at > now`).

Properties, each over 10 000 runs (seeded; a failure prints the shrunk event sequence):
1. **No duplicate** in any sequence in which no worker clicks while frozen across its own lease expiry
   (the zombie window is the only exception, and the property says so by construction).
2. **No duplicate at all** when `pause` never spans `lease + settle` (the zombie can't reach the window).
3. **No lost job:** after the events, `resume` everyone, advance the clock past every lease, run
   `recover` + `complete` to quiescence: the job is terminal.
4. **Terminal states are final** (no event moves a `succeeded`/`failed`/`business_outcome`/`needs_human`
   job), and `queued ⇒ attempt < max_attempts` always (D21).
5. **Blind retry only before the intent:** every `queued` transition after an intent passed through a
   verify with two 0-match lookups.
6. **The oracle agrees with the model:** feeding the model's final job and ledger to `checkLedger`
   gives `pass` exactly when properties 1 and 3 hold.

## 8. Tests per rule

Unit (`npm run test:unit`):
- `recoveryAction`: one case per row of section 4's table; exhaustion is never `queued`.
- `verifyDecision`: one case per row of section 5's table, both `prior_status` branches.
- `jobOutcomeFor` (Step 6's cases) with the Step 9 change: `commit_uncertain` → `verifying`.
- Heartbeat class with a fake clock and a fake pool: beats every 10 s; a 0-row beat aborts with
  `LeaseLostError`; transient errors don't abort; `stop()` stops; refuses `heartbeat * 2 >= lease`.
- Fault flag: the new points `stall-after-intent` and the recovery points (section 9) parse.
- The property tests (section 7).

DB (`*.db.test.ts`, real Postgres, test schema):
- T2: extends while the token matches; 0 rows after a token bump; never revives an expired lease;
  a worker JS clock an hour off changes nothing (D22).
- T3: sets `committing`, `commit_intent_at`, extends the lease, stamps the attempt; fenced out (token
  bumped, owner changed, lease expired) → `FencingError` and no change; Postgres cut by the test TCP
  proxy (Step 6's) → throws, nothing clicked.
- T4 over `committing`; a stale T4 after recovery writes 0 rows.
- T6: every row of section 4, leases expired by `UPDATE … SET lease_expires_at = now() - interval '1 s'`
  (database clock); 8 concurrent recoverers over 50 expired jobs: each job recovered exactly once.
- T5/T7 (Step 9): every row of section 5 against the in-process bank, with a real lookup replay.

Integration (worker + in-process bank + Chromium):
- Heartbeat abort mid-replay: the token is bumped under a running job (bank latency 3 s): the context
  closes within one beat, 0 rows, nothing recorded, attempt `lease_lost`.
- Fenced intent: token bumped before Submit → `FencingError`, 0 rows.
- `errors/after-write` (Step 9) → `commit_uncertain` → verify → 1 match → `succeeded`/`already_done`,
  1 row, attempt 1, `confirmationRef` = the row's id.
- `errors/on` armed in `before()` (503 before the write) → verify → `[0, 0]` → requeued → attempt 2
  `succeeded`, exactly 1 row.
- Business outcome after Submit with nothing written → `[0, 0]` → `business_outcome`, never retried.
- **Crash before / after submit** (the brief's CI deliverable, Step 10, in `npm test`): a worker child
  process with `ROTE_FAULT=before-submit` / `after-submit`, then a clean worker: exactly 1 row and
  `succeeded` in both, by the oracle. Linux CI and Windows locally.

## 9. How the judges turn green

**Crash-point matrix** (Step 7's `scripts/crash-matrix.ts`, extended): an **Expected** column, and a
point passes only if the oracle passes **and** the final state is the expected one (not merely "oracle
ok": `needs_human` with 0 rows would pass the oracle but is the wrong answer after Day 2). The matrix
runs with `--lease-seconds 5 --heartbeat-seconds 2` so a point costs seconds, not a 30 s wait (the
Compose stack keeps 30/10; the D-entry says why).

| Point | Step 8 expected | Step 9+ expected |
| --- | --- | --- |
| `after-dequeue`, `after-step-01` … `after-step-10` | requeued by T6.1, attempt 2 `succeeded`, 1 row | same |
| `before-submit` (intent written, no click) | `needs_human` (T6.3), 0 rows | verify `[0, 0]` → requeued → attempt 2 `succeeded`, 1 row |
| `after-submit`, `after-step-12`, `before-complete` | `needs_human` (T6.3), 1 row | verify `[1]` → `succeeded` `already_done`, 1 row, attempt 1 |
| `after-complete` | `succeeded`, 1 row (terminal before the kill) | same |

Recovery-internal points (Step 7 reviewer decision B4; built in Step 9). Each is a two-fault scenario:
the first worker dies at point X (which leaves the job `committing`), the **recovering** worker dies
at point Y, a clean worker finishes. Fault points by name, fired through the lookup replay's `onStep`
and the recovery code:

| Scenario (X → Y) | Y fires | Expected |
| --- | --- | --- |
| `after-submit` → `verify-after-login` | the lookup's step-03 (credentials submitted) | re-verify (T6.5) `[1]` → `succeeded` `already_done`, 1 row |
| `after-submit` → `verify-after-count` | the lookup's step-09 (count read, not yet acted on) | same |
| `after-submit` → `verify-before-result` | decision computed, T7 not started | same |
| `before-submit` → `verify-after-count` | after lookup #1 read 0 | re-verify `[0, 0]` → requeued → `succeeded`, 1 row |
| `before-submit` → `verify-before-requeue` | decision "resubmitted", T7 not started | re-verify → requeued → `succeeded`, 1 row |
| `before-submit` → `verify-after-requeue` | T7 (queued) committed | dequeued normally → `succeeded`, 1 row |
| `after-dequeue` → `recover-in-transaction` | inside T6 after the claim, before `COMMIT` | the rollback releases the lock; another recoverer requeues; `succeeded`, 1 row |

**Chaos** (Step 7's `scripts/chaos.ts`, unchanged except the drain default stays 10 min): a killed
worker's job is recovered within lease (30 s) + one poll; its replica restarts after 2 s (the harness
is the supervisor). The paused replica's lease expires at 30 s of its 45 s pause: its job is recovered
(requeued, or verified), and on unpause its heartbeat or its fenced intent stops it, except in the
section-6 window. Expected per run: `RESULT: PASS`, 0 DUPLICATE, 0 LOST, the recoveries listed by
label. Step 10 runs 20+ seeds (amendment 3) and commits each folder; the README quotes the tally.

## 10. Commits (Step 8 only)

1. `db/migrations/0002_day2.sql` + schema tests (index, column, table, constraints).
2. `src/fleet/stateMachine.ts` (`jobOutcomeFor` moved, `recoveryAction`) + unit tests; fast-check
   devDependency + property tests (properties 3–5 for Step 8's machine; 1, 2, 6 extended in Step 9).
3. Heartbeat (T2) + `LeaseLostError` + the 30/10 defaults + unit and DB tests.
4. Commit intent (T3) in `onIrreversible.before`, T4 widened + DB and integration tests.
5. Recovery (T6.1–T6.3) in `beforeDequeue` + DB tests (incl. 8 concurrent recoverers).
6. Crash matrix: the **Expected** column, `--heartbeat-seconds`, the Step 8 expectations; run it →
   `evidence/crash-matrix/step-08/`.
7. One chaos run (seed printed) → `evidence/chaos/step-08-seed-<n>/` (expected: 0 LOST, 0 DUPLICATE,
   `needs_human` for jobs killed after their intent).
8. Docs: D-entries (lease 30/10 and the no-revive heartbeat; the fenced intent as one transaction;
   recovery bumps the token; the interim `needs_human` rule; the state-machine module and the
   property tests), REPO_NOTES, README.

`npm test` before every commit; never commit or push on red; full suite ×3 at the end; never run the
suite with the 4-worker fleet up.

## Open questions for the reviewer

1. **The split** (section 0): Step 8 leases/heartbeat/intent/recovery of `running`, Step 9 verify,
   Step 10 the chaos-at-scale exit. Or verify in Step 8 too?
2. **Heartbeat never revives an expired lease** (`lease_expires_at > now()` in T2). Stricter than the
   brief ("extend only if the token matches"); a worker whose Postgres blip outlasts the lease loses the
   job even if nobody recovered it yet. OK?
3. **Every recovery transition bumps the fencing token**, including the requeue (dequeue bumps it
   again). OK, or bump only where a new holder is assigned?
4. **One lookup retry on a transient/session-timeout failure before "unreadable"** (section 5), or the
   brief's strict "can't read → `needs_human`" at the first failure?
5. **Lookup 1.2.0 reads the first matching row's reference** so a recovered job keeps
   `confirmationRef` and the oracle's MISMATCH check stays uniform (section 5). Alternative: the oracle
   accepts `already_done` without a reference (weaker).
6. **Matrix timing:** `--lease-seconds 5 --heartbeat-seconds 2` for the matrix only (section 9), with
   the 30/10 values exercised by chaos and the DB tests?
7. **The zombie window** (section 6) is measured with a deterministic `stall-after-intent` point and
   reported as the honest limit. Is a duplicate in that targeted run acceptable as evidence of the
   limit (it would be the only expected `DUPLICATE` in the repo, in its own clearly named folder)?
