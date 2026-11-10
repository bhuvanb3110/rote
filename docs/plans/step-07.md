# Step 7 plan — close Day 1: the ledger oracle, the chaos harness, the crash-point matrix, CI (proposed, not built)

Branch `fleet/day-1`. Reads `docs/plans/step-06.md` (built; see its "Reviewer decisions" and "Built"
sections). Status: **for review**; nothing here is built.

The brief's Day-1 close: *"write the chaos test script and the ledger check now, even though they will
fail"*, plus CI. So this step builds the tools that will judge Day 2 and runs them against today's
fleet, which has leases but no heartbeat, no recovery and no commit intent. **Most of what this step
builds is expected to report failures today.** Those failures are recorded as the "before" evidence;
they are not tuned away, and none of them is in `npm test` (CI stays green on the tests that should be
green). Section 6 says exactly what stays red until Day 2.

Rules carried forward: extend replay, never fork it (new behavior enters `runReplay` only as optional,
additive options); every claim backed by a script-checked run under `evidence/`; `npm test` before
every commit; never push on red.

## 1. The ledger oracle: a reusable module plus a CLI

Today the Day-1 exit script (`scripts/evidence-day1-exit.ts`) carries its own ledger checks. Step 7
moves them into one module that every later harness (chaos, crash matrix, Day-3 load) calls, so
"0 duplicates, 0 lost" means the same thing everywhere.

**`src/oracle/ledger.ts`** (pure, no I/O):

```ts
checkLedger(input: {
  jobs: Array<Pick<JobRow, "id" | "tenant_id" | "state" | "memo_key" | "result" | "lease_owner">>;
  ledger: LedgerRow[];            // GET /control/ledger entries
  drainTimedOut: boolean;         // the harness's drain deadline passed
}): OracleReport
```

Per job, the rows of the ledger whose `memo` equals the job's `memo_key`:

| Job state | Rows | Verdict |
| --- | --- | --- |
| any | 2 or more | **DUPLICATE** (always the worst finding; reported even if the job is also lost) |
| `succeeded` | exactly 1 | ok (and `result.outputs.confirmationRef` must equal that row's id, and the row's tenant must be the job's: otherwise **MISMATCH**) |
| `succeeded` | 0 | **MISSING_COMMIT** (the job claims a transfer the bank never recorded) |
| `failed` | 0 | ok |
| `failed` | 1 | **UNRECORDED_COMMIT** (money moved, the job says it didn't) |
| `needs_human`, `business_outcome` | 0 or 1 | ok (a `commit_uncertain` with 1 row is exactly what Day 2's verify will turn into `succeeded`); the count is reported |
| `queued`, `running`, `committing`, `verifying` after the drain timeout | 0 or 1 | **LOST** (with the row count, so "lost after commit" is visible) |

Reverse check: every ledger row whose `memo` matches no job → **ORPHAN**. (The harnesses reset the
bank's ledger before a run, so every row must belong to a job of that run.)

`OracleReport` = per-job verdicts, counts per verdict, `pass` (no DUPLICATE, LOST, MISSING_COMMIT,
UNRECORDED_COMMIT, MISMATCH or ORPHAN), and a fixed-format text rendering that ends in
`RESULT: PASS` or `RESULT: FAIL`.

**`src/oracle/collect.ts`**: reads `jobs` from Postgres and `/control/ledger` from the bank.
**CLI**: `rote oracle check [--database-url …] [--bank http://127.0.0.1:4100] [--job-ids file]
[--out dir]` prints the report, writes `oracle.json` and `check.txt`, exits 1 on FAIL. The Day-1 exit
script is refactored to call the module (its run is repeated once afterwards to show the same PASS).

Tests (`npm test`): one unit test per row of the table and the orphan check, built from synthetic jobs
and rows; a DB test that collects from a test schema plus an in-process bank.

## 2. The chaos harness (expected to fail today)

`scripts/chaos.ts` (`npm run chaos -- --seed <n>`), driving Docker exactly as the brief describes,
from the Windows host or Linux alike:

1. **Seeded and reproducible.** A seeded PRNG (mulberry32; the seed comes from `--seed` or is drawn
   and printed) decides the whole schedule up front: kill times (uniform 5–15 s apart), which worker
   replica index is the victim, and the pause windows. The seed and the generated schedule are printed
   first and saved (`seed.txt`, `schedule.json`). Honest limit: the seed reproduces the schedule, not
   the interleaving of jobs with it (container start-up and Chromium timing vary between runs).
2. Stack up (`ROTE_WORKERS=4`), reset the queue tables and the ledger, enqueue N transfer jobs
   through the API (default 100), with distinct `Idempotency-Key`s.
3. **Kills:** `docker kill --signal=KILL <container>` per the schedule. Before each kill, the harness
   records which job the victim holds (`jobs.lease_owner`), so the report can tie every lost job to
   the kill that orphaned it (`events.jsonl`).
4. **Zombie scenario:** `docker pause` of one worker for a scheduled window, then `docker unpause`
   (the cgroup freezer, the real SIGSTOP/SIGCONT effect). Day 2's point is that a lease that expired
   while the worker was frozen must stop it from committing afterwards; today nothing expires leases,
   so the job simply resumes.
5. **Supervisor:** after each kill, `docker start <container>` brings the same replica back after a
   short delay (Compose's `restart: "no"` stays: the harness is the supervisor, so every restart is
   logged and attributable). The bank and Postgres are never touched (REPO_NOTES "disagrees" 8).
6. **Drain timeout** (default 10 min) after the last job was enqueued and the chaos schedule ended,
   then the oracle (section 1).
7. Writes `evidence/chaos/<UTC timestamp>-seed-<n>/`: `seed.txt`, `schedule.json`, `events.jsonl`,
   `oracle.json`, `check.txt`, `jobs.json`, `ledger.json`, `docker stats` samples and `docker compose
   logs`. Exit 1 on FAIL.

**The "before" evidence.** Step 7 runs the harness once (seed printed and committed) and commits that
folder as `evidence/chaos/before-day2/`, with a `README.md` stating that it is **expected to fail**
and why: each killed worker leaves its job `running` forever (no lease expiry, no recovery), so the
oracle must report LOST jobs, some of them "lost after commit" (a row exists, the job says `running`).
It may also report 0 duplicates. That is not a success: duplicates need a second runner, and only
Day 2's recovery creates one. The README says this plainly so nobody reads "0 duplicates" as safety.
`check.txt` will end in `RESULT: FAIL`, and the handoff report will quote it.

## 3. The crash-point matrix (mechanism now; green on Day 2)

The brief's amendment: kill the worker at every step boundary of the transfer and show exactly-once
for each point. Step 7 plans and builds the mechanism, runs the matrix once, and records it; it turns
green on Day 2.

**Hooks, additive only.**
- `onIrreversible.before` / `.after` already exist (D11, D12).
- New, optional `ReplayOptions.onStep?: { after(step: Step, index: number): Promise<void> }`, called
  after each step's checkpoint passes. Absent → no behavior change (every existing call site
  unchanged); `invokeCapability` passes it through like the other fleet options. A throw from it is
  treated like a hook error (rejects, D11).
- The worker gets a fault flag, `ROTE_FAULT=<point>` (read once at start, refused unless
  `ROTE_FAULT_ENABLE=1` so it can never be set by accident in a real deployment), where `<point>` is
  one of:

| Point | Where it fires |
| --- | --- |
| `after-dequeue` | lease taken, before any browser work |
| `after-step-01` … `after-step-10` | `onStep.after` for each step before the irreversible one |
| `before-submit` | `onIrreversible.before` (Day 2: after the commit intent is written) |
| `after-submit` | `onIrreversible.after` (the bank has answered; its ledger has the row if it committed) |
| `after-step-12` | after the confirmation reference was read |
| `before-complete` | the outcome is computed, the completion transaction not started |
| `after-complete` | the completion transaction committed |

  At the point, the worker calls `process.kill(process.pid, "SIGKILL")`: no cleanup, no finally
  blocks, the same as a container kill (on Windows it is `TerminateProcess`, which is equivalent for
  this purpose; CI runs on Linux).

**Harness** (`scripts/crash-matrix.ts`, `npm run crash-matrix`): for each point, a fresh test schema
and a fresh in-process bank, one job, a worker started as a **child process** (`tsx
src/worker/main.ts`) with the fault flag, wait for its exit, check that it died by signal at the
intended point (it logs the point just before killing itself), then start a clean worker, drain with a
timeout, and run the oracle. One row per point in `evidence/crash-matrix/<timestamp>/matrix.md`
(point, final job state, ledger rows, verdict) plus `check.txt`.

**Expected today:** every point is red. The killed worker's job stays `running` (lease 300 s, no
recovery), the clean worker never takes it, and the oracle reports LOST, with 1 ledger row for
`after-submit` and later. On Day 2 the expected result per point is: before `before-submit` → retried,
1 row; `before-submit` (intent written) → verify finds 0, retry, 1 row; `after-submit` and later →
verify finds 1, `succeeded`, 1 row; `after-complete` → already terminal.

The matrix runs on every CI push only once it is green (Day 2). Until then it is a script, and its
red output is committed as evidence.

## 4. GitHub Actions CI

`.github/workflows/ci.yml`:

```yaml
name: ci
on:
  push:
    branches: ["main", "fleet/**"]
  pull_request:
    branches: ["main", "fleet/**"]
jobs:
  test:
    runs-on: ubuntu-24.04
    timeout-minutes: 30
    services:
      postgres:
        image: postgres:17
        env: { POSTGRES_USER: rote, POSTGRES_PASSWORD: rote_dev_only, POSTGRES_DB: rote }
        ports: ["55432:5432"]
        options: >-
          --health-cmd "pg_isready -U rote -d rote" --health-interval 2s
          --health-timeout 3s --health-retries 30
    env:
      ROTE_TEST_DATABASE_URL: postgres://rote:rote_dev_only@127.0.0.1:55432/rote_test
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx playwright install --with-deps chromium   # the version in package-lock (1.62.1)
      - run: npx tsc -p tsconfig.json --noEmit
      - run: npm test 2>&1 | tee npm-test.txt; exit ${PIPESTATUS[0]}
      - if: always()
        uses: actions/upload-artifact@v4
        with: { name: npm-test-log, path: npm-test.txt }
```

- **Playwright pinned to the repo's version:** `npx playwright install` uses the `playwright`
  package installed by `npm ci` from `package-lock.json` (1.62.1), so the browser matches the
  package. A step prints `npx playwright --version` into the log.
- **Node:** 22 (LTS; `engines` says `>=20`). The builder's machine runs Node 25.9.0; open question 3.
- **The full log is uploaded on every run**, pass or fail, so a CI failure keeps its full error text
  (the same rule as the local evidence).
- **Badge** in the README: `![ci](https://github.com/bhuvanb3110/rote/actions/workflows/ci.yml/badge.svg?branch=fleet/day-1)`.
- The workflow-scope token is already set up, so pushing `.github/workflows/` works.
- The Postgres-16 caveat from the reviewer's run: CI uses 17, as Compose does, so the version-17
  assertion holds.
- **Flake risk:** `net::ERR_INSUFFICIENT_RESOURCES` (Step 6, `evidence/step-06/flakes.md`) came from
  many parallel Chromium instances on one host. GitHub's runners have 4 vCPUs and 16 GB. If CI
  shows it, the fix is a reviewed change (vitest `maxWorkers` in CI only), never a retry that hides
  it.
- Not in CI (stated in the README): the Docker image build, the Day-1 exit, chaos and the crash
  matrix. They need the Compose stack and minutes of wall time; they run as scripts with committed
  evidence. Open question 2 proposes a separate image-build job.

## 5. Commits

1. `src/oracle/ledger.ts` + unit tests (one per verdict).
2. `src/oracle/collect.ts`, `rote oracle check` CLI + DB test; refactor `evidence-day1-exit.ts` onto it;
   re-run it (PASS expected) into `evidence/fleet-day1-exit-oracle/`.
3. `ReplayOptions.onStep` (additive) + `invokeCapability` pass-through + tests (absent = unchanged;
   called once per passed step; a throw rejects).
4. Worker fault flag (`ROTE_FAULT`, `ROTE_FAULT_ENABLE`) + unit tests (refused without the enable flag;
   unknown point refused at startup).
5. `scripts/crash-matrix.ts` + one run → `evidence/crash-matrix/before-day2/` (expected red).
6. `scripts/chaos.ts` + one run → `evidence/chaos/before-day2/` (expected `RESULT: FAIL`).
7. `.github/workflows/ci.yml`, README badge and "CI" section; first CI run linked in the handoff.
8. Docs: D-entries (oracle verdicts; chaos determinism and supervisor; `onStep` and the fault flag;
   CI), REPO_NOTES, README "Chaos and the oracle (Day 1: expected to fail)".

## 6. What stays red until Day 2, plainly

| Thing | Today (after Step 7) | Why | Turns green when |
| --- | --- | --- | --- |
| `npm test` and CI | **green** | tests cover what is built and correct now | stays green |
| Day-1 exit (100 jobs, no faults) | green if Step 6's run passed | no faults injected | stays green |
| Chaos harness `check.txt` | **RESULT: FAIL** (LOST jobs; possibly 0 duplicates) | a killed worker's job stays `running`: no lease expiry, no recovery, no restart of its job | Day 2: heartbeat + expiry + recovery + commit intent + verify |
| Zombie (pause) scenario | the paused worker resumes and finishes its job; no protection is exercised | nothing expires the lease while it is frozen | Day 2: the lease expires, the fencing check stops the zombie's commit |
| Crash-point matrix | **every point red** (LOST; 1 row from `after-submit` on) | as above | Day 2 |
| "0 duplicates" under chaos | **not claimed** | without a second runner, duplicates cannot occur, so their absence proves nothing | Day 2 chaos runs |

## 7. Proposed D-entries

- **D30: The oracle's verdicts** (section 1's table); DUPLICATE dominates; ORPHAN as the reverse
  check; why `needs_human` may have 0 or 1 rows.
- **D31: Chaos is seeded on the schedule, not the interleaving**; the harness is the supervisor
  (`docker start`), Compose keeps `restart: "no"`.
- **D32: Crash points via an additive `onStep` hook and a doubly-gated fault flag**; self-SIGKILL in a
  child process.
- **D33: CI: GitHub Actions, `postgres:17` service, Playwright from the lockfile, full log uploaded.**

## Open questions for the reviewer

1. **Chaos default size:** 100 jobs, 4 workers, kills every 5–15 s, one pause of 45 s, drain timeout
   10 min. OK, or should the "before" run be shorter for the 4 GB Docker VM (it has 8 GB swap now)?
2. **A CI job that builds the Docker image** (about 5 minutes, 3.6 GB) on pushes to `main` only, to
   catch a broken `Dockerfile` early? Or keep Docker out of CI until Day 3?
3. **Node in CI:** 22 LTS (proposed) vs the builder's 25.9.0. Pin 22 in `engines` too?
4. **The `ERR_INSUFFICIENT_RESOURCES` flake:** leave as is and keep recording it, or cap vitest's
   parallelism (`maxWorkers`) locally as well as in CI?
