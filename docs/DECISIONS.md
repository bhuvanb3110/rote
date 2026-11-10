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
