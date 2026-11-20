# Step 13a evidence: the telemetry core

Branch `feat/day3-13a`. The plan: `docs/plans/step-13a.md`. The decisions: D63–D66, plus amendments to D61 and D62.
Everything here was written by the scripts named, on this laptop (Windows, Docker Desktop, 8 GB), on 2026-11-19
(UTC: 2026-11-19 / 20).

| Proof | Files | Result |
| --- | --- | --- |
| The route lookup fails closed (first commit, `535284f`) | `npm-test-commit1-failclosed.txt` | 67 files, **744 passed** |
| The dependency group (D61, `--before=2026-11-12`) | `deps-lockdiff.txt`, `npm-test-commit3-deps.txt` | 11 package paths, all new, each published before the cutoff; 67 files, **744 passed**; `npm audit`: 0 |
| The telemetry core's commit (`c227054`) | `npm-test-commit4-run1-FAILED.txt`, `npm-test-commit4-run2-FAILED.txt`, `npm-test-commit4-run3.txt`, **`flakes.md`** | Run 1 failed: a timing bound under load, and two teardowns timed out from my test's load. Run 2 failed: my test's 5 s timeout. Each is fixed at its cause (`flakes.md`). Run 3: 72 files, **780 passed** |
| **`npm test` ×3 on the final code** (`7444087`), back to back | `npm-test-final-1.txt`, `-2`, `-3` | **72 files, 780 passed, 0 failed, 0 skipped**, each run; 348 s, 328 s, 311 s; no flake |
| **Crash matrix, 5 s / 2 s, telemetry ON and pointed at a dead collector** (`--telemetry dead`) | `crash-matrix-telemetry-dead/` (`matrix.md`, `check.txt`, every worker's log), `crash-matrix-telemetry-dead-stdout.txt` | **23/23, RESULT: PASS**, 1 ledger row in every scenario, the same outcomes as Step 12's matrix. 52 of the 53 worker logs say `telemetry: serving /metrics`; the other worker was killed before that line. 12 say `telemetry: degraded` (`span_export`, `ECONNREFUSED`, class and code only) |
| **Mutation check** | `mutation-check/` (`report.md`, `check.txt`, one JSON per mutant), `mutation-check-stdout.txt` | **15/15 caught** (01–14 and 16); the tree is exactly as before afterwards. 14 (the flush rethrows an exporter error): 3 tests red. 16 (the span allowlist skipped): 2 tests red |
| **Chaos, one standard seed, on the rebuilt image, with Compose's telemetry on** | `chaos-seed-412432443/` (`check.txt`, `summary.json`, `compose-logs.txt`…), `chaos-stdout.txt` | **RESULT: PASS**, stamped `7444087` (clean): 100/100 succeeded (98 `success`, 2 `already_done`), 15 kills + the 45 s pause, 12 crashed attempts recovered, **0 DUPLICATE, 0 LOST**; worker peaks 219–295 MiB |
| A `/metrics` scrape of the composed fleet (a short separate run: 12 jobs through the API) | `fleet-metrics-scrape/` | 12/12 succeeded. The API's gauges read the queue (3/2/3) while queued, and 0 at the end, with 0 `gauge_query` errors. Worker 1 counted its 3 jobs (`rote_jobs_completed_total{outcome="success"} 3`) while its 5 span exports failed, uncounted elsewhere |
| The image before and after | `docker/image-size.txt` | 3,579,680,917 → 3,602,097,655 bytes: **+22.4 MB (+0.63 %)**. `node_modules/@opentelemetry` is 20 MB. `npm ls` inside the image |

## What the chaos run shows about telemetry

**Telemetry was on all through the run.** Compose sets `ROTE_METRICS_PORT=9464` and
`OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318`, and the API runs with `--metrics`. There is no `jaeger` service
until 13c. `compose-logs.txt` shows what that means:
- every worker start (19, the 15 restarts included) logged `telemetry: serving /metrics` on 0.0.0.0:9464, and the
  API logged its gauges;
- 14 `telemetry: degraded` warnings were logged, all `span_export` / **`TelemetryTimeoutError`**. Inside Compose the
  unresolvable name **hangs** until the exporter wrapper's 2 s timeout; it is not refused at once. That is the
  black-hole case of the equivalence test, in the production configuration. The warning is rate-limited to one per
  worker per minute.

**The verdicts match Step 12's run of the same seed** (`evidence/step-12/chaos-seed-412432443/`, no telemetry):
both PASS with 0 DUPLICATE and 0 LOST, and every job succeeded. The counts differ: Step 12 had 8 crashed attempts
and 1 `already_done`, Step 13a 12 and 2. Chaos is seeded on its schedule, not on the interleaving (D33), so runs
are compared by verdict and by the final-state distribution, not row by row (step-13.md section 7). Worker peak
memory is about the same: 216–303 MiB in Step 12, 219–295 MiB here.

## Reproduce

```
docker compose up -d postgres
npm test                                                   # x3: scripts/npm-test-log.ps1 -Log <file>
npm run crash-matrix -- --lease-seconds 5 --heartbeat-seconds 2 --expect step-10 --reconcile-margin-seconds 5 --drain-timeout 90s --telemetry dead --out <dir>
npm run mutation-check -- --out <dir>
npm run chaos -- --seed 412432443 --out <dir>              # builds the image; stops the fleet at the end
```
