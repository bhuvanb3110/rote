-- 0001_init: the fleet queue schema.
-- Design: docs/plans/step-05.md section 3, with the reviewer decisions of 2026-11-09 (same file):
-- idempotency keys unique PER TENANT, business_outcome as an 8th terminal state, and a queued job
-- always has attempts left. Rationale: docs/DECISIONS.md D18-D23.
--
-- Small vocabularies are text + CHECK, not enums (D21). All SQL is unqualified: it lands in the
-- session's current schema (public in the app database, one schema per test file in tests).
-- Applied once and never edited; changes go in a new numbered file.

-- One row per bank tenant. Same ids as mock-app/tenants.ts and overrides/*.<tenant>.json.
CREATE TABLE tenants (
  id             text PRIMARY KEY CHECK (id ~ '^[a-z0-9][a-z0-9-]{0,62}$'),
  max_concurrent int  NOT NULL CHECK (max_concurrent BETWEEN 1 AND 100),
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Dev defaults; change with an UPDATE.
INSERT INTO tenants (id, max_concurrent) VALUES
  ('tenant-a', 2),
  ('tenant-b', 2),
  ('tenant-c', 2);

CREATE TABLE jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Unique per tenant (constraint below), never globally: a global key would let tenant B learn
  -- that tenant A used a key (B would get a 409 on A's key).
  idempotency_key  text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 255),
  -- SHA-256 (hex) of canonical JSON {tenant, capability_id, params}; params never hold secrets.
  request_hash     text NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  tenant_id        text NOT NULL REFERENCES tenants (id),
  -- Not a foreign key: capabilities live in artifacts/, not in the database.
  capability_id    text NOT NULL CHECK (length(capability_id) BETWEEN 1 AND 200),
  -- Business params only, NEVER credentials (reviewer decision 1, D23): enqueue rejects any input
  -- the capability marks redact: true; the worker injects credentials per tenant.
  params           jsonb NOT NULL CHECK (jsonb_typeof(params) = 'object'),
  state            text NOT NULL DEFAULT 'queued' CHECK (state IN (
                     'queued', 'running', 'committing', 'verifying',
                     'succeeded', 'business_outcome', 'failed', 'needs_human')),
  -- Incremented on every dequeue.
  attempt          int  NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  max_attempts     int  NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 20),
  lease_owner      text,
  -- Always computed from the DATABASE clock (now()), never a worker's clock (D22).
  lease_expires_at timestamptz,
  -- Incremented on every lease; Day 2 checks it on heartbeat and on the commit intent.
  fencing_token    bigint NOT NULL DEFAULT 0 CHECK (fencing_token >= 0),
  -- W3C trace id, generated at enqueue, so every attempt joins one trace.
  trace_id         text NOT NULL CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  commit_intent_at timestamptz,
  -- Short terminal label (success, business_outcome, failure, already_done, ...).
  outcome          text,
  -- Redacted, human-readable.
  error            text,
  -- The final ReplayResult (already redacted by replay), including commitUncertain.
  result           jsonb,
  -- The 41-character memo the worker types (D5). Generated, so it can never disagree with id.
  memo_key         text GENERATED ALWAYS AS ('rote-' || id::text) STORED,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Set explicitly by every UPDATE (no trigger: all SQL stays visible).
  updated_at       timestamptz NOT NULL DEFAULT now(),

  -- Correctness of the race-safe enqueue (ON CONFLICT (tenant_id, idempotency_key)), not just speed.
  CONSTRAINT jobs_tenant_idempotency_key_key UNIQUE (tenant_id, idempotency_key),
  -- A lease is both fields or neither.
  CONSTRAINT jobs_lease_pair CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  -- An active job always has an owner. An EXPIRED lease keeps its owner until Day-2 recovery moves
  -- the job on; that owner is what recovery reads.
  CONSTRAINT jobs_active_has_owner CHECK (
    state NOT IN ('running', 'committing', 'verifying') OR lease_owner IS NOT NULL),
  CONSTRAINT jobs_committing_has_intent CHECK (state <> 'committing' OR commit_intent_at IS NOT NULL),
  -- Reviewer decision 6 (tenant starvation): a queued job always has an attempt left, so every
  -- queued job is dequeueable. Day-2 recovery moves an exhausted job to 'failed', never 'queued'.
  CONSTRAINT jobs_queued_has_attempts_left CHECK (state <> 'queued' OR attempt < max_attempts)
);

-- Waiting jobs only (partial, so it stays small however many finished rows pile up). Serves "does
-- this tenant have queued work", "its oldest queued job" (fairness) and the per-tenant pick.
CREATE INDEX jobs_queued_by_tenant ON jobs (tenant_id, created_at, id) WHERE state = 'queued';

-- The per-tenant active count for max_concurrent. Tiny: at most workers x tenants rows.
CREATE INDEX jobs_active_by_tenant ON jobs (tenant_id)
  WHERE state IN ('running', 'committing', 'verifying');

-- One row per attempt (= per lease), inserted in the dequeue transaction, so a lease with no
-- attempt row cannot exist.
CREATE TABLE job_attempts (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  job_id           uuid   NOT NULL REFERENCES jobs (id) ON DELETE CASCADE,
  attempt          int    NOT NULL CHECK (attempt >= 1),
  worker_id        text   NOT NULL,
  fencing_token    bigint NOT NULL CHECK (fencing_token >= 1),
  started_at       timestamptz NOT NULL DEFAULT now(),
  ended_at         timestamptz CHECK (ended_at IS NULL OR ended_at >= started_at),
  -- success, business_outcome, needs_human, failure, lease_lost, aborted, crashed (set by recovery).
  outcome          text,
  -- Copied from the ReplayResult (D10).
  commit_uncertain boolean NOT NULL DEFAULT false,
  trace_id         text,
  error            text,
  -- Each attempt and each lease is recorded exactly once; if a bug ever let two workers hold the
  -- same token, the second insert fails instead of hiding it.
  CONSTRAINT job_attempts_job_attempt_key UNIQUE (job_id, attempt),
  CONSTRAINT job_attempts_job_token_key UNIQUE (job_id, fencing_token)
);

-- Circuit breaker per capability. Created now so the schema is complete; transitions and the
-- dequeue filter are Day-3 work.
CREATE TABLE breakers (
  capability_id        text PRIMARY KEY,
  state                text NOT NULL DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half_open')),
  consecutive_failures int  NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
  opened_at            timestamptz,
  probe_job_id         uuid REFERENCES jobs (id),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT breakers_open_has_opened_at CHECK (state <> 'open' OR opened_at IS NOT NULL)
);
