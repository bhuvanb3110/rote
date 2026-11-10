// Per-capability approval status + confidence run history, persisted as a sidecar file (never in
// the artifact itself -- confidence is a property of a RUN against a surface, not of the
// artifact). Schema-first with Zod, same fail-loud serialize/deserialize pattern as
// src/tenant/types.ts's TenantOverride.
import { z } from "zod";
import { SEMVER_REGEX } from "../artifact/schema.js";
import { SHA256_HEX_REGEX } from "../artifact/canonical.js";

const VersionSchema = z.string().regex(SEMVER_REGEX, "version must be semantic, e.g. 1.0.0");
const DigestSchema = z.string().regex(SHA256_HEX_REGEX, "digest must be 64 lowercase hex characters (SHA-256)");

export const ConfidenceRunRecordSchema = z.object({
  runId: z.string().min(1),
  confidence: z.number().min(0).max(1),
  at: z.iso.datetime(),
  /**
   * The artifact version this run replayed. Optional so history written before approvals were
   * version-bound still parses; a record without it never counts toward promoting a specific
   * version (see consecutiveQualifyingRuns).
   */
  version: VersionSchema.optional(),
  /**
   * capabilityDigest() of the artifact this run replayed (D24). Optional for the same reason; a run
   * without it never counts toward promoting a specific digest.
   */
  digest: DigestSchema.optional(),
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
  /**
   * The artifact version the approval covers (docs/DECISIONS.md D15). Every approval written since
   * 2026-11-09 sets it; checkApproval refuses an artifact whose version differs. Optional so status
   * files written before then still parse: a missing value is treated as grandfathered (allowed,
   * and the gate's reason says so).
   */
  approvedVersion: VersionSchema.optional(),
  /**
   * capabilityDigest() -- SHA-256 of the canonical JSON -- of the exact artifact content the approval
   * covers (docs/DECISIONS.md D24). Every approval written since D24 sets it; checkApproval refuses
   * an artifact whose digest differs even when the version matches. Optional so older files still
   * parse: a missing value falls back to the version check alone (grandfathered, and the gate's
   * reason says so).
   */
  approvedDigest: DigestSchema.optional(),
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
