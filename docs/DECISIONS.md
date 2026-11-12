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
