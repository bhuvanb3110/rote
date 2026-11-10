// Minimal Express endpoint over the catalog: GET /capabilities (list) and POST
// /capabilities/:id/invoke (invoke). Same minimal style as src/escalation/console.ts -- no extra
// framework layers, Express is already a dependency. A ReplayResult is returned as-is with 200
// regardless of its own status field: business_outcome/needs_human/failure are normal outcomes
// per CLAUDE.md, not HTTP errors. Only a pre-replay problem (unknown id, invalid params) is an
// HTTP error.
//
// Fleet (docs/plans/step-06.md section 4, D27): with `{ queue: { pool } }` the same app also offers
//   POST /capabilities/:id/invoke?mode=async   (header Idempotency-Key)  -> enqueue a job
//   GET  /jobs/:id?tenant=<tenant>                                       -> job status
//   GET  /healthz                                                         -> Postgres reachable
// Without `queue` (every existing caller and test) the app is exactly the synchronous one, except
// that ?mode=async is refused (501) instead of being silently run synchronously.
//
// NOT AUTHENTICATION: the `tenant` in a request is whatever the caller says. Scoping GET /jobs/:id by
// ?tenant= only stops one tenant from reading another's job by id; this project has no auth by scope.
import express, { type Express, type Request, type Response } from "express";
import { checkApproval } from "../confidence/index.js";
import {
  CredentialsInParamsError,
  enqueue,
  IdempotencyKeyConflict,
  InvalidParamsError,
  JobRowSchema,
  ReservedParamError,
  sqlState,
  validateJobParams,
  type JobRow,
  type Pool,
} from "../queue/index.js";
import { isTransientDbError } from "../queue/index.js";
import { DEFAULT_ARTIFACTS_DIR, findCapability, listCapabilities } from "./registry.js";
import { invokeCapability } from "./invoke.js";

export interface CatalogQueueOptions {
  pool: Pool;
  artifactsDir?: string;
  /** Where the enqueue-time approval check reads status/ (default "status"). */
  statusDir?: string;
}

export interface CatalogAppOptions {
  queue?: CatalogQueueOptions;
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 255;
const ASYNC_BODY_KEYS = new Set(["tenant", "params"]);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function jobLink(job: Pick<JobRow, "id" | "tenant_id">): string {
  return `/jobs/${job.id}?tenant=${encodeURIComponent(job.tenant_id)}`;
}

/** The public shape of a job. Never credentials: they are never stored (D23). */
export function jobView(job: JobRow) {
  return {
    id: job.id,
    tenant: job.tenant_id,
    capabilityId: job.capability_id,
    state: job.state,
    attempt: job.attempt,
    maxAttempts: job.max_attempts,
    outcome: job.outcome,
    error: job.error,
    result: job.result,
    memoKey: job.memo_key,
    traceId: job.trace_id,
    createdAt: job.created_at.toISOString(),
    updatedAt: job.updated_at.toISOString(),
  };
}

function databaseUnavailable(res: Response): void {
  res.status(503).set("Retry-After", "2").json({ error: "job queue database unavailable; retry shortly" });
}

async function handleAsyncInvoke(queue: CatalogQueueOptions, req: Request, res: Response): Promise<void> {
  const key = req.get("Idempotency-Key");
  if (!key || key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    res.status(400).json({ error: `Idempotency-Key header is required (1..${MAX_IDEMPOTENCY_KEY_LENGTH} characters)` });
    return;
  }
  const body = (req.body ?? {}) as Record<string, unknown>;
  const extra = Object.keys(body).filter((k) => !ASYNC_BODY_KEYS.has(k));
  if (extra.length > 0) {
    // approveRisky / approveUnattended / entryUrl in particular: async jobs never take run-time
    // approvals or targets from the client.
    res.status(400).json({ error: `async invoke accepts only "tenant" and "params"; not allowed: ${extra.join(", ")}` });
    return;
  }
  if (typeof body.tenant !== "string" || body.tenant === "") {
    res.status(400).json({ error: `"tenant" is required` });
    return;
  }
  const params = body.params ?? {};
  if (typeof params !== "object" || params === null || Array.isArray(params)) {
    res.status(400).json({ error: `"params" must be an object` });
    return;
  }

  const capability = await findCapability(String(req.params.id), queue.artifactsDir ?? DEFAULT_ARTIFACTS_DIR);
  if (!capability) {
    res.status(404).json({ error: `No capability with id "${req.params.id}".` });
    return;
  }
  try {
    validateJobParams(capability, params as Record<string, unknown>);
  } catch (err) {
    if (err instanceof CredentialsInParamsError || err instanceof ReservedParamError || err instanceof InvalidParamsError) {
      res.status(400).json({ error: err.message });
      return;
    }
    throw err;
  }
  // Fail fast (reviewer decision B4); the worker's run-time check is still the authoritative one.
  const approval = await checkApproval(capability, { statusDir: queue.statusDir });
  if (!approval.allowed) {
    res.status(422).json({ error: approval.reason });
    return;
  }

  try {
    const { job, created } = await enqueue(queue.pool, {
      capability,
      tenantId: body.tenant,
      idempotencyKey: key,
      params: params as Record<string, unknown>,
    });
    const link = jobLink(job);
    res
      .status(created ? 201 : 200)
      .set("Location", link)
      .json({
        jobId: job.id,
        state: job.state,
        tenant: job.tenant_id,
        capabilityId: job.capability_id,
        memoKey: job.memo_key,
        links: { self: link },
      });
  } catch (err) {
    if (err instanceof IdempotencyKeyConflict) {
      res.status(409).json({ error: err.message, jobId: err.existingJobId });
      return;
    }
    if (sqlState(err) === "23503") {
      res.status(404).json({ error: `No tenant "${body.tenant}".` });
      return;
    }
    if (isTransientDbError(err)) {
      databaseUnavailable(res);
      return;
    }
    throw err;
  }
}

async function handleGetJob(queue: CatalogQueueOptions, req: Request, res: Response): Promise<void> {
  const tenant = typeof req.query.tenant === "string" ? req.query.tenant : "";
  if (!tenant) {
    res.status(400).json({ error: `?tenant= is required (scoping only; this is not authentication)` });
    return;
  }
  const id = String(req.params.id);
  const notFound = () => res.status(404).json({ error: `No job "${id}" for tenant "${tenant}".` });
  if (!UUID_RE.test(id)) {
    notFound();
    return;
  }
  try {
    const { rows } = await queue.pool.query("SELECT * FROM jobs WHERE id = $1 AND tenant_id = $2", [id, tenant]);
    if (rows.length === 0) {
      // Another tenant's job looks exactly like a missing one.
      notFound();
      return;
    }
    res.json(jobView(JobRowSchema.parse(rows[0])));
  } catch (err) {
    if (isTransientDbError(err)) {
      databaseUnavailable(res);
      return;
    }
    throw err;
  }
}

export function createCatalogApp(options: CatalogAppOptions = {}): Express {
  const app = express();
  app.use(express.json());
  const queue = options.queue;

  app.get("/capabilities", async (req, res) => {
    const tenant = typeof req.query.tenant === "string" ? req.query.tenant : undefined;
    const entries = await listCapabilities({ tenant });
    res.json(entries);
  });

  app.post("/capabilities/:id/invoke", async (req, res) => {
    const mode = req.query.mode;
    if (mode !== undefined && mode !== "sync" && mode !== "async") {
      res.status(400).json({ error: `mode must be "sync" or "async"` });
      return;
    }
    if (mode === "async") {
      if (!queue) {
        res.status(501).json({ error: "async mode needs the job queue (catalog serve --queue)" });
        return;
      }
      try {
        await handleAsyncInvoke(queue, req, res);
      } catch (err) {
        res.status(500).json({ error: `internal error: ${(err as Error).name}` });
      }
      return;
    }

    const body = (req.body ?? {}) as {
      params?: Record<string, unknown>;
      tenant?: string;
      entryUrl?: string;
      approveRisky?: boolean;
      approveUnattended?: boolean;
    };
    try {
      const result = await invokeCapability({
        id: req.params.id,
        params: body.params ?? {},
        tenant: body.tenant,
        entryUrl: body.entryUrl,
        approveRisky: body.approveRisky,
        approveUnattended: body.approveUnattended,
      });
      res.json(result);
    } catch (err) {
      const message = (err as Error).message;
      const status = message.startsWith("No capability with id") ? 404 : 400;
      res.status(status).json({ error: message });
    }
  });

  if (queue) {
    app.get("/jobs/:id", async (req, res) => {
      try {
        await handleGetJob(queue, req, res);
      } catch (err) {
        res.status(500).json({ error: `internal error: ${(err as Error).name}` });
      }
    });

    app.get("/healthz", async (_req, res) => {
      try {
        await queue.pool.query("SELECT 1");
        res.json({ ok: true });
      } catch {
        databaseUnavailable(res);
      }
    });
  }

  return app;
}
