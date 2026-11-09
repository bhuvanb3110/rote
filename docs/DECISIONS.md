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
