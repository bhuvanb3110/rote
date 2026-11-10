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
