// Zod schemas for queue rows: rows coming back from Postgres are PARSED, never cast (CLAUDE.md:
// schema-first, one definition = type + runtime validator). Column names stay snake_case, exactly
// as in db/migrations/0001_init.sql, so the SQL and the types read the same.
import { z } from "zod";

export const JOB_STATES = [
  "queued",
  "running",
  "committing",
  "verifying",
  "succeeded",
  "business_outcome",
  "failed",
  "needs_human",
] as const;
export const JobStateSchema = z.enum(JOB_STATES);
export type JobState = z.infer<typeof JobStateSchema>;

/** States that hold a lease and count toward the tenant's max_concurrent (reviewer decision 4). */
export const ACTIVE_STATES = ["running", "committing", "verifying"] as const satisfies readonly JobState[];
/** No further transitions. business_outcome is terminal: a bank refusal is final, never retried (D21). */
export const TERMINAL_STATES = ["succeeded", "business_outcome", "failed", "needs_human"] as const satisfies readonly JobState[];

export const JobRowSchema = z.object({
  id: z.uuid(),
  idempotency_key: z.string().min(1).max(255),
  request_hash: z.string().regex(/^[0-9a-f]{64}$/),
  tenant_id: z.string().min(1),
  capability_id: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  state: JobStateSchema,
  attempt: z.number().int().nonnegative(),
  max_attempts: z.number().int().min(1),
  lease_owner: z.string().nullable(),
  lease_expires_at: z.date().nullable(),
  fencing_token: z.number().int().nonnegative(),
  trace_id: z.string().regex(/^[0-9a-f]{32}$/),
  commit_intent_at: z.date().nullable(),
  outcome: z.string().nullable(),
  error: z.string().nullable(),
  result: z.unknown().nullable(),
  memo_key: z.string().length(41),
  created_at: z.date(),
  updated_at: z.date(),
});
export type JobRow = z.infer<typeof JobRowSchema>;

export const AttemptRowSchema = z.object({
  id: z.number().int().positive(),
  job_id: z.uuid(),
  attempt: z.number().int().min(1),
  worker_id: z.string().min(1),
  fencing_token: z.number().int().min(1),
  started_at: z.date(),
  ended_at: z.date().nullable(),
  outcome: z.string().nullable(),
  commit_uncertain: z.boolean(),
  trace_id: z.string().nullable(),
  error: z.string().nullable(),
});
export type AttemptRow = z.infer<typeof AttemptRowSchema>;
