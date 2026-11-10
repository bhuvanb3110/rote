// Enqueue with an Idempotency-Key: ONE race-safe statement (docs/DECISIONS.md D19).
//
//   INSERT … ON CONFLICT (tenant_id, idempotency_key) DO UPDATE SET <no-op> RETURNING *
//
// Why DO UPDATE and not DO NOTHING + SELECT: when two requests with the same key race, the loser's
// INSERT waits on the winner's uncommitted row; after the winner commits, DO NOTHING skips, and a
// SELECT in the same statement reads the statement's snapshot, taken BEFORE the winner committed,
// so the loser gets no row at all. ON CONFLICT DO UPDATE locks and returns the latest committed
// conflicting row, so every caller gets the winner's job id. (enqueue.db.test.ts forces both
// interleavings.)
//
// Keys are unique PER TENANT (reviewer decision 3): a global key would let tenant B learn that
// tenant A used a key (B would get a 409 on A's key).
//
// Params are business params only (reviewer decision 1, D23): any input the capability marks
// redact: true is REJECTED, never stored, so credentials never sit in Postgres or a row dump, and
// request_hash covers only non-secret params. The worker injects credentials per tenant (Step 6).
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { canonicalJson, type Capability } from "../artifact/index.js";
import { inputsToZodSchema } from "../catalog/schema.js";
import type { Queryable } from "./db.js";
import { JobRowSchema, type JobRow } from "./types.js";

/**
 * The input a capability with an irreversible step gets its idempotency marker in: the worker types
 * the job's memo_key there (D5), so a client cannot supply it (it would be silently replaced).
 */
export const MEMO_INPUT = "memo";

export const DEFAULT_MAX_ATTEMPTS = 3;

export type EnqueueCapability = Pick<Capability, "id" | "inputs" | "steps">;

export interface EnqueueInput {
  /** The capability (from artifacts/): its inputs decide what params may be stored. */
  capability: EnqueueCapability;
  tenantId: string;
  idempotencyKey: string;
  /** Business params only: never credentials, never the memo of an irreversible capability. */
  params: Record<string, unknown>;
  /** Default 3. Not part of request_hash: a replay of the same request returns the existing job as is. */
  maxAttempts?: number;
}

export interface EnqueueResult {
  job: JobRow;
  /** true: this call inserted the job (API 201). false: an existing job was returned (API 200). */
  created: boolean;
}

/** The same Idempotency-Key was used for a DIFFERENT request in this tenant (API 409). */
export class IdempotencyKeyConflict extends Error {
  constructor(
    readonly tenantId: string,
    readonly idempotencyKey: string,
    readonly existingJobId: string,
  ) {
    super(
      `Idempotency-Key already used in tenant "${tenantId}" for a different request (job ${existingJobId}); ` +
        `the original job is unchanged.`,
    );
    this.name = "IdempotencyKeyConflict";
  }
}

/** params named an input the capability marks redact: true (API 400). Never echoes the values. */
export class CredentialsInParamsError extends Error {
  constructor(
    readonly capabilityId: string,
    readonly fields: string[],
  ) {
    super(
      `Params for "${capabilityId}" must not contain credentials (${fields.join(", ")} ` +
        `${fields.length === 1 ? "is" : "are"} marked redact: true). They are injected per tenant by the worker ` +
        `and are never stored in the queue.`,
    );
    this.name = "CredentialsInParamsError";
  }
}

/** params named the memo input of a capability with an irreversible step (API 400). */
export class ReservedParamError extends Error {
  constructor(
    readonly capabilityId: string,
    readonly fields: string[],
  ) {
    super(
      `Params for "${capabilityId}" must not contain ${fields.join(", ")}: the worker writes the job's ` +
        `memo_key there so the transfer can be found in the bank's history (docs/DECISIONS.md D5).`,
    );
    this.name = "ReservedParamError";
  }
}

/** params failed the capability's (non-secret) input schema (API 400). */
export class InvalidParamsError extends Error {
  constructor(
    readonly capabilityId: string,
    detail: string,
  ) {
    super(`Invalid params for "${capabilityId}":\n${detail}`);
    this.name = "InvalidParamsError";
  }
}

export function hasIrreversibleStep(capability: Pick<Capability, "steps">): boolean {
  return capability.steps.some((step) => step.risk === "risky");
}

/** Names of inputs the queue never stores: credentials always; the memo of an irreversible capability. */
export function workerSuppliedInputs(capability: EnqueueCapability): string[] {
  const names = capability.inputs.filter((i) => i.redact).map((i) => i.name);
  if (hasIrreversibleStep(capability) && capability.inputs.some((i) => i.name === MEMO_INPUT && !i.redact)) {
    names.push(MEMO_INPUT);
  }
  return names;
}

/**
 * Rejects credentials (typed, first, so the error says exactly that), then the reserved memo, then
 * validates the remaining params STRICTLY against the capability's other inputs: an unknown key is
 * an error, so a stray "pwd" can't slip into a stored row under a name the capability doesn't
 * declare.
 */
export function validateJobParams(capability: EnqueueCapability, params: Record<string, unknown>): Record<string, unknown> {
  const has = (name: string) => Object.prototype.hasOwnProperty.call(params, name);
  const secrets = capability.inputs.filter((i) => i.redact && has(i.name)).map((i) => i.name);
  if (secrets.length > 0) throw new CredentialsInParamsError(capability.id, secrets);

  const supplied = new Set(workerSuppliedInputs(capability));
  const reserved = [...supplied].filter((name) => has(name));
  if (reserved.length > 0) throw new ReservedParamError(capability.id, reserved);

  const jobInputs = capability.inputs.filter((i) => !supplied.has(i.name));
  const parsed = inputsToZodSchema(jobInputs).strict().safeParse(params);
  if (!parsed.success) throw new InvalidParamsError(capability.id, z.prettifyError(parsed.error));
  return parsed.data;
}

/** Re-exported from its new home (src/artifact/canonical.ts) so existing imports keep working. */
export { canonicalJson };

/** SHA-256 hex of canonical {tenant, capability_id, params}. params are already secret-free. */
export function computeRequestHash(tenantId: string, capabilityId: string, params: Record<string, unknown>): string {
  return createHash("sha256")
    .update(canonicalJson({ tenant: tenantId, capability_id: capabilityId, params }), "utf8")
    .digest("hex");
}

/** W3C trace id: 16 random bytes as 32 lowercase hex characters. */
export function newTraceId(): string {
  return randomBytes(16).toString("hex");
}

export const ENQUEUE_SQL = `
INSERT INTO jobs (idempotency_key, request_hash, tenant_id, capability_id, params, max_attempts, trace_id)
VALUES ($1, $2, $3, $4, $5, $6, $7)
ON CONFLICT (tenant_id, idempotency_key) DO UPDATE
  SET idempotency_key = EXCLUDED.idempotency_key   -- deliberate no-op: lock + return the committed row
RETURNING *, (xmax = 0) AS created`;

/**
 * Enqueue one job, or return the existing job for this (tenant, Idempotency-Key). `db` is a pool or
 * a checked-out client. Throws CredentialsInParamsError / ReservedParamError / InvalidParamsError
 * before touching the database, and IdempotencyKeyConflict when the key was used for a different
 * request in this tenant.
 */
export async function enqueue(db: Queryable, input: EnqueueInput): Promise<EnqueueResult> {
  const params = validateJobParams(input.capability, input.params);
  const requestHash = computeRequestHash(input.tenantId, input.capability.id, params);
  const { rows } = await db.query(ENQUEUE_SQL, [
    input.idempotencyKey,
    requestHash,
    input.tenantId,
    input.capability.id,
    params,
    input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    newTraceId(),
  ]);
  const { created, ...row } = rows[0] as Record<string, unknown> & { created: boolean };
  const job = JobRowSchema.parse(row);
  // (xmax = 0) only picks 201 vs 200; correctness rests on the job id every caller gets back.
  if (!created && job.request_hash !== requestHash) {
    throw new IdempotencyKeyConflict(input.tenantId, input.idempotencyKey, job.id);
  }
  return { job, created };
}
