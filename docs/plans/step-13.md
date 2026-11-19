# Step 13 — Day 3: observability (plan only; nothing built yet)

Reads `CLAUDE.md`, `docs/REPO_NOTES.md`, `docs/DECISIONS.md` and the brief's "Observability" section
(`docs/FLEET_BRIEF.md`). Starts from `main` once the Step 12 dependency PR has merged, because this step adds
dependencies and they should land on the refreshed lockfile. **Plan for review. Nothing is built until it is
approved.**

The brief's goal, in one line: **one screenshot of a job whose first worker died after clicking Submit, and
whose second worker verified the transfer had already happened and finished without resubmitting.** The
second deliverable is the Grafana dashboard during a chaos run. A third rule comes from the reviewer and
outranks both: **telemetry must never change behaviour.** With the collector down, slow or absent, the fleet
runs exactly as it does today.

The work is too big for one reviewable step, so it comes in three (section 9): **13a** the telemetry core
and the never-changes-behaviour harness, **13b** the traces, **13c** the stack, the dashboard and the
screenshots.

## 1. What exists today (verified on `main` at `0fa700f` plus Step 12)

- **`jobs.trace_id`** (`0001_init.sql`): `text NOT NULL`, 32 lower-case hex, generated at enqueue
  (`src/queue/enqueue.ts`), returned by `GET /jobs/:id` as `traceId`. **`job_attempts.trace_id`** is copied
  at lease (`src/queue/dequeue.ts`). Nothing creates a span yet.
- **In-process counters** (`src/worker/metrics.ts`, `InMemoryCounters`): `illegal_transitions_total`,
  `verify_decisions_total{decision}`, `reconcile_decisions_total{decision}`, `duplicates_detected_total`,
  `unrecorded_commits_detected_total`, `reconcile_abandoned_total`. Every increment is also a log line.
  Nothing exports them.
- **`WebSurface.screenshotRetries`** (D8): a per-surface count, not yet reported anywhere.
- **`jobs.crashes`, `lease_crashes`, `reconcile_crashes`** (D57–D59): counted in Postgres by the recovering
  worker, because a killed worker cannot count its own death.
- **`breakers`** table (`0001_init.sql`): created, but its transitions are Day-4 work. Until then
  `breaker_state` can only ever report closed (0). The dashboard panel exists from 13c and says so.
- **Replay hooks:** `onIrreversible` and `onStep` (D34). `onStep.after(step, index)` is awaited and may throw
  on purpose: that is how the fault worker dies at a step. A normal worker passes no `onStep` at all
  (`src/worker/runJob.ts:146`). The winning locator strategy is known inside `WebSurface` (`Handle.strategy`,
  locator provenance) but is not passed to any hook.
- **Compose** (`docker-compose.yml`): postgres, one bank, api, `ROTE_WORKERS` (4) workers at `mem_limit:
  700m`. The Docker VM has about 3.8 GiB plus 8 GB swap. The measured peak is about 260 MiB per worker (D9,
  Step 6).

## 2. Design rules: how telemetry is kept from changing behaviour

These are the constraints every 13a–13c change is reviewed against. Each has a test in section 7.

1. **One seam.** All telemetry goes through `src/telemetry/` and a small `Telemetry` interface, like
   `WorkerMetrics`/`NO_METRICS` today. The default is a no-op. The OpenTelemetry implementation is chosen at
   startup by configuration, and nothing else imports `@opentelemetry/*`.
2. **Fire and forget.** Fleet code never `await`s a telemetry call, and a telemetry call never throws. Every
   method of the OTel implementation is wrapped in try/catch. The error is swallowed and reported through
   one rate-limited `telemetry: degraded` warning plus a `telemetry_errors_total` counter.
3. **Bounded, asynchronous export.** Spans go through a `BatchSpanProcessor` with a bounded queue (default
   2048) that drops when full. The OTLP/HTTP exporter has a short timeout (2 s). Nothing in the job path
   waits for an export.
4. **Metrics are pulled.** Prometheus scrapes each worker. A Prometheus that is down or absent means no one
   reads the numbers; the worker does nothing differently.
5. **Startup never depends on the stack.** SDK initialisation does no network I/O. If the metrics port can't
   be bound, the worker logs one warning and runs without `/metrics`. It never exits over telemetry.
6. **Shutdown is bounded inside the existing grace.** One `forceFlush` capped at 2 s, taken from inside
   `ROTE_SHUTDOWN_GRACE_MS`, never added to it. A flush that times out is dropped.
7. **No auto-instrumentation.** No `@opentelemetry/auto-instrumentations-node`, and no monkeypatching of
   `pg`, `http`, `express` or Playwright. Patched drivers change timing and error paths in the code that holds
   leases and writes fenced transitions. Every span is explicit.
8. **One-way.** No decision reads anything from telemetry: no span context, no metric value, no exporter
   state. The job row's `trace_id` is data the worker already has.
9. **Off unless configured.** Telemetry is off unless configured: with no `OTEL_EXPORTER_OTLP_ENDPOINT` the
   tracer is the no-op, and with no `ROTE_METRICS_PORT` there is no listener. So `npm test`, the crash matrix
   and every child-process worker in the tests run as today unless a test turns it on. Compose turns it on.
10. **Redaction (CLAUDE.md non-negotiable).** Span attributes come from a fixed allowlist per span name.
    Params, credentials, memo text, URLs with query strings and error messages are never copied in. Errors
    are recorded as their class or kind (`LeaseLostError`, `FencingError`, the outcome code). The
    idempotency key the brief asks for on `commit.intent` is a client-chosen key, not a credential. It goes in
    as-is; if the reviewer prefers, it can be its SHA-256 prefix (open question 3).

## 3. Dependencies (each version resolved under Step 12's 7-day cooling-off, D61)

Added in 13a and listed in that step's plan, with release dates and `npm ls`:
- `@opentelemetry/api`;
- `@opentelemetry/sdk-trace-base` (or `sdk-trace-node`);
- `@opentelemetry/exporter-trace-otlp-http`;
- `@opentelemetry/sdk-metrics`;
- `@opentelemetry/exporter-prometheus`;
- `@opentelemetry/resources`;
- `@opentelemetry/semantic-conventions`.

Runtime dependencies, so the worker image grows. Its size is measured before and after, as in
`evidence/step-06/docker/`. **Not** `@opentelemetry/sdk-node`. It depends on every exporter (gRPC
included), reads a wide set of `OTEL_*` environment variables at start, and is the usual place
auto-instrumentation gets registered (rule 7). The pieces above are wired by hand in one file. 13a checks
`sdk-node`'s current dependency list before ruling it out for good. OTLP over HTTP/protobuf rather than gRPC: no native `@grpc/grpc-js` stack in the image, and
Jaeger v2 accepts OTLP/HTTP on 4318.

## 4. Traces: one trace per job, across attempts and workers

**Trace identity.** Every span for a job uses the job row's `trace_id`. Today nothing records a parent span,
so the API's enqueue becomes the trace's root:
- **Proposed (open question 1):** migration `0009_trace_root.sql` adds `jobs.root_span_id text NULL` (16
  hex). The API's `job.enqueue` span writes its own id there in the enqueue transaction. Each attempt,
  verify, recovery and reconcile then starts as a child of `{trace_id, root_span_id}`, rebuilt as a remote
  parent context. That is two columns of plain data, and rule 8 holds.
- **Alternative:** no migration. Each worker starts its spans under a synthetic remote parent built from
  `trace_id` alone. Jaeger shows one trace, but with a "missing parent span" warning at the root, which is a
  poor screenshot.
- Rows enqueued before 0009 (`root_span_id IS NULL`) use the alternative.

**A killed worker's spans are lost.** Its unfinished spans never end, and finished ones still in the batch
queue die with the process. So the trace of a recovered job cannot rely on the dead worker having exported
anything. **The recovering worker records the dead attempt.** At each T6.x recovery it emits
`job.attempt.recovered` in the job's trace:
- start = `job_attempts.started_at`;
- end = the lease expiry it observed;
- attributes `attempt`, `worker_id` (the dead one), `fencing_token`, `commit_intent_at` set or not, and the T6
  label;
- `synthesized=true`, so the screenshot never passes off a reconstruction as an observation.

Those times are the database's (D22), so the span is exact. Anything the dead worker did export (its
`job.dequeue`, a `commit.intent` that ended before the kill) also appears. Exporting with a short scheduled
delay (500 ms) makes that likely but not certain, and the plan does not depend on it.

**Spans** (brief table first, then the added ones; attributes from the allowlist only):

| Span | Where | Attributes |
| --- | --- | --- |
| `job.enqueue` | API, `POST …?mode=async` | `job_id`, `tenant`, `capability_id`, `deduplicated` (idempotent re-send) |
| `job.dequeue` | worker, the lease transaction | `job_id`, `tenant`, `capability_id`, `queue_wait_ms` (now − `created_at`, or − `not_before` after a backoff), `attempt` |
| `job.attempt` | worker, around `runJob` | `attempt`, `worker_id`, `fencing_token`, `outcome` |
| `browser.acquire` | worker, `newContext` on the shared browser | `pool_size` (1: one browser per worker, D13), `wait_ms` |
| `capability.step` | replay, per step (new `observe` option below) | `step_index`, `step_id`, `irreversible`, `locator_strategy`, `retries` (screenshot) |
| `commit.intent` | worker, T3 in `onIrreversible.before` | `idempotency_key` (open question 3), `fencing_token`, `result` (`written` / `fenced`) |
| `commit.verify` | worker, one verify phase (T5 or T6.4/T6.5/T6.7) | `result`: `already_done` / `not_found` / `ambiguous`, plus the D43 decision (`resubmitted`, `deferred`, `handed_off`, `unreadable`, `verify_unavailable`, `crash_limit`) and `phase` |
| `verify.lookup` | child of `commit.verify`, each history read | `lookup_index` (1 or 2), `classification` (count / unavailable / transient / unreadable), `count` |
| `job.recover` | worker, each T6.x transition it wins | `transition` (T6.1…T6.7), `crashes`, `lease_crashes`, `result` |
| `job.attempt.recovered` | worker, at T6.x (see above) | as above, `synthesized=true` |
| `job.reconcile` | worker, R1/R2 (D50, D55, D59) | `decision` (`reconciled`, `duplicate_suspected`, `unrecorded_commit_suspected`, `reconcile_unreadable`, `reconcile_deferred`, `abandoned`), `reconcile_crashes` |
| `reconcile.lookup` | child of `job.reconcile` | `classification`, `count` |
| `job.complete` | worker, T4 / T7 | `outcome`, `confidence` (from `readRunConfidence`), `state` |

Span events: `lease.lost` (heartbeat, D36), `illegal_transition` (D41), `screenshot.retry` (D8).

**Replay gets one additive option, not a reuse of `onStep`.** `onStep.after` is awaited and may throw by
design (the fault worker), and a normal worker passes none. Making every worker pass one would put an awaited
hook into every step, a behaviour change in the code under test. Instead:
`observe?: (event: ReplayObservation) => void`.
- Replay calls it synchronously, inside try/catch, and never awaits it.
- It is called with step start/end, `irreversible`, the winning `locator_strategy` (from `WebSurface`'s
  provenance) and screenshot retries.
- An exception from it is swallowed.
- Absent, nothing changes.

`invokeCapability` passes it through, as it did `onStep`. CLAUDE.md "extend replay; never fork it".

## 5. Metrics

Exported by each worker on `ROTE_METRICS_PORT` (compose: 9464) at `/metrics`, and by the API on its existing
port at `/metrics`. Names are as written below; the reviewer decides whether to prefix them `rote_` (open
question 4).

| Metric | Type | Source |
| --- | --- | --- |
| `jobs_completed_total{outcome}` | counter | worker, at T4/T7 |
| `job_duration_seconds` | histogram (p50/p95 by `histogram_quantile`) | worker, from `jobs.created_at` to the terminal write |
| `job_retries_total` | counter | worker, a requeue it performs (T4 retry, T6.1) |
| `recoveries_total{result}` | counter: `already_done`, `resubmitted`, `escalated` | worker, verify decisions (the brief's three, mapped from D43's decisions) |
| `queue_depth{tenant}` | gauge | **API**, one `SELECT tenant_id, count(*) … WHERE state='queued'` per scrape, with a 1 s `statement_timeout`; a timeout leaves the gauge stale and counts `telemetry_errors_total`, and the request path is unaffected |
| `workers_alive` | gauge | Prometheus: `sum(up{job="worker"})`, kept as a recording rule named `workers_alive`. A dead worker cannot report itself, and a per-worker gauge would say 1 until the scrape fails anyway |
| `browser_contexts_in_use` | gauge | worker (0 or 1 each: one context per job) |
| `breaker_state{capability}` | gauge: 0 closed, 1 half-open, 2 open | **API**, from `breakers`. Always 0 until Day 4 builds the breaker (section 1) |
| `duplicates_detected_total` | counter | worker (existing, D50) |
| `illegal_transitions_total` | counter | worker (existing, D41) |
| `reconcile_abandoned_total` | counter | worker (existing, D59) |
| `worker_crashes_total{kind}` | counter | worker that *detects* the death at T6.x / the reconcile claim: `kind` = `before_intent`, `committing`, `verifier`, `reconciler`. Also `jobs_crashes_sum` (gauge, API: `sum(crashes)` over non-terminal jobs) so the dashboard shows the crash budget in use |
| `screenshot_retries_total` | counter | worker, from `WebSurface.screenshotRetries` after each run (D8 promised this) |
| `verify_decisions_total{decision}`, `reconcile_decisions_total{decision}`, `unrecorded_commits_detected_total` | counter | worker (existing) |
| `telemetry_errors_total{kind}` | counter | rule 2: export failures, dropped spans, scrape-query timeouts |

`InMemoryCounters` stays the test double. The OTel implementation forwards the same `inc()` calls, so every
existing call site is unchanged.

**Counters die with a killed worker**, which is normal for Prometheus (`rate()`/`increase()` handle resets).
Events between a worker's last scrape (every 5 s) and its death are not counted. So **the dashboard is for
watching. The evidence numbers still come from the oracle and the database**, never from Prometheus. The
README says so.

## 6. The stack in `docker-compose.yml` (13c), sized for the 8 GB laptop

| Service | Image (exact tag + digest pinned in 13c, 7-day rule) | Memory | Notes |
| --- | --- | --- | --- |
| `jaeger` | `jaegertracing/jaeger:2.x` (v2, OTLP built in) | `mem_limit: 300m` | in-memory storage, `max_traces` 10 000; UI on `127.0.0.1:16686`; OTLP/HTTP 4318 on the compose network only |
| `prometheus` | `prom/prometheus:v3.x` | `mem_limit: 300m` | scrape 5 s; `dns_sd_configs` on `worker` (Compose DNS returns every replica), plus `api:8080`; retention `2d` / `200MB`; the `workers_alive` recording rule; UI on `127.0.0.1:9090` |
| `grafana` | `grafana/grafana:12.x` | `mem_limit: 200m` | datasource and dashboard provisioned from `observability/grafana/` (committed); anonymous Viewer, loopback only, no plugins; `127.0.0.1:3000` |

The budget:
- **Limits:** today's 4 × 700m + 800m for the three adds ≈ 3.6 GiB of limits on a 3.8 GiB VM.
- **Expected use:** about 260 MiB × 4 + Postgres, bank and API (about 300 MiB) + about 450 MiB for the stack ≈
  1.8 GiB.
- **Measured, not assumed:** 13c records `docker stats` peaks during its chaos run, like the Day-1 exit's
  `peakMiB`. Pass criterion: no `OOMKilled`, and a total peak under 3.2 GiB.
- **If it doesn't fit:** a Compose profile `observability`. The brief says `docker compose up` starts all
  of it, so a profile would be a reviewed deviation, used only if the measurement fails.

All three stay up only while needed ("stop the fleet when not in use"). `docker compose up -d postgres` for
the tests is unchanged. The worker and API get `OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318`,
`OTEL_SERVICE_NAME` (`rote-worker`/`rote-api`) and `ROTE_METRICS_PORT=9464`. The worker id becomes the
`service.instance.id` resource attribute.

**The dashboard** (`observability/grafana/dashboards/fleet.json`), with the brief's panels:
- jobs per minute (`rate(jobs_completed_total[1m])*60` by outcome);
- p95 (and p50) job duration;
- queue depth per bank;
- workers alive;
- recoveries by result;
- breaker state.

Added panels:
- duplicates detected (should be a flat 0);
- illegal transitions (flat 0);
- reconcile abandoned;
- worker crashes by kind;
- screenshot retries;
- telemetry errors.

## 7. Tests: telemetry never changes behaviour

| Test | What it proves |
| --- | --- |
| `src/telemetry/telemetry.test.ts` | the no-op and OTel implementations satisfy one contract; with an exporter that **throws**, one that **hangs** forever, and one that rejects after 10 s, every `Telemetry` call returns synchronously (under 5 ms) and never throws; the batch queue drops at its bound; `telemetry_errors_total` counts it |
| `src/telemetry/redaction.test.ts` | every span from a full transfer run (InMemorySpanExporter) carries only allowlisted attribute keys, and no attribute value contains a fake credential, a param value or a memo |
| `src/worker/telemetry.db.test.ts` (**the equivalence test**) | the same scripted scenarios run under **four telemetry modes**: off; on to an in-memory exporter; on to a **closed port**; on to a **black hole** (a TCP server that accepts and never answers). The scenarios: success, business outcome, crash before Submit, crash after Submit (two worker processes, like `crashSubmit.db.test.ts`), a lost lease, a deferred verify. They must give identical job end states, `outcome`/`error`, attempt and verification rows (timestamps aside) and ledger counts, within a wall-time bound of the off run |
| `src/worker/trace.db.test.ts` | crash after Submit across two worker processes: every exported span carries the job's `trace_id`, parented under `root_span_id`; the dead attempt appears as `job.attempt.recovered` (`synthesized=true`); the second worker's `commit.verify` says `already_done` |
| `src/worker/metricsPort.db.test.ts` | the metrics port already taken → the worker logs one warning and completes jobs; `/metrics` parses as the Prometheus text format and has every metric in section 5 |
| replay `observe` tests (`src/replay/fleet.test.ts`) | absent = today's behaviour (the existing suite); a throwing `observe` changes nothing in the `ReplayResult` or the evidence; strategy and `irreversible` are reported per step |
| **mutation check** (D54), new mutants | (13) the OTel wrapper rethrows an exporter error; (14) the worker `await`s `forceFlush` after `commit.intent`; (15) span attributes copy `params`. Each must turn the tests above red (target 15/15) |
| **crash matrix** | a new flag `--telemetry dead` points every worker at a closed port. **23/23** at 5/2 with it, plus the usual run. Added to CI's crash-matrix job as a second invocation |
| **chaos** (13c) | one standard seed with the stack up, and the **same seed with Jaeger and Prometheus stopped** (`docker compose stop jaeger prometheus` before the run, plus a mid-run stop in a third run). Every run: oracle PASS, 0 DUPLICATE, 0 LOST. Chaos interleaving isn't deterministic (D33), so the runs are compared by verdict and by the final-state distribution, not row for row |

## 8. The two proof screenshots (13c), script-made and committed

`scripts/observability-screenshots.ts` drives headless Chromium (the repo's Playwright) against the
loopback UIs. Screenshots are evidence, and nothing hand-cropped is committed:
1. **The recovered job's trace across two workers.** After a chaos run, the script picks a job from
   `jobs.json`/`attempts.json` with attempt 1 `crashed` after `commit_intent_at`, a verify by a different
   `worker_id`, and the result `already_done` (verified from the ledger: exactly 1 row). If chaos produced
   none, it falls back to the crash matrix's `after-submit` scenario with telemetry on. It opens
   `http://127.0.0.1:16686/trace/<trace_id>`, expands the spans and saves `trace-recovered-job.png` plus that
   trace's JSON (Jaeger API) and the job's rows.
2. **The dashboard during a chaos run**, saved as `dashboard-during-chaos.png`, about 90 s into the kill
   schedule, with Grafana's time range covering the run. Saved with the run's seed and the oracle's
   `check.txt`.

Redaction: section 7's allowlist test guarantees no credentials or params in span attributes. The script also
checks each page's text for the fake credentials before saving, and refuses to save if one appears.

## 9. Split into reviewable steps

| Step | Contents | Exit |
| --- | --- | --- |
| **13a: telemetry core** | the deps (section 3); `src/telemetry/` (interface, no-op, OTel impl, config, allowlist); metrics (section 5) exported from workers and API; `InMemoryCounters` forwarded; `screenshot_retries_total`; the replay `observe` option; the tests in section 7 rows 1, 2, 5 and 6; mutants 13 and 15; D-entries | `npm test` ×3, typecheck, mutation-check, the matrix 23/23 (telemetry off, the default); `npm audit` 0 |
| **13b: traces** | migration 0009 (if approved); every span in section 4; `job.attempt.recovered`; the equivalence test and the trace test (section 7 rows 3 and 4); mutant 14; the matrix `--telemetry dead` flag in CI | the matrix 23/23 twice (off, dead); equivalence green ×3 |
| **13c: the stack** | Jaeger, Prometheus, Grafana in Compose (section 6); provisioning and dashboard JSON; the API's DB gauges; the memory measurement; the chaos runs with the stack up and down; the two screenshots; README "Fleet (Day 3)" and the evidence index | Day-3 exit: both screenshots committed, the chaos verdicts PASS, peak memory recorded |

Each sub-step ends with the usual handoff report and saves its plan as `docs/plans/step-13a.md` etc. before
building.

## 10. Open questions for the reviewer

1. **Migration 0009 (`jobs.root_span_id`)** for a clean trace root, or the synthetic parent with Jaeger's
   "missing parent" warning?
2. **The API's DB gauges** (`queue_depth`, `breaker_state`, `jobs_crashes_sum`): from the API (one target, one
   small query per scrape with a timeout), or a separate exporter? The plan says the API.
3. **`commit.intent.idempotency_key`:** raw (as the brief says) or a SHA-256 prefix?
4. **Metric prefix:** the brief's names as-is, or `rote_` for every one?
5. **If the memory measurement fails:** a Compose profile for the observability stack, or fewer workers during
   the screenshot run?
6. `fast-check`, Express 5.3.0 and Playwright 1.65 are held from Step 12. **Should Playwright 1.65 land before
   13c**, so the screenshots are taken on the browser build that ships?
