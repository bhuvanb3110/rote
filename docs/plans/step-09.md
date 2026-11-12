# Step 9 plan — Day 2, part 2: verify (proposed, not built)

Branch `fleet/day-1`. Reads `docs/plans/step-08.md`, which planned all of Day 2 and is the source for
everything below (its sections 5, 6, 8 and 9, and its "Reviewer decisions (2026-11-11)"); see its
"Built" section for what Step 8 shipped. This file only says what Step 9 builds, in what order, and what
Step 8 changed that Step 9 must account for. Status: **for review**; nothing here is built.

Not in Step 9: the `npm audit` dependency upgrades get their own reviewed step after Day 2 (reviewer
decision A5); chaos at 20+ seeds, the 30/10 matrix run, the reconcile pass and the zombie-window-limit
evidence are Step 10 (step-08 section 9a).

## 1. What Step 9 builds (step-08 section 5, unchanged unless noted)

1. **`transfer-history-lookup` 1.2.0** with `firstMatchRef` (reviewer decision 5): after the count, a
   `readText` of the first matching row's Reference column on all three tenants; version bump, `catalog
   approve` with fresh evidence (`evidence/transfer-history-lookup-1.2.0/`), and the three tenant
   override digests re-approved (D30 refuses a tenant run otherwise). A test asserts the committed
   approval names 1.2.0 and every override digest.
2. **`verifyDecision`** in `src/fleet/stateMachine.ts`: one row per line of step-08 section 5's table,
   both `prior_status` branches; unreadable = the lookup's result not `success`, its count not an
   integer, or a throw, **after one retry on a `failure` with category `transient` or `session-timeout`**
   (reviewer decision 4).
3. **`src/worker/verify.ts`**: lookup #1; on 0, the settle period (`ROTE_VERIFY_SETTLE_MS`, 5 s,
   abortable by the heartbeat) and lookup #2; decide; **T7** (fenced on the verify token, writes the
   decision to `jobs` and to the `job_verifications` row). Runs under the heartbeat with `setToken` on
   the verify phase's token.
4. **T5** (completion into verify) replaces Step 8's interim for `commit_uncertain` results and for runs
   that ended after their intent: the live owner moves straight to `verifying` (token + 1) and verifies.
5. **Recovery T6.4–T6.6** replaces T6.3: an expired `committing` job is claimed to verify (T6.4); an
   expired `verifying` job is re-claimed (T6.5) while it has had fewer than 3 verify phases, else
   escalated `verify_exhausted` (T6.6). The sweep stops early once it has claimed a job to verify (that
   job is the iteration's work).
6. **The `business_outcome` + `commitUncertain` rule** (section 5): the refusal stands only after two
   0-match lookups; 1 match → `succeeded` / `already_done`.
7. **`rote jobs reverify <id> [--tenant]`**: moves one `needs_human` / `commit_uncertain` job (Steps 6–8
   parked them) into `verifying` with a fresh token and a `job_verifications` row (reason
   `commit_uncertain`), fenced on its state, so a human can hand it to verify. Jobs are never moved
   automatically (a person may already be looking at them).
8. **Recovery-internal crash points** (step-08 section 9's second table): `verify-after-login`,
   `verify-after-count`, `verify-before-result`, `verify-before-requeue`, `verify-after-requeue` (fired
   through the lookup replay's `onStep` and the verify code) and `recover-in-transaction` (inside T6
   after the claim, before COMMIT). The matrix runs each as a two-fault scenario (first worker dies at X,
   the recovering worker at Y, a clean worker finishes), with its expected outcome.

## 2. What Step 8 changed that Step 9 must account for

- **The decisions live in `src/fleet/stateMachine.ts`** (`jobOutcomeFor` moved there from
  `src/worker/outcome.ts`). Step 9 changes `jobOutcomeFor`'s `commit_uncertain` rows to "→ verify (T5)"
  and adds `verifyDecision`. `recoveryAction` gains T6.4–T6.6 and stops escalating `committing`.
- **`irreversibleStarted` now comes from T3** (D37): a `FencingError` means the intent was definitely not
  written (retry rule); any other T3 error means "may have committed" and, in Step 9, goes to verify
  (which will find 0 matches twice and resubmit). The integration test that asserts `needs_human` for
  that case (`lease.db.test.ts`) changes to "verify `[0, 0]` → requeued".
- **T4's state guard** (`completionAllowed`) allows only `succeeded`/`needs_human` from `committing`.
  T5 is a separate statement (running/committing → verifying); `completionAllowed` does not grow a
  `verifying` target. The model (`src/fleet/model.ts`) gains `modelCompleteIntoVerify` (T5),
  `modelVerifyResult` (T7) and the T6.4–T6.6 branches, and the **model-vs-real test gains T5 and T7
  commands** (R1).
- **Recovery's SQL is one parameterized UPDATE for T6.1–T6.3.** T6.4/T6.5 also assign a new owner and a
  lease and insert a `job_verifications` row, so they get their own statement in `recover.ts`; the
  dead verifier's `job_verifications` row is closed `crashed` the way the attempt row is.
- **A worker that lost its lease writes `lease_lost` to its attempt row**, keeping recovery's note. The
  verify phase does the same on its `job_verifications` row (`decision = 'lease_lost'`).
- **Crash-matrix expectations are a module** (`src/chaos/crashExpected.ts`, `--expect`). Step 9 adds the
  `step-09` phase (step-08 section 9's right-hand column) and the two-fault scenarios; the CI job's
  `--expect` moves to `step-09`.
- **The property tests' Step 8 forms change** (step-08 section 7): property 1 regains its precondition
  (no worker clicks while frozen across its own lease expiry), property 2 gets its own run (pauses never
  spanning lease + settle), property 5 becomes "every requeue after an intent passed through a verify
  with two 0-match lookups", and the lookup (with lag) joins the simulation. The deterministic zombie
  scenario "frozen after the intent" changes its expected result: with verify + resubmit it is the
  section-6 window, and the test documents the duplicate (the honest limit, detected in Step 10).
- **The suite got slower**: 88 s → about 150 s wall locally (the lease integration tests wait on a slow
  bank on purpose, and the property and model-vs-real tests add CPU). Step 9's verify integration tests
  add more browser time; if a step's suite passes 3 minutes, the slow integration tests move to a
  `slow` project that still runs in `npm test` and CI (a reviewed change, never a skip).
- **Jobs parked by Step 8's T6.3** (`needs_human` / `commit_uncertain`, `error` "lease expired after the
  commit intent") stay parked; `rote jobs reverify` is how they reach verify.

## 3. Tests (step-08 section 8, Step 9 rows)

Unit: `verifyDecision` per row; `jobOutcomeFor`'s new rows; `recoveryAction` T6.4–T6.6; the fault points
parse. Property: the Step 9 forms above, 10 000 runs each. Model vs real: + T5, T7, T6.4–T6.6. DB: T5,
T7 and T6.4–T6.6 per row; a stale T7 after re-claim writes nothing. Integration (in-process bank,
Chromium): `errors/after-write` → verify `[1]` → `succeeded` / `already_done`, 1 row, `confirmationRef`
the row's id; `errors/on` armed in `before()` → `[0, 0]` → requeued → attempt 2, 1 row; a business
outcome after Submit with nothing written → `[0, 0]` → `business_outcome`, never retried; lookup
`transient` then success → counted (the one retry); lookup unreadable twice → `needs_human` /
`unreadable`; `rote jobs reverify` end to end.

## 4. Judges

- Crash matrix `--lease-seconds 5 --heartbeat-seconds 2 --expect step-09`: all 16 points with their
  Step 9 expectations (before-submit → `[0, 0]` → requeued → attempt 2, 1 row; after-submit … →
  `[1]` → `succeeded` / `already_done`, attempt 1, 1 row) plus the 7 recovery-internal scenarios.
  → `evidence/crash-matrix/step-09/`. The CI job stays report-only until Step 10.
- One chaos run (seeded, saved) → `evidence/chaos/step-09-seed-<n>/`: `RESULT: PASS`, and no
  `needs_human` / `commit_uncertain` left from a kill (they are verified now), the recoveries listed by
  label including `already_done` and `resubmitted`.

## 5. Commits

1. Lookup 1.2.0 + approvals + override digests + evidence.
2. `verifyDecision` + model + property tests (Step 9 forms).
3. `verify.ts` + T5 + T7 + DB tests + model-vs-real T5/T7.
4. Recovery T6.4–T6.6 + DB tests (incl. concurrent re-claim).
5. `rote jobs reverify` + tests.
6. Recovery-internal fault points + matrix two-fault scenarios + `step-09` expectations; matrix run.
7. One chaos run.
8. Docs: D-entries (verify procedure and decisions; T5; re-claim and the 3-phase cap; reverify),
   REPO_NOTES, README; the full suite 3 times; push; CI checked.

## Open questions for the reviewer

1. **Settle period 5 s** (one re-check after 0): enough for the mock bank (its ledger is synchronous),
   and a real bank may need more. Configurable (`ROTE_VERIFY_SETTLE_MS`); keep 5 s as the default?
2. **3 verify phases before `verify_exhausted`** (T6.6): each phase dies only by a crash or a lost lease,
   so 3 means the verifier itself is crashing repeatedly. OK, or fewer?
3. **`rote jobs reverify`**: one job at a time by id only (proposed), or also `--all-commit-uncertain`
   for the Step 6–8 backlog?
