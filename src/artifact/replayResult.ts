// The replay result contract. business_outcome is deliberately distinct from failure: "no such
// member" is data the caller branches on, not a crash. failure.category is a narrow enum --
// only what's left of CLAUDE.md's error taxonomy once business outcomes and recoverable/
// transient states are pulled into their own statuses (recoverables are retried internally by
// replay and never surface as a failure).
import { z } from "zod";

export const FailureCategorySchema = z.enum(["unexpected-state", "session-timeout", "unknown"]);
export type FailureCategory = z.infer<typeof FailureCategorySchema>;

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
  }),
  z.object({
    status: z.literal("needs_human"),
    reason: z.string().min(1),
    atStepId: z.string().min(1),
    contextRef: z.string().min(1),
  }),
  z.object({
    status: z.literal("failure"),
    atStepId: z.string().min(1),
    expected: z.string().min(1),
    observed: z.string().min(1),
    category: FailureCategorySchema,
    evidenceRef: z.string().min(1),
  }),
]);
export type ReplayResult = z.infer<typeof ReplayResultSchema>;
