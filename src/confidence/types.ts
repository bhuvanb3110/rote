// Per-capability approval status + confidence run history, persisted as a sidecar file (never in
// the artifact itself -- confidence is a property of a RUN against a surface, not of the
// artifact). Schema-first with Zod, same fail-loud serialize/deserialize pattern as
// src/tenant/types.ts's TenantOverride.
import { z } from "zod";

export const ConfidenceRunRecordSchema = z.object({
  runId: z.string().min(1),
  confidence: z.number().min(0).max(1),
  at: z.iso.datetime(),
});
export type ConfidenceRunRecord = z.infer<typeof ConfidenceRunRecordSchema>;

export const ApprovalStatusSchema = z.enum(["draft", "approved"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;

export const CapabilityStatusSchema = z.object({
  capabilityId: z.string().min(1),
  approvalStatus: ApprovalStatusSchema,
  history: z.array(ConfidenceRunRecordSchema),
  approvedAt: z.iso.datetime().optional(),
  approvedReason: z.string().min(1).optional(),
});
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;

export function serializeCapabilityStatus(status: CapabilityStatus): string {
  const validated = CapabilityStatusSchema.parse(status);
  return JSON.stringify(validated, null, 2);
}

export function deserializeCapabilityStatus(json: string): CapabilityStatus {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`Invalid CapabilityStatus JSON: ${(err as Error).message}`);
  }
  const result = CapabilityStatusSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`CapabilityStatus failed schema validation:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
