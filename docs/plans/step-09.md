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

## Reviewer decisions (2026-11-11)

The reviewer **approved** this plan with the decisions below. Where they differ from the sections
above, these win; everything else in this file stands. The reviewer re-ran Step 8 on Postgres 16:
500/501, only the version-17 assertion failing, as expected; the guard SQL in `heartbeat.ts`,
`intent.ts`, `recover.ts` and `complete.ts` matches the plan.

### Part A, built first: a small item from Step 8

A1. **A distinct error for a forbidden completion.** When T4 updates 0 rows, re-read the job's
    `fencing_token` in the same transaction (or right after). Token changed → `lease_lost`, as today.
    Token unchanged → the worker attempted a transition `completionAllowed` forbids, i.e. a **bug**: log
    it at error level as `illegal_transition`, record the attempt outcome `illegal_transition`, and
    count it (a metric hook Day 3 will export). The job is untouched; its lease expires and recovery
    handles it. Test both branches.

### Part B: Step 9 as planned

Lookup 1.2.0 with `firstMatchRef` and its re-approval with fresh evidence and all three override
digests, `verifyDecision`, T5, T7, T6.4–T6.6, `rote jobs reverify` by id, the recovery-internal crash
points, T5/T7 in the model-vs-real test, the matrix's Step 9 expectations, one chaos run. Open
questions answered:

1. **Settle period default 5 s, configurable via `ROTE_VERIFY_SETTLE_MS`:** approved.
2. **3 verify phases before `verify_exhausted`:** approved.
3. **`rote jobs reverify`: one job at a time, by id only:** approved.

### Reviewer additions

4. **History lag in the mock bank.** Today the history page shows a transfer instantly, so the `[0, 1]`
   path never happens naturally and settle-and-recheck is untested. Add `/control/history-lag/:ms`
   (0 = off, the default): a ledger row becomes visible on history pages (and the count row) only after
   that many ms; `/control/ledger` (the oracle) always sees it at once. Then prove, with saved evidence:
   - lag 3000 ms, settle 5000 ms, a crash right after Submit → the verify sees `[0, 1]` → `succeeded` /
     `already_done`, exactly 1 ledger row;
   - lag 8000 ms, settle 5000 ms, the same crash → `[0, 0]` → resubmitted → 2 ledger rows → the oracle
     reports DUPLICATE.

   Saved as `evidence/settle-vs-history-lag/` with a README stating the rule: **the settle period must
   exceed the bank's history visibility delay.** That is a deployment configuration requirement, and
   the reconcile pass (Step 10) is the backstop. Also add a property/model event for lagged visibility
   so the model covers it.
5. **Bank unavailable ≠ ambiguous.** Split the "unreadable" verify outcome:
   - **unavailable:** the lookup fails with the bank's 503 / "System unavailable", or transient /
     session-timeout failures persist after the one retry → **defer**. The job stays `verifying`, the
     verify phase ends with decision `deferred` (a new value), and the job is retried after a backoff.
     Deferrals get their own budget (e.g. up to 10 minutes from the first deferral, configurable) that
     does **not** count toward the 3-phase crash cap; when the budget is exhausted → `needs_human`
     (outcome `verify_unavailable`).
   - **ambiguous:** 2+ matches, or a page that loads but can't be understood → `needs_human` at once,
     as planned.

   Design the exact SQL (respect the `jobs_active_has_owner` CHECK; e.g. keep the owner and set a short
   lease, or another approach, justified), add it to the pure state machine, the property tests and the
   model-vs-real test, and test it with `/control/errors/on` for 30 s during verifies: no duplicates,
   and the verifies complete after the outage instead of escalating. A D-entry.
6. **Step 10 plan item:** commit the deliberate-bug checks as `scripts/mutation-check` (apply each
   planted bug as a patch, run the property tests, expect red, revert), and run it in CI as a job.

### Turning green in Step 9

After Step 9 every crash-matrix point, the new recovery-internal ones included, is green with the
Step 9 expectations (after-intent points → verified, 1 row, `succeeded` or resubmitted). Run the matrix
at 5 / 2 timing plus one seeded chaos run; update the before/after table in `evidence/README.md`.

### Also required

- Memory: 8 GB laptop. Never run the full suite while the fleet is up; stop the fleet containers when
  not in use.
- `npm test` before every commit; never commit or push on red. Full suite 3 times at the end, logs
  unfiltered. After pushing, check CI with `gh` and report it; if it is red, fix it in this step.
- Then write `docs/plans/step-10.md` (commit it; don't build it): the Day-2 exit. Chaos at scale (20+
  seeds), the zombie stall-after-intent evidence paired with the reconcile pass, the bank-slow /
  bank-down scenario, the matrix at production 30 / 10 timing, crash tests required in CI, the chaos
  snapshot re-read fix, `scripts/mutation-check`, README "Fleet (Day 2)", the Day-2 exit criteria from
  the brief, and what must be true before the PR from `fleet/day-1` to `main` opens.

## Built (2026-11-13/14)

Built in order: Part A (A1), then section 5's commits. Commits 2–5 landed as one, because each alone left
the suite red: `jobOutcomeFor`'s `verifying` needs T5 in the worker, and T5 needs 0003 and the recovery
claims. The reviewer additions' evidence followed as its own commit. Session note: the build was
interrupted by a usage limit after commit 2–5 with commit 6 uncommitted in the working tree; it was
resumed, checked (typecheck, `npm test` 571/571) and committed, not redone.

| Commit | What |
| --- | --- |
| `9f1f873` | A1: `illegal_transition` (D41) |
| `2935370` | 1: lookup 1.2.0, approvals with the three override digests, history lag in the mock bank (D42) |
| `7337661` | 2–5: `verifyDecision`, T5/T7/T8, recovery T6.4–T6.7, `rote jobs reverify`, migration 0003, model + property + model-vs-real + DB + integration tests (D43–D46) |
| `efcd7c5` | 6: matrix `step-09` expectations + the 7 two-fault scenarios; run: 23/23 |
| `5416f60` | reviewer additions 4–5: `scripts/verify-scenarios.ts`; settle vs history lag, the 30 s outage (D47) |
| `5aeec8a` | 7: chaos run, seed 14449393 |
| (docs) | 8: D41–D47, the D40 amendment, REPO_NOTES, README, evidence index, this section; the full suite ×3 |

Decisions D41–D47 and an amendment to D40. Evidence: `evidence/step-09/` (every `npm test` log and the
mutation check), `evidence/transfer-history-lookup-1.2.0/`, `evidence/crash-matrix/step-09/`,
`evidence/settle-vs-history-lag/`, `evidence/verify-bank-outage-30s/`, and
`evidence/chaos/step-09-seed-14449393/`.

Where the build went beyond, or differed from, the text above:

- **"Unreadable" is four answers, not one** (reviewer decision 5, D44). `classifyLookup` returns count /
  unavailable / transient / unreadable, and the lookup itself recognizes the bank's 503 page
  (`BANK_UNAVAILABLE`), so verify can tell "down" from "garbled".
- **T8, the deferral** (the SQL the reviewer asked for). The job stays `verifying`; `lease_owner` stays
  the deferring worker (`jobs_active_has_owner`); the token is bumped, so that worker holds nothing; and
  `lease_expires_at = now() + backoff`. When the lease expires, recovery resumes the job (**T6.7**, a
  fourth claim not in the plan) as a phase with reason `resumed`. The backoff is 5 s doubling to 60 s and
  the budget 600 s, both configurable; deferrals never count toward the cap. Migration **0003_verify.sql**
  adds the values (`resumed`, `deferred`, `handed_off`, `illegal_transition`) and "decided ⇔ ended".
- **The 3-phase cap counts dead phases only** (crashed, lease lost, illegal transition), per verify
  *cycle* (the phases since a `commit_uncertain` or `lease_expired_in_committing` one).
- **`rote jobs reverify`** hands the job to recovery instead of verifying in the CLI. It writes
  `verifying` with a lease already expired and a `handed_off` phase, and the next worker resumes it
  (T6.7). It accepts every "could not tell" outcome (`commit_uncertain`, `unreadable`,
  `verify_unavailable`, `verify_exhausted`), never `ambiguous`.
- **`illegal_transition` (A1) applies to T5, T7 and T8 too.**
- **The mock bank's empty filtered history is one "No matching transfers." row**, so lookup 1.2.0's step-10
  always has a first row to read.
- **Reviewer addition 4's predicted outcomes held only when the verify starts at once.** With T5 (the bank
  writes, then answers 503), lag 3 s gave `[0, 1]` and lag 8 s gave `[0, 0]` → DUPLICATE, as predicted.
  With "a crash right after Submit", the verify starts only when the lease expires (~6 s after the write
  at the matrix's 5 s lease), so lag 3 s gave `[1]` and lag 8 s `[0, 1]`, one row each. A 30 s lag gave the
  crash-path duplicate. The evidence runs all six, each judged by a script against its own measured lookup
  timing. The rule stands as the reviewer stated it: settle ≥ lag is sufficient on every path (D47).
- **The 30 s outage is a saved evidence run** (`npm run verify-scenarios -- --family outage`). The 8 s
  version runs in `npm test`.
- **The crash matrix runs scenarios** (`X>Y`). Its harness pieces moved to `scripts/lib/harness.ts`. The
  CI job runs `--expect step-09` with a 60 s drain cap, still report-only.
- **Chaos now fails on any `needs_human`** and reports verify phases. The seed's 14 kills produced 3
  verifies, all `already_done`. None landed between an intent and its click, so this seed shows no
  resubmit. The seed was not re-drawn, and the matrix and verify scenarios cover that path.
- **Found while planning Step 10:** a failure before the intent is requeued for immediate pickup with no
  backoff, so a 30 s bank outage burns all 3 attempts and fails the job (safe, 0 rows, but not the brief's
  "retries back off"). Step 10 designs it.
- **Suite time:** 58 files, 571 tests, usually 162–176 s wall locally. Two of nine runs took 243–246 s
  (the verify commit's, and final run 1), with the extra spread across all tests (contention). That crosses
  section 2's 3-minute line. The `slow`-project move is a reviewed change, so it is proposed in step-10
  (open question 6), not made here.
