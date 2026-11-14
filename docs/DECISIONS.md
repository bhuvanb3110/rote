# Design decisions — fleet build

One entry per decision: **Decision**, **Alternatives considered**, **Why**, **Date**. Append new
entries at the bottom; never rewrite an old one — add a new entry that supersedes it.

## D1: Reverse CLAUDE.md's single-process rule for the fleet

**Decision.** CLAUDE.md's bullet "Do NOT build scaling infra (queues, clusters, multi-tenant
plumbing). Single process." is replaced by a single-machine fleet scope: Postgres job queue, worker
processes, leases and fencing, Docker Compose, per `docs/FLEET_BRIEF.md`. Every other non-negotiable
(Surface abstraction, ranked semantic locators, the four-way result union, the single policy gate,
redaction, escalation owner token) is unchanged. Multi-machine (Kubernetes, autoscaling) and desktop
surfaces stay out of scope and design-only.

**Alternatives considered.**
- Leave CLAUDE.md alone and build the fleet anyway — every future Claude Code session would push
  back on, or quietly "fix", fleet code against a rule that says not to write it.
- Build the fleet in a separate repo — duplicates replay and the mock bank, and "extend replay,
  don't fork it" becomes impossible.
- Delete the rule entirely — loses the useful limit (no distributed infra).

**Why.** The original rule was right for the original scope: one browser, one human, a demo.
The fleet is a deliberate new scope, and the rule must say so in the file the assistant reads first.
Narrowing rather than deleting keeps the real boundary: one machine.

**Date.** 2026-11-09

## D2: Postgres (`SKIP LOCKED`) over Redis or a queue library

**Decision.** Jobs, leases, fencing tokens, commit intent and circuit-breaker state live in
Postgres. Workers dequeue with `SELECT … FOR UPDATE SKIP LOCKED`.

**Alternatives considered.** Redis (lists/streams, or BullMQ on top of it); a Postgres queue
library (e.g. graphile-worker, pg-boss); an in-process queue.

**Why.** The brief's reason: one store keeps job state, the lease, and the commit intent in the
same transaction, which is what makes recovery correct. "Confirm the lease is still held with this
token, then set `committing`" must be atomic; with Redis that spans two systems. `SKIP LOCKED` lets
many workers dequeue without blocking each other. A queue library would hide the lease/fencing
rules this project exists to demonstrate and to defend in an interview, so the SQL is written by hand.

**Date.** 2026-11-09

## D3: Hand-author the transfer and history-lookup capability artifacts

**Decision.** The `transfer` and `transfer-history-lookup` Capability artifacts are written by hand
in the same shape as `artifacts/open-sub-account-confirmed.json`, validated through
`deserializeCapability`, approved with a recorded reason in `status/`, and covered by replay tests.
No LLM discovery run produces them.

**Alternatives considered.**
- Run `rote discover` for both flows — needs an API key and costs money, and discovery stops at
  confirmation screens by design, so it can never produce the final irreversible "Submit" step.
- Discover the read-only history lookup with the LLM and hand-author only the transfer — possible
  later as extra evidence (an open question for the reviewer), but not needed for the fleet.

**Why.** $0 cost, deterministic and reviewable. The precedent is already in the repo:
`open-sub-account-confirmed.json` (added in commit 0a3b247 with the escalation feature) is the one
artifact whose final step is a risky "Confirm", which discovery by design never produces — it sits
beside the discovery-produced `open-sub-account.json`. The artifact schema and
replay engine are unchanged, so nothing about the fleet depends on how the artifact was authored.

**Date.** 2026-11-09

## D4: Run workers as Docker Compose services so chaos uses real signals

**Decision.** Workers (and the mock bank, API, Postgres, telemetry) run as Docker Compose services.
The chaos script uses `docker kill --signal=KILL <worker>` for crashes and `docker pause` /
`docker unpause` for the zombie-worker scenario.

**Alternatives considered.**
- Spawn workers as host Node processes and kill them from the chaos script — on Windows,
  `process.kill`/`taskkill /F` is `TerminateProcess` (an acceptable SIGKILL stand-in), but there is
  **no SIGSTOP/SIGCONT**, so the paused-worker scenario cannot be done faithfully.
- Emulate the pause by suspending the process with a native helper (e.g. `NtSuspendProcess`) —
  Windows-only, fragile, and not what a Linux deployment would experience.
- Fault-injection flags only, no real signals — fine for the CI crash-before/after-submit tests
  (which still use in-process flags), but it does not prove behavior under messy real kills.

**Why.** `docker pause` uses the cgroup freezer, which has the real SIGSTOP-like effect (the
process, including its heartbeat timer, stops mid-flight and later resumes) on any host OS, and
`docker kill --signal=KILL` is a real SIGKILL to PID 1 of the container. The same chaos script then
runs unchanged from PowerShell, CI or Linux. Verified available on 2026-11-09: Docker 29.9.3,
Compose v5.7.0. Cost: containers need ~4 GB of Docker VM memory to host many Chromium workers
(see the open question about memory).

**Date.** 2026-11-09

## D5: The mock bank truncates memos at 64 characters; the fleet writes a job-derived key

**Decision.** The mock bank silently truncates the memo to 64 characters when a transfer is
submitted, and stores and shows the truncated value (the confirm page still shows what was typed).
Consequence: the fleet writes a **job-derived key, `rote-<job uuid>` (41 characters)**, into the
memo, never the raw client `Idempotency-Key`, which can be any length. The two are equivalent for
our purpose because each idempotency key maps to exactly one job, so finding the job's key in the
history finds that client request's transfer.

**Alternatives considered.**
- Put the client's `Idempotency-Key` into the memo — breaks silently for keys over 64 characters:
  the stored memo is cut, and the history lookup for the full key finds nothing, which looks like
  "not committed" and invites a duplicate.
- Reject over-long memos in the bank — unlike real banks, and it would hide the hazard instead of
  testing for it.
- Hash the client key to a fixed length — works, but the job uuid already exists and is unique.

**Why.** Real banks truncate free-text fields without telling the operator. Making the mock do the
same forces the fleet's key to fit, and the 41-character key fits with room to spare.

**Date.** 2026-11-09

## D6: A write-then-error bank mode (`/control/errors/after-write`)

**Decision.** Besides `errors/on` (503 before any write), the mock bank has `errors/after-write`:
on `POST /member/:id/transfer/confirm` it appends the ledger row and then returns the 503 "System
unavailable" page. `errors/off` clears both. The fleet must treat any error observed **after the
commit intent** as "unknown, verify via history", never as "failed, retry".

**Alternatives considered.**
- Only the before-write error — a retry-on-error policy would pass every test, hiding the bug.
- Make the bank fail randomly after writing — harder to reproduce and to assert; a deterministic
  mode gives a test that fails if the fleet ever retries blindly.

**Why.** This is the realistic duplicate trap: the bank commits, then the worker sees an error
(timeout, 5xx, dropped connection). It is the same situation as a crash after submit, reached by a
different route. A test with this mode leaves exactly one ledger row while the page shows an error.

**Date.** 2026-11-09

## D7: Fleet workers run only approved capabilities; never pass `approveUnattended`

**Decision.** Fleet workers run only capabilities whose status is `approved`. They never pass
`approveUnattended` to `runReplay`/`invokeCapability`.

**Alternatives considered.**
- Let workers run draft capabilities unattended via `approveUnattended` so they accrue confidence
  runs — that is exactly the path that writes `status/<id>.json` after a run.

**Why.** `recordConfidenceRun` writes the status file only for draft capabilities, and its
read-modify-write has a documented lost-update race (`src/confidence/store.ts`). Approved
capabilities are never written, so concurrent workers share no mutable file state. The two transfer
artifacts are approved by hand with a recorded reason (Step 3) before any worker runs them.

**Date.** 2026-11-09

## D8: Retry the transient screenshot failure inside `WebSurface.perceive()`

**Decision.** `perceive()` retries `page.screenshot()` up to 3 attempts in total, only when the
error message matches `/Unable to capture screenshot/`, with a 100 ms × attempt backoff. Any other
error, or the third failure, throws exactly as before. Each retry increments a public read-only
`screenshotRetries` counter on the surface, which the fleet will report as a metric.

**Alternatives considered.**
- **Cap test parallelism** (vitest `maxWorkers`/`fileParallelism: false`) — makes the test suite
  green by making the machine less busy. It only hides the problem in tests: the fleet runs many
  browsers on one machine *by design*, so production would hit the same failure with nothing to
  absorb it.
- **Catch it in the fleet worker** — the worker would see a throw from `runReplay` and would have
  to decide whether to retry the whole job. After the irreversible click that is exactly the wrong
  moment to throw, and the worker cannot tell a screenshot hiccup from a real crash. It also leaves
  every non-fleet caller (CLI, catalog HTTP, tests) unprotected.
- **Degrade: return an empty screenshot on failure** — keeps replay going but silently loses
  evidence, and a failure that is not transient would never surface.

**Why.** The failure is a transient Chromium hiccup under CPU load (measured: 4 of 4 unpatched full
runs failed; with a retry, 6 of 6 passed and every retry succeeded on its first attempt). The fleet
creates exactly that load on purpose, so the fix belongs at the lowest layer that sees it, where it
protects every caller. The narrow message match and the attempt cap keep real errors loud, and the
counter keeps the retries visible instead of hidden.

**Date.** 2026-11-09

## D9: Chaos at 4 workers; load test at 1, 2, 4 and 6 workers

**Decision.** Chaos runs use 4 workers. The load test runs 1, 2, 4 and 6 workers (not the brief's
1, 2, 4 and 8) and reports where throughput stops growing and why.

**Alternatives considered.**
- Keep the brief's 8 workers — with ~4 GB for Docker, 8 Chromium workers plus Postgres, the mock
  bank, the API and the telemetry stack would likely run out of memory, and an OOM-killed worker
  in a chaos run is indistinguishable from a chaos kill, which corrupts the result.
- Raise Docker's memory allocation — the laptop has 8 GB in total; giving Docker more starves the
  Windows host that runs the tests and the IDE.
- Run workers on the host instead of in Docker — gives up real `docker pause`/`kill` (D4).

**Why.** The builder's laptop has 8 GB RAM and Docker gets about 4 GB (`docker info`, REPO_NOTES
Q7). 4 workers leaves headroom so chaos kills are the only kills. Stepping the load test to 6 finds
the real memory ceiling instead of assuming it, and the brief itself prefers an honest "it flattens
at N workers because each context needs X MB" to a big number.

**Date.** 2026-11-09

## D10: "The commit may have happened" is an optional `commitUncertain` field, not a fifth status

**Decision.** `ReplayResult`'s `business_outcome`, `needs_human` and `failure` members gain an
optional `commitUncertain: { irreversibleStepId, detail }` (`src/artifact/replayResult.ts`).
`runReplay` sets `irreversibleAttempted` right *before* it dispatches the irreversible click, and
`finish()` (the one function every result goes through) adds the field to every non-success result
from then on. `success` never carries it. Meaning: **present → verify (history lookup) before any
retry; absent on a non-success → nothing irreversible was attempted, a blind retry is safe.** Once
the attempt is made, replay also stops applying recoverable retries/reloads, never repeats the
irreversible step (operator mode: a "retry" after hand-back becomes a terminal `needs_human`), and
turns any throw into `failure`/`unknown` with the field. The CLI prints a distinct warning line.

Fleet rule (built on Day 2): `business_outcome` + `commitUncertain` → verify via history. 1 match →
the job succeeded. 0 matches → record the business outcome as **final, no retry**. A bank refusal
is never looped until `max_attempts`.

**Alternatives considered.**
- A fifth status `commit_unknown` — changes CLAUDE.md's four-way union (a non-negotiable) and throws
  away the real classification ("503 after Submit" is still a `failure`; "Insufficient funds on the
  confirm POST" is still a `business_outcome`).
- `failure.category: "commit-unknown"` — covers only `failure` and overwrites the real category;
  `business_outcome`/`needs_human` after Submit would have nowhere to say it.
- Leave it to the caller to infer from `atStepId` — every caller would have to know which step is
  irreversible, and a throw after the click would carry no result at all.

**Why.** Step 3 measured the trap: with `errors/after-write` the bank commits, the page shows a 503,
and replay returned a plain `failure` that a retry-on-failure caller would repeat. A
"transient right after Submit" test, run against the old rules, showed the worse case: replay's
recoverable reload re-posted the confirm form and reported `success` with a commit made by the
*second* POST. An additive optional field keeps every existing consumer compiling and every old
result parsing, while making the dangerous case explicit and set in one place. Reviewer approved the
field and the `business_outcome` coverage (step-04 reviewer decisions 1 and 3).

**Date.** 2026-11-09

## D11: Abort and hook errors reject; they never return a `ReplayResult`

**Decision.** If `onIrreversible.before()` throws, the click never happens and `runReplay` rejects
with that same error, unwrapped. If `after()` throws, `runReplay` rejects with its error. If
`signal` aborts (already at entry, or mid-run), replay closes its context at once and rejects with
`signal.reason`, even after the irreversible attempt; evidence gets one `aborted` entry
(`reason`, `irreversibleAttempted`), no `result` entry and no confidence write. Abort wins over a
hook error. In every case the run's context is closed before the promise settles.

**Alternatives considered.**
- Return a `failure` carrying `commitUncertain` on abort after the attempt — gives a worker that has
  already lost its lease something that looks recordable.
- Wrap hook errors in a replay error type — the fleet would have to unwrap its own fencing error to
  recognize it.
- Let the run finish after an abort and discard the result — keeps clicking on a job another worker
  now owns.

**Why.** The fleet aborts only when its heartbeat has lost the lease, and its hooks throw only for
its own reasons (fencing). In both cases the fleet owns the outcome: a stale worker must record
nothing, and the next lease holder recovers by reading the bank's history. A rejection is the one
shape a worker cannot accidentally persist as a job result. Reviewer approved (decision 2).

**Date.** 2026-11-09

## D12: `onIrreversible.after()` runs once the bank has answered, with a bounded wait

**Decision.** After the irreversible click, replay waits up to **10 s** for the main frame's
resulting navigation to reach `load` (`WebSurface.watchNextNavigation`, attached *before* the click
so the navigation can't be missed), then calls `after()`. A timeout or error in that wait does not
throw: it is recorded as an `irreversible_settle` evidence entry (`loaded: false`, `reason`) and
`after()` still runs. `after()` also runs if the click itself threw.

**Alternatives considered.**
- Call `after()` as soon as the click resolves (the original plan) — Playwright's click can resolve
  before the POST is processed, so a crash-after-submit test would sometimes see 0 rows and sometimes
  1, which proves nothing.
- Wait for a specific success page — couples the hook to each capability's success condition, and a
  503 or business-outcome answer would never arrive.
- Throw when the wait times out — turns a slow bank into a lost result right after the commit, the
  worst moment to throw.

**Why.** The crash-after-submit test is only meaningful if, when `after()` fires, the bank has
already processed the POST: then the ledger has exactly one row and the fleet must find it via
history. Waiting for "load" of whatever page comes back (success, error or 503) gives that, for
every outcome, without knowing the capability. Bounded, because a hung bank must not hang a worker.
Cost: a click that navigates nowhere (e.g. a Submit that was never found) waits the full 10 s; this
only happens on an already-failing run. Reviewer decision 7.

**Date.** 2026-11-09

## D13: Reuse the worker's browser; workers enter through `invokeCapability`

**Decision.** `ReplayOptions.browser` (and `WebSurfaceOptions.browser`): replay opens a fresh
context on the given browser and closes only that context on every exit path. `headless` is ignored,
not rejected, when a browser is passed. `invokeCapability` passes `browser`, `onIrreversible`,
`signal`, `evidenceBaseDir` and `statusDir` through to `runReplay`; fleet workers call
`invokeCapability`, never `runReplay` directly.

**Alternatives considered.**
- One browser per job (today's behavior) — a Chromium launch per job costs time and memory the
  4 GB Docker VM doesn't have (D9).
- Throw when both `headless` and `browser` are given — `invokeCapability` always passes `headless`,
  so the fleet's own call would throw.
- Workers call `runReplay` and resolve tenant overrides themselves — a second copy of tenant
  resolution that can drift from the CLI and HTTP paths.

**Why.** One browser per worker and one context per job is the brief's model: contexts don't share
cookies (tested with two concurrent runs) and are cheap to create and destroy. Routing workers
through `invokeCapability` keeps param validation and tenant resolution in one place for CLI, HTTP
and fleet. Reviewer decisions 4 and 5.

**Date.** 2026-11-09

## D14: Scope business-outcome recognizers to the bank's error box, without a schema change

**Decision.** The transfer and history-lookup `knownOutcomes` are `elementPresent` recognizers whose
target is a single `css` strategy on the error-message element, e.g.
`.msg1.err:has-text("Insufficient funds")` (Playwright's `:has-text` through `page.locator`),
instead of whole-page `textPresent`. `RECIPIENT_CLOSED` requires both "Recipient" and "is closed.".
Both artifacts are now 1.1.0. Added `REQUIRED_FIELD_MISSING` ("is required.").

**Alternatives considered.**
- Keep whole-page `textPresent` — the confirm and history pages display the memo, so a memo
  containing "Insufficient funds" or "Record not found" was reported as that business outcome
  (test written first; it failed with `NO_SUCH_MEMBER`).
- Add a scoped recognizer kind to the schema (e.g. `textPresent` with a `within` descriptor) — cleaner
  and surface-neutral, but a schema change, which this step was told not to make.
- Choose memo text that can never collide — the fleet controls its own memo (`rote-<uuid>`), but
  other operators' memos appear in the same history.

**Why.** It closes a real false positive that would mislabel a committed transfer, and in the
lookup it would break the fleet's verify step, using vocabulary the schema already has. Limits,
recorded in REPO_NOTES: the descriptor is CSS-only (no semantic strategy exists for a non-interactive
message box), and `:has-text` is Playwright-specific, so a future `DesktopSurface` would need its
own equivalent; if the bank's error markup changes, these recognizers stop matching and the run ends
in a `failure` at the Submit step (no Submit button on the re-shown form) instead of a
`business_outcome`. Nothing is submitted, but the result carries a conservative `commitUncertain`
(see the REPO_NOTES limitation on a Submit that is never found). A scoped recognizer kind is the
proper fix in a reviewed schema step.

**Date.** 2026-11-09

## D15: Approvals are bound to the artifact version; all five committed approvals backfilled

**Decision.** Every approval (auto-promotion and `catalog approve`, with or without a reason) records
`approvedVersion` in `status/<id>.json`. `checkApproval(id, version, …)` refuses an approved status
whose `approvedVersion` differs from the artifact's `version` ("approved for 1.0.0, artifact is
1.1.0; re-approve"), in either direction (an upgrade or a downgrade). A status with no
`approvedVersion` still parses and is still allowed, and the gate's reason says it is grandfathered.
Runs record their version too, and the auto-promotion streak counts only runs of the version being
promoted. The catalog lists a stale approval as `draft`.

The five committed status files were **backfilled** with `approvedVersion: "1.0.0"`, leaving
`approvedAt` and `approvedReason` untouched:
- `member-lookup`, `open-sub-account`, `open-sub-account-confirmed`: each artifact has exactly one
  commit in git history (034faf1 / 0a3b247, 2026-08-13), always at 1.0.0, never edited; they were
  approved on 2026-09-03 (d05edca). So "approved for 1.0.0" is a fact, not a guess.
- `transfer`, `transfer-history-lookup`: approved in Step 3 (f1f2e8b) when both were 1.0.0 (776c86b),
  then bumped to 1.1.0 in Step 4 (b9ecaa2) with no re-approval, which is exactly the gap. After the
  backfill, both are **refused** at 1.1.0 until re-approved on the basis of a new 1.1.0 evidence run
  (`evidence/transfer-replay-1.1.0/`).

**Alternatives considered.**
- *Leave the three grandfathered files without a version* (allowed forever with a "grandfathered"
  reason). That keeps the gap open for exactly those three: anyone could edit `member-lookup.json`,
  bump it, and it would still run unattended. The history needed to backfill honestly exists, so
  there is no reason to keep the hole.
- *Leave the transfer pair without a version, then re-approve.* The 1.1.0 evidence run would then
  run under an approval that really covered 1.0.0, labelled "grandfathered", which is untrue.
- *Store a content hash instead of (or as well as) the version.* Catches an edit that forgets to bump
  the version, which the version alone does not. But artifacts are hand-edited JSON (CRLF/LF and
  formatting changes would invalidate approvals for no behavioral change), and the schema already
  says the version is bumped when the flow changes. Noted as a possible later hardening; not done.
- *Flip a stale approval back to `draft` on disk.* The file would stop recording what was actually
  approved. The gate already refuses it; the catalog shows it as draft.

**Why.** An approval is a claim about specific, tested behavior. An artifact edit changes the
behavior (Step 4 changed every business-outcome recognizer of `transfer`), so the claim must not
carry over silently. The missing-version path stays for files written before this change (and for
any outside this repo), but no committed file uses it any more; it is tested, not relied on.

**Date.** 2026-11-09

## D16: `pg` (node-postgres) as the driver

(Drafted as D15 in docs/plans/step-05.md §10; renumbered because D15 went to version-bound
approvals, which landed first.)

**Decision.** `pg` 8.23 with an explicit `Pool` per process and one checked-out client per
transaction, through a single helper, `withTransaction` (`src/queue/db.ts`). `int8` is parsed to
`number` by a per-pool type parser that throws above `Number.MAX_SAFE_INTEGER`.

**Alternatives considered.** `postgres` (postgres.js): faster, with a tagged-template API and
`sql.begin()` transactions. `pg-promise`. A query builder (Kysely, Knex).

**Why.** The queue's correctness lives in a few hand-written transactions (D2). `pg` keeps each one
literal: a SQL string, a parameter array, and `BEGIN`/`COMMIT` on a client you can see. postgres.js's
tagged templates build SQL from fragments and pin connections implicitly inside `sql.begin`, which
hides exactly what this project needs to show and defend. `pg` is the most widely deployed Node
driver, so its `SKIP LOCKED` usage and pool error handling are well trodden, and its throughput is far
beyond what a few browser workers generate. Cost: CommonJS (imports fine from ESM) and `int8` as
strings, handled by the guarded parser (a rounded fencing token could compare equal to another).

**Date.** 2026-11-09

## D17: Plain `.sql` migrations and a small runner, no ORM

(Drafted as D16.)

**Decision.** Forward-only numbered files in `db/migrations/`; `src/queue/migrate.ts` (~130 lines)
applies each pending file in its own transaction together with its `schema_migrations` row, under a
session advisory lock keyed on `current_schema()`, with SHA-256 checksums computed after CRLF → LF.
An applied file that was edited or deleted fails the run. `.gitattributes` pins `*.sql` to LF.
`rote db migrate` / `npm run db:migrate`; Step 6's workers and API run it at startup.

**Alternatives considered.** An ORM with migrations (Prisma, Drizzle, TypeORM); node-pg-migrate;
Knex migrations; graphile-migrate.

**Why.** The schema is part of the design being reviewed: constraints, partial indexes and a
generated column read best as the SQL Postgres runs. An ORM would add a second schema language, a
generator and a runtime the project doesn't otherwise need (CLAUDE.md is schema-first with Zod). The
runner is small enough to test fully: concurrent starts apply once, a failing file rolls back whole
and releases the lock, CRLF and LF checkouts agree (all in `migrate.db.test.ts`).

**Date.** 2026-11-09

## D18: The per-tenant cap is a recount under a tenant row lock; a tenant that yields nothing is excluded and the claim retried

(Drafted as D17; adjusted for reviewer decision 6.)

**Decision.** Dequeue (`src/queue/dequeue.ts`), one transaction per try: (1) claim a tenant row with
queued work and a probable free slot, `FOR UPDATE OF t SKIP LOCKED`, oldest waiting job first;
(2) recount active jobs (`running`, `committing`, `verifying`) in a fresh statement; (3) pick the
oldest queued job `FOR UPDATE SKIP LOCKED`; (4) lease it (attempt + 1, fencing_token + 1, expiry =
`now()` + lease); (5) insert the attempt row. If (2) finds the tenant full or (3) finds no job (its
rows locked by another transaction), the try is rolled back and (1) runs again **excluding that
tenant**; each retry excludes one more tenant, so the loop is bounded by the tenant count.

**Alternatives considered.**
- A count in the same transaction with no lock: write skew (two dequeuers each count 1 under cap 2
  and both lease). Forced in `dequeue.db.test.ts`: 3 active under cap 2.
- `pg_try_advisory_xact_lock(hashtext('tenant:'||id))`: equivalent serialization, but hash collisions
  can make two tenants share a lock, and the lock is invisible in the schema.
- `SERIALIZABLE`: correct, but turns contention on a popular tenant into serialization-failure retry
  loops.
- Returning `null` when the claimed tenant yields nothing (the plan as first drafted): the reviewer
  found the starvation bug, where a tenant whose queued jobs were all exhausted (or row-locked) was
  claimed first and dequeue returned `null` while other tenants had work.

**Why.** It is correct under `READ COMMITTED` and deterministic, and it reuses the `SKIP LOCKED`
primitive the queue already depends on. A tenant being claimed by someone else is skipped, not waited
on. Exclude-and-retry means a dequeue never returns `null` while an unlocked tenant with room still
has a dequeueable job, and exhaustion can no longer cause it at all: the schema forbids a queued job
with no attempts left (D21). Measured (`evidence/step-05-queue/check.txt`): 300 jobs, 16 dequeue loops,
cap 2, max active per tenant 2 over 2045 samples, 0 duplicate ids. Known cost: a dequeuer that finds a
tenant's row locked by another dequeuer skips it, so with one hot tenant it can return `null` while a
slot is momentarily free; the worker's next poll picks it up (REPO_NOTES "Known limitations" 7).

**Date.** 2026-11-09

## D19: Enqueue is one `INSERT … ON CONFLICT (tenant_id, idempotency_key) DO UPDATE` (no-op) `RETURNING`; keys are unique per tenant

(Drafted as D18; adjusted for reviewer decision 3.)

**Decision.** `src/queue/enqueue.ts`: a single statement that inserts or returns the existing job for
`(tenant_id, idempotency_key)`, with `(xmax = 0) AS created` to choose 201 vs 200 in Step 6. A
returned row whose `request_hash` differs from the caller's → `IdempotencyKeyConflict` (409), the
original job untouched. `UNIQUE (tenant_id, idempotency_key)`, not a global unique key.

**Alternatives considered.**
- `DO NOTHING` + `SELECT` in one statement: loses the race. Forced in `enqueue.db.test.ts`: B blocks
  on A's uncommitted insert, A commits, and B's statement returns **zero rows** (its `SELECT` reads the
  snapshot from before A committed). Pinned by a test.
- `DO NOTHING`, then a second statement: works under `READ COMMITTED` but is two round trips.
- An advisory lock on the key.
- A globally unique key (the brief's wording; plan open question 3): tenant B would get a 409 on a key
  tenant A had used, which tells B something about A's traffic, a cross-tenant leak.

**Why.** One statement returns the winning row to every concurrent caller (20 connections × 25
rounds: one job per round, every caller got its id). Per-tenant keys keep tenants independent; the
same key in two tenants is two jobs (tested). Cost: one dead tuple per duplicate request.

**Date.** 2026-11-09

## D20: Test isolation is one Postgres schema per test file in a separate `rote_test` database; `npm run test:unit` skips the DB files

(Drafted as D19; plus reviewer decision 9.)

**Decision.** `src/queue/testDb.ts` creates `rote_test` on demand (42P04/23505 = already exists), a
schema `t_<file>_<random>` per DB test file with a pool whose `search_path` is that schema, runs the
real migration runner into it, and drops it in `afterAll`. DB test files are named `*.db.test.ts`.
Without Postgres they fail loudly with `PostgresUnreachableError` ("run `docker compose up -d
postgres`", password redacted); there is no skip condition. `npm test` is the full suite;
`npm run test:unit` = `vitest run --exclude "**/*.db.test.ts"`.

**Alternatives considered.** Roll back a transaction per test (breaks the multi-connection
concurrency tests); a database per file from a template (slower, and fails if the template has an open
connection); a fresh container per run (slow on a 4 GB Docker VM and hides migration problems behind a
fresh init); skipping DB tests when Postgres is down (hides a red build).

**Why.** Parallel vitest files can't see each other's rows, every file exercises the migrations, and
setup costs milliseconds. The unit split lets pure code changes be checked without Docker while
`npm test` stays the gate.

**Date.** 2026-11-09

## D21: States are `text` + `CHECK`; `business_outcome` is a terminal state; a queued job always has an attempt left

(Drafted as D20; plus reviewer decisions 2 and 6.)

**Decision.** `jobs.state` ∈ `queued, running, committing, verifying, succeeded, business_outcome,
failed, needs_human`. `CHECK (state <> 'queued' OR attempt < max_attempts)`
(`jobs_queued_has_attempts_left`). **Day-2 recovery moves an exhausted job to `failed`, never to
`queued`**; the constraint rejects the latter (tested).

**Alternatives considered.** A Postgres `enum` (`ALTER TYPE … ADD VALUE` can't be used in the
transaction that adds it); recording a bank refusal as `succeeded` or `failed` with the code in
`result`; filtering exhausted jobs in the dequeue query only (the plan as drafted, which caused the
starvation bug in D18).

**Why.** `CHECK` constraints evolve in an ordinary transactional migration. A refused transfer is
neither a success nor a failure: CLAUDE.md calls that distinction load-bearing for replay results, and
the step-04 reviewer rule makes a business outcome final, no retry, so the job table says so without
parsing `result`. Making "queued ⇒ dequeueable" a database invariant removes a whole class of
"looks like work, yields nothing" states instead of patching each query.

**Date.** 2026-11-09

## D22: Every lease-time comparison uses the database clock

(Reviewer decision 7.)

**Decision.** Lease expiry is set as `now() + make_interval(secs => $n)` in SQL, and every later
comparison (expired-lease recovery `lease_expires_at < now()`, heartbeat extension, the commit-intent
token-and-lease check) is computed in SQL against the database's `now()`. A worker never sends a
timestamp it computed. Day 2 must keep this rule.

**Alternatives considered.** Workers compute `Date.now() + lease` and send it; workers compare a
fetched `lease_expires_at` with their own clock.

**Why.** Containers' clocks drift and can be wrong (a paused container resumes with a stale view, a VM
clock jumps). With one clock, the database's, "is this lease alive" has one answer for every worker;
with many, a live lease can look expired to one worker (two workers run the job) and a dead one alive
to another (a job is stuck). Tested: a worker whose JS clock is an hour ahead still gets a ~30 s lease
by the database's clock; no dequeue statement takes a timestamp parameter.

**Date.** 2026-11-09

## D23: Job params hold business params only: credentials and the irreversible memo are never stored

(Reviewer decision 1, plus one addition for review.)

**Decision.** Enqueue rejects params naming any input the capability marks `redact: true`
(`CredentialsInParamsError`, checked first, never echoes the values). `request_hash` is computed over
the stored params, so it covers only non-secret ones. The remaining params are validated **strictly**
against the capability's other inputs (an unknown key is `InvalidParamsError`). Addition: for a
capability with an irreversible step (`step.risk === "risky"`), the `memo` input is reserved for the
job's `memo_key` (D5) and a client-supplied memo is `ReservedParamError`; a read-only capability (the
history lookup) keeps `memo` as an ordinary param. The worker (Step 6) injects credentials per tenant
from env and the memo from `memo_key`.

**Alternatives considered.** Store credentials encrypted in `jobs.params` (key management in scope,
and still credentials at rest in every row dump); store them and strip on read (a dump still holds
them); accept unknown keys (a stray `pwd` would be stored under a name nothing redacts); silently
overwrite a client memo (the client's value disappears without a word).

**Why.** Credentials must never land in artifacts, logs or storage (CLAUDE.md redaction rule); a queue
table is storage. Strict validation makes "the queue never stores a secret" checkable from the
capability's own declared inputs instead of from a deny-list of names.

**Date.** 2026-11-09

## D24: Approvals are bound to the artifact's content (SHA-256 of canonical JSON) as well as its version

(Step 6 reviewer decision, Part A. Closes REPO_NOTES known limitation 6.)

**Decision.** Every approval (manual `catalog approve` and auto-promotion) records `approvedDigest`:
SHA-256 (64 lowercase hex) of `canonicalJson(CapabilitySchema.parse(artifact))`. `canonicalJson`
(object keys sorted at every level by code unit, `undefined` dropped, no whitespace, array order
kept) already existed for the queue's `request_hash`; it moved to `src/artifact/canonical.ts` and is
re-exported from `enqueue.ts`. `checkApproval(capability, …)` now takes the artifact and computes the
digest itself (a caller cannot hand it a stale one). Order of checks: draft → refused; approved for
another version → refused (D15); a recorded digest that differs → refused, *even when the version
matches*: "artifact content changed since approval; re-approve", with both digests in the reason. A
status with no `approvedDigest` falls back to the version check alone and the reason says so
("grandfathered approval that records no approvedDigest … only the version was checked"). Runs record
their digest; the auto-promotion streak counts only runs of the same version **and** digest, and an
approval for other content is stale (runs are recorded, and can re-promote it).

The approval is about the **base** artifact, not the tenant-merged copy replay executes, so
`ReplayOptions` gains an additive, optional `approvalArtifact` (default: `capability`; must have the
same id and version, or replay throws before anything runs). `invokeCapability` and the CLI's
`replay`/`operator` pass the base they resolved overrides from.

**Backfill.** All five committed status files got `approvedDigest` from the current committed
artifacts, by `scripts/backfill-approval-digests.ts` (output: `evidence/step-06/approval-digest-
backfill.txt`, `RESULT: PASS`). The script adds only that field and refuses unless the approval names
the artifact's current version, the artifact file is clean, and git shows the commit that last
changed the artifact is an ancestor of the commit that last wrote the approval. For the three
grandfathered artifacts that is 034faf1 / 0a3b247 (2026-08-13, never edited since) before 954c4ad; for
the transfer pair, b9ecaa2 (Step 4) before the 1.1.0 re-approval dbc3648. So each digest records what
was actually approved, not merely what is on disk today.

**Tests.** `src/confidence/approval.test.ts` (digest match; same version, edited content → refused;
key order + tabs + CRLF → same digest, still allowed; missing digest → version fallback, still enforces
the version), `src/artifact/canonical.test.ts`, the digest cases in `store.test.ts`, a replay-level
refusal before any browser launches (`confidenceGate.test.ts`), and the guard test
`committedApprovals.test.ts`, which now also asserts `approvedDigest === capabilityDigest(artifact)`
for every committed artifact. Existing browser tests that replayed **port-relaxed copies** of the
artifacts against the committed `status/` had been passing only because approval ignored content;
they now approve exactly what they replay in a temp `statusDir` (or approve the relaxed base and pass
it as `approvalArtifact`, as the tenant flow does). None of them reads or writes `status/` any more.

**Alternatives considered.**
- *Hash the file bytes.* Breaks on formatting-only edits (CRLF vs LF checkouts, re-indentation), the
  reason D15 gave for not hashing. Canonical JSON of the validated artifact has neither problem.
- *Hash the raw parsed JSON (before Zod).* An unknown key that Zod strips would change the digest
  without changing behavior; hashing the validated object hashes exactly what replay runs.
- *Replace the version check with the digest.* The version is still the human-readable claim ("1.1.0
  is approved") and keeps the D15 reasons; the digest makes the claim exact. Both are checked.
- *Let callers pass a digest string.* A stale or wrong value could be passed; computing it inside the
  gate from the artifact removes that class of mistake.
- *Also cover tenant overrides in the digest.* Overrides change what a tenant's replay executes, but
  the reviewer's scope was the artifact; noted as an open question (REPO_NOTES limitation 6).

**Why.** An approval is a claim about specific, tested content. D15 caught an edit with a version
bump; this catches an edit without one, which is the easier mistake to make with hand-edited JSON, and
it does so without punishing formatting.

**Date.** 2026-11-09

## D25: How a run maps to a job state; anything that may have committed is parked, never retried

(Step 6, plan section 2; reviewer decisions B2 and B3.)

**Decision.** One pure function, `jobOutcomeFor` (`src/worker/outcome.ts`), maps how a run ended to
the job's next state. A preflight in `runJob` first checks that the job can run at all (capability
exists, params valid with the tenant's credentials injected, tenant override readable, entry URL
allowed); a refusal is `failed` / `invalid_job` at once, without a browser and without spending
retries. Then: `success` → `succeeded`; `business_outcome` → `business_outcome`, never retried
(D21); `needs_human` (including the run-time approval gate's refusal) → `needs_human`; `failure`
without `commitUncertain` → `queued` again while attempts are left (lease cleared, attempt counted),
else `failed`; a throw or shutdown abort before `onIrreversible.before` ran → the same retry rule
(`aborted` when exhausted by aborts). **Any result carrying `commitUncertain`, and any throw or
abort after `onIrreversible.before` ran, → `needs_human` with `outcome = 'commit_uncertain'`, never
retried.** That includes a `needs_human` carrying `commitUncertain` (not producible without an
escalation controller today; handled defensively so Day 2's sweep of `outcome = 'commit_uncertain'`
finds every such job). Completion is one fenced transaction (`src/worker/complete.ts`); 0 rows →
nothing is written to `jobs` and the attempt is marked `lease_lost`.

**Alternatives considered.** For `commit_uncertain`: retry (the one thing that can duplicate a
transfer); leave the job `running` for Day-2 recovery (it would hold its tenant slot and look like a
hung worker to the Day-1 exit check); `failed` (says "didn't happen", which may be false);
`business_outcome` (says "the bank refused", which may be false after a write-then-error). For
invalid jobs: let them fail through replay and burn three attempts.

**Why.** `needs_human` is terminal, frees the slot, and says what is true: someone (or Day 2's
verify, reading the bank's history by `memo_key`) must decide. Tested row by row
(`outcome.test.ts`) and end to end (`faults.db.test.ts`: `errors/after-write` → 1 ledger row,
attempt 1, `commit_uncertain`, no second attempt).

**Date.** 2026-11-09

## D26: In Docker, workers reach the bank through an in-container TCP forwarder

(Reviewer decision B1, plan open question 1.)

**Decision.** With `ROTE_BANK_FORWARD=bank:4100`, the worker entrypoint (`src/worker/main.ts`)
starts `startTcpForwarder` (`src/worker/bankForward.ts`, `node:net` only, half-close aware) on
`127.0.0.1:4100` → `bank:4100` **before** the worker. Chromium keeps talking to
`http://localhost:4100`, so every artifact, override, approval (version and digest) and the policy
allowlist stay byte-identical. Tested: 1 MiB both ways with a half-close, HTTP bodies intact, an
unreachable target closes the client, `close()` drops open connections.

**Alternatives considered.** `network_mode: "service:bank"` (no code, but every worker shares the
bank's network namespace, so Day-3 per-worker metrics ports would collide, and a bank restart breaks
every worker); making the bank origin configurable in the artifacts (edits all five artifacts:
version bumps, re-approvals, a looser allowlist anchor); socat (an extra package in the image).

**Why.** It is the only option that changes nothing that was approved. **In a real deployment the bank
origin would be per-environment configuration** (`entryUrlPattern` plus the per-tenant overrides'
`entryUrl`, approved per environment), not a forwarder; the forwarder exists to keep this demo's
approved artifacts byte-identical. A side effect Day 2 can use: pausing a worker container also
pauses its path to the bank.

**Date.** 2026-11-09

## D27: The async API: strict body, approval at enqueue and at run time, tenant-scoped reads (not auth)

(Plan section 4; reviewer decisions B4, B5, B7.)

**Decision.** `POST /capabilities/:id/invoke?mode=async` with `Idempotency-Key` (1..255) and a body
of exactly `{tenant, params}`: any other key (`approveRisky`, `approveUnattended`, `entryUrl`, ...)
is 400, because async jobs never take run-time approvals or targets from the client. Order: 404
unknown capability → 400 params (credentials named, never echoed; reserved memo; strict schema) →
**422 if the capability is not approved for its current version and content** → enqueue: 201 new
(with `Location`), 200 same tenant + key + request, 409 same key with a different request, 404
unknown tenant (FK), 503 + `Retry-After: 2` when Postgres is unreachable. The worker's run-time check
stays the authoritative one (an approval can change between enqueue and run). `GET
/jobs/:id?tenant=` requires the tenant and answers 404 for another tenant's job, exactly as for a
missing one. `?mode=async` on an app without a queue is 501, never silently run synchronously. Sync
mode is unchanged.

**Alternatives considered.** Run-time approval check only (a job certain to end `needs_human` would be
accepted); ignoring unknown body keys (a client could believe `approveRisky: false` was honored);
`GET /jobs/:id` without scoping (any caller could read any job by id).

**Why.** Fail fast where the answer is already known, and keep every authority decision on the server.
**The `?tenant=` scoping is not authentication**: the tenant is whatever the caller says. The project
has no auth, by scope; the scoping only stops one tenant reading another's job by id (stated in the
README).

**Date.** 2026-11-09

## D28: One image for worker, API and bank; compiled JS; pinned Playwright; one bank container

(Plan section 5; reviewer decision B6.)

**Decision.** A multi-stage `Dockerfile` on `mcr.microsoft.com/playwright:v1.62.1-noble` (the repo's
Playwright version, `ARG PLAYWRIGHT_VERSION`, re-checked by the worker at startup), building `dist/`
with `tsc`, installing production dependencies only in the runtime stage, running as `pwuser`.
Compose runs the same image as `bank` (exactly one container, never scaled, `restart: "no"`: its
in-memory ledger is the source of truth), `api` (`catalog serve --queue`, migrates at startup under
the advisory lock) and `worker` (`replicas: ${ROTE_WORKERS:-4}`, `init: true`, `stop_grace_period:
45s`, `mem_limit: 700m`, `restart: "no"`). Every published port is bound to 127.0.0.1. Credentials
come in through the environment with empty defaults, so `docker compose up -d postgres` never needs
them; the worker refuses to start, naming the missing variable.

**Alternatives considered.** Separate images per service (three builds of the same code); `tsx` at
runtime (a dev dependency, slower start); `restart: on-failure` for workers in Step 6 (would hide a
dead worker; the reviewer asked for dead workers to show up as lost jobs).

**Why.** One build, one set of dependencies, and the browser in the image matches the npm package by
construction. `mem_limit` makes an out-of-memory kill visible as `OOMKilled: true` instead of being
mistaken for a chaos kill (D9).

**Date.** 2026-11-09

## D29: Workers run with approveRisky, on the authority of the capability's approval

(Reviewer decision B2.)

**Decision.** `runJob` calls `invokeCapability` with `approveRisky: true` and never sets
`approveUnattended`. The authority for clicking Submit unattended is the capability's approval for its
exact version and content (D15, D24), which `runReplay` re-checks on every run and refuses with
`needs_human` otherwise (tested: a stale approval → `needs_human`, 0 ledger rows). Workers read
credentials per tenant from `ROTE_CRED_<TENANT>_<INPUT>` (at least 4 characters, checked at startup
for every tenant × every redact input of every committed capability), and every credential value is
replaced by `[REDACTED]` in any error text the worker stores or logs.

**Alternatives considered.** A per-job approval flag stored on the job (a client could set it); a
separate allowlist of "fleet-runnable" capabilities (a second approval system next to `status/`).

**Why.** One approval system. Until Day 2 there is no commit intent, so a worker that dies after
Submit cannot be recovered: Step 6 runs no chaos, and a dead worker's job stays `running` and is
reported as lost by the exit check, never papered over.

**Date.** 2026-11-09

## D30: Approvals also cover tenant overrides, by digest, per tenant

(Step 7 reviewer decision A1. Closes the "still open" part of REPO_NOTES known limitation 6.)

**Decision.** Every approval also records `approvedOverrideDigests`: tenantId → SHA-256 of the
canonical JSON of the schema-validated override (`tenantOverrideDigest`, `src/tenant/digest.ts`;
same canonicalization as D24), for every `overrides/<capabilityId>.<tenantId>.json` of that
capability (`tenantOverrideDigests`; a file whose name and content name different tenants is an
error). `catalog approve` records them (`approvalKeyWithOverrides`). A tenant run passes the override
it applied to replay as the additive `ReplayOptions.approvalOverride` (`invokeCapability`, the CLI's
`replay`/`operator --tenant`), and `checkApproval` refuses, after the version and content checks:
- the tenant is not in the map: "tenant override for "<t>" exists but was not approved (the approval
  covers: …)";
- its digest differs: "tenant override for "<t>" changed since approval; re-approve", with both
  digests.
Other tenants' runs are decided by their own files, so one edited override stops one tenant. A status
with **no map** is grandfathered: allowed, and the reason says the override was not checked. An
approval written **without** overrides (auto-promotion, which knows only the base artifact, or a
caller using `approvalKey`) records `{}`, so it approves no override: tenant runs are refused until a
`catalog approve` names them (fail closed). **Reviewer decision (2026-11-11, Step 8 A4):** auto-promotion
approving no overrides (`{}`) is correct and intended; it is not a gap to close. `isApprovalCurrent` compares the override map only when
the key names one, so the catalog listing and the run recorder still ask only about the base. The
async API's enqueue-time 422 check (D27) loads the tenant's override too (only for a plain tenant
name, never building a path from anything else; a missing file is left to the worker's preflight).

**Backfill.** `scripts/backfill-approval-override-digests.ts` (output
`evidence/step-07/approval-override-backfill.txt`, `RESULT: PASS`) adds only the map, and only where
git shows every override of the capability unchanged since the approval: the approval commit is the
one that introduced the status file's current `approvedAt` (`git log -S`, so the D24 digest backfill,
a later metadata write, does not count as the approval), and each override's last change must be its
ancestor with no uncommitted edits. All nine committed overrides passed (member-lookup's three:
515b032/4fd7661 before the approval d05edca; the transfer pair's six: 776c86b before dbc3648); the two
`open-sub-account*` capabilities have no override files and got `{}`.

**Tests.** `src/tenant/digest.test.ts` (formatting-only changes keep the digest, value changes don't;
capability ids that are prefixes of others; name/content mismatch); `src/confidence/overrideApproval.test.ts`
(every approved tenant allowed; one override edited → refused for that tenant only, the other two and
the base unaffected; a never-approved override refused; re-approval restores it; grandfathered map;
`{}` from a base-only approval; through `invokeCapability` the refusal is `needs_human` before any
browser); `asyncApi.db.test.ts` (422 for the edited tenant, 201 for another); the guard test
`committedApprovals.test.ts` now asserts that each committed approval's map equals the digests of the
committed override files, and that every tenant's gate decision says the override digest matches.

**Alternatives considered.**
- *One digest over the artifact plus all its overrides.* Simpler to store, but an edit to tenant-b's
  override would stop tenants a and c too, and the refusal could not say which file changed.
- *Fold each override into a per-tenant effective-artifact digest.* Hashes what replay executes, but
  the approval could no longer be checked for a base run, and the reason could not separate "the
  artifact changed" from "the override changed".
- *Grandfather an approval written without overrides* (leave the map absent). Auto-promotion would
  then silently produce approvals that check no override at all; failing closed costs one
  `catalog approve`.
- *Check overrides only at enqueue.* The run-time check stays authoritative (an override can change
  between enqueue and run), as for the artifact (D27).

**Why.** An override is executable content: it replaces locators (and can replace the success
condition and entry URL) for one tenant. D24 made an approval a claim about specific content; without
the overrides it was a claim about the base only, while tenant runs executed something else.

**Date.** 2026-11-11

## D31: Browser test files run in their own vitest project, at most 3 at a time; test servers never take a blocked port

(Step 7 reviewer decisions A2 / open question 4.)

**Decision.** `vitest.config.ts` defines two projects. **`unit-db`**: every test file that does not
launch Chromium, at vitest's default parallelism (CPUs − 1). **`browser`**: the 11 files listed in
`vitest.browser-files.ts`, `maxWorkers: 3`, run as a second group (vitest requires a distinct
`sequence.groupOrder` for projects with different `maxWorkers`, so the groups run one after the
other). `ROTE_BROWSER_TEST_WORKERS` overrides the cap for measuring. A guard test
(`src/testing/browserProject.test.ts`) fails if a test file that launches a browser (calls
`chromium.launch` / `WebSurface.launch`, uses the worker test env, or replays against the in-process
mock bank) is missing from the list, or a listed file isn't one. `npm test` / `npm run test:unit` are
unchanged commands.

Also, found while proving this: `server.listen(0)` can return a port Chromium refuses
(`net::ERR_UNSAFE_PORT`; a run got 2049) and Node's `fetch` refuses the same "bad ports".
`src/testing/listen.ts` `listenOnSafePort()` re-listens until the port is on neither list; every test
server reached by Chromium or `fetch` uses it (`evidence/step-07/flakes.md`).

**Measurement** (`evidence/step-07/flake-cap/`; `scripts/measure-test-run.ps1` samples every
Playwright Chromium process every 500 ms during one full run, so these runs carry the sampler's
overhead and compare with each other, not with unsampled runs):

| Browser cap | Wall (s) | Peak Chromium processes | Peak Chromium working set |
| --- | --- | --- | --- |
| none (before) | 117.7 | 28 | 1965 MB |
| 2 | 124.9 | 11 | 714 MB |
| **3** | **108.8** | **15** | **1098 MB** |
| 4 | 102.3 | 19 | 1378 MB |

Rule: the smallest cap whose run is no slower than the uncapped one. 3 qualifies and roughly halves
peak Chromium memory; 2 is slower. (The suite grew by 2 files between these runs as Step 7 tests were
written; the browser project was the same 11 files in each.) Proof: 10 unsampled full runs at the
chosen cap, all logs kept: **10 of 10 passed**, 378/378, no resource or port error in any log. Duration
before vs after, as an interleaved A/B on one commit with nothing else running (`ab/`): uncapped mean
**94.3 s**, capped **84.4 s**, faster in every round (the 10 proof runs themselves averaged 99.9 s
while the builder was editing, so they are not used as the "after" figure; README of
`evidence/step-07/flake-cap/`).

**Alternatives considered.**
- *Global `maxWorkers` (or `--no-file-parallelism`).* Also slows the ~28 unit/DB files that never
  start a browser; the reviewer asked for full parallelism there.
- *`maxConcurrency`.* Limits concurrent tests *inside* a file, not concurrent files; each browser file
  already runs its tests serially, so it would change nothing.
- *Retrying failed browser tests (`retry: n`).* Hides the flake instead of removing its cause.
- *A shared Chromium for all test files (globalSetup).* Fewer processes, but every file would share
  one browser's fate and its contexts; a larger change to every browser test.
- *Rename the browser files (`*.browser.test.ts`) and select by glob.* Clearer, but churns 11 files'
  history; the explicit list plus its guard test gives the same safety.

**Why.** The Step-6 flake was `net::ERR_INSUFFICIENT_RESOURCES` from up to 7 Chromium-launching files
at once on one 8 GB host (28 Chromium processes, ~2 GB). Capping only those files removes the
pressure where it comes from and costs nothing measurable in wall time, because unit and DB files keep
every core and the browser files were contending with each other anyway.

**Date.** 2026-11-11

**Amendment (2026-11-11, Step 8 reviewer decision A2).** `vitest.uncapped.config.ts` (the pre-D31
one-project configuration, kept only for the A/B) is deleted: a second vitest config at the repo root
is one more thing to keep in step with the real one, for a measurement already taken. To reproduce the
A/B, check out the commit it was measured on, which still has the file: `git switch --detach b9bc8da`,
then `powershell -File scripts/ab-timing.ps1 -Out <dir> -Rounds 3`, then `git switch -`. The script now
refuses with that instruction when the file is absent. Alternative considered: keep the file (it costs
nothing at run time, but it is dead configuration on every later commit).

## D32: The ledger oracle: one module, one verdict table, DUPLICATE dominates, ORPHAN as the reverse check

(Step 7 plan section 1; drafted there as D30, renumbered because Part A came first.)

**Decision.** `src/oracle/ledger.ts` `checkLedger({jobs, ledger, drainTimedOut})` is pure and is the
only definition of "0 duplicates, 0 lost": the Day-1 exit, chaos, the crash-point matrix and `rote
oracle check` all call it. Per job, the ledger rows whose memo is its `memo_key`: 2+ → **DUPLICATE**
whatever the state (checked first, so a duplicated job that is also lost reports the worse finding);
1 row of another tenant → **MISMATCH**; `succeeded` needs exactly 1 row whose id is
`result.outputs.confirmationRef` (0 → **MISSING_COMMIT**, another id → **MISMATCH**); `failed` and
`business_outcome` need 0 (1 → **UNRECORDED_COMMIT**); `needs_human` may have 0 or 1 and is listed
with its outcome and row count; a non-terminal job is **LOST** after the drain timed out (with its row
count, so "lost after commit" is visible) and **PENDING** before it (the oracle ran too early; also a
failure). Every row whose memo matches no job is an **ORPHAN** (harnesses reset the ledger first). The
report ends in exactly `RESULT: PASS` or `RESULT: FAIL`. `src/oracle/collect.ts` reads jobs from
Postgres and `GET /control/ledger`, both Zod-parsed; an asked-for job id that is missing is an error,
not a skip. CLI: `rote oracle check [--database-url] [--bank] [--job-ids file] [--drain-timed-out]
[--out dir]`, exit 0 PASS / 1 FAIL / 2 could not run.

**One deviation from the plan's table, stricter:** the plan listed `business_outcome` with "0 or 1
rows: ok", next to `needs_human`. A job can only end `business_outcome` when the bank refused and no
commit was uncertain (a refusal seen after Submit carries `commitUncertain` and is parked as
`needs_human`, D25; Day 2 verifies it, step-08 section 5). So a `business_outcome` job with a ledger
row means money moved while the job says it was refused: the oracle reports UNRECORDED_COMMIT, as for
`failed`. Raised in the handoff for the reviewer. **Reviewer decision (2026-11-11, Step 8 A4): it stays
strict.** Day 2 keeps it consistent: Step 9's verify ends `business_outcome` only after two 0-match
lookups (`not_committed_final`), and a refusal with a matching row becomes `succeeded` / `already_done`,
so a correct fleet never produces `business_outcome` with a row.

**Alternatives considered.** Keep each harness's own checks (the Day-1 exit had them inline): three
copies would drift. Judge by `job_attempts` or worker logs: the brief says correctness is judged only
by the bank's ledger. Treat a non-terminal job before the drain as ok: a harness bug could then report
PASS for a run it never waited for.

**Why.** The verdicts are the brief's ledger check made exact, plus the three ways a run can be wrong
that the brief's list leaves implicit: a commit the job denies, a reference that points at the wrong
row, a row nobody owns.

**Date.** 2026-11-11

## D33: Chaos is seeded on the schedule, not the interleaving; the harness is the supervisor

(Step 7 plan section 2; reviewer decision B1. Drafted as D31.)

**Decision.** `src/chaos/schedule.ts` builds the whole schedule from the seed with mulberry32 before
anything runs: kill times (gaps uniform in 5–15 s over `--duration`, default 150 s), victims (replica
1..N), one `docker pause` of 45 s at a seeded time and replica. Draw order is fixed (the pause first),
so the seed alone reproduces the schedule. A kill drawn for the replica being paused (from the restart
delay before the pause to its end), or for a replica still down, goes to the next replica that is up,
and the redirect is recorded. `scripts/chaos.ts` prints and saves the seed and the schedule first,
resets the queue tables and the bank ledger, enqueues `--jobs` (100) through the API, executes the
schedule with `docker kill --signal=KILL` / `docker pause` / `docker unpause`, records before each kill
or pause which jobs the victim holds (`lease_owner` starts with the container's hostname), restarts
each killed replica with `docker start` after 2 s (Compose keeps `restart: "no"`: the harness is the
supervisor, so every restart is in its event log), never touches Postgres or the bank, drains until
every job is terminal or `--drain-timeout` passes (default 10 min; the committed Day-1 run uses 3 min,
reviewer decision B1), and judges with the oracle (D32). Evidence: the seed, the schedule, the events,
the oracle report, jobs, attempts, the ledger, `docker stats`, compose logs, `docker inspect` of the
workers (OOM attribution, D9) and a credential grep. Workers, API and bank are stopped at the end
(8 GB laptop) unless `--keep-up`.

**Alternatives considered.** Random decisions at run time (not reproducible); seeding the job order as
well (the interleaving still depends on container start-up and Chromium timing, so it would promise a
reproducibility it can't deliver); Compose `restart: on-failure` as the supervisor (restarts would be
invisible in the harness's events, and a crash loop would hide); `kill -9` of the node process inside
the container (leaves Chromium and tini running; `docker kill` is a real container death).

**Why.** A failing chaos seed must be re-runnable with the same kills at the same times, and every lost
job must be attributable to the kill that orphaned it. Saying plainly that the seed does not fix the
interleaving keeps the claim honest.

**Date.** 2026-11-11

## D34: Crash points through an additive `onStep` hook and a doubly gated fault flag; self-SIGKILL in a child process

(Step 7 plan section 3. Drafted as D32.)

**Decision.** `ReplayOptions.onStep?: { after(step, index) }` (optional; absent = no change at any call
site) runs after a step completed normally (its checkpoint passed, or it had none and no error), on
the main path only (not after a human "skip"). A throw from it is handled like an `onIrreversible`
hook error: `runReplay` closes the context and rejects with that error, unwrapped, even after the
irreversible step (D11). `invokeCapability` passes it through. The worker reads `ROTE_FAULT=<point>`
once at start (`src/worker/fault.ts`) and **refuses to start** unless `ROTE_FAULT_ENABLE=1` is also set
(it also refuses `ROTE_FAULT_ENABLE` without a point, and any unknown point). At its point the worker
writes one line to stderr synchronously (`ROTE_FAULT firing at <point>`) and calls
`process.kill(process.pid, "SIGKILL")`: no cleanup, no `finally`, no completion. Points:
`after-dequeue` (lease taken, before any browser work), `after-step-NN` (`onStep.after`),
`before-submit` (`onIrreversible.before`), `after-submit` (`onIrreversible.after`: the bank has
answered), `before-complete` (outcome computed, completion not started), `after-complete`.
`scripts/crash-matrix.ts` runs each point in isolation: a fresh test schema, a fresh in-process bank on
:4100, one job, the faulty worker as a child process, a check that it died at that point, then a clean
worker and the oracle.

**Alternatives considered.** Throwing an exception at the point (cleanup code and `finally` blocks would
run, which a real crash never does); killing the worker from outside at a guessed time (not
deterministic); a fault flag read per job from the database (any client could then set it); a single
environment variable (one stray variable in a deployment would make it kill itself).

**Why.** A crash point must behave exactly like a crash and fire exactly where named, every time. The
hook keeps replay unforked; the double gate keeps the mechanism out of real deployments.

**Date.** 2026-11-11

## D35: CI: GitHub Actions; Node 22 with a postgres:17 service; Node 25 unit tests; a separate image build

(Step 7 plan section 4; reviewer decisions B2, B3 and A3. Drafted as D33.)

**Decision.** `.github/workflows/ci.yml`, on every push and pull request to `main` and `fleet/**`,
three jobs. **test**: ubuntu-24.04, Node 22 LTS, a `postgres:17` service on 55432 with a health check,
`npm ci`, `npx playwright install --with-deps chromium` (the version from the lockfile printed first),
`npm run typecheck`, `npm test` through `tee`, the full log uploaded as an artifact on every run, pass
or fail. **unit-node25**: Node 25, the builder's local Node, running the `unit-db` project without the
`*.db.test.ts` files (no browser, no Postgres; about a minute, so cheap per decision B3). **docker**:
Buildx and `docker/build-push-action` with `push: false` and the GitHub Actions cache, so a broken
Dockerfile fails fast on every push. `package.json` `engines.node` is `>=22`. `npm run typecheck`
(`tsconfig.typecheck.json`) covers every file including tests, `scripts/` and the vitest config, which
the build config excludes; CI runs it, so the two errors fixed in A3 cannot come back unseen. A README
badge for `fleet/day-1`. Not in CI: the Day-1 exit, chaos and the crash-point matrix (they need the
Compose stack or minutes of wall time; committed evidence instead); the matrix joins CI once it is
green (Day 2).

**Alternatives considered.** Node 25 for the whole suite (not an LTS line; the builder keeps it
locally); Postgres 16 (Compose pins 17 and a test asserts it); the image build only on `main` (the
plan's first proposal; the reviewer wants every push, minutes being free on a public repo); pushing the
image to a registry (nothing consumes it yet).

**Why.** The suite is the gate for every commit; CI makes it the gate for every push, on a clean Linux
machine where the crash tests' `SIGKILL` is a real signal.

**Amendment (2026-11-11, found by CI's first run).** unit-node25 failed on its first run: the DB files
ran with no Postgres. With vitest projects (D31), a CLI `--exclude` does not reach a project's own
`exclude` list, so `vitest run --exclude "**/*.db.test.ts"`, which is both this job's command and
`npm run test:unit`, had silently kept the DB files since D31 (unseen locally because Postgres was
always up). Now `vitest.config.ts` drops `*.db.test.ts` from both projects when `npm_lifecycle_event`
is `test:unit` (npm sets it, on every OS) or `ROTE_SKIP_DB_TESTS=1` (the CI job). Guarded by
`src/testing/unitScript.test.ts`, which lists the files vitest would run in each mode in a child
process. Alternative considered: `cross-env` in the npm script (a new dependency, which needs its own
reviewed step).

**Amendment (2026-11-11, Step 8 reviewer decision A1): actions pinned by commit SHA, on node24.** Every
run carried the warning "Node.js 20 is deprecated. The following actions target Node.js 20 but are being
forced to run on Node.js 24" for `checkout@v4`, `setup-node@v4`, `upload-artifact@v4`,
`setup-buildx-action@v3` and `build-push-action@v6`. Each is now the current major whose `action.yml`
says `runs.using: node24` (checked with `gh` against each repository's releases and the tag's own
`action.yml`), pinned by the full commit SHA the tag points at (an annotated tag dereferenced to its
commit), with the release in a trailing comment: checkout v7.0.1 `3d3c42e…`, setup-node v7.1.0
`949feb2…`, upload-artifact v7.0.2 `cf430e0…`, setup-buildx-action v4.4.1 `f87e599…`, build-push-action
v7.4.0 `c3c9e26…`. The release notes between the old and new majors were read for breaking changes;
none touches this workflow (setup-node v5+ caches automatically, and we already set `cache: npm`;
checkout v6 stores the persisted token in a separate file; upload-artifact v7 adds an opt-in unzipped
upload; the Docker actions drop inputs and env vars we never set). Alternatives considered: pin by tag
(`@v7`; a tag can be moved to other code, a SHA cannot); Dependabot to keep the pins fresh (a new bot
with write access to PRs, out of this step's scope; noted for the dependency step after Day 2).

**Amendment (2026-11-11, Step 8 reviewer decision A3): a report-only crash-matrix job.** A fourth job,
**crash-matrix**, runs `npm run crash-matrix -- --lease-seconds 5 …` on ubuntu-24.04 with its own
`postgres:17` service, so the matrix runs on Linux with real signals (the fault worker's `SIGKILL`
shows up as `signal SIGKILL`, not Windows' `exit 1`) on every push. `continue-on-error: true`: a red
matrix does not fail the workflow while Day 2 is being built; `matrix.md` goes to the job summary and
the whole report (per-point logs, jobs, ledgers, oracle reports) is uploaded as the
`crash-matrix-report` artifact on every run. Step 10 removes `continue-on-error` and makes the job
required. Alternatives considered: wait for Step 10 to add it (the first Linux run would then also be
the gating one); run it only on `main` (Day 2 is built on `fleet/day-1`).

## D36: A 30 s lease kept alive by a 10 s heartbeat that never revives an expired lease; a lost lease aborts the run and writes nothing to `jobs`

(Step 8, plan section 2; reviewer decision 2.)

**Decision.** `ROTE_LEASE_SECONDS=30`, `ROTE_HEARTBEAT_SECONDS=10` (Compose and the worker's defaults;
Step 6's 300 s existed only because there was no heartbeat). The worker refuses to start unless
`heartbeat * 2 < lease`, so one missed beat never loses a lease by itself. T2 (`src/worker/heartbeat.ts`)
is one autocommit `UPDATE … SET lease_expires_at = now() + lease WHERE id, fencing_token, lease_owner, an
active state AND lease_expires_at > now()`: it extends only a lease that is still alive by the database's
clock (D22); an expired lease is recovery's, even if nobody has recovered it yet. 0 rows → the heartbeat
stops and aborts the job's `AbortController` with a `LeaseLostError`; `runReplay` closes the context and
rejects with it (D11); the worker writes **nothing** to `jobs` and marks only its own attempt row
`lease_lost`, keeping any note recovery wrote first (`… [recovery had recorded: …]`), because the worker
was alive and `crashed` would be the wrong label. A transient DB error is retried at the next beat
(three misses = the lease is gone); a non-transient one gives the job up the same way (a heartbeat that
cannot run cannot keep the lease). The heartbeat stops before T4. A run that *returned* before the abort
landed still goes through the fenced T4 (its result is real information; T4 decides).

**Alternatives considered.** Extend whenever the token matches (the brief's wording): a worker back
from a long Postgres outage would revive a lease that recovery is entitled to take, and the moment of
"expired" would depend on who reached Postgres first. Let the aborted run complete through T4 anyway:
safe (T4 is fenced and `jobOutcomeFor` is conservative) but it writes into a job that is recovery's by
then. A worker-side deadline timer as a second abort source: uses the worker's clock (D22).

**Why.** A lease only means something if it ends on one clock and stays ended. Aborting on the first
0-row beat closes the browser context while a zombie's next action is most likely still pending, which
is the cheapest protection the zombie case has (plan section 6).

**Date.** 2026-11-11

## D37: The commit intent is one fenced transaction right before the Submit; only a FencingError means "not written"; T4 accepts `committing` through `completionAllowed`

(Step 8, plan section 3.)

**Decision.** T3 (`src/worker/intent.ts`) runs in `onIrreversible.before` (seam 1): `UPDATE jobs SET
state = 'committing', commit_intent_at = now(), lease_expires_at = now() + lease WHERE id, token, owner,
state = 'running' AND lease_expires_at > now()`, then `UPDATE job_attempts SET commit_intent_at = now()`,
one transaction. 0 rows → `FencingError`; the hook throws; the Submit is never clicked. **Only a
committed T3 lets the click happen.** `runJob` records `irreversibleStarted` from T3's outcome: a
`FencingError` (definitely not written) leaves it false, so the run is retried like any failure before
Submit (its T4 is fenced out, unless the lease merely expired with nobody recovering, in which case the
worker's own requeue is the truth and is recorded); any other error (the COMMIT failed or its result is
unknown) sets it, so the attempt is treated as "may have committed" (needs_human in Step 8) even though
no click went out. T4 is widened from `state = 'running'` to `(state = 'running' OR (state =
'committing' AND $4 IN ('succeeded','needs_human')))`, which is `completionAllowed`
(`src/fleet/stateMachine.ts`) in SQL: not even a buggy caller can requeue or fail a job past its intent.
T4 still does not check expiry (an unrecovered holder is the only one who ran the job).

**Alternatives considered.** Write the intent and the state change in separate transactions (a crash
between them leaves a row that says less than the truth); treat every T3 error as "not written" (a
COMMIT whose result is unknown may have landed, and the job would then be retried past an intent); treat
a `FencingError` as "may have committed" (it provably did not, and parking it costs a human).

**Why.** The brief's rule: *a job is only ever retried blindly if it crashed before its commit intent was
saved.* That needs the intent to be durable before the click and exactly as fenced as the lease.

**Date.** 2026-11-11

## D38: Recovery runs in every worker's loop, one transaction per job; every transition bumps the token; Step 8 parks an expired `committing` job as needs_human

(Step 8, plan section 4; reviewer decision 3.)

**Decision.** Seam 4 (`beforeDequeue`) runs `createRecoverySweep` (`src/worker/recover.ts`) before every
dequeue: up to 10 expired jobs per iteration, each in its own transaction: claim the earliest-expired
active lease `FOR UPDATE SKIP LOCKED` (served by the partial index `jobs_lease_expiry`, 0002), decide with
the pure `recoveryAction` (T6.1 `running` with attempts left → `queued`; T6.2 `running` on its last
attempt → `failed` / `lease_expired`, never `queued`, D21; T6.3 `committing` → `needs_human` /
`commit_uncertain`, the Step 8 interim until Step 9's verify; `verifying`, unreachable in Step 8, is
escalated too), execute it with one parameterized `UPDATE` that also sets `fencing_token + 1` and clears
the lease, fenced on the claimed token and state and re-checking `lease_expires_at < now()`, and close the
dead holder's open attempt row as `crashed` ("lease expired in <state>; recovered by <w> (T6.x kind)").
A transient DB error is logged and the loop carries on to dequeue; any other error stops the worker
loudly. A requeue's next dequeue bumps the token again (tokens 1 → 2 → 3).

**Alternatives considered.** A separate reaper process (one more thing to supervise; a dead reaper
silently stops recovery for everyone); bump the token only where a new holder is assigned (then "the
token changed" would not always mean "the old holder is fenced", and every fence would need a state
check too); requeue an expired `committing` job (the one thing that can duplicate a transfer without
verify); recover without `SKIP LOCKED` (recoverers queue behind each other on the same row).

**Why.** Every worker recovering a little before every dequeue keeps recovery as available as the fleet
itself, and bounds how long a dead worker's job holds its tenant slot to one poll past expiry. With the
token bumped by every transition, every fenced statement (T2, T3, T4) can trust the token alone.
Tested: every row of the table, 8 concurrent recoverers over 50 expired jobs (each recovered exactly
once), the model-vs-real test (D39).

**Date.** 2026-11-11

## D39: Every decision is a pure function; the SQL is mirrored by a pure model; property tests on the model, and a model-vs-real test that runs the same commands against Postgres

(Step 8, plan section 7; reviewer additions R1 and R2.)

**Decision.** `src/fleet/stateMachine.ts` holds `jobOutcomeFor` (moved from `src/worker/outcome.ts`),
`completionAllowed` (T4's guard) and `recoveryAction` (T6); Step 9 adds `verifyDecision`. The worker
calls them; the SQL repeats their guards and decides nothing alone. `src/fleet/model.ts` mirrors each
statement (dequeue, T2, T3, T4 with the D21 CHECK, T6) as a pure function on a database-clock number.
Two kinds of tests use it:
- **Pure-model properties** (`stateMachine.property.test.ts`, fast-check 4.10.2, a new devDependency):
  one job, a bank ledger, three workers that crash, restart, freeze and wake (heartbeat first, or the
  zombie acting first), the clock; 10 000 seeded sequences per property, each ending in the same drain
  (everyone wakes, every lease passes, clean workers run to quiescence), invariants checked on every
  single transition (a requeue undone by a dequeue within the same event is still seen). Step 8's set:
  no duplicate in any sequence, zombies included (nothing is requeued after an intent); no lost job;
  terminal states final and `queued ⇒ attempt < max`; no requeue after an intent; the oracle passes
  exactly when there is no duplicate and the job is terminal; R2a at most one worker holds a valid
  lease, and it is the latest dequeuer; R2b the token never decreases. Plus deterministic zombie
  scenarios. Event arrays are generated at `size: "max"`: fast-check's default small size left 60% of
  runs without a single dequeue.
- **Model vs real** (`modelVsReal.db.test.ts`, R1): fast-check commands (dequeue, heartbeat, intent,
  complete to each target, recover, tick) run against the model and the real SQL on a test schema;
  after every command each job's state, token, owner, attempt, outcome and lease (within 1 s) must
  match, and so must each command's own answer; R2a/R2b are checked on the database too. 200 seeded
  sequences of up to 25 commands (about 3 s). **Time is simulated by shifting every stored lease back
  by dt**, exactly equivalent to the database clock moving forward because every rule compares
  `lease_expires_at` with `now()`; the clock itself is never faked. Commands whose answer depends on a
  lease within 1 s of expiry are not generated, so the milliseconds of real time a sequence takes cannot
  flip a comparison.

**Mutation-checked** (each reverted after): `recoveryAction` requeueing an expired `committing` job fails
properties 1, 5 and 6 (shrunk to `dequeue, intent, click, crash`); T2 without `lease_expires_at > now()`
fails model-vs-real (shrunk to `dequeue(wB), tick(31), heartbeat(wB)`); T6 without the token bump fails
it (`dequeue(wA), tick(45), recover(wA)`). An earlier version of the properties missed the first mutant
(per-event checks and short arrays); that is why the checks are per transition and the arrays full-size.

**Alternatives considered.** Properties on the model only (the model could drift from the SQL unseen,
which is what R1 exists to catch); faking the database clock (a test-only `now()` would mean test-only
SQL); a TLA+ spec (a second language for one state machine, and nothing would tie it to the code).

**Why.** The safety argument of Day 2 is a set of invariants over interleavings no example test
enumerates; the model makes them checkable at thousands of sequences a second, and the model-vs-real
test is what lets the properties speak about the SQL the workers actually run.

**Date.** 2026-11-11

## D40: The crash matrix judges every point against its expected Day-2 outcome, at a 5 s lease and a 2 s heartbeat

(Step 8, plan section 9; reviewer decision 6.)

**Decision.** `scripts/crash-matrix.ts` gains `--heartbeat-seconds` and `--expect <phase>`; a point
passes only if the fault fired there, the oracle passes, **and** the final job matches
`src/chaos/crashExpected.ts` (state, outcome, attempt, ledger rows): "oracle ok" alone would pass a
`needs_human` with 0 rows, which is the wrong answer once verify exists. Step 8's expectations: every
point before the intent (`after-dequeue` … `after-step-10`) → requeued (T6.1), attempt 2 `succeeded`,
1 row; `before-submit` → `needs_human` / `commit_uncertain`, 0 rows; `after-submit`, `after-step-12`,
`before-complete` → `needs_human` / `commit_uncertain`, 1 row; `after-complete` → `succeeded`, 1 row;
never 2 rows. The matrix runs at `--lease-seconds 5 --heartbeat-seconds 2` (locally and in the
report-only CI job) so a point costs seconds, not a 30 s wait; Compose keeps 30/10, which chaos
exercises. **Step 10 adds one matrix run at the production 30/10**, saved as evidence (reviewer
decision 6).

**Alternatives considered.** Run the matrix at 30/10 always (16 points × at least 30 s of waiting per
run, for the same transitions); judge by the oracle alone (see above).

**Why.** The matrix is the brief's per-step-boundary exactly-once check; it has to say what the right
answer is at each boundary, not merely that nothing was duplicated or lost.

**Date.** 2026-11-11

**Amendment (Step 9, 2026-11-14).** `--expect step-09` (now the default) judges the after-intent points
as **verified**: `before-submit` → T6.4 verify `[0, 0]` → resubmitted → attempt 2, 1 row;
`after-submit` / `after-step-12` / `before-complete` → T6.4 verify `[1]` → `succeeded` / `already_done`,
attempt 1, 1 row. The matrix also runs **scenarios**, not just points. A two-fault scenario `X>Y` runs
three workers in turn: one that dies at X; one that recovers the job and dies at the recovery-internal
point Y (inside T6, or in the verify phase); and a clean one. It passes only if both faults fired.
There are seven, from step-08 section 9's second table: `src/chaos/crashExpected.ts`
`RECOVERY_SCENARIOS`. The CI job moved to `--expect step-09` with a 60 s drain cap. Evidence:
`evidence/crash-matrix/step-09/`, 23/23.

## D41: A completion the state guard forbids is `illegal_transition`, not `lease_lost`

(Step 9, reviewer decision A1.)

**Decision.** When a fenced write (T4; and in Step 9 also T5, T7, T8) matches 0 rows, the same
transaction re-reads the job's `fencing_token` (`readFence` in `src/worker/complete.ts`). Then:
- **The token moved:** someone else holds the job, so the result is `lease_lost`, as before.
- **The token is unchanged:** this worker still holds the job, and the guard (`completionAllowed`, or the
  write's own state guard) refused the transition it asked for. That is a **bug** in the caller. The
  attempt row (or verify phase row) records `illegal_transition`, the worker logs it at error level, and
  the counter `illegal_transitions_total` goes up (`src/worker/metrics.ts`, in process; Day 3 exports it).

In both cases the job is left as it is: its lease expires and recovery takes it. The model
(`src/fleet/model.ts`) makes the same distinction, so the model-vs-real test checks it.

**Alternatives considered.** Keep one `lease_lost` answer for every 0-row write: a bug that tries to
requeue a job past its intent would look exactly like a routine lost lease, and nobody would see it.
Throw and crash the worker: recovery would handle the job the same way, but every bug would also cost a
browser, a process restart and the worker's other work.

**Why.** "Someone else owns this job" is normal in a fleet; "this worker asked for a transition the state
machine forbids" never is. They need different alarms.

**Date.** 2026-11-13

## D42: `transfer-history-lookup` 1.2.0 reads the first match's Reference and knows the bank's 503 page; the mock bank can lag its history

(Step 9; step-08 reviewer decision 5, step-09 reviewer decisions 4 and 5.)

**Decision.** Lookup 1.2.0 makes three changes:
- After reading the count, its step-10 reads the first body row's **Reference** on the history grid
  (output `firstMatchRef`), on all three tenants. A job that verify finds already done therefore keeps
  `confirmationRef` = the bank's row id, and the oracle's MISMATCH check stays uniform (D32).
- The bank's 503 "System unavailable" page is a **known outcome**, `BANK_UNAVAILABLE`. Verify can then
  tell "the bank is down" from "a page it cannot understand" (D44).
- The mock bank shows an empty filtered history as one "No matching transfers." row, so the grid's first
  body row always exists.

The mock bank also gains `/control/history-lag/:ms`. A ledger row stays hidden from the history pages, the
count included, until it is that old. The rule is applied at read time, and `/control/ledger` (the oracle)
sees every row at once.

The new version was approved with `catalog approve` (version, digest, and the tenant-a/b/c override digests,
D30). The basis is `evidence/transfer-history-lookup-1.2.0/` (26 script checks against the ledger), and
`committedApprovals.test.ts` asserts the version and all three digests.

**Alternatives considered.** Have the oracle accept `already_done` without a reference (weaker: a wrong row
would pass). Read the reference only in verify, through a second capability (two artifacts to approve and
keep in step for one page).

**Why.** The history page is the only place verify can learn anything. The lookup has to return
everything a decision needs, and say plainly when the bank itself is the problem.

**Date.** 2026-11-13

## D43: The verify phase: a run that may have committed goes straight into its owner's verify (T5); two lookups with a settle period between them decide; T7 writes the decision

(Step 9; docs/plans/step-08.md section 5, step-09 reviewer decisions 1 and 4.)

**Decision.**
- **Who verifies.** Usually the worker whose own run may have committed. That covers a `commitUncertain`
  result, and a throw or abort after a T3 that was not a `FencingError` (D37). `jobOutcomeFor` sends
  such runs to **T5**, which moves the job from `running`/`committing` to `verifying`. In one fenced
  transaction T5 bumps the token, grants a fresh lease, closes the attempt row, and opens a
  `job_verifications` phase whose `prior_status` is the run's `ReplayResult` status. The worker then
  verifies at once, under a heartbeat on the new token. Otherwise the verifier is a worker that claimed
  the job in recovery (D45). T4 refuses a `verifying` target, in SQL and in `completeJob`.
- **The procedure** (`src/worker/verify.ts`):
  1. Lookup #1: lookup 1.2.0 for (memberId, memo_key), read-only, no `approveRisky`. A transient result
     (session timeout, interstitials exhausted, a network-level throw) gets one retry.
  2. If it counted 0, wait the **settle period** (`ROTE_VERIFY_SETTLE_MS`, default 5 s; the heartbeat can
     abort the wait) and run lookup #2 the same way.
  3. Decide with the pure `verifyDecision` (`src/fleet/stateMachine.ts`), one row per line of step-08
     section 5's table:
     - `[1]` or `[0, 1]` → `succeeded` / `already_done`, `confirmationRef` = `firstMatchRef`.
     - `[0, 0]` with attempts left → `queued` (`commit_intent_at` cleared). This is **the only retry after
       an intent**.
     - `[0, 0]` with no attempts left → `failed` / `not_committed_attempts_exhausted`.
     - `[0, 0]` after a refusal shown after Submit (`prior_status` = `business_outcome`) →
       `business_outcome`; the refusal stands and the job is never retried.
     - `[2+]` or `[0, 2+]` → `needs_human` / `ambiguous`.
     - A page that loads but cannot be read → `needs_human` / `unreadable`.
     - The bank unavailable → deferred (D44).
  4. **T7** writes the decision, fenced on the verify token, and ends the phase row with its lookups and
     decision. A non-success result keeps the original result and adds `result.verify` (lookups, evidence
     references). A lost lease writes nothing to `jobs`; the phase row records `lease_lost`.

**Alternatives considered.**
- For T5, keep Step 8's interim and park every lost Submit response as `needs_human`: one human page per
  lost response, for questions the bank's history answers in seconds.
- Let recovery verify after the lease expires: a full lease of latency, for no safety gain.
- A single lookup with no settle period: a history that lags the ledger reads 0, and that 0 resubmits a
  transfer that happened (D47).
- No retry at all (the brief's strict reading): approved as one retry (step-08 reviewer decision 4).
- A dedicated verifier pool: more processes, for work every worker can already do.

**Why.** After an intent, the job must not be retried blindly. The bank's own history, searched by the
memo key the job wrote, is the only witness. Two looks with a pause between them, and a decision
function with one row per case, make each outcome traceable to what the bank showed.

**Date.** 2026-11-13

## D44: A bank that is unavailable is not ambiguous: the verify defers (T8) within a budget, outside the crash cap

(Step 9, step-09 reviewer decision 5.)

**Decision.** `classifyLookup` tells four answers apart:
- **unavailable**: the lookup's `BANK_UNAVAILABLE` outcome (the 503 page, D42), or a transient that is
  still there after the one retry;
- **transient**: session timeout, interstitials exhausted, or a network-level throw;
- **unreadable**: anything else that is not a count (another business outcome, an unexpected page, a
  count that is not a number);
- **count**: the history was read, with n matches.

Unreadable and 2+ matches go to `needs_human` at once. Unavailable **defers** the verify with T8, one
fenced transaction:

```sql
UPDATE jobs
SET fencing_token = fencing_token + 1, lease_expires_at = now() + make_interval(secs => $backoff),
    error = $why, updated_at = now()
WHERE id = $1 AND fencing_token = $2 AND lease_owner = $3 AND state = 'verifying'
RETURNING fencing_token;
-- + the phase row: ended_at = now(), decision = 'deferred', lookups
```

- The job **stays `verifying`**. `lease_owner` stays the deferring worker, because
  `jobs_active_has_owner` requires an owner on every active row. The **token is bumped**, so that worker
  holds nothing any more: its heartbeat or a later write would match 0 rows.
- The lease is set to `now() + backoff` on the database clock: 5 s, doubling each time, capped at 60 s
  (`ROTE_VERIFY_DEFER_BACKOFF_SECONDS`). When it expires, any worker's recovery resumes the verify
  (T6.7, D45) as a new phase with a fresh lease.
- Deferral has its own **budget**: 600 s from the end of the cycle's first deferral
  (`ROTE_VERIFY_DEFER_BUDGET_SECONDS`, measured with the database clock). After that, `verifyDecision`
  escalates to `needs_human` / `verify_unavailable`.
- Deferred phases **never count toward the 3-phase crash cap** (T6.6), and a deferred job keeps its tenant
  slot (`verifying` is an active state).

`job_verifications` gains the decision `deferred` and the reason `resumed`, and a phase row is decided
exactly when it is ended (migration `0003_verify.sql`).

**Alternatives considered.**
- A new `deferred` state with no owner: a new state for every CHECK, for `ACTIVE_STATES` and for the
  tenant cap, when the lease columns already express "nobody holds it until time T".
- Set `lease_owner` to NULL: forbidden by `jobs_active_has_owner`, and relaxing that CHECK would weaken
  every other active state.
- Keep the verifier holding the job with its heartbeat while it sleeps: one worker and one browser tied
  up per job for up to 10 minutes; in a fleet-wide outage every worker would be parked.
- `needs_human` at once (the brief's strict rule): a 30 s outage would page a human for every in-flight
  job.

**Why.** For a legacy back office, an outage is the expected failure, not the exceptional one. A
deferral costs nothing in safety: no decision is made without a readable history, and the job stays
fenced. Saved evidence: `evidence/verify-bank-outage-30s/` (D47 has the history-lag counterpart).

**Date.** 2026-11-13

## D45: Recovery claims expired commits and verifies them itself (T6.4–T6.7); a verify cycle escalates after 3 dead phases

(Step 9; docs/plans/step-08.md section 4, step-09 reviewer decision 2.)

**Decision.** `recoveryAction` gains three ways to claim a job for the recovering worker (`state =
'verifying'`, token + 1, `lease_owner` = the recoverer, its own lease, a new phase row):
- **T6.4** an expired `committing` job (replaces Step 8's T6.3, which parked it);
- **T6.5** an expired `verifying` job whose phase died (still open, closed `crashed` by this recovery,
  `lease_lost`, or `illegal_transition`), while the cycle has had **fewer than 3 dead phases**;
- **T6.7** a `verifying` job whose newest phase was `deferred` (D44) or `handed_off` (D46).

**T6.6** escalates the third dead phase of a cycle to `needs_human` / `verify_exhausted`. A *cycle* is the
run of phases since the newest one that started one (reason `commit_uncertain` or
`lease_expired_in_committing`). `VERIFY_CYCLE_SQL` derives it from `job_verifications`, and the model
derives it the same way. A claim is one statement (`CLAIM_TO_VERIFY_SQL`). The dead holder's open attempt
or phase row is closed `crashed` in the same transaction. The sweep **stops at a claim**: that job becomes
this loop iteration's work, so the worker verifies it at once. A kill inside T6 rolls back and releases the
row lock, and the next recoverer takes the job (crash point `recover-in-transaction`).

**Alternatives considered.**
- Count every phase toward the cap: a long outage would exhaust jobs that never crashed (reviewer
  decision 5).
- Have recovery only release the job, for any worker to dequeue: a second state for "waiting to be
  verified", and a gap in which nobody owns a possibly committed transfer.
- Record verify phases as attempts: `attempt` counts Submit clicks (D21's `queued ⇒ attempt <
  max_attempts`), and a verify never clicks.

**Why.** A job that may have committed should be in someone's hands at every moment, under a lease. Only
a verifier that keeps dying is a reason to stop; a slow bank is not.

**Date.** 2026-11-13

## D46: `rote jobs reverify <id>` hands one parked job to recovery, by id only, fenced on its state

(Step 9; step-09 plan item 7, reviewer decision 3.)

**Decision.** `rote jobs reverify <id> [--tenant] [--by] [--database-url]` (`npm run jobs`) moves **one**
`needs_human` job to `verifying`. It accepts only the "could not tell" outcomes: `commit_uncertain`
(including Step 6–8's parked jobs), `unreadable`, `verify_unavailable` and `verify_exhausted`. It never
accepts `ambiguous`, which means two rows may exist and needs a person. One fenced transaction does the
hand-off:
- the job gets token + 1, `lease_owner` = `--by`, and a lease **already expired**;
- a phase row is inserted already ended, with decision `handed_off` and the job's prior status.

The next worker's recovery resumes the job (T6.7) and verifies it. Refusals exit 1 (no such job, wrong
tenant, not reverifiable); bad arguments exit 2.

**Alternatives considered.**
- Move parked jobs automatically after Step 9 shipped: a person may already be working on one.
- `--all-commit-uncertain`: rejected by the reviewer (one at a time, by id).
- Have the CLI run the lookup itself: a second verify path to keep in step with the first.

**Why.** Humans decide which parked jobs to hand back. The machinery that decides them stays the one
recovery path (T6.7, then the verify phase), so a hand-off is verified exactly like a crash.

**Date.** 2026-11-13

## D47: The verify settle period must exceed the bank's history visibility delay (a deployment requirement); the reconcile pass is the backstop

(Step 9, step-09 reviewer decisions 1 and 4.)

**Decision.** `ROTE_VERIFY_SETTLE_MS` (default 5000) is documented, in `src/worker/main.ts`,
`src/worker/verify.ts` and the README, as a **deployment requirement**: it must exceed the longest delay
between the bank committing a transfer and the transfer appearing in its history search. Settle ≥ lag is
**sufficient on every path**. Lookup #2 renders at least `settle` after lookup #1 began, and lookup #1
begins after the write. A worker crash only adds margin: its job is verified once the lease expires
(about 30 s in production). That margin cannot be counted on, because the T5 path verifies about 1 s
after the write. A history slower than that has to be met by raising the setting, never by trusting the
lease. The reconcile pass (Step 10) is the backstop that makes a duplicate from a misconfigured settle
period loud.

**Evidence** (`evidence/settle-vs-history-lag/`, `npm run verify-scenarios -- --family lag`). Six runs,
each judged by a script against its own measured timing (render window per lookup, from the lookup's
`run.jsonl`):
- Immediate verify (T5): lag 3 s → `[0, 1]`, 1 row; lag 8 s → `[0, 0]` → resubmitted → 2 rows,
  DUPLICATE. These are exactly the reviewer's predictions.
- A crash after Submit at the matrix's 5 s lease: the same lags give `[1]` and `[0, 1]`, one row each; lag
  30 s → DUPLICATE.

The reviewer predicted `[0, 1]` and DUPLICATE for the crash path too. That prediction assumed the verify
starts at the crash, and the README explains the difference.

**Alternatives considered.**
- Derive the settle period from the lease ("a crash always waits a lease anyway"): wrong for T5.
- Keep looking until a timeout instead of exactly twice: it still needs a bound, which is the same setting
  under another name, and every `[0, 0]` resubmit gets slower.
- Have the mock bank never lag: the `[0, 1]` path would stay untested (the reviewer's reason for adding
  `/control/history-lag`).

**Why.** Verify can only be as good as the history it reads. Whether a history lags, and by how much, is
a property of each deployment's bank, so it has to be configured and stated, not assumed.

**Date.** 2026-11-14

## D48: A `slow` vitest project for the integration files that wait, in the browser files' pool with one longest-first queue; overlapping them with the unit/DB files was measured and rejected

(Step 10, plan section 6; reviewer decision 6: the first code commit of Step 10.)

**Decision.** `vitest.config.ts` has three projects. `unit-db` is unchanged (group 0, full parallelism).
`browser` and the new **`slow`** share group 1 and one pool of at most `BROWSER_TEST_WORKERS` (3) files, so
D31's browser cap covers both. `slow` holds the integration files that mostly wait on leases, a deliberately
slow bank, an outage or worker child processes: `faults`, `lease` and `verify` (moved out of `browser`), and
from Step 10's later commits `crashSubmit`. All three projects run in `npm test` and in CI; nothing is
skipped. `npm run test:fast` (`--project unit-db --project browser`) leaves the slow files out for a quick
local loop, never as a commit gate.

vitest's own sequencer orders a group's files by **project name** before duration ("projects run
sequential"), which queued every slow file behind every browser file. **`vitest.sequencer.ts`** is vitest's
comparator without that step, so group 1 is one longest-first queue across both projects, as it was when the
slow files were browser files; with no recorded durations (a fresh CI checkout) the slow files go first.

The guard test (`browserProject.test.ts`) requires every Chromium-launching file, worker child processes
included, to be in exactly one of the two lists, and every slow file to be a `*.db.test.ts`; `npm run
test:unit` leaves the slow project empty (`passWithNoTests`).

**Measurement** (`evidence/step-10/slow-project/README.md`: every run's full log and JSON per-file timeline;
`scripts/test-timeline.ts` prints them). An interleaved A/B, 3 rounds, nothing else running. "Before" is the
pre-D48 arrangement; the first "after" ran the slow project in group 0, beside `unit-db`, to overlap its
waiting with the unit/DB CPU work:

| Round | Before (s) | Slow in group 0 (s) |
| --- | --- | --- |
| 1 | 168.5 | 160.3 |
| 2 | 171.6 | 180.0 |
| 3 | 215.4 | 215.3, **6 tests failed** |
| mean | 185.2 | 185.2 |

No gain: overlapping made both sides slower (`modelVsReal.db.test.ts` about 40 → 75 s, `verify` 59 → 75 s),
and in round 3, with the machine loaded, it failed six tests (model vs real past its slack, two recovery
tests' 5 s timeouts, `faults`' setup hook). Then the slow project in group 1 WITHOUT the sequencer: the
slow files ran after the browser files (group 1: browser 45–160 s, slow 159–213 s), slower by design. With
the sequencer: it packs group 1 as tightly as the "before" runs did (span / summed file time 0.36 against 0.355-0.36),
so the scheduling is the one the suite had before the slow project existed. The committed run passed
572/572 in 203.4 s on a machine loaded enough that every file ran slower than in the A/B's first rounds
(`final-4`). The runs on the way there are in the README, including one red gate run whose failure was
the model-vs-real load flake in unit-db, not the slow project (`evidence/step-10/flakes.md` 1).

**Alternatives considered.**
- *The slow project in group 0* (measured above): no gain, and flaky under load.
- *Group 1 with vitest's default order* (measured above): the slow files run last.
- *Name the projects so "slow" sorts first:* it works by accident of spelling, and it is slow-first, not
  longest-first.
- *Its own group after `browser`:* the groups run one after the other, adding the slow files' longest one
  to the wall time.
- *Raise group 1's cap to 4:* D31 measured cap 4 as faster (102.3 s vs 108.8 s; 19 vs 15 peak Chromium
  processes) but chose 3 to halve peak memory on the 8 GB laptop. Changing it is D31's decision; noted for
  the reviewer.
- *Skip the slow files locally:* never; they run in every `npm test` and every CI run.

**Why.** The project boundary is what the reviewer asked for: the waiting integration files are named,
guarded, and can be left out of a quick loop, while the gate still runs everything. The measurements say
where they can run without making the suite slower or flakier: in the pool they were already in, in the
same order.

**Date.** 2026-11-14

## D49: A requeue after a failure backs off: `not_before`, 10 s × 3^(attempt−1), jittered, capped at 120 s

(Step 10, plan section 1; reviewer decision 2: option B.)

**Decision.** Migration **`0004_day2_exit.sql`** (all of Step 10's schema) adds `jobs.not_before`, with the
CHECK `jobs_not_before_only_queued` (`state = 'queued' OR not_before IS NULL`).
- **T4's requeue** (`COMPLETE_JOB_SQL`) sets `not_before = now() + make_interval(secs => $8)` (database
  clock, D22). The worker computes `$8` with the pure `requeueBackoffSeconds(attempt, random)`:
  `min(120, 10 · 3^(attempt−1))` × a jitter in [0.8, 1.2), so 10 s, 30 s, 90 s, then 120 s. Any other T4
  target leaves it NULL. Each retry still consumes an attempt (D21 unchanged).
- **The dequeue** skips a job until its backoff has passed. `CLAIM_TENANT_SQL`'s `EXISTS` and its `ORDER BY`
  subquery, and `PICK_JOB_SQL`, each test `(not_before IS NULL OR not_before <= now())`. Otherwise a tenant
  whose only queued jobs are not yet due would be claimed, yield nothing and be excluded on every dequeue,
  and fairness would rank a tenant by work it may not run yet. `LEASE_SQL` clears `not_before`.
- **No backoff** for a crash requeue (T6.1, `RECOVER_JOB_SQL`) or a verified resubmit (T7,
  `VERIFY_RESULT_SQL`): neither failure was the bank's, and T6.1 already waited out a lease.
- The worker logs `retryInSeconds` on a requeue; `GET /jobs/:id` shows `notBefore`.

With 3 attempts, the earliest the third attempt can run is 0.8 × (10 + 30) = **32 s** after the first
failure (`minRequeueScheduleSeconds`), so the brief's 30 s bank outage fails no job. Longer outages are Day
4's circuit breaker (reviewer decision 2).

**Tests.** Unit: the schedule, the jitter bounds, the refusals, the 32 s bound. **Property 7** (a new,
smaller simulation: one job, 1–3 workers polling as eagerly as possible, one outage, every transition
through the model and the real `jobOutcomeFor`): an outage shorter than 32 s never fails the job (10 000
runs), and the bound is tight: fast-check finds a failed job with a longer outage, and with a 30 s outage
and no backoff (the "T4 requeue without `not_before`" mutant, in the model). The main simulation's T4
requeue backs off too. Model vs real: `not_before` is compared after every command (within 1 s), T4
requeues are generated with backoffs, the tick shifts `not_before` with the leases, and the test requires
that a dequeue was held back by a backoff at least once. DB: the dequeue respects `not_before`; the oldest
DUE job is picked; the tenant claim skips a tenant with no due work; fairness ranks by due work only (a
test that fails if the held-back job were counted); T4 sets it by the database clock and only for a
requeue; T6.1 and T7 leave it NULL; the 0004 CHECK. Integration (`faults.db.test.ts`, slow project): the
brief's 30 s `errors/on` from the first attempt: the attempts back off (each ≥ 8 s apart), the attempt
after the outage succeeds, 1 ledger row.

**Alternatives considered.**
- **A.** A bank-unavailable failure before Submit costs no attempt: transfer 1.2.0 to recognize the 503
  page, re-approval with override digests, and a free-attempt count in D21's CHECK. It survives outages of
  any length, but it is a capability change and a CHECK change for a case Day 4's breaker owns.
- **C.** Bring Day 4's circuit breaker forward (the `breakers` table exists): Day 4 work either way.
- Back off in the worker (sleep before releasing the job): holds a worker, a browser and a tenant slot
  while waiting, and uses the worker's clock.
- Back off T6.1 too: a crash is not the bank's fault, and the lease expiry already cost 30 s.

**Why.** "Retries back off" is the brief's bank-slow/down row. A database-clock `not_before` is the
smallest change that meets it: one column, one CHECK, one clause in each dequeue query, and nothing held
while a job waits.

**Date.** 2026-11-14

## D50: The reconcile pass: a job that succeeded after a resubmit is re-read once, after lease + settle + margin; 2+ matches move it to `needs_human` / `duplicate_suspected`; `GET /jobs/:id` says when a job is `settled`

(Step 10, plan section 2 (step-08 section 9a, R3); reviewer decision 3 and its addition.)

**Decision.** Verify + resubmit reopens the zombie window (step-08 section 6): a worker frozen after its
intent can click after another worker verified `[0, 0]` and resubmitted, and the bank has no lease to
check. The window is not closed; it is made **loud**. Only a job that **succeeded after a resubmit** can
carry such a late second transfer, so only those are reconciled.
- **Marking.** T4 (to `succeeded`) and T7 (`already_done`) set `reconcile_after = now() + $due` when the job
  has a `resubmitted` verify phase (an `EXISTS` on `job_verifications`). `$due` = lease + settle + margin
  (`reconcileDueSeconds`; `ROTE_RECONCILE_MARGIN_SECONDS`, default 25, so 30 + 5 + 25 = 60 s in production):
  by then a zombie frozen across its lease has had a full settle period and the margin to click.
- **R1, the claim** (`RECONCILE_CLAIM_SQL`, in `beforeDequeue` after the recovery sweep, at most one per
  loop iteration, and only when the sweep claimed nothing to verify). The job **stays `succeeded`**; the
  reconcile lease is `lease_owner` / `lease_expires_at` on the succeeded row (`jobs_lease_pair` holds;
  `jobs_active_has_owner` does not apply); token + 1; a `job_verifications` row with reason `reconcile`. A
  dead reconciler's open row is closed `crashed` and its expired lease is claimable again (T6 only looks at
  active states). No heartbeat: one lookup takes about a second against the lease, and a reconciler whose
  lease expired is fenced by the next claim's token bump (it is read-only).
- **One lookup** (the verify lookup, 1.2.0, one retry if transient), then the pure `reconcileDecision`:
  1 match → `reconciled` (stays succeeded); 2+ → `duplicate_suspected` (`needs_human`,
  `duplicates_detected_total` + 1, one error-level log line); 0 or unreadable → `reconcile_unreadable`
  (`needs_human`: a succeeded job whose transfer the history cannot show is itself an alarm); unavailable →
  `reconcile_deferred` (`reconcile_after` moves by D44's backoff; past D44's budget → `reconcile_unreadable`).
- **R2, the result** (`RECONCILE_RESULT_SQL`), fenced on (id, token, owner, state `succeeded`); 0 rows →
  `readFence` (D41). A `needs_human` decision keeps the job's result and adds `result.reconcile`
  (`decision`, `matches`, `firstMatchRef`, `jobConfirmationRef`, `lookups`, `evidenceRefs`).
  **`reconciled_at` is set by every decision except a deferral** (the plan set it only for `reconciled`),
  so "the pass decided" is one column.
- **`settled`** (reviewer decision 3's addition). `GET /jobs/:id` returns `settled: true` when the job is
  terminal and no reconcile is due: `reconcile_after IS NULL OR reconciled_at IS NOT NULL` (`jobSettled`).
  Until then a succeeded job can still change to `needs_human`; the README says so.
- **The one exception to terminal finality**: `succeeded` → `needs_human` (`duplicate_suspected` /
  `reconcile_unreadable`), approved by the reviewer. `rote jobs reverify` never accepts either outcome.
- `job_verifications` gains reason `reconcile` and four decisions, with a CHECK that ties them to that
  reason; `VERIFY_CYCLE_SQL` (and the model) ignore reconcile rows, so a verify cycle is only verify phases.
- Counters `duplicates_detected_total` and `reconcile_decisions_total{decision}` (in process until Day 3).

**The honest limits.**
- A zombie frozen longer than the delay that also beats its overdue heartbeat on waking clicks **after**
  the reconcile read, and that duplicate is silent again (reviewer decision 5). The end-of-day batch
  (D51) re-reads every such job in a window, regardless of `reconciled_at`.
- Lookup 1.2.0 reads only the FIRST match's Reference. With 2 matches the reconcile records the count, the
  first match's reference and the job's own `confirmationRef`; when the history lists the job's own row
  first (the mock bank lists oldest first), the second row's reference is in the evidence screenshot, not
  in a field. Reading every match is a lookup 1.3.0 (re-approval), not done here.
- Only `succeeded` jobs are reconciled. A job that ends `failed` or `business_outcome` after a resubmit can
  also meet a zombie's late click (1 row against a job that says it did not move money; the oracle's
  UNRECORDED_COMMIT). Not covered; an open question for the reviewer.

**Tests.** Unit: every row of `reconcileDecision`, `reconcileDueSeconds`, `jobSettled`. Property: terminal
finality with the one exception; **property 8**: after a drain past the reconcile delay, a job never stays
`succeeded` with 2+ rows unless a row became visible only after the reconcile's read (the zombie after the
pass); **property 9**: with the end-of-day batch after the drain, never at all. Model vs real: R1, the batch
claim and R2 per decision, `reconcile_after` / `reconciled_at` after every command, a sequence family that
starts from a job that succeeded after a resubmit. DB: T4/T7 marking (and not without a resubmit); R1's due
selection, `SKIP LOCKED`, a re-claim after an expired reconcile lease (the dead row closed `crashed`); R2 per
decision; a stale R2 writes nothing; the 0004 CHECKs. Integration (real lookup, real bank): two ledger rows
for one memo → `duplicate_suspected` with the count and both refs on the job; 1 row → `reconciled`.

**Alternatives considered.**
- Keep `succeeded` with outcome `duplicate_suspected` plus the alert (gentler for API clients, but the
  brief's `needs_human` list would not show it): the reviewer chose `needs_human`.
- Reconcile every succeeded job: a history read per job for a window only resubmitted jobs have.
- A second, later reconcile (e.g. +15 min): the reviewer chose the batch command instead (D51).
- A heartbeat during the reconcile: a lookup is a second against a 30 s lease, and a re-run is harmless.

**Why.** The window cannot be closed from outside the bank (it has no lease to check), so the system must
look again after the window and say so loudly. Limiting the look to resubmitted jobs keeps the cost at one
read per job that could possibly be affected.

**Date.** 2026-11-14

## D51: `rote reconcile --since <duration>`: end-of-day reconciliation re-reads every job that succeeded after a resubmit, regardless of `reconciled_at`

(Step 10, reviewer decision 5.)

**Decision.** The reconcile pass (D50) looks once, at lease + settle + margin. A zombie frozen longer than
that, which also beats its own overdue heartbeat on waking, clicks after the look, and its duplicate is
silent again: that is stated as the pass's honest limit. Banks close the gap the way they always have, with
an end-of-day reconciliation, so the reviewer asked for one:

```
npm run reconcile -- --since 24h [--tenant tenant-a] [--by <name>] [--database-url <url>] [--evidence-dir <dir>]
```

- **The window** (`RECONCILE_WINDOW_SQL`): every job still `succeeded` with `reconcile_after` set (it
  succeeded after a resubmit) whose `reconcile_after` is inside `--since`. `reconcile_after` is the success
  moment plus the reconcile delay (moved later by a deferral), so the window reaches back `since` plus one
  delay: a few more jobs than strictly "succeeded in the window", never fewer, and it is read-only.
- **Each job, one at a time**: the batch's claim (`RECONCILE_CLAIM_JOB_SQL`: by id, `succeeded`, reconcile
  lease free, **regardless of `reconciled_at`**), then exactly the workers' reconcile phase: one lookup, the
  pure `reconcileDecision`, R2. So 2+ matches are flagged exactly like R2 (`needs_human` /
  `duplicate_suspected`, `duplicates_detected_total`, the error log line), and the run's rows carry the
  batch's `--by` name.
- A job whose workers' pass is **not due yet** is left to it (reported `not_due`): reconciling it early
  would set `reconciled_at` before the window the workers' pass exists for. A job another reconciler holds
  is reported `busy`.
- **Read-only toward the bank**: only the history lookup runs, never `approveRisky`; the integration test
  checks the ledger is unchanged.
- **Exit code**: 0 when every job in the window reconciled (or was not due); 1 when it flagged a job or
  left one undecided (deferred, busy, fenced out): a human reads the summary; 2 when it could not run (bad
  arguments, no database, a missing credential). Credentials come from the same `ROTE_CRED_*` variables as a
  worker's.

**Tests.** DB (scripted lookups, `reconcile.db.test.ts`): a job the workers' pass reconciled with 1 match
is re-read and flagged when the history now shows 2; a not-yet-due job is left alone; a job never
resubmitted is never read; the window excludes older jobs; a held job is `busy`; the duration parser.
Integration (real lookup, real bank): a succeeded-after-resubmit job, a second ledger row with its memo
added after the workers' pass reconciled it, the batch flags it and the ledger is unchanged. The property
test models the batch after the drain (property 9: then no job stays `succeeded` with 2+ rows).

**Alternatives considered.**
- A second, late reconcile in the workers (e.g. +15 min): another timer per job, still a fixed window; the
  reviewer chose the batch.
- Reconcile not-yet-due jobs too: steals the workers' pass's window (see above).
- Reconcile every succeeded job in the window: a history read per job for a hazard only resubmitted jobs
  carry.

**Why.** A fixed-delay check always leaves a later window; a periodic sweep over a window, run by an
operator, closes it the way back offices already do, with the same decision table, so a flag means the same
thing whoever raised it.

**Date.** 2026-11-14

## D52: The zombie window, measured and made loud: the `stall-after-intent` fault (heartbeat suspended) and `evidence/zombie-window-limit/`

(Step 10, plan section 3; reviewer decisions 4 and 5; step-08 section 6.)

**Decision.**
- **A stall fault point**, `stall-after-intent`, doubly gated like every fault (`ROTE_FAULT` +
  `ROTE_FAULT_ENABLE=1`) and needing `ROTE_FAULT_STALL_MS` (1..600 000; refused with any other point, and
  this point is refused without it). Right after T3 commits, the worker **stops its heartbeat** (a frozen
  process runs no timers), writes `ROTE_FAULT stalling at stall-after-intent for <ms> ms` to stderr, sleeps
  the stall without any abort signal, writes `ROTE_FAULT stall over: clicking Submit now`, and returns, so
  the click goes out the moment it "wakes". That is the window's worst case by construction (the zombie acts
  before its heartbeat could notice the lost lease), and the reviewer approved it as the evidence; no
  `SIGSTOP` variant (its timing between T3 and the click cannot be aimed from outside).
- **`npm run verify-scenarios -- --family zombie`** → `evidence/zombie-window-limit/`. One job; lease 5 s /
  heartbeat 2 s; settle 5 s; a 30 s stall; the reconcile margin 10 s (delay 5 + 5 + 10 = 20 s). The zombie
  starts first; the clean worker starts once the job is `committing`. The judge checks, from the database,
  the ledger and the workers' logs:
  1. T6.4 by the clean worker → verify `[0, 0]` → resubmitted;
  2. attempt 2 (clean) succeeded, and the job's `confirmationRef` is the first ledger row;
  3. the zombie woke and clicked: **2 ledger rows, oracle DUPLICATE** (the honest limit), and its late
     result was fenced (`lease lost; outcome NOT recorded`);
  4. the reconcile read 2 matches: `needs_human` / `duplicate_suspected`, `result.reconcile.matches = 2`,
     and `duplicates_detected_total = 1` over the workers' error lines;
  5. the order of events, from the timestamps: the verify decided `resubmitted` < attempt 2's row < the
     zombie's row < the reconcile started. A run whose timing differs fails loudly instead of passing by
     luck.

  RESULT: PASS means the duplicate happened AND it was detected. The README there states plainly that the
  window is not closed; it is made loud.
- **In chaos** (10b) the 45 s pause in every seed keeps exercising the realistic case, where the heartbeat
  usually wins on waking.

**Alternatives considered.** A real `SIGSTOP` / `docker pause` (cannot be aimed between T3 and the click);
stalling with the heartbeat running (the heartbeat would abort the run on waking: the benign case, not the
window); stalling in the browser (replay has no hook there, and the click is what matters).

**Why.** A limit nobody has seen is a limit nobody believes. The evidence shows the duplicate the design
cannot prevent, and the pass that makes it a page for a human instead of a silent second transfer.

**Date.** 2026-11-14
## D53: Crash right before and right after Submit run in `npm test` with real worker processes; the worker spawner moves to `src/testing/`

(Step 10, plan section 6; the brief's deliverable "integration tests for crash-before and crash-after Submit".)

**Decision.** `src/worker/crashSubmit.db.test.ts` (the `slow` project, D48) runs, for each case, a real worker
CHILD PROCESS with `ROTE_FAULT=before-submit` / `after-submit` that SIGKILLs itself at the point (a real
signal on Linux CI; Windows' `TerminateProcess` locally, exit code 1), then a clean child worker that
recovers the job when its lease expires, verifies it and drains until the job is **settled**, then the
ledger oracle. Lease 5 s / heartbeat 2 s as in the matrix, settle 1 s, reconcile margin 1 s, so each case
takes seconds. Expected, both cases: exactly 1 ledger row, `succeeded`, oracle PASS.
- **before-submit**: T6.4 verify `[0, 0]` → resubmitted → attempt 2 succeeds (the dead attempt `crashed`)
  → the reconcile pass reads 1 match (`reconciled`).
- **after-submit**: T6.4 verify `[1]` → `succeeded` / `already_done` on attempt 1, `confirmationRef` = the
  row, no reconcile due.

The spawner (`startWorker`, `runFaultWorker`, `listenBank`, `workerEnv`, `FAKE_CREDS`, ...) moves from
`scripts/lib/harness.ts` to **`src/testing/workerProcess.ts`**; `crash-matrix.ts` and `verify-scenarios.ts`
import it from there and `scripts/lib/harness.ts` is deleted (`scripts/lib/compose.ts` re-exports
`FAKE_CREDS`). The test binds the mock bank on :4100 (the committed artifacts point there), like the matrix:
the Compose bank must be stopped, which the working agreement already requires for `npm test`. The guard test
counts a file that imports the spawner and starts workers as a Chromium launcher.

**Alternatives considered.** In-process fault flags only (the plan of Day 1; the matrix already proves the
real-signal path, and the brief asks for the tests in `npm test`); relaxed copies of the artifacts on an
ephemeral port (needs the worker entrypoint to take test-only directories; the matrix's path is the one to
test); keeping the spawner under `scripts/` (a test importing from `scripts/` inverts the layering).

**Why.** The brief's two worst cases should fail `npm test` and CI the moment they regress, through the same
entrypoint, signals and recovery that production runs.

**Date.** 2026-11-14


## D54: `scripts/mutation-check`: every planted bug must turn its tests red, in a required CI job; the crash matrix becomes required

(Step 10, plan section 7; step-09 reviewer addition 6; D35's amendment for the matrix.)

**Decision.** `npm run mutation-check` (`scripts/mutation-check.ts`) applies each patch in
`scripts/mutations/` in turn: `git apply --check` (a patch that no longer applies fails the check: "update the
mutant", so the mutants cannot rot), a refusal if a touched file has uncommitted changes, `git apply`, its
test files under vitest with a JSON report (caught = a non-zero exit AND at least one named failing test),
`git apply -R`, then `git diff --exit-code` on the touched files. `evidence/mutation-check/` keeps the
report. The eight mutants:

| # | Step | The planted bug | Caught by |
| --- | --- | --- | --- |
| 01 | 8 (and Step 9's M2) | recovery requeues an expired `committing` job | property tests, unit tests |
| 02 | 8 | T2 extends an expired lease | model vs real |
| 03 | 8 | T6 without the token bump | model vs real |
| 04 | 9 (M1) | one 0-match lookup decides | property tests |
| 05 | 9 (M3) | `[0, 1]` read as not committed | property tests |
| 06 | 9 (M4) | a refusal after Submit is retried | property tests |
| 07 | 10 | the reconcile reads 2+ matches as reconciled | property tests, unit tests |
| 08 | 10 | T4's requeue without `not_before` | model vs real, DB tests |

CI gains a **`mutation-check`** job (ubuntu-24.04, Node 22, a `postgres:17` service; no browser), and the
**`crash-matrix`** job loses `continue-on-error` and runs `--expect step-10` (Step 9's outcomes, plus the
reconcile pass on the resubmit paths, each scenario drained until settled). A red matrix or a surviving
mutant now fails the workflow. Making them *required status checks* on the branch is a repository setting
for its owner; the workflow can only make them fail.

**Alternatives considered.** A mutation-testing tool (Stryker: a new dependency, its own reviewed step, and
thousands of random mutants instead of the bugs these tests exist to catch); mutants as in-script string
replacements, as Step 9's PowerShell check did (they silently stop matching when the code moves; a patch
that no longer applies fails loudly).

**Why.** A property test that cannot fail is worse than none: it reads as proof. Each mutant is a bug the
design argument says is caught; the check proves it is, on every push.

**Date.** 2026-11-14
