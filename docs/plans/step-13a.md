# Step 13a — the telemetry core (plan, written before building)

Reads `docs/plans/step-13.md` (approved, with "Reviewer decisions (2026-11-19)"), D61, D62 and the reviewer's
13a instruction (2026-11-19). Branch `feat/day3-13a` from `main` at `e2f16fd` (PR #3 merged).

## 0. First commit: the route lookup fails closed (done, `535284f`)

The reviewer's condition on `mountRouter` (D62 amendment): if Express's internals are not where `routeOf`
expects them, it logs `/(unknown route)` and nothing else. Three tests simulate missing internals. 744/744.

## 1. Scope: section 9's 13a row, plus three items the instruction pulls forward

| Item | step-13.md section 9 says | 13a builds it because |
| --- | --- | --- |
| the deps, `src/telemetry/`, the metrics from both lists, `InMemoryCounters` forwarded, `screenshot_retries_total`, replay `observe`, tests rows 1, 2, 5, 6, mutants 14 and 16 | 13a | — |
| **the API's DB gauges** on their own pool with a short `statement_timeout` (reviewer decision 2, with its test) | 13c | the instruction lists them for 13a |
| **the four-mode equivalence test** (section 7 row 3) | 13b | the instruction lists it for 13a |
| **the crash matrix `--telemetry dead` flag** | 13b | the proof is "the matrix at 5/2 with telemetry on and pointed at a dead collector" |

Still 13b: migration 0009, every span of section 4 except `capability.step`, `job.attempt.recovered`, the trace
test (row 4), mutant 15, and the matrix's second invocation in CI. Still 13c: the Jaeger/Prometheus/Grafana
containers, the dashboard, the screenshots and the memory measurement.

**One span in 13a: `capability.step`.** Section 9's 13a includes the redaction test ("every span from a full
transfer run carries only allowlisted attribute keys") and mutant 16 ("span attributes copy params"). Both need
spans from a run, and the replay `observe` option exists to feed this one. Without 0009 its parent is the
synthetic remote parent built from `jobs.trace_id`. That is the fallback the reviewer approved for rows enqueued
before 0009 (decision 1). It also gives the equivalence test's closed-port and black-hole modes real spans to
fail to export.

## 2. Dependencies (D61: named packages, `--before=2026-11-12`, the cutoff 2026-11-12T00:00Z)

step-13.md section 3 names the packages but resolves no versions, so 13a resolves them. Two things changed
since that list was written:
- **`@opentelemetry/sdk-trace-base` is replaced by `@opentelemetry/sdk-trace`** in the 3.x SDK line.
  `sdk-trace-base` stops at 2.12.x, which requires `@opentelemetry/api <1.10.0`. Every other 3.x package requires
  `>=1.10.0`. So the named package is `@opentelemetry/sdk-trace@3.1.1`.
- **`npm view <pkg> version --before=…` ignores `--before`:** it printed 0.301.2 for both exporters, published
  2026-11-12 17:10. The versions below were checked against each package's `time` field. `npm install … --before`
  resolved them, and `evidence/step-13a/deps-lockdiff.txt` lists every path with its publish time.

| Package | Version | Published |
| --- | --- | --- |
| `@opentelemetry/api` | 1.10.0 | 2026-10-20 |
| `@opentelemetry/sdk-trace` | 3.1.1 | 2026-11-09 |
| `@opentelemetry/exporter-trace-otlp-http` | 0.301.1 | 2026-11-09 |
| `@opentelemetry/sdk-metrics` | 3.1.1 | 2026-11-09 |
| `@opentelemetry/exporter-prometheus` | 0.301.1 | 2026-11-09 |
| `@opentelemetry/resources` | 3.1.1 | 2026-11-09 |
| `@opentelemetry/semantic-conventions` | 1.45.0 | 2026-11-06 |

Transitive: `core`, `otlp-exporter-base`, `otlp-transformer`, `sdk-logs` (all 3.1.1 / 0.301.1). 11 paths, all new,
0 vulnerabilities. **`@opentelemetry/sdk-node` 0.301.1, checked and ruled out:** it depends on the gRPC and proto
exporters for all three signals, `instrumentation`, `configuration`, `propagator-b3` and `exporter-zipkin`.
**Encoding:** `exporter-trace-otlp-http` sends OTLP/HTTP with a JSON body. step-13.md said "HTTP/protobuf" but
named this package. Jaeger v2 accepts both on 4318, and the proto exporter would add `protobufjs`.

## 3. Design

**`src/telemetry/`**, the only place that imports `@opentelemetry/*` (rule 1):
- `names.ts`: every metric name (`rote_` prefix), its labels and HELP text, the brief's name for each (the
  README's table is generated from it), the span names and **the attribute allowlist per span**.
- `types.ts`: the `Telemetry` interface and `NO_TELEMETRY`. Calls are `count`, `observe`, `adjust`,
  `startSpan` → `{ setAttributes, addEvent, end }`, `metricsHandler`, `flush(capMs)` and `shutdown(capMs)`.
  Every one is synchronous except flush/shutdown, which resolve within `capMs` and never reject.
- `otel.ts`, `createOtelTelemetry(config)`, has these parts:
  - **Tracing:** a `TracerProvider` (no global registration, no context manager) with explicit contexts.
    Spans go to a `BatchSpanProcessor` (queue 2048, batch 512, delay 500 ms, export timeout 2 s), then the OTLP
    exporter (timeout 2 s).
  - **A guard processor in front of the batch processor:** it counts spans in flight and drops at the bound,
    counting the drop. The batch processor would drop silently.
  - **An exporter wrapper:** it turns a synchronous throw into a failed result, and counts failures.
  - **Metrics:** a `MeterProvider` with the Prometheus exporter (`preventServerStart`). The handler is mounted by
    `metricsServer.ts` (worker) or the API's Express app.
  - **Errors:** every public method body is in try/catch. An error is swallowed, counted in
    `rote_telemetry_errors_total{kind}`, and logged as one rate-limited `telemetry: degraded` warning (60 s). The
    log has the error's class and code only, never its message.
- `config.ts`: `telemetryConfigFromEnv`. Telemetry is off unless configured (rule 9):
  - `OTEL_EXPORTER_OTLP_ENDPOINT` (+ `/v1/traces`) turns on traces;
  - `ROTE_METRICS_PORT` turns on the worker's listener, with `ROTE_METRICS_HOST` defaulting to 127.0.0.1;
  - `OTEL_SERVICE_NAME` sets the service name, and the worker id is `service.instance.id`.
- `metricsServer.ts`: binds the port. A failure (EADDRINUSE…) logs one warning and the worker runs on without
  `/metrics` (rule 5).
- `workerMetrics.ts`: `forwardingMetrics(InMemoryCounters, telemetry)`. Every existing `inc()` call site is
  unchanged. `InMemoryCounters` stays the test double and the source of the totals in log lines.
- `apiGauges.ts`: `rote_queue_depth{tenant}`, `rote_breaker_state{capability}` (0/1/2; 0 until Day 4) and
  `rote_jobs_crashes_sum`.
  - They are read on every scrape through **a dedicated pool** (`max: 1`, `statement_timeout` 1000 ms, connect
    timeout 1000 ms), with a 1500 ms cap in JS.
  - A failed or slow query leaves that gauge at its last value and counts `gauge_query`.
  - The API's request pool is never touched.

**The metrics** (section 5, renamed with `rote_`, reviewer decision 4):

| Where it is counted | Metrics |
| --- | --- |
| Worker: T4 / T7, and T6.2 / T6.6, which are terminal writes too | `jobs_completed_total{outcome}`, `job_duration_seconds` (`created_at` → the write) |
| Worker: T4's requeue and T6.1 | `job_retries_total` |
| Worker: the verify decision | `recoveries_total{result}`: `already_done`, `resubmitted` and `escalated`, with T6.6 counted as `escalated` |
| Worker: the recoverer, from the dead state | `worker_crashes_total{kind}`: `before_intent`, `committing`, `verifier`, `reconciler` |
| Worker: around each replay run (job or lookup) | `browser_contexts_in_use` |
| Worker: replay's per-run total | `screenshot_retries_total` |
| Worker: the existing counters, forwarded | `illegal_transitions_total`, `verify_decisions_total`, `reconcile_decisions_total`, `duplicates_detected_total`, `unrecorded_commits_detected_total`, `reconcile_abandoned_total` |
| Worker and API | `telemetry_errors_total{kind}` |
| API, per scrape | the three DB gauges |

`workers_alive` stays a Prometheus recording rule (13c).

**Replay's `observe`** (additive, step-13.md section 4):
- `observe?: (event: ReplayObservation) => void`, with three events:
  - `step_start`: index, id, irreversible;
  - `step_end`: the same, plus the winning locator strategy, that step's screenshot retries and how it ended;
  - `run_end`: the run's total screenshot retries.
- It is called synchronously inside try/catch. A returned promise's rejection is swallowed too. It is never
  awaited. Absent, no code path changes.
- `invokeCapability` passes it through.

**The worker:**
- `main.ts` builds the telemetry from env.
- `Worker`, `runJob`, the verify and reconcile contexts and the recovery sweep take an optional `telemetry`
  (default `NO_TELEMETRY`).
- `observe` is passed only when telemetry is on.
- At shutdown there is one `shutdown(cap)` with cap = min(2 s, what is left of `ROTE_SHUTDOWN_GRACE_MS`) (rule 6).
- **Small additive data changes:**
  - `CLAIM_EXPIRED_SQL` also selects `created_at`, so a T7 or T6.x terminal write can observe the duration.
  - `ReconcileClaim` and `ReconcileAbandoned` say whether a dead reconciler was found (`deadReconciler`).
  - `CreatePoolOptions.statementTimeoutMillis`.

**The API:** `catalog serve --queue --metrics` mounts `GET /metrics` with the gauges. Compose passes it. Without
the flag, `createCatalogApp` is unchanged.

**Compose (13a):**
- **Workers:** `ROTE_METRICS_PORT=9464`, `ROTE_METRICS_HOST=0.0.0.0`,
  `OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318`, `OTEL_SERVICE_NAME=rote-worker`.
- **The API:** `--metrics`, `OTEL_SERVICE_NAME=rote-api`.
- Until 13c adds Jaeger, the endpoint does not resolve. That is "telemetry on, collector absent", the state the
  chaos run proves.

## 4. Tests

| File | What it proves |
| --- | --- |
| `src/telemetry/telemetry.test.ts` | no-op and OTel satisfy one contract. With an exporter that throws, one that hangs, and one that rejects after 10 s, every call returns in under 5 ms and never throws; `flush`/`shutdown` resolve within their cap and never reject. The guard drops at its bound and counts it; export failures are counted; the degraded warning is rate-limited and carries no message |
| `src/telemetry/redaction.test.ts` | a full transfer run's spans (in-memory) carry only allowlisted keys and no credential, param value or memo. Offered attributes outside the allowlist (params included) are dropped; values must be plain identifiers or numbers |
| `src/telemetry/metricsPort.db.test.ts` (section 7 row 5) | the port already taken → one warning, jobs complete; `/metrics` parses as Prometheus text and has every worker metric. `rote_telemetry_errors_total` appears too |
| `src/catalog/apiMetrics.db.test.ts` (reviewer decision 2) | `/metrics` has the three gauges with the right values. With `breakers` locked by an open transaction, a scrape takes about the statement timeout and keeps the stale value (`gauge_query` counted), while `/healthz`, `GET /jobs/:id` and an async enqueue each answer within their baseline |
| `src/replay/fleet.test.ts` (observe) | the events for a full transfer: start/end per step, `irreversible` on Submit, the strategies. A throwing `observe` and a rejecting async one change nothing in the `ReplayResult` or the evidence's kinds |
| `src/worker/telemetry.db.test.ts` (**equivalence**, in process) | success, business outcome, a lost lease and a deferred verify, each under **off / in-memory / closed port / black hole**. Equal job end states, outcome/error, attempt and verification rows (timestamps aside) and ledger counts; each mode's wall time within 1.5 × off + 3 s; in-memory mode exported the steps' spans |
| `src/worker/crashSubmit.db.test.ts` (**equivalence**, worker processes) | crash before and after Submit, each under the four modes at once. Each mode is a worker child process with the mode's env. The child's "in-memory" mode is an OTLP receiver in the test that answers 200 and keeps the requests, since an in-memory exporter cannot cross a process boundary. Every mode keeps the existing assertions, and the modes match each other |

**The crash matrix:** `--telemetry dead` points every worker at a closed port (OTLP) and turns on the metrics
port. The proof run is 23/23 at 5/2 with it.

**Mutants** (D54, renumbered after 12b's 13):
- 14: the OTel wrapper's flush rethrows an exporter error. A worker would exit 1 over telemetry at shutdown.
  Caught by `telemetry.test.ts`.
- 16: the span attribute allowlist is skipped, so params pass through. Caught by `redaction.test.ts`.
- The target is all 15 caught: 01–14 and 16. Mutant 15 (`await forceFlush` after `commit.intent`) is 13b's, once
  `commit.intent` exists.

## 5. Proof (`evidence/step-13a/`)

- `npm test` ×3 (logs) and the typecheck.
- The crash matrix: `--lease-seconds 5 --heartbeat-seconds 2 --telemetry dead`, 23/23.
- The mutation check: 15/15.
- One standard chaos run on the rebuilt image, with Compose's telemetry on. That means the OTLP endpoint
  unresolvable and `/metrics` on each worker; a `/metrics` scrape of one worker and the API is saved during the
  run.
- The image size before (3,579,680,917 bytes, `rote-fleet:before-13a` built from `535284f`) and after.
- `npm audit` and `npm ls @opentelemetry/*` inside the image.

## 6. Commits

1. fix(http): fail closed (`535284f`).
2. docs: this plan.
3. deps: the 7 packages (lockdiff, `npm test`).
4. feat(telemetry): `src/telemetry/` + its unit/redaction tests + mutants 14 and 16.
5. feat(replay): `observe` + tests.
6. feat(worker): wiring + metrics port test + equivalence tests.
7. feat(api): `/metrics` and the gauge pool + test.
8. feat(chaos): the matrix flag, Compose env, README/REPO_NOTES/D-entries.
9. evidence.

Each commit is preceded by a full `npm test`.
