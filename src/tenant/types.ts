// A tenant override is data, not code: a thin patch applied to a base Capability at replay
// time, never a second copy of the artifact. Only steps that genuinely differ on that tenant
// get an entry; every other step reuses the base capability's own descriptor untouched.
import { z } from "zod";
import { CheckpointSchema, ElementDescriptorSchema } from "../artifact/index.js";

export const TenantOverrideSchema = z.object({
  tenantId: z.string().min(1),
  /** The base Capability this override applies to -- applying it to any other id fails loudly. */
  capabilityId: z.string().min(1),
  /** Concrete URL to navigate to before step 1, replacing the base capability's entryUrl. */
  entryUrl: z.string().min(1),
  /** Step id -> replacement ElementDescriptor, for exactly the steps that differ on this tenant. */
  stepOverrides: z.record(z.string(), ElementDescriptorSchema),
  /**
   * Replaces the base capability's successCondition, only if it references something
   * tenant-specific (e.g. a label that also differs). Omit to reuse the base's successCondition
   * unchanged -- most overrides won't need this.
   */
  successCondition: CheckpointSchema.optional(),
});
export type TenantOverride = z.infer<typeof TenantOverrideSchema>;

export function deserializeTenantOverride(json: string): TenantOverride {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`Invalid TenantOverride JSON: ${(err as Error).message}`);
  }
  const result = TenantOverrideSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`TenantOverride failed schema validation:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
