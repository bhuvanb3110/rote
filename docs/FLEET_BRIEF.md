# rote fleet — 4-day build brief

Oct 29, 2026 · Bhuvan. Copied from the Claude Doc "rote fleet — 4-day build brief" so Claude Code
can read it from the repo. The two diagrams in the original are described in words where they stood.

## How to use this brief

Instructions for the building assistant:

1. **Read the repo first.** Before any code, write `docs/REPO_NOTES.md` answering the questions in "Starting point" below. Where the repo disagrees with this brief, the repo wins; note the difference and adjust the plan.
2. **Match rote's existing language, stack and style.** Don't introduce a second language or rewrite working code. Extend the replay engine; don't fork it.
3. **Keep all existing tests passing** (83 at last count) after every step.
4. **The headline comes first.** Crash-safe execution, proven against the mock bank's ledger, beats every other feature. Follow the cut order at the end if time runs short.
5. **Work in small commits**, each with a passing test. Record design decisions in `docs/DECISIONS.md` (one entry each: decision, alternatives, why).
6. **Never claim done without evidence.** "Zero duplicates" means the ledger was checked by a script, and the run output is saved under `evidence/`, the same way rote's existing evidence runs work.
7. **Explain choices so the builder can defend them in an interview.** The builder must understand every line.

## Goal and headline result

Turn rote from one browser at a time into a crash-safe fleet of workers, and prove that killing workers mid-transfer causes **zero duplicate transfers and zero lost jobs**, verified against the bank's own ledger.

The hard problem is specific to rote: a worker clicks "Submit transfer" and dies before recording success. A naive retry sends the money twice, and the legacy system has no API to ask whether it already happened. The fleet answers that question by reading the bank UI, the same way rote does everything else.

Target resume line, filled in with measured numbers only:

> Scaled rote to a multi-worker fleet with crash-safe execution of irreversible actions: 0 duplicate transfers and 0 lost jobs across N chaos runs with random worker kills; X jobs/min on 8 workers, with OpenTelemetry tracing and a Grafana dashboard.

## Starting point

rote already has the hard single-run pieces; the fleet adds concurrency, crash recovery and visibility around them.

What rote has today, per its demo deck:

- Discovery records a task once as a typed artifact; a deterministic Playwright engine replays it with zero model calls.
- One safety gate shared by discovery and replay, with human escalation that pauses execution.
- Confidence scoring from locator drift; capabilities start as `draft` and auto-promote to `approved` after three clean runs.
- Capability catalog: `GET /capabilities` with JSON Schema and `POST /capabilities/:id/invoke`.
- Multi-tenant overrides, record-time redaction, a mock bank app, curated evidence runs, 83 tests.
- Stated gap: "runs one browser at a time, not a fleet."

Questions to answer in `docs/REPO_NOTES.md` before Day 1 coding:

1. What language and framework is rote in, and how is replay invoked (function, CLI, HTTP)?
2. Can replay run in a separate process? Does it rely on global state, a single browser instance, or files that two workers would fight over?
3. Where are irreversible steps marked? (The safety gate must already know which steps are risky; reuse that classification.)
4. Does the mock bank have a transaction history page the UI can read? Does its transfer form have a free-text memo or reference field?
5. Does the mock bank keep a ledger that a test script can read directly (database, file, or debug endpoint)?
6. How does `POST /capabilities/:id/invoke` run today: synchronously in the request?
7. Is Docker available on the builder's machine?

## Scope

Everything runs on one machine with Docker Compose, at $0; the README says "single-machine fleet" plainly.

| In scope | Out of scope (name it in the README's limits) |
| --- | --- |
| Postgres job queue using `SELECT … FOR UPDATE SKIP LOCKED` | Multiple machines, Kubernetes, autoscaling |
| Worker processes, each with a shared browser and one fresh context per job | Desktop or terminal surfaces |
| Idempotency keys, job leases with heartbeats, fencing tokens | Exactly-once guarantees for a zombie worker (see limits) |
| Check-before-retry for irreversible steps, escalation when unsure | Real banks or real credentials |
| Per-bank concurrency cap and a per-capability circuit breaker | Login session pooling (add only if login is slow) |
| OpenTelemetry traces and metrics; Jaeger, Prometheus, Grafana | Alerting, log aggregation |
| Chaos test, load test, evidence runs, README case study, video | A production auth or secrets story |

`POST /capabilities/:id/invoke` gains an async mode: it enqueues a job and returns a job ID; `GET /jobs/:id` returns its state. Clients pass an `Idempotency-Key` header; sending the same key twice returns the same job.

## Architecture

Postgres is the single source of truth for jobs, leases and breaker state; workers hold nothing that matters if they die.

*Diagram (fleet architecture, one machine, Docker Compose):* API → Postgres (jobs, leases, breakers) ← workers 1..N (each: one browser, one context per job) → mock bank UI. Chaos script → kills/pauses workers. Ledger check → reads the mock bank's ledger directly. API and workers → OTLP → Jaeger; Prometheus scrapes workers' `/metrics`; Grafana reads Prometheus.

The API enqueues; workers lease jobs from Postgres and drive the mock bank through its UI only; the chaos script kills and pauses workers; the test reads the ledger directly to judge correctness; telemetry goes to Jaeger, Prometheus and Grafana.

Why Postgres instead of Redis or a queue library: one store keeps job state, leases and the commit intent in the same transaction, which is what makes recovery correct. `SKIP LOCKED` lets many workers dequeue without blocking each other.

## Crash-safety design

A job is only ever retried blindly if it crashed before its commit intent was saved; after that point, a second worker checks the bank's history first and escalates to a human when it can't tell.

*Diagram (job state machine, 7 states):* `queued` → `running` → `committing` → `succeeded`. Lease expiry from `running` → back to `queued`. Lease expiry from `committing` → `verifying` → `succeeded` (1 match) / `queued` (0 matches, re-checked) / `needs_human` (2+ or unreadable). Any state with `attempt >= max_attempts` → `failed`.

Steps before the irreversible click (navigate, log in, fill the form) are safe to repeat. The click itself is the only step that needs care, so the design wraps exactly that step.

### Job record

`id`, `idempotency_key` (unique), `tenant`, `capability_id`, `params`, `state`, `attempt`, `max_attempts` (e.g. 3), `lease_owner`, `lease_expires_at`, `fencing_token`, `trace_id`, `commit_intent_at`, `outcome`, `error`.

### Rules

1. **Lease on dequeue.** Picking a job sets `lease_owner`, `lease_expires_at = now + 30 s`, and increments `fencing_token`, in the same transaction as the `SKIP LOCKED` pick.
2. **Heartbeat.** Every 10 s the worker extends its lease, but only if `fencing_token` still matches. If the update matches nothing, the worker has lost the job: it closes the browser context immediately and stops.
3. **Commit intent.** Right before the irreversible click, in one transaction: confirm the lease is still held with this token, then set `state = committing`, `commit_intent_at = now`. Only then click.
4. **Mark the memo.** Put the idempotency key into the transfer's memo or reference field, so the history lookup can find this exact transfer later.
5. **Finish.** After the click, wait for the confirmation screen, then set `succeeded`.
6. **Recovery.** When a lease expires, the next worker looks at the state it was left in:

| Left in state | Action | Metric |
| --- | --- | --- |
| `queued` or `running` (no intent) | Back to `queued`; replay from the start | `job_retries_total` |
| `committing` | Move to `verifying`; run a read-only lookup of the history page for the memo | — |
| `verifying`: exactly 1 match | `succeeded`, no resubmit | `recoveries_total{result="already_done"}` |
| `verifying`: 0 matches | Wait a short settle period, check once more; still 0 → `queued` | `recoveries_total{result="resubmitted"}` |
| `verifying`: 2+ matches, or page can't be read | `needs_human` with the evidence | `recoveries_total{result="escalated"}` |
| any state, `attempt >= max_attempts` | `failed` | `jobs_completed_total{outcome="failed"}` |

If the bank UI has no memo field, match on account, recipient, amount and a time window, and send any ambiguity to `needs_human`. rote's existing safety-gate escalations also land in `needs_human`.

## Per-bank limits and circuit breaker

Legacy core systems can't take heavy load, and a broken capability should stop everywhere at once instead of failing hundreds of jobs.

**Per-bank concurrency cap**

- Each tenant (bank) has `max_concurrent` in config, for example 2.
- The dequeue query only picks a job if fewer than `max_concurrent` jobs for that tenant are `running` or `committing`. Do this inside the same transaction as the `SKIP LOCKED` pick, or with a Postgres advisory lock per tenant, so two workers can't both take the last slot.
- Jobs over the cap simply stay queued; nothing fails.

**Per-capability circuit breaker**

| State | Meaning | Moves to |
| --- | --- | --- |
| Closed | Normal; jobs run | Open, after K consecutive failures or rolling confidence below the threshold (reuse rote's confidence score) |
| Open | No jobs for this capability are dequeued; they wait, not fail | Half-open, after a cooldown (e.g. 60 s) |
| Half-open | Exactly one probe job runs | Closed if the probe succeeds with good confidence; Open again if not |

- Breaker state lives in Postgres so every worker sees the same state.
- Opening the breaker emits a span event and a metric, and is visible on the dashboard.
- Demo for the video: break a locator in the mock bank mid-run and show the breaker open after a few jobs, not after hundreds.

## Observability

The point of tracing is one screenshot: a job whose first worker died after clicking submit, and whose second worker verified the transfer had already happened and finished without resubmitting.

**Stack (all free, all in `docker-compose.yml`)**

- OpenTelemetry SDK in the workers and API, exporting over OTLP
- Jaeger for traces (single container)
- Prometheus scraping a `/metrics` endpoint on each worker
- Grafana with the dashboard provisioned from a JSON file committed to the repo, so it appears on `docker compose up`

**Spans (one trace per job, across attempts)**

| Span | Key attributes |
| --- | --- |
| `job.dequeue` | job_id, tenant, capability_id, queue_wait_ms |
| `job.attempt` | attempt, worker_id, fencing_token |
| `browser.acquire` | pool_size, wait_ms |
| `capability.step` | step_index, irreversible (true/false), locator_strategy |
| `commit.intent` | idempotency_key |
| `commit.verify` | result: already_done / not_found / ambiguous |
| `job.complete` | outcome, confidence |

Carry the trace ID in the job row so a retry by another worker joins the same trace.

**Metrics**

| Metric | Type |
| --- | --- |
| `jobs_completed_total{outcome}` | counter |
| `job_duration_seconds` | histogram (p50 / p95) |
| `job_retries_total` | counter |
| `recoveries_total{result}` | counter: already_done, resubmitted, escalated |
| `queue_depth{tenant}` | gauge |
| `workers_alive` | gauge |
| `browser_contexts_in_use` | gauge |
| `breaker_state{capability}` | gauge: 0 closed, 1 half-open, 2 open |

**Grafana dashboard panels:** jobs per minute, p95 latency, queue depth per bank, workers alive, recoveries by result, breaker state. This is the screen recorded during the chaos test.

## Chaos and load tests

Correctness is judged only by the mock bank's ledger, read directly by the test script; workers never read the ledger, because a real bank wouldn't let them.

**Ledger check (the oracle)**

For every job, after the run:

- `succeeded` → exactly 1 matching transfer in the ledger
- `failed` → exactly 0
- `needs_human` → listed in the report with the reason; 0 or 1 transfers, never 2
- Any job with 2 or more transfers = a **duplicate** (test fails)
- Any job not in a final state after the drain timeout = **lost** (test fails)

**Chaos scenarios**

| Scenario | How | What it proves |
| --- | --- | --- |
| Random kills | 500 jobs, 4–8 workers; `SIGKILL` a random worker every 5–15 s; a supervisor restarts it | Leases and recovery under messy, realistic crashes |
| Crash right after submit | Fault-injection flag makes a worker exit immediately after the irreversible click, before recording anything | The worst case is tested every time, not by luck |
| Crash right before submit | Same flag, other side of the click | Recovery retries safely when nothing happened |
| Paused (zombie) worker | `SIGSTOP` a worker past its lease, then `SIGCONT` | The fencing check stops a stale worker from committing |
| Bank slow or down | Mock bank adds latency or returns errors for 30 s | Retries back off; nothing duplicates |

Run the random-kill scenario at least 5 times with different seeds; save each run's ledger report under `evidence/fleet-chaos-<n>/`.

The crash-after-submit and crash-before-submit cases also become automated integration tests that run in CI (no Grafana needed there).

**Load test**

- 1, 2, 4 and 8 workers, 200 jobs each, per-bank cap raised so it isn't the bottleneck.
- Record jobs per minute, p50 and p95 job duration, CPU and memory.
- Find where throughput stops growing and say why (CPU, browser memory, Postgres, or the mock bank). An honest "it flattens at 6 workers because each browser context needs about X MB" is better than a big number.
- Save results under `evidence/fleet-load/` and chart them in the README.

## Four-day plan

Day 2 is the hard day and the one that matters; Days 3 and 4 shrink before Day 2 is ever cut short.

1. **Day 1 — the fleet runs**
   - First hour: read the repo, write `docs/REPO_NOTES.md`, and spike calling replay from a separate process. If it relies on global state, fix that before anything else.
   - Postgres schema (jobs, attempts, tenants, breakers), enqueue API with `Idempotency-Key`, `SKIP LOCKED` dequeue, worker processes, browser with one context per job.
   - Add a transaction history page and a memo field to the mock bank if missing, plus a ledger read for tests.
   - Write the chaos test script and the ledger check now, even though they will fail.
   - Exit: 100 jobs complete across 4 workers; existing tests pass.
2. **Day 2 — crash safety**
   - Leases, heartbeats, fencing tokens, the job state machine, `commit.intent` before irreversible steps, check-before-retry, escalation to `needs_human`.
   - Fault-injection flags for crash-before and crash-after submit; integration tests for both.
   - Exit: all chaos scenarios pass with 0 duplicates and 0 lost jobs, across 5 random-kill runs.
3. **Day 3 — observability**
   - OpenTelemetry spans and metrics; Docker Compose with Jaeger, Prometheus and a provisioned Grafana dashboard.
   - Exit: the recovered-job trace screenshot and a dashboard during a chaos run.
4. **Day 4 — limits, numbers, story**
   - Per-bank cap and circuit breaker; load test at 1, 2, 4, 8 workers.
   - README case study, `docs/FLEET_DESIGN.md`, 2-minute video.
   - Exit: everything in Deliverables exists and every number traces to a saved evidence run.

## Deliverables and definition of done

Done means a reviewer can watch two minutes of video, see the ledger say zero duplicates, and reproduce it with one command.

- [ ] `docker compose up` starts Postgres, the mock bank, API, workers, Jaeger, Prometheus and Grafana
- [ ] One command runs the chaos test and prints the ledger report
- [ ] 5+ random-kill chaos runs plus every other scenario saved under `evidence/`, all at 0 duplicates and 0 lost
- [ ] Crash-before and crash-after submit tests run in CI; all existing tests still pass
- [ ] Trace screenshot of a recovered job; Grafana screenshot during a chaos run
- [ ] Load test results with the bottleneck explained
- [ ] `docs/FLEET_DESIGN.md`: the state machine, recovery rules, fencing, and why each choice
- [ ] README "Fleet" section written as a case study: problem, design, results, limits
- [ ] 2-minute video: start fleet, kill workers live, dashboard keeps going, ledger check passes
- [ ] Demo deck (the rote artifact) gets one new slide with the numbers

Interview prep falls out of this: be able to explain why `SKIP LOCKED`, why leases plus fencing, why verify through the UI instead of trusting the queue, and what still isn't guaranteed.

## Risks, honest limits and cut order

The one limit to state openly is the zombie-worker window: no system can make a click on an external UI exactly-once, so the design shrinks that window and escalates instead of guessing.

| Risk | Early sign | Response |
| --- | --- | --- |
| Replay isn't process-safe | Spike on Day 1 hour 1 fails | Fix shared state first; budget up to half of Day 1 |
| Mock bank has no history page or memo field | Found in REPO_NOTES | Add them; real banks have both, so this is realistic |
| Laptop runs out of memory at 8 workers | Workers crash on their own | Share one browser per worker, one context per job; cap at what the machine handles and report it |
| Docker not available | REPO_NOTES question 7 | Run Postgres and Jaeger natively; skip Grafana, keep traces |
| Day 2 runs long | Chaos test not green by end of Day 2 | Move Day 2 into Day 3; shrink observability to Jaeger only |

**Honest limits for the README**

- A paused worker can still finish a click in the moment between its last lease check and the click. Fencing, short commits and killing the browser context on lost lease make this rare; the paused-worker scenario measures it.
- When the history lookup can't decide, the job goes to a human. That's a design choice, not a failure.
- Single machine, mock bank, one surface (web).

**Cut order** (first to go at the top):

1. Grafana (keep Jaeger traces)
2. Circuit breaker
3. Per-bank cap
4. Load test reduced to 1 and 4 workers
5. Bank-slow scenario

Never cut: leases, check-before-retry, the crash-after-submit test, the ledger check, or the evidence runs.

## Amendments (2026-11-09)

Added after the original brief; the text above is unchanged. Where they disagree, these amendments win.

1. **No cut list.** Quality over schedule; every deliverable above gets built. The "Cut order" and
   the "follow the cut order" instruction no longer apply.
2. **Memory limit.** The builder's laptop has 8 GB RAM and Docker gets about 4 GB. So:
   - chaos runs use **4 workers** (not 4–8);
   - the load test runs **1, 2, 4 and 6 workers** (not 1, 2, 4 and 8) to find the memory limit, and
     the README reports where it is, honestly.
3. **Extra proof beyond the brief:**
   - a **crash-point matrix** that kills a worker at every step boundary of the transfer and checks
     the ledger each time;
   - **20+ random-kill chaos seeds** instead of 5;
   - **fast-check property tests** that drive the job state machine through random sequences of
     crashes, lease expiries and retries, and assert no duplicate and no lost job;
   - **GitHub Actions CI** running the unit and crash integration tests against a Postgres service on
     every push;
   - **hardened risky-click classification:** a step counts as irreversible if `policyGate` says so
     **or** the artifact step has `risk: "risky"`.
