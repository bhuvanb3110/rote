# Step 6 plan — the worker and the async API (proposed, not built)

Branch `fleet/day-1`. Reads `docs/plans/step-05.md` (built; see its "Reviewer decisions" and
"Built" sections). Status: **for review**; nothing here is built.

Scope: a worker process that dequeues and runs jobs, the async `invoke` mode with `Idempotency-Key`,
`GET /jobs/:id`, the Docker image and Compose services for the mock bank, the API and N workers,
graceful shutdown, Postgres blips, and the **Day-1 exit: 100 jobs across 4 workers, all succeeded,
ledger-checked by a script**. Leases are taken (Step 5) but **not** heartbeated, and nothing recovers
a dead worker's job: that is Day 2. §7 lists exactly which seams Step 6 leaves for it.

Rules carried forward: extend replay, never fork it (workers call `invokeCapability`, D13); workers run
only capabilities approved for their current version and never pass `approveUnattended` (D7, D15);
credentials never in `jobs.params` (D23); every lease comparison on the database clock (D22).

## 1. The worker process (`src/worker/`)

```
src/worker/
  main.ts          entry point: env config, migrate, launch Chromium, run the loop, signal handlers
  loop.ts          poll loop: dequeue -> runJob -> complete; backoff with jitter; stop()
  runJob.ts        build params, invokeCapability, map the outcome (section 2)
  complete.ts      the fenced completion transaction
  credentials.ts   per-tenant credentials from env
  backoff.ts       exponential backoff with full jitter (injectable RNG for tests)
  bankForward.ts   127.0.0.1:4100 -> bank:4100 TCP forwarder (Docker only; section 4, open question 1)
```

**One Chromium per worker.** `chromium.launch({ headless: true, args: ["--disable-dev-shm-usage"] })`
once at start. Each job gets its own context through `invokeCapability({ browser })` (D13), so jobs
share no cookies. If the browser disconnects (Chromium crash), the in-flight job is handled as a thrown
run (section 2, row "invokeCapability throws"), the worker relaunches Chromium, and the loop goes on.

**Poll loop.**
```
while (!stopping):
  beforeDequeue()                      # Day-2 seam: expired-lease recovery runs HERE (note 8)
  job = dequeue(pool, { workerId, leaseSeconds })
  if job is null: sleep(backoff.next()); continue      # 100 ms base, x2, cap 2 s, full jitter
  backoff.reset()
  outcome = runJob(job)                # section 2
  complete(job, outcome)               # section 3
```
- `workerId` = `${hostname}-${pid}-${random4}` (container hostname is the container id, so
  `job_attempts.worker_id` names the container).
- `leaseSeconds` = `ROTE_LEASE_SECONDS`, default **300** in Step 6: there is no heartbeat yet, and a
  lease shorter than a slow job would mean nothing anyway, because nothing recovers expired leases
  until Day 2. Day 2 sets 30 s with a 10 s heartbeat (the brief).
- Full jitter (`sleep = random(0, min(cap, base * 2^n))`) so idle workers don't poll in lockstep.

**Running a job (`runJob`).**
1. `findCapability(job.capability_id)`; missing → outcome `failed` (permanent).
2. Params = `job.params` + **credentials for `job.tenant_id`** for every input the capability marks
   `redact: true` + `memo = job.memo_key` if the capability has an irreversible step
   (`workerSuppliedInputs`, `src/queue/enqueue.ts`, D23). The memo is the 41-character key the
   history lookup will search for on Day 2 (D5).
3. `invokeCapability({ id, tenant: job.tenant_id, params, browser, signal, evidenceBaseDir,
   approveRisky: true, onIrreversible })`, with `approveUnattended` never set.
   - `approveRisky: true` is what lets the transfer click Submit unattended. The worker's authority
     for it is the capability's approval for its current version, which `runReplay` re-checks (D15)
     and refuses with `needs_human` otherwise. Open question 2.
   - `evidenceBaseDir` = `ROTE_EVIDENCE_DIR` (a container volume), never the repo's `evidence/`
     (REPO_NOTES Q2).
   - `signal`: one `AbortController` per job; in Step 6 only shutdown aborts it (section 6).
   - `onIrreversible.before`: sets an in-memory `irreversibleStarted` flag (section 7, seam 1).
4. Map the result to a job outcome (section 2).

**Credentials per tenant** (`credentials.ts`): env `ROTE_CRED_<TENANT>_<INPUT>`, with the tenant id
upper-cased and `-` → `_`: `ROTE_CRED_TENANT_A_USERNAME`, `ROTE_CRED_TENANT_A_PASSWORD`. At startup the
worker checks that every row in `tenants` has a value for every redact input of every committed
capability, and refuses to start otherwise (fail fast, naming the missing variable, never a value).
Compose passes them from `.env` (fake values; `.env.example` documents the names). Values are
registered with the run's error redactor: any error text stored in `jobs.error` or logged passes
through a replace-all of every credential value → `[REDACTED]`, on top of replay's own redaction.

## 2. ReplayResult (+ `commitUncertain`) → job state, for Step 6

| Run ended with | Job state | `outcome` | Retried? | Why |
| --- | --- | --- | --- | --- |
| `success` | `succeeded` | `success` | — | |
| `business_outcome`, no `commitUncertain` | `business_outcome` | `business_outcome` | **never** | A bank refusal is final (step-04 reviewer decision 3, D21). |
| `business_outcome` **with** `commitUncertain` | **`needs_human`** (temporary) | `commit_uncertain` | **never** | Day-2 rule: verify via history (1 match → `succeeded`, 0 → `business_outcome`). Until verify exists nobody can decide, and a retry might send the money twice. |
| `failure` **with** `commitUncertain` | **`needs_human`** (temporary) | `commit_uncertain` | **never** | Same: the Submit may have committed (D6: write-then-error). |
| `needs_human` (any; incl. the approval gate's refusal) | `needs_human` | `needs_human` | never | The fleet does not pause for a human (no controller); it parks the job. A refusal for a stale approval lands here too. |
| `failure`, no `commitUncertain`, `attempt < max_attempts` | `queued` (lease cleared) | — | yes | Nothing irreversible was attempted: a blind retry is safe (D10). |
| `failure`, no `commitUncertain`, attempts exhausted | `failed` | `failure` | — | `queued` would violate `jobs_queued_has_attempts_left` (D21). |
| `invokeCapability` throws before replay (unknown capability, invalid params, entryUrl mismatch, missing credentials) | `failed` | `invalid_job` | never | Deterministic: retrying can't help. |
| replay throws/rejects for another reason (browser crash) with `irreversibleStarted = false` | as `failure` without marker (retry if attempts left) | | | |
| … with `irreversibleStarted = true` | `needs_human` | `commit_uncertain` | never | The in-memory flag says Submit may have been clicked. |
| aborted by shutdown (section 6) | same two rows as the line above | `aborted` | | |

**Why `commitUncertain` goes to `needs_human` until Day 2**, rather than the alternatives:
- *Retry* (`queued`): the one thing that can duplicate a transfer. Ruled out.
- *Leave it `running`* for Day-2 recovery: there is no Day-2 recovery yet, so the job would look
  in-progress forever, hold its tenant slot (note 8: two such jobs block a cap-2 tenant entirely),
  and the Day-1 exit could not tell it from a hung worker.
- *`failed`*: says "it didn't happen", which may be false; a client would resubmit.
- *`business_outcome`*: says "the bank refused", which may be false (the write-then-error case).
- `needs_human` is terminal, frees the slot, and says exactly what is true: a person (or Day-2
  verify) must check the bank's history. The job keeps `result.commitUncertain` and `memo_key`, so
  Day 2 can sweep `outcome = 'commit_uncertain'` jobs into `verifying` mechanically.

The mapping is one pure function, `jobOutcomeFor(result | thrown, { attempt, maxAttempts,
irreversibleStarted })`, tested row by row.

## 3. Recording the final state (fenced)

One transaction:
```sql
UPDATE jobs
SET state = $state, outcome = $outcome, error = $error, result = $result,
    lease_owner = NULL, lease_expires_at = NULL, updated_at = now()
WHERE id = $id AND fencing_token = $token AND lease_owner = $worker AND state = 'running'
RETURNING id;
-- 0 rows -> this worker no longer holds the job: record NOTHING on jobs (log it), mark the attempt lease_lost
UPDATE job_attempts SET ended_at = now(), outcome = $attemptOutcome, commit_uncertain = $cu, error = $error
WHERE job_id = $id AND fencing_token = $token;
```
`result` is the `ReplayResult` as returned (already redacted by replay). Requeue (the retry row in
section 2) is the same statement with `state = 'queued'`; the `CHECK` guarantees it is only possible
while attempts are left. The `WHERE` on `(fencing_token, lease_owner, state)` is the Step-5 fencing
token doing its job: a completion from a worker that lost the job can never overwrite the new owner's
state. In Step 6 nothing takes a job away, so this only fires in a test; Day 2 relies on it.

If the completion fails because Postgres is unreachable, the outcome is kept in memory and the write
retried with backoff (section 6). The job is **never** re-run locally to "recover".

## 4. The async API

`POST /capabilities/:id/invoke?mode=async`, header `Idempotency-Key: <1..255 chars>`, body
`{ "tenant": "tenant-a", "params": { …business params only… } }`. Added to the existing
`createCatalogApp`, which gains an optional `{ queue: { pool } }`; without it (every existing caller
and test) the app is exactly today's. No `mode`, or `mode=sync`: **unchanged synchronous path**.

| Case | Status | Body |
| --- | --- | --- |
| New job | **201** | `{ jobId, state: "queued", tenant, capabilityId, memoKey, links: { self: "/jobs/<id>" } }`, `Location: /jobs/<id>` |
| Same tenant + key + same request | **200** | the existing job (current state) |
| Same tenant + key, different request | **409** | `{ error, jobId }` (`IdempotencyKeyConflict`) |
| Credentials in params | **400** | `{ error }` (`CredentialsInParamsError`; names the fields, never values) |
| Memo of an irreversible capability, unknown/missing/mistyped param | **400** | `ReservedParamError` / `InvalidParamsError` |
| Missing/oversized `Idempotency-Key`, missing `tenant`, `approveRisky`/`approveUnattended` in an async body | **400** | async jobs never take run-time approvals from the client |
| Unknown capability | **404** | |
| Unknown tenant | **404** | (FK violation mapped) |
| Capability not approved for its current version | **422** | fail fast instead of a job that will end `needs_human`; re-checked at run time anyway (open question 4) |
| Postgres unreachable | **503** | `Retry-After: 2` |

`GET /jobs/:id?tenant=<tenant>` → `{ id, tenant, capabilityId, state, attempt, maxAttempts, outcome,
error, result, memoKey, traceId, createdAt, updatedAt }`. **Never credentials**: they are never stored
(D23), `result` is replay's redacted result, `error` passed the credential redactor (section 1). A test
greps the JSON of every job state for the configured credential values. A job of another tenant is
`404`, same as a missing one (open question 5: there is no auth in this project, so the tenant comes
from the request; the point is that one tenant can't probe another's job ids).

## 5. Docker

**One image** (`Dockerfile`, multi-stage) for the worker, the API and the mock bank:
```dockerfile
ARG PLAYWRIGHT_VERSION=1.62.1
FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY mock-app ./mock-app
COPY scripts ./scripts
COPY examples ./examples
RUN npm run build

FROM mcr.microsoft.com/playwright:v${PLAYWRIGHT_VERSION}-noble
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY artifacts ./artifacts
COPY overrides ./overrides
COPY status ./status
COPY db ./db
USER pwuser
CMD ["node", "dist/src/worker/main.js"]
```
- **Pinned to the repo's Playwright** (1.62.1; the tag `v1.62.1-noble` exists, checked with `docker
  manifest inspect` on 2026-11-09). The browsers in the image match the npm package only if the
  versions are equal, so `main.ts` checks `playwright/package.json`'s version against
  `PLAYWRIGHT_VERSION` (baked in as an env var) and exits with a clear message on a mismatch. The
  base image digest is recorded in evidence.
- Runs compiled JS (`tsc` → `dist/`), not `tsx`: `tsx` is a dev dependency, and the runtime stage
  installs production dependencies only. `artifacts/`, `overrides/`, `status/` and `db/` are copied at
  the paths the code resolves relative to the working directory.
- `.dockerignore`: `node_modules`, `dist`, `evidence`, `.env`, `.git`.

**Compose services** (added to `docker-compose.yml`):

| Service | Command | Notes |
| --- | --- | --- |
| `postgres` | (Step 5) | |
| `bank` | `node dist/mock-app/index.js` | **exactly one container**: no `deploy.replicas`, never `--scale`d, `restart: "no"`, and the chaos scripts never touch it. Its sessions and its ledger are in-process memory (`mock-app/data.ts`), so one process is the one source of truth, and a restart would wipe it (REPO_NOTES "Where the repo disagrees" 8). Port `127.0.0.1:4100:4100`, so the host-side ledger check reads `/control/ledger` (loopback only: `/control/*` is unauthenticated). Healthcheck: `GET /control/ledger`. |
| `api` | `node dist/src/cli/index.js catalog serve --port 8080 --queue` | `127.0.0.1:8080:8080`. Runs `migrate()` at startup (advisory lock, D17). Same image, so the unchanged sync mode still works in Compose. |
| `worker` | default `CMD` | `deploy.replicas: ${ROTE_WORKERS:-4}`; `init: true` (tini: PID 1 forwards SIGTERM and reaps Chromium's children); `stop_grace_period: 45s` (section 6); `mem_limit: 700m` so an out-of-memory kill is attributed (`OOMKilled: true` in `docker inspect`) and never mistaken for a chaos kill (D9); `restart: "no"` in Step 6 (Day 2 decides restarts for chaos). Credentials from `.env`. Evidence volume `worker-evidence:/evidence`. |

`depends_on`: `api` and `worker` on `postgres: service_healthy` and `bank: service_healthy`.

**How a worker reaches the bank (open question 1).** Every committed artifact has
`entryUrlPattern: "^http://localhost:4100/"` and every override `entryUrl` is `http://localhost:4100/…`.
Inside a container, `localhost` is the container itself. Options:
- **(recommended) An in-container forwarder.** With `ROTE_BANK_FORWARD=bank:4100`, `main.ts` starts a
  ~20-line Node TCP forwarder on `127.0.0.1:4100` → `bank:4100` before launching Chromium. Artifacts,
  overrides, approvals and the policy allowlist stay byte-for-byte as approved (D15); Chromium still
  talks to `http://localhost:4100`, so cookies and the `entryUrlPattern` check behave exactly as on the
  host. Each worker owns its forwarder, so pausing a worker pauses its path to the bank too.
- `network_mode: "service:bank"` for workers: no code, but every worker shares the bank's network
  namespace (Day-3 per-worker metrics ports would collide), and a bank restart breaks every worker.
- Make the bank origin configurable in the artifacts: the right shape for a real bank, but it edits
  all five artifacts (version bump, re-approval) and loosens the allowlist anchor. Not for a mock.

## 6. Graceful shutdown and Postgres blips

**SIGTERM / SIGINT** (`docker stop`, Ctrl-C):
1. Stop dequeuing immediately (the loop checks `stopping` before every `dequeue`).
2. If a job is in flight, let it finish for up to `ROTE_SHUTDOWN_GRACE_MS` (default 30 s, inside
   Compose's 45 s `stop_grace_period`), then record its outcome normally.
3. If the grace period runs out: `abort()` the job's controller. `runReplay` closes the context and
   rejects (D11). Recorded per section 2's abort rows: before the irreversible step → requeue (attempt
   counted; `failed` if exhausted); after it → `needs_human` / `commit_uncertain`.
4. Close the browser, end the pool, exit 0. A second signal aborts at once and exits.

`SIGKILL` / OOM: no cleanup; the job stays `running` with its lease until Day-2 recovery. A Step-6
limitation, stated in the README.

**Postgres briefly unavailable.** Errors are classified as *transient* (SQLSTATE class `08`,
`57P01`–`57P03`, `ECONNREFUSED` / `ECONNRESET` / `ETIMEDOUT`, pool connect timeouts) or *fatal*
(anything else: a schema or constraint error is a bug).
- In `dequeue`: transient → log (URL redacted), back off with jitter (cap 5 s), keep the browser, try
  again. The worker never exits on a transient database error. Fatal → exit 1, loudly.
- In `complete`: the outcome is held in memory and the write retried with backoff until it succeeds
  or shutdown. If the worker stops first, the job stays `running` for Day-2 recovery, which verifies
  through the bank's history. The job is never re-run locally.
- Startup: wait for Postgres with backoff (Compose's `service_healthy` normally covers it), then
  `migrate()`, then start the loop.

## 7. What Step 6 leaves for Day 2 (the seams)

| # | Seam in Step 6 | Day 2 puts there |
| --- | --- | --- |
| 1 | `onIrreversible.before` sets an in-memory `irreversibleStarted` flag | the commit-intent transaction: `UPDATE … SET state = 'committing', commit_intent_at = now() WHERE id AND fencing_token AND lease_owner AND lease_expires_at > now()`; 0 rows → throw `FencingError` (the click never happens, D11) |
| 2 | `onIrreversible.after` is a no-op | the crash-after-submit fault flag (and the crash-point matrix) |
| 3 | `signal` aborted only by shutdown | the heartbeat: every 10 s `UPDATE … SET lease_expires_at = now() + 30 s WHERE id AND fencing_token AND lease_owner RETURNING`; 0 rows → `abort()` |
| 4 | `beforeDequeue()` is a no-op in the loop | expired-lease recovery (`lease_expires_at < now()`, database clock, D22), **inside the dequeue loop** (Step-5 note 8), with the `jobs_lease_expiry` index |
| 5 | `commit_uncertain` → `needs_human` (section 2) | → `verifying` + `transfer-history-lookup` for `memo_key`: 1 → `succeeded`, 0 → retry, or `business_outcome` final when the run's status was `business_outcome` |
| 6 | `complete()` fences on `state = 'running'` | also `committing` / `verifying`; recovery's own transitions |
| 7 | lease 300 s, no heartbeat | lease 30 s + heartbeat 10 s |
| 8 | exhausted retry → `failed` | unchanged; recovery also moves exhausted jobs to `failed`, never `queued` (D21) |

## 8. Tests

Unit (`npm run test:unit`, no Docker):
- `jobOutcomeFor`: one case per row of section 2's table.
- Credentials: env name mapping, startup check names the missing variable, error text never contains
  a value; the redactor replaces every credential value.
- Param building: credentials injected for redact inputs; `memo = memo_key` only for an irreversible
  capability; job params never mutated.
- Backoff: bounds and jitter with an injected RNG; reset after success.
- Transient-vs-fatal error classification.

Integration (`*.db.test.ts`: Postgres + in-process mock bank on an ephemeral port + one shared
Chromium; artifacts/overrides copied to a temp dir with a relaxed `entryUrlPattern`, as
`invoke.test.ts` does; approvals in a temp `statusDir`). Every row count reads `/control/ledger`.
- 6 jobs (2 per tenant), one worker → all `succeeded`; 6 ledger rows whose memos are exactly the
  jobs' `memo_key`s; each `result.outputs.confirmationRef` = that row's id.
- Two workers, 12 jobs → each job run once (attempt 1), both workers used, cap never exceeded.
- Business outcome (unknown `toMemberId`) → `business_outcome`, attempt 1, never retried, 0 rows.
- Failure before Submit (bank `errors/on` for the first attempt) → requeued, attempt 2 `succeeded`,
  1 row.
- `errors/after-write` → `failure` + `commitUncertain` → `needs_human` / `commit_uncertain`, attempt 1,
  **exactly 1 row, no second attempt**.
- Stale completion: the job's `fencing_token` bumped under the worker → completion writes 0 rows,
  the job is untouched, the attempt is `lease_lost`.
- Shutdown during a slow job (`/control/latency`): finishes and is recorded; with a tiny grace →
  aborted before Submit → requeued (attempt counted), 0 rows.
- Postgres blip: the worker's pool goes through an in-process TCP proxy the test can cut. With the
  proxy cut, the loop backs off without exiting; restored, the queued job completes. (Never stops the
  shared Compose Postgres, which other test files are using.)
- Stale approval (temp `statusDir` approved for another version) → `needs_human`, 0 rows.

API (`*.db.test.ts`, HTTP on an ephemeral port): 201 / 200 / 409 / 400 (credentials, missing key,
reserved memo, run-time approval flags) / 404 (capability, tenant) / 422 (not approved) / 503 (pool
pointed at a closed port); `GET /jobs/:id` shape, tenant scoping (another tenant → 404), and no
credential value anywhere in any response. The existing sync-mode catalog tests pass unchanged.

Docker (scripted, not in `npm test`): `docker compose build`; `up -d`; every service healthy;
`docker compose ps`, image digests and the version check recorded.

## 9. Day-1 exit: 100 jobs across 4 workers

`scripts/evidence-day1-exit.ts` (`npm run evidence:day1`), against Compose:
1. `docker compose up -d --build` with `ROTE_WORKERS=4`; wait for health; reset the bank's ledger.
2. POST 100 async jobs through the API: `transfer`, tenants a/b/c round-robin, distinct
   `Idempotency-Key`s, `amount: "1.00"` (the mock never debits balances, so no Insufficient funds).
3. POST the same 100 again with the same keys → 100 × `200` with the same job ids (API idempotency).
4. Poll `GET /jobs/:id` until all are terminal (timeout 10 min) while a sampler watches the per-tenant
   active count in Postgres.
5. Script checks, from the database and the bank's `/control/ledger`:
   - 100 jobs, all `succeeded`; every `attempt = 1` (or retries reported, never hidden);
   - the ledger has **exactly 100 rows**; every job's `memo_key` appears **exactly once**; no row
     without a job; each job's `confirmationRef` = its row's id → **0 duplicates, 0 lost**;
   - the replayed POSTs created 0 jobs and 0 rows;
   - `job_attempts.worker_id`: 4 distinct workers, with the per-worker split reported;
   - max active per tenant ≤ 2 (sampled);
   - no credential value in any job row, API response or log line.
6. Writes `evidence/day1-exit/` (`check.txt` with `RESULT: PASS/FAIL`, `ledger.json`, `jobs.json`,
   `docker compose ps`, image digests, timings) and exits 1 on any failure.

## 10. Commits

1. `src/worker/backoff.ts`, `credentials.ts` (+ redactor), error classification + unit tests.
2. `jobOutcomeFor` + the fenced `complete()` + tests.
3. `runJob` + the worker loop + graceful stop + integration tests (incl. the Postgres-blip proxy).
4. Async API mode + `GET /jobs/:id` + tests; `catalog serve --queue`.
5. `Dockerfile`, `.dockerignore`, bank forwarder, Compose services; Docker check evidence.
6. `scripts/evidence-day1-exit.ts` + the run + evidence.
7. Docs: D-entries (worker outcome mapping and `commit_uncertain` → `needs_human`; the bank forwarder;
   one image; approveRisky authority; API status codes), REPO_NOTES, README "Fleet (Day 1)",
   `docs/plans/step-07.md`.

`npm test` before every commit; never commit or push on red; full suite ×3 at the end.

## Open questions for the reviewer

1. **Bank reachability in Docker:** the in-container forwarder (recommended), `network_mode:
   service:bank`, or configurable artifact origins (section 5)?
2. **`approveRisky: true` in workers**, justified by the version-bound approval. Until Day 2 there is
   no commit intent, so a crash after Submit can't be recovered; Step 6 runs no chaos. OK?
3. **`commitUncertain` → `needs_human` (outcome `commit_uncertain`)** until Day 2's verify (section 2)?
4. **Approval check at enqueue (422)** as well as at run time, or run time only?
5. **`GET /jobs/:id` tenant scoping** via `?tenant=` (404 on mismatch) while the project has no auth?
6. **Worker memory limit 700 MB** and `restart: "no"` for Step 6 (Day 2 revisits restarts for chaos)?
7. Carried from Step 5 (D23): **the memo of an irreversible capability is reserved** for `memo_key`
   and a client-supplied one is rejected. OK, or should enqueue ignore it silently?

## Reviewer decisions (2026-11-09)

The reviewer **approved** this plan with the decisions below. Where they differ from the sections
above, these win; everything else in this file stands. The reviewer independently re-ran the full
Step 5 suite on Postgres 16: all 271 tests passed except the version-17 assertion, as expected.

### Part A, built first: approvals bound to artifact CONTENT (closes known limitation 6)

A1. Every approval also records `approvedDigest`: SHA-256 of the artifact's canonical JSON (the
    repo's stable serialization; if there is none, define it and test that key order and whitespace
    don't change the digest).
A2. `checkApproval` refuses when the digest differs, even if the version matches ("artifact content
    changed since approval; re-approve"). A missing digest falls back to the version check
    (grandfathered), and the reason says so.
A3. Backfill digests for all five status files from the current committed artifacts; extend the guard
    test (`committedApprovals.test.ts`) to check digests.
A4. Tests: digest match; content change with the same version → refused; whitespace/key-order change →
    still allowed.
A5. A D-entry; REPO_NOTES known limitation 6 marked fixed.

### Part B: Step 6 as planned, with these decisions

1. **Open question 1, bank reachability: the in-container forwarder.** Written in Node (`node:net`, a
   few lines; no socat, no extra packages), started by the worker entrypoint before the worker,
   listening on `127.0.0.1:4100` and forwarding to the bank service. Artifacts, approvals and the
   policy allowlist stay unchanged. Tested: bytes both ways, closes cleanly. D-entry: in a real
   deployment the bank origin would be per-environment configuration (`entryUrlPattern`/overrides);
   the forwarder keeps this demo's approved artifacts byte-identical.
2. **Open question 2, `approveRisky: true` in workers: approved** for Step 6 (no chaos yet). If a
   worker dies anyway, its job stays `running` and the 100-job exit check must report it as lost.
   Never paper over it.
3. **Open question 3, `commitUncertain` → `needs_human` (outcome `commit_uncertain`)** until Day 2's
   verify: approved. Never retried.
4. **Open question 4, approval checked at enqueue (422) AND at run time** (run time is
   authoritative): approved.
5. **Open question 5, `GET /jobs/:id` requires `?tenant=`** (404 on mismatch): approved. The README
   must say clearly that this is NOT authentication; the project has no auth by scope.
6. **Open question 6, worker memory limit 700 MB, `restart: "no"`** for Step 6: approved.
7. **Open question 7, a client memo on an irreversible capability is rejected** (D23): approved.

### Also required

- Record the first image build time and the image size, and `docker stats` (memory per container)
  during the 100-job run.
- Keep full, unfiltered logs of every full test run under `evidence/` (no output filtering that loses
  error text).
- **Day-1 exit (the brief's):** 100 transfer jobs across 4 workers, all succeeded, checked by a script
  that reads `/control/ledger`: exactly 1 ledger row per job (matched by `memo_key`), 0 duplicates,
  0 lost, every job in a terminal state. Saved under `evidence/fleet-day1-exit/` (this replaces §9's
  `evidence/day1-exit/`) with `check.txt` ending in `RESULT: PASS` or `FAIL`. If it fails, report the
  failure honestly; don't tune until it passes.
- `npm test` before every commit; never commit or push on red. Full suite 3 times at the end. Push at
  the end.
- Then write `docs/plans/step-07.md` (commit it; don't build it): the ledger oracle (module + CLI),
  the seeded chaos harness (expected to fail until Day 2, its failing output saved as "before"
  evidence), the crash-point matrix mechanism, GitHub Actions CI with a `postgres:17` service and a
  README badge, and what stays red until Day 2.

## Built (2026-11-09 / 2026-11-10)

Built in the planned order, Part A first. Decisions: D24 (Part A), D25-D29 (Part B). Evidence:
`evidence/step-06/` (every full `npm test` log, unfiltered; the digest backfill; Docker build) and
`evidence/fleet-day1-exit/` (`RESULT: PASS`). Where the build went beyond or differed from the text
above:

**Part A.**
- `canonicalJson` already existed (the queue's `request_hash`); it moved to
  `src/artifact/canonical.ts`. The digest is taken over the **schema-validated** artifact, so it
  covers exactly what replay executes.
- `checkApproval` now takes the artifact and computes the digest itself. Because the approval is
  about the base artifact and replay runs the tenant-merged copy, `ReplayOptions` gained the additive
  `approvalArtifact`; `invokeCapability` and the CLI's `replay`/`operator` pass the base (without it,
  `replay --tenant` would have been refused).
- Runs record their digest; the promotion streak counts only same-version, same-digest runs.
- Backfill by `scripts/backfill-approval-digests.ts`, which refuses unless git shows each artifact
  unchanged since its approval.
- Five existing browser test files had been replaying **port-relaxed copies** of the artifacts against
  the committed `status/`, passing only because approval ignored content. They now approve exactly
  what they replay in a temp `statusDir`.

**Part B.**
- `isTransientDbError` lives in `src/queue/transient.ts` (the API uses it too), not `src/worker/`.
- `runJob` runs a **preflight** (capability, params with credentials injected, override, entry URL),
  so deterministic problems fail as `invalid_job` without a browser.
- `needs_human` carrying `commitUncertain` maps to `commit_uncertain` (defensive; D25).
- The async body is strict: only `tenant` and `params`; `entryUrl` is refused too. `?mode=async`
  without a queue is 501, not a silent synchronous run. `GET /healthz` added for the Compose health
  check.
- Credentials must be at least 4 characters (so redaction cannot eat ordinary text). Compose passes
  them with empty defaults, so `docker compose up -d postgres` works without them; the worker refuses
  to start instead.
- Worker health check: the loop touches a file; healthy if touched within 120 s.
- The Day-1 exit script truncates the dev database's queue tables before the run, stops the workers
  gracefully at the end, and checks the exit codes (all 0).
- **Docker incident:** the first image build died mid-pull when Docker Desktop's engine stopped
  answering (HTTP 500 on every API call). The builder restarted Docker with 8 GB of swap; the build
  was redone from cold: 283 s, image 3.58 GB. Both logs are kept.
- **Day-1 exit attempt 1** passed every fleet check, then the script crashed parsing `docker inspect`
  output; fixed and rerun from scratch (attempt 1 kept, with a README).
- **Flake:** `net::ERR_INSUFFICIENT_RESOURCES` in `src/replay/fleet.test.ts` in one full run; the
  rerun passed (`evidence/step-06/flakes.md`).
