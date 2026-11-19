// The replay result contract. business_outcome is deliberately distinct from failure: "no such
// member" is data the caller branches on, not a crash. failure.category is a narrow enum --
// only what's left of CLAUDE.md's error taxonomy once business outcomes and recoverable/
// transient states are pulled into their own statuses (recoverables are retried internally by
// replay and never surface as a failure).
import { z } from "zod";

export const FailureCategorySchema = z.enum(["unexpected-state", "session-timeout", "unknown"]);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

/**
 * Present on a non-success result → an irreversible action WAS attempted in this run, so the
 * commit may have happened: verify (e.g. via the bank's history) before any retry. Absent on a
 * non-success → nothing irreversible was attempted, so a blind retry is safe. Never on success (a
 * recognized success condition after the irreversible step is the confirmation). An optional field
 * rather than a fifth status, so the four-way union and each result's real classification stand
 * (docs/DECISIONS.md D10).
 */
export const CommitUncertainSchema = z.object({
  /** The irreversible step whose action was attempted in this run. */
  irreversibleStepId: z.string().min(1),
  /** Human-readable: what was observed after the attempt. */
  detail: z.string().min(1),
});
export type CommitUncertain = z.infer<typeof CommitUncertainSchema>;

export const ReplayResultSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    outputs: z.record(z.string(), z.unknown()),
    evidenceRef: z.string().min(1),
  }),
  z.object({
    status: z.literal("business_outcome"),
    code: z.string().min(1),
    detail: z.string().min(1),
    evidenceRef: z.string().min(1),
    commitUncertain: CommitUncertainSchema.optional(),
  }),
  z.object({
    status: z.literal("needs_human"),
    reason: z.string().min(1),
    atStepId: z.string().min(1),
    contextRef: z.string().min(1),
    commitUncertain: CommitUncertainSchema.optional(),
  }),
  z.object({
    status: z.literal("failure"),
    atStepId: z.string().min(1),
    expected: z.string().min(1),
    observed: z.string().min(1),
    category: FailureCategorySchema,
    evidenceRef: z.string().min(1),
    commitUncertain: CommitUncertainSchema.optional(),
  }),
]);
export type ReplayResult = z.infer<typeof ReplayResultSchema>;

/** The one-line operator warning for a result that carries commitUncertain, or null. */
export function commitUncertainWarning(result: ReplayResult): string | null {
  if (result.status === "success" || !result.commitUncertain) return null;
  return (
    `commit may have happened at ${result.commitUncertain.irreversibleStepId} -- verify before retrying ` +
    `(${result.commitUncertain.detail})`
  );
}
