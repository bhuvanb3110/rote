# Step 5 plan — Postgres job queue (proposed, not built)

Branch `fleet/day-1`. Reads `docs/plans/step-04.md` (built; see its "Built" section). Status:
**for review**; nothing here is built. From this step on, **Docker is required**: the queue tests
run against Postgres in a container, and `npm test` fails (loudly, never skips) without it.

Scope of this step: Postgres in Compose, the driver, migrations, the schema, **enqueue** with an
`Idempotency-Key`, and **dequeue** with a lease, a fencing token and the per-tenant cap. No worker
and no API changes. What waits for Step 6 and Day 2 is listed at the end.

## 1. `docker-compose.yml`: Postgres only

```yaml
name: rote
services:
  postgres:
    image: postgres:17          # pinned major; the resolved digest is recorded in evidence
    environment:
      POSTGRES_USER: rote
      POSTGRES_PASSWORD: ${ROTE_PG_PASSWORD:-rote_dev_only}
      POSTGRES_DB: rote
    ports:
      - "127.0.0.1:${ROTE_PG_PORT:-55432}:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U rote -d rote"]
      interval: 2s
      timeout: 3s
      retries: 30
      start_period: 10s
volumes:
  pgdata:
```

- **Pinned major (`17`)**, not `latest`: a major upgrade changes the on-disk format, and the named
  volume would refuse to start. 17 is the current boring choice (supported to 2029). The
  official image changed its data-dir layout in 18, so moving to 18 needs its own reviewed step.
- **Named volume `pgdata`**: data survives `docker compose down` and container recreation;
  `docker compose down -v` is the explicit reset.
- **Healthcheck** with `pg_isready`: later services (mock bank, API, workers) use
  `depends_on: { postgres: { condition: service_healthy } }`, so nobody connects to a database that
  is still initializing.
- **Port `127.0.0.1:55432`**: bound to loopback only (not reachable from the LAN), and 55432 rather
  than 5432 so it never collides with a native Postgres the builder might install later (none
  listens today; checked). Overridable with `ROTE_PG_PORT`.
- The password is a **local-only dev value** from `.env` (an `.env.example` is committed, not
  `.env`). It never appears in logs: the connection-string logger prints
  `postgres://rote:***@127.0.0.1:55432/rote`.
- Memory: Postgres idles at ~50–150 MB of the ~4 GB Docker VM (D9). No tuning in this step.

## 2. Driver and migrations

**Driver: `pg` (node-postgres) + `@types/pg`.** Proposed D15 (§10). One `Pool` per process from
`ROTE_DATABASE_URL`. Multi-statement transactions check out one client
(`BEGIN … COMMIT` on that client, `ROLLBACK` in `finally` on error) through a single helper,
`withTransaction(pool, fn)`. `int8` (`fencing_token`, identity ids) is parsed to `number` with a
guard that throws above `Number.MAX_SAFE_INTEGER`, so a token is never silently rounded.

**Migrations: plain `.sql` files plus a small runner, no ORM.** Proposed D16 (§10).

- `db/migrations/0001_init.sql`, `0002_…`: forward-only, numbered, never edited once applied.
- `src/queue/migrate.ts` (~80 lines): creates `schema_migrations(version text primary key,
  checksum text not null, applied_at timestamptz not null default now())`. Takes
  `pg_advisory_lock(hashtext(current_schema() || ':migrations'))`, so concurrent runners (several
  containers starting at once, or two test files) serialize. Then it applies each pending file in
  **its own transaction** (file + `INSERT INTO schema_migrations` commit together, or neither does).
  For already-applied files it checks the checksum and fails loudly if a file was edited.
- **Checksums ignore line endings** (`\r\n` → `\n` before SHA-256) and `.gitattributes` gets
  `*.sql text eol=lf`. Without this, a checkout on Windows (CRLF) and one on Linux CI (LF) would
  checksum differently and the runner would refuse to start.
- CLI: `rote db migrate` and `npm run db:migrate`. Workers and the API (Step 6) run it at startup;
  the advisory lock makes that safe.

## 3. Schema (`0001_init.sql`)

States and other small vocabularies are `text` with a `CHECK` constraint, not Postgres `enum`s:
adding a value is a one-line constraint swap in a migration, and an `ALTER TYPE … ADD VALUE` can't be
used inside the same transaction that adds it (proposed D20).

### `tenants`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | `text primary key` | `tenant-a` … — the same ids as `mock-app/tenants.ts` and `overrides/*.<tenant>.json` |
| `max_concurrent` | `int not null check (max_concurrent between 1 and 100)` | brief: "e.g. 2" |
| `created_at` | `timestamptz not null default now()` | |

Seeded in `0001` with `tenant-a`, `tenant-b`, `tenant-c` at `max_concurrent = 2` (dev defaults;
changed with an `UPDATE`, or a later `rote db tenants set`). A job for an unknown tenant fails at
the foreign key, not at run time.

### `jobs` (every column in the brief's job record, plus `memo_key`, `result`, and bookkeeping)

| Column | Type / constraint | Why |
| --- | --- | --- |
| `id` | `uuid primary key default gen_random_uuid()` | built in since PG 13 |
| `idempotency_key` | `text not null`, `check (length between 1 and 255)`, **`unique`** | the race-safe enqueue (§4) depends on this index |
| `request_hash` | `text not null` | SHA-256 of canonical JSON `{tenant, capability_id, params}`; same key + different request → 409 (§4) |
| `tenant_id` | `text not null references tenants(id)` | the brief's `tenant` |
| `capability_id` | `text not null` | not a FK: capabilities live in `artifacts/`, not the DB |
| `params` | `jsonb not null` | **business params only, never credentials** (see open question 1) |
| `state` | `text not null default 'queued'`, `check (state in ('queued','running','committing','verifying','succeeded','business_outcome','failed','needs_human'))` | the brief's 7 states + `business_outcome` (open question 2) |
| `attempt` | `int not null default 0 check (attempt >= 0)` | incremented on every dequeue |
| `max_attempts` | `int not null default 3 check (max_attempts between 1 and 20)` | |
| `lease_owner` | `text` | worker id |
| `lease_expires_at` | `timestamptz` | |
| `fencing_token` | `bigint not null default 0 check (fencing_token >= 0)` | incremented on every lease; Day 2 checks it on heartbeat and commit intent |
| `trace_id` | `text check (trace_id ~ '^[0-9a-f]{32}$')` | W3C trace id, generated at enqueue so every attempt joins one trace |
| `commit_intent_at` | `timestamptz` | set by the Day-2 commit-intent transaction |
| `outcome` | `text` | short terminal label (`success`, `business_outcome`, `failure`, `already_done`, …), for metrics and queries |
| `error` | `text` | redacted, human-readable |
| `result` | `jsonb` | the final `ReplayResult` (already redacted by replay), incl. `commitUncertain` |
| `memo_key` | `text generated always as ('rote-' \|\| id::text) stored` | the 41-character memo the worker types (D5); generated, so it can never disagree with `id` |
| `created_at`, `updated_at` | `timestamptz not null default now()` | `updated_at` set explicitly in each `UPDATE` (no trigger, so all SQL stays visible) |

Constraints across columns:
- `check ((lease_owner is null) = (lease_expires_at is null))`: a lease is both fields or neither.
- `check (state not in ('running','committing','verifying') or lease_owner is not null)`: an
  active job always has an owner. An *expired* lease keeps its owner until Day-2 recovery moves the
  job on, which is what recovery reads.
- `check (state <> 'committing' or commit_intent_at is not null)`.

Indexes:
- `unique (idempotency_key)`: correctness of enqueue (§4), not just speed.
- `jobs_queued_by_tenant ON jobs (tenant_id, created_at, id) WHERE state = 'queued'`. A **partial**
  index, so it holds only waiting jobs and stays small however many finished rows pile up. It
  serves "does this tenant have queued work", "its oldest queued job" (fairness) and the per-tenant
  pick (§5), in that order.
- `jobs_active_by_tenant ON jobs (tenant_id) WHERE state IN ('running','committing','verifying')`:
  the per-tenant active count for `max_concurrent`. It is tiny (at most workers × tenants rows).
- Day 2 adds `jobs_lease_expiry ON jobs (lease_expires_at) WHERE state IN ('running','committing',
  'verifying')` with the recovery code that uses it.

### `job_attempts`: one row per attempt

| Column | Type / constraint |
| --- | --- |
| `id` | `bigint generated always as identity primary key` |
| `job_id` | `uuid not null references jobs(id) on delete cascade` |
| `attempt` | `int not null` |
| `worker_id` | `text not null` |
| `fencing_token` | `bigint not null` |
| `started_at` | `timestamptz not null default now()` |
| `ended_at` | `timestamptz`, `check (ended_at is null or ended_at >= started_at)` |
| `outcome` | `text` (`success`, `business_outcome`, `needs_human`, `failure`, `lease_lost`, `aborted`, `crashed` — the last set by recovery) |
| `commit_uncertain` | `boolean not null default false` (copied from the `ReplayResult`, D10) |
| `trace_id` | `text` |
| `error` | `text` |

`unique (job_id, attempt)` and `unique (job_id, fencing_token)`: each attempt and each lease is
recorded exactly once. If a bug ever let two workers hold the same token, the second insert fails
instead of hiding it. The row is inserted **in the dequeue transaction**, so a lease with no attempt
row cannot exist.

### `breakers`

| Column | Type / constraint |
| --- | --- |
| `capability_id` | `text primary key` |
| `state` | `text not null default 'closed' check (state in ('closed','open','half_open'))` |
| `consecutive_failures` | `int not null default 0 check (>= 0)` |
| `opened_at` | `timestamptz`, `check (state <> 'open' or opened_at is not null)` |
| `probe_job_id` | `uuid references jobs(id)` (the one half-open probe) |
| `updated_at` | `timestamptz not null default now()` |

The table is created now so the schema is complete. The transitions and the dequeue filter
(`… AND NOT EXISTS (open breaker)`) are Day 3 work.

## 4. Enqueue with `Idempotency-Key`: one race-safe statement

```sql
INSERT INTO jobs (idempotency_key, request_hash, tenant_id, capability_id, params, max_attempts, trace_id)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (idempotency_key) DO UPDATE
  SET idempotency_key = EXCLUDED.idempotency_key     -- deliberate no-op
RETURNING id, request_hash, state, (xmax = 0) AS created;
```

**Why `DO UPDATE` and not the obvious `DO NOTHING` + `SELECT`.** The usual idiom is a CTE: insert
with `DO NOTHING`, then `UNION` a `SELECT … WHERE idempotency_key = $1`. That loses the race. Two
requests with the same key arrive together. B's insert waits on A's uncommitted row in the unique
index; when A commits, B's insert does nothing, and B's `SELECT` reads the **statement's snapshot,
taken before A committed**, so it finds no row and B gets nothing back. `ON CONFLICT DO UPDATE`
instead locks and returns the *latest committed* conflicting row, so both clients get A's job id.
The cost is one extra tuple version per duplicate request. That is irrelevant at this scale, and
the lock is brief, because no long transaction ever holds a job row lock: the lease is a column,
not a lock (§5).

- `(xmax = 0) AS created` tells a fresh insert from a duplicate. It is used **only** to choose
  `201` vs `200` in Step 6's API, never for correctness: it's an implementation-level signal, and
  the job id is what both clients rely on.
- **Same key, different request:** the caller compares the returned `request_hash` with its own.
  On a mismatch, enqueue throws `IdempotencyKeyConflict` (Step 6 maps it to `409`), and the
  original job is untouched.
- `trace_id` is generated in TypeScript (16 random bytes, hex) at enqueue.

Tests (`src/queue/enqueue.test.ts`):
- **Concurrent same key:** 20 enqueues with one key on 20 separate pool clients, fired with
  `Promise.all`, repeated over 25 rounds (fresh key each round). Every client gets the same job id,
  `count(*) = 1`, and exactly one result has `created = true`.
- **Deterministic interleaving** (the case above, forced): client A `BEGIN` + enqueue (not
  committed); client B's enqueue starts and is observed blocked (`pg_stat_activity.wait_event_type
  = 'Lock'`); A commits; B returns **A's id**.
- **Why not `DO NOTHING`:** the same interleaving against the CTE idiom returns **zero rows** for B.
  The test pins that, so the reason for the odd-looking no-op update is executable.
- Same key with different params → `IdempotencyKeyConflict`; the stored job is unchanged.
- An unknown tenant → foreign-key error; an over-long key → check violation.

## 5. Dequeue: `SKIP LOCKED` + lease + fencing token + per-tenant cap, one transaction

**The per-tenant cap: a count in the same transaction, under a per-tenant lock.** Proposed D17
(§10). A count alone is **not** safe. Under `READ COMMITTED`, two dequeuers each count 1 active job
for tenant-a (cap 2), each `SKIP LOCKED`-pick a *different* queued row, and both commit: 3 running.
That's write skew, and row locks on jobs can't prevent it, because the two never touch the same row.
So dequeuers serialize **per tenant** by locking the tenant's row, and recount after taking that
lock:

```sql
BEGIN;
-- (1) Claim one tenant that has queued work and (probably) a free slot. Tenants another dequeuer
--     is claiming right now are skipped, not waited on. Oldest waiting job first = fairness.
SELECT t.id, t.max_concurrent
FROM tenants t
WHERE EXISTS (SELECT 1 FROM jobs q WHERE q.tenant_id = t.id AND q.state = 'queued')
  AND (SELECT count(*) FROM jobs a
       WHERE a.tenant_id = t.id AND a.state IN ('running','committing','verifying')) < t.max_concurrent
ORDER BY (SELECT min(q.created_at) FROM jobs q WHERE q.tenant_id = t.id AND q.state = 'queued')
FOR UPDATE OF t SKIP LOCKED
LIMIT 1;

-- (2) Recount in a NEW statement. Under READ COMMITTED it gets a fresh snapshot, so it sees any job
--     that went active (and committed) after (1)'s snapshot. Nothing can raise this count while we
--     hold the tenant row lock: every transition INTO an active state happens here.
SELECT count(*) FROM jobs WHERE tenant_id = $tenant AND state IN ('running','committing','verifying');
-- if count >= max_concurrent: ROLLBACK, exclude this tenant, go back to (1) (bounded by #tenants)

-- (3) Pick the tenant's oldest queued job; SKIP LOCKED still guards against any other locker.
SELECT id FROM jobs
WHERE tenant_id = $tenant AND state = 'queued' AND attempt < max_attempts
ORDER BY created_at, id
FOR UPDATE SKIP LOCKED
LIMIT 1;

-- (4) Lease it: owner, expiry, attempt + 1 and fencing_token + 1 together.
UPDATE jobs
SET state = 'running', attempt = attempt + 1, fencing_token = fencing_token + 1,
    lease_owner = $worker, lease_expires_at = now() + make_interval(secs => $leaseSeconds),
    updated_at = now()
WHERE id = $job
RETURNING *;

-- (5) One attempt row, same transaction.
INSERT INTO job_attempts (job_id, attempt, worker_id, fencing_token, trace_id)
VALUES ($job, $attempt, $worker, $fencingToken, $traceId);
COMMIT;
```

Why a tenant **row** lock rather than an advisory lock, or `SERIALIZABLE`:
- `pg_try_advisory_xact_lock(hashtext('tenant:' || id))` gives the same serialization. But
  `hashtext` can collide (two tenants sharing one lock: harmless but baffling), the lock is invisible
  in the schema, and it needs the same fresh-snapshot recount anyway. A `FOR UPDATE SKIP LOCKED`
  on `tenants` uses the same primitive as the job pick, shows up in `pg_locks` against a named
  table, and needs no hashing.
- `SERIALIZABLE` would detect the write skew, but it does so by aborting transactions with
  serialization failures that must be retried. Workers poll constantly, so contention on a popular
  tenant would turn into retry loops. Explicit locking makes the outcome deterministic.
- Throughput cost: two dequeuers can't pick for the *same* tenant in the same few milliseconds; the
  second one skips to another tenant or finds nothing and polls again (worker poll backoff, Step 6).
  With 4–6 workers and millisecond transactions this is negligible. The load test (Day 3) measures
  it.

Counted as active: `running`, `committing` **and `verifying`**. The brief says running or
committing; `verifying` also drives the bank's UI (the history lookup), so it uses a slot too.
`dequeue()` returns the leased job (Zod-parsed row) or `null`. Lease length is a parameter
(default 30 s, per the brief).

Tests (`src/queue/dequeue.test.ts`):
- **N concurrent dequeuers never get the same job:** 300 jobs across the 3 tenants (caps raised to
  100), 16 concurrent dequeue loops on 16 connections. Each loop dequeues until `null` and marks its
  job `succeeded` right away, to free capacity. Asserts: 300 distinct ids, each exactly once, every
  `fencing_token = 1` and `attempt = 1`, exactly 300 `job_attempts` rows, `unique (job_id)` across
  them.
- **The cap holds under concurrency:** tenant-a cap 2, 10 queued; 8 concurrent dequeuers that *don't*
  complete. Exactly 2 get a job and 6 get `null`. A sampler polling the active count during the run
  never sees more than 2.
- **The write skew, forced** (why the tenant lock exists): two transactions interleaved by hand
  run the count-only variant: both count 1, both pick, both commit → 3 active. The same
  interleaving with the real dequeue: the second claim skips the locked tenant and returns `null`.
- **Fairness:** with tenant-a's oldest job older than tenant-b's, the first dequeue picks tenant-a.
  A tenant at its cap is skipped in favor of one with room.
- **Lease and token are atomic with the pick:** after dequeue, `lease_owner`, `lease_expires_at ≈
  now() + 30 s`, `fencing_token = 1` and the attempt row all exist. A test that injects a failure
  between (4) and (5) (a forced error inside `withTransaction`) leaves the job `queued` with token 0
  and no attempt row.
- Re-dequeue after a manual `UPDATE … SET state = 'queued', lease_owner = NULL, lease_expires_at =
  NULL` (standing in for Day-2 recovery) → `fencing_token = 2`, `attempt = 2`, a second attempt row.

## 6. How tests get a database (Windows host, Postgres in Compose)

- **Postgres runs in Compose on the host:** `docker compose up -d postgres` once. Tests connect to
  `ROTE_TEST_DATABASE_URL`, default `postgres://rote:rote_dev_only@127.0.0.1:55432/rote_test`. That
  is a **separate `rote_test` database** in the same container, never the dev `rote` database.
  `127.0.0.1`, not `localhost`: Node 17+ may resolve `localhost` to `::1` first, and loopback IPv4 is
  what the port is bound to.
- **Created on demand:** a shared helper (`src/queue/testDb.ts`) connects to the maintenance
  database and runs `CREATE DATABASE rote_test`, treating `42P04 duplicate_database` as success,
  because several test files race to create it.
- **Isolation: one schema per test file.** Each DB test file creates `t_<file>_<random>`, gives its
  pool `options: '-c search_path=t_…'`, runs the real migration runner into it (so every file also
  exercises migrations), and `DROP SCHEMA … CASCADE` in `afterAll`. Inside a file, `beforeEach`
  runs `TRUNCATE jobs, job_attempts, breakers RESTART IDENTITY CASCADE` and re-seeds tenants. All
  SQL is unqualified, so it runs in whichever schema the pool points at. The advisory-lock key
  includes `current_schema()`, so files never wait on each other's migrations.
- Rejected: a **transaction per test, rolled back**. The concurrency tests need several connections
  to see each other's commits. A **database per file** (`CREATE DATABASE … TEMPLATE`) also isolates,
  but costs ~0.2–0.5 s per file and fails if the template has an open connection. Schemas are faster
  and just as isolated for unqualified SQL.
- **Docker down → loud failure, never a skip.** The helper tries to connect with a 5 s timeout and
  throws `Postgres not reachable at 127.0.0.1:55432 (password redacted): run "docker compose up -d
  postgres"`. CLAUDE.md's "never hide a failure" applies: `npm test` is red without the database,
  which is the point of "Docker is required from Step 5".
- **Connections:** each DB test file's pool is capped at 24 (the 16-dequeuer and 20-enqueuer tests
  are the peaks). Postgres' default `max_connections = 100` covers the 3–4 DB files vitest may run
  in parallel. If more DB files arrive, `max_connections` is raised in Compose (`command: postgres
  -c max_connections=200`) rather than serializing tests.
- **Windows specifics (REPO_NOTES Q7, "Answers from the builder"):** tests run on the Windows host
  with `npm test`; only Postgres is in Docker (WSL2 backend, ~4 GB VM). Line endings: §2's checksum
  normalization and `.gitattributes`. No signals are involved in this step. The CI workflow
  (amendment 3, later step) uses a `postgres:17` service container with the same
  `ROTE_TEST_DATABASE_URL`, so the helper is CI-ready as is.

## 7. Code layout

- `docker-compose.yml`, `.env.example`, `.gitattributes` (`*.sql text eol=lf`) at the root.
- `db/migrations/0001_init.sql`.
- `src/queue/`: `db.ts` (pool from env, int8 parser, `withTransaction`, redacted URL),
  `migrate.ts`, `enqueue.ts`, `dequeue.ts`, `types.ts` (Zod `JobRowSchema`, `JobStateSchema`,
  `AttemptRowSchema`, so rows are parsed, not cast), `index.ts`, `testDb.ts`. This adds `queue/` to
  CLAUDE.md's repo layout line (updated in the docs commit).
- `src/cli/index.ts`: `rote db migrate`. `package.json`: `pg`, `@types/pg`, `db:migrate` script.
- `scripts/evidence-queue.ts`: against the Compose database, runs the concurrent enqueue (same key)
  and 16-dequeuer scenarios and checks the tables. It writes `check.txt` (`RESULT: PASS/FAIL`, 0
  duplicate ids, cap never exceeded) under `evidence/step-05-queue/`, together with `docker compose
  ps`, the health status and the pulled image digest.

## 8. Commits

1. `docker-compose.yml` (Postgres only), `.env.example`, `.gitattributes`; Docker check recorded.
2. `pg` dependency, `src/queue/db.ts`, `testDb.ts` and the loud-failure connectivity test.
3. Migration runner + `0001_init.sql` + tests (applies once, idempotent rerun, edited-file checksum
   failure, CRLF/LF same checksum, two concurrent runners → applied once).
4. Schema constraint tests (lease pair, active-has-owner, committing-has-intent, FK tenant, state
   check, generated `memo_key` = `'rote-' || id` and 41 characters).
5. Enqueue + its tests (concurrent same key, forced interleaving, the `DO NOTHING` counter-example,
   conflict on a different request).
6. Dequeue + its tests (16 dequeuers, cap under concurrency, forced write skew, fairness, atomicity,
   re-lease increments the token).
7. `rote db migrate` CLI + `scripts/evidence-queue.ts` + evidence run.
8. Docs: D15–D20 appended to DECISIONS, REPO_NOTES (Docker now required; how to run the DB), CLAUDE.md
   repo layout, README "Running the tests" (start Postgres first), `docs/plans/step-06.md`.

`npm test` (with Postgres up) before every commit; never commit or push on red; full suite ×3 at
the end.

## 9. What lands when

| Piece | Step 5 (this) | Step 6 (worker) | Day 2 (leases/recovery) | Day 3 |
| --- | --- | --- | --- | --- |
| Compose | Postgres | + mock bank, API, worker services | | + Jaeger, Prometheus, Grafana |
| Schema | all four tables, constraints, indexes | | + lease-expiry index | |
| Enqueue | SQL function + tests | `POST …/invoke?mode=async` + `Idempotency-Key` header, `201`/`200`/`409`, `GET /jobs/:id` | | |
| Dequeue | SKIP LOCKED + lease + token + cap | worker poll loop with backoff, one browser per worker | | breaker filter |
| Running a job | — | `invokeCapability({ browser, signal, evidenceBaseDir })`, memo = `memo_key`, credentials injected, job → `succeeded` / `business_outcome` / `failed` / `needs_human` with `result` | | |
| Heartbeat (10 s, token-checked) | — | — | yes; lost lease → `AbortController.abort()` | |
| Commit intent | — | — | `onIrreversible.before`: token check + `state = committing` in one transaction | |
| Recovery | — | — | lease expiry → requeue / `verifying` → history lookup → `succeeded` / `queued` / `needs_human`; the business_outcome + `commitUncertain` rule (step-04 reviewer decision 3); `max_attempts` → `failed` | |
| Crash tests | — | — | crash before/after submit via `onIrreversible.after` | |
| Breaker | table only | — | — | transitions, half-open probe |

## 10. Proposed D-entries (appended to `docs/DECISIONS.md` when this step is built)

DECISIONS.md is append-only, so these are drafted here for review and land with the code.

**D15: `pg` (node-postgres) as the driver.**
*Decision.* `pg` with an explicit `Pool`, and one checked-out client per transaction.
*Alternatives.* `postgres` (postgres.js): faster, with a tagged-template API and `sql.begin()`
transactions. `pg-promise`. A query builder (Kysely, Knex).
*Why.* The queue's correctness lives in a few hand-written transactions (D2). `pg` keeps each one
literal: a SQL string, a parameter array, and `BEGIN`/`COMMIT` on a client you can see. postgres.js's
tagged templates are pleasant but build SQL from fragments and pin connections implicitly inside
`sql.begin`, which hides exactly what this project needs to show and defend. `pg` is also the most
widely deployed Node driver, so its `SKIP LOCKED` usage and pool error handling are well trodden,
and its throughput is far beyond what a few browser workers generate. Cost: CommonJS (it imports
fine from ESM) and `int8` arriving as strings, handled by the guarded parser in `db.ts`.

**D16: Plain `.sql` migrations and a small runner, no ORM.**
*Decision.* Forward-only numbered `.sql` files; a ~80-line runner with an advisory lock, one
transaction per file, and line-ending-insensitive checksums.
*Alternatives.* An ORM with migrations (Prisma, Drizzle, TypeORM); node-pg-migrate; Knex migrations;
graphile-migrate.
*Why.* The schema is part of the design being reviewed: constraints, partial indexes and a generated
column read best as the SQL Postgres runs. An ORM would put a second schema language in front of it,
plus a generator and a runtime the project doesn't otherwise need, and CLAUDE.md is schema-first
with Zod for types. The runner is small enough to test fully (including concurrent starts and edited
files), which a third-party tool's internals are not.

**D17: The per-tenant cap is a recount under a tenant row lock (`FOR UPDATE SKIP LOCKED` on
`tenants`).**
*Decision.* §5's transaction: claim a tenant row with `SKIP LOCKED`, recount active jobs in a fresh
statement, pick the job with `SKIP LOCKED`, lease it, insert the attempt row.
*Alternatives.* A count in the same transaction with no lock (write skew: shown by a forced-
interleaving test); `pg_try_advisory_xact_lock` per tenant (equivalent, but hash collisions and
invisible in the schema); `SERIALIZABLE` (correct, but turns contention into retry loops).
*Why.* It is the only option among these that is both correct under `READ COMMITTED` and
deterministic. It reuses the `SKIP LOCKED` primitive the queue already depends on, and a tenant
that is busy being claimed is skipped, not waited on.

**D18: Enqueue is one `INSERT … ON CONFLICT (idempotency_key) DO UPDATE` (no-op) `RETURNING`.**
*Decision.* §4's statement; `request_hash` detects key reuse with a different request (409).
*Alternatives.* `DO NOTHING` + `SELECT` in one statement (loses the race: the `SELECT` can't see a
row committed after the statement's snapshot); `DO NOTHING` then a second statement (works under
`READ COMMITTED`, but two round trips and not one statement); an advisory lock on the key.
*Why.* One statement that returns the winning row to every concurrent caller. Postgres guarantees
`ON CONFLICT DO UPDATE` sees the latest committed conflicting row. The cost is a dead tuple per
duplicate request.

**D19: Test isolation is one Postgres schema per test file in a separate `rote_test` database.**
*Decision.* §6.
*Alternatives.* Roll back a transaction per test (breaks multi-connection concurrency tests); a
database per file from a template (slower, fragile when the template has an open connection); a
fresh container per run (slow on a 4 GB Docker VM, and it hides migration problems behind a fresh
init every time).
*Why.* Parallel vitest files can't see each other's rows, every file runs the real migrations, and
setup costs milliseconds.

**D20: States are `text` + `CHECK`, and `business_outcome` is a terminal job state.**
*Decision.* `jobs.state` ∈ the brief's seven states plus `business_outcome` (pending open question 2).
*Alternatives.* A Postgres `enum`; recording a bank refusal as `succeeded` or `failed` with the code
in `result`.
*Why.* `CHECK` constraints evolve in an ordinary transactional migration. A refused transfer is
neither a success nor a failure. CLAUDE.md calls that distinction load-bearing for replay results,
and the step-04 reviewer rule makes a business outcome *final, no retry*, so the job table should be
able to say so without parsing `result`.

## Open questions for the reviewer

1. **Credentials are not stored in `jobs.params`.** The transfer's `username`/`password` inputs are
   `redact: true`. Persisting them in a queue table would put credentials at rest in Postgres and in
   every row dump. Proposal: enqueue (Step 6) rejects params for any `redact: true` input, and the
   worker injects them from per-tenant configuration (Compose `.env`, fake values; a production
   secret store is out of scope per the brief). The schema here assumes that. OK?
2. **`business_outcome` as an eighth job state** (D20), instead of `failed`/`succeeded` + code. The
   brief's diagram has seven states.
3. **`idempotency_key` unique globally** (as the brief says) rather than per tenant
   (`unique (tenant_id, idempotency_key)`). Global is simpler and matches the brief. Per-tenant
   would let two banks' clients reuse a key independently.
4. **`verifying` counts toward `max_concurrent`** (it uses the bank's UI). The brief lists only
   `running` and `committing`.
5. **Postgres 17 vs 18** for the pinned major (§1).

## Reviewer decisions (2026-11-09)

The reviewer **approved** this plan with the changes below. Where they differ from the sections
above, these win. Everything not mentioned here stands as written: Compose, the `pg` driver,
migrations with line-ending-insensitive checksums and `.gitattributes`, the schema (with the changes
below), the `ON CONFLICT DO UPDATE` enqueue with the forced-interleaving and `DO NOTHING`
counter-example tests, the `SKIP LOCKED` dequeue under the tenant row lock with all listed tests,
schema-per-test-file isolation, loud failure without Postgres, the evidence script, and D15–D20
(adjusted for decisions 3, 6 and 7).

### Part A, built first: approvals bound to the artifact version

The gap: `status/*.json` approvals don't record which artifact version was approved, so an edited
artifact silently inherits approval. This already happened once: `transfer` and
`transfer-history-lookup` were approved at 1.0.0 in Step 3 (commit f1f2e8b) and bumped to 1.1.0 in
Step 4 (commit b9ecaa2) with no re-approval.

A1. Every approval (auto-promotion and manual) records `approvedVersion` in the capability status.
    Old status files without it still parse.
A2. `checkApproval` takes the capability's version. An approved status whose `approvedVersion`
    differs from the artifact's version → not allowed, with a clear reason ("approved for 1.0.0,
    artifact is 1.1.0; re-approve"). A status with no `approvedVersion` (the three grandfathered
    artifacts) stays allowed, and the reason says so. Decide whether to backfill their
    `approvedVersion` now, and record the decision in a D-entry.
A3. Tests: match, mismatch, missing (grandfathered), and auto-promotion recording the version.
A4. Re-run the transfer evidence script for 1.1.0 into a **new** folder
    (`evidence/transfer-replay-1.1.0/`; `evidence/transfer-replay/` stays as the 1.0.0 history), then
    re-approve both transfer artifacts for 1.1.0 with a reason citing it.

### Part B: Step 5 as planned, with these changes

1. **Open question 1: credentials NEVER in `jobs.params`.** Enqueue rejects params containing any
   input the capability marks `redact: true` (typed error, tested). `request_hash` covers only
   non-secret params. The worker (Step 6) injects credentials per tenant from env.
2. **Open question 2: `business_outcome` is an 8th terminal job state.** Approved.
3. **Open question 3, CHANGED: idempotency keys are unique PER TENANT.** `unique (tenant_id,
   idempotency_key)` and `ON CONFLICT (tenant_id, idempotency_key)`. Reason: a global key lets
   tenant B learn that tenant A used a key (B gets a 409 on A's key), a cross-tenant leak. Test: the
   same key in two tenants → two different jobs.
4. **Open question 4: `verifying` counts toward `max_concurrent`.** Approved.
5. **Open question 5: `postgres:17`.** Approved.
6. **BUG FIX, tenant starvation.** Dequeue step (1) claims a tenant with ANY queued job, but step (3)
   only picks `attempt < max_attempts`, so a tenant whose queued jobs are all exhausted is claimed,
   yields nothing, and dequeue returns `null` while other tenants have work.
   - Add `CHECK (state <> 'queued' OR attempt < max_attempts)` to `jobs`. **Day-2 recovery must move
     an exhausted job to `failed`, never to `queued`** (the constraint would reject it anyway).
   - If step (3) finds no job for the claimed tenant (e.g. its rows are briefly locked by another
     transaction), roll back that tenant's claim and continue with step (1) excluding it, bounded by
     the tenant count. Never return `null` while another eligible tenant has work.
   - Tests: an exhausted job cannot be set to `queued`; and with tenant-a's queued job row locked by
     another open transaction, a dequeue still returns tenant-b's job.
7. **RULE: every lease-time comparison uses the database clock (`now()`), never a worker's clock.**
   Recorded in a D-entry and in the Day-2 notes below.
8. **NOTE for Day 2:** a dead worker's job holds its tenant slot until recovery runs. With
   `max_concurrent` 2, two dead workers block a tenant entirely, so recovery of expired leases must
   run **inside the dequeue loop**, not only on a separate timer.
9. **Optional, recommended: `npm run test:unit`** runs everything except the DB tests, so pure code
   changes can be checked without Docker. `npm test` stays the full suite and fails loudly without
   Postgres.

Also: report the Docker image digest and `docker compose ps` output; `npm test` before every commit,
never commit or push on red; full suite 3 times at the end with all three result lines; push at the
end; then write (don't build) `docs/plans/step-06.md`.

### Notes carried to Day 2 (from decisions 6, 7 and 8)

- Recovery moves an exhausted job (`attempt >= max_attempts`) to `failed`, never to `queued`.
- Every lease comparison (`lease_expires_at < now()`, heartbeat extension, the commit-intent token
  check) is computed in SQL against the database's `now()`. A worker never sends a timestamp it
  computed, so clock skew between containers can't make a live lease look expired or a dead one
  look alive.
- Expired-lease recovery runs inside the dequeue loop (before or as part of each dequeue), so a
  tenant whose slots are held by dead workers is unblocked by the next poll, not by a timer.

### D-entry numbering

Part A lands first and its decision takes the next free number, **D15**. The six entries drafted in
§10 therefore land one number later than drafted: plan D15 (`pg`) → **D16**, D16 (migrations) →
**D17**, D17 (tenant lock) → **D18**, D18 (enqueue) → **D19**, D19 (test isolation) → **D20**, D20
(states) → **D21**. New entries from the decisions above follow: **D22** (database clock, decision 7)
and **D23** (credentials never in `jobs.params`, decision 1).
