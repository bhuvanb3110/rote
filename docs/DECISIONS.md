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
