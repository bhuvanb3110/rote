// Applies a TenantOverride to a base Capability to produce the effective Capability replay
// actually executes. The base capability object is never mutated -- steps without an override
// entry keep the EXACT SAME descriptor object the base capability declared; only steps named in
// stepOverrides get a replacement target. Re-validated through CapabilitySchema so a malformed
// override fails loudly here, not partway through a live replay.
import { CapabilitySchema, type Capability } from "../artifact/index.js";
import type { TenantOverride } from "./types.js";

export function applyTenantOverride(capability: Capability, override: TenantOverride): Capability {
  if (override.capabilityId !== capability.id) {
    throw new Error(
      `Tenant override "${override.tenantId}" is for capability "${override.capabilityId}", ` +
        `not "${capability.id}".`,
    );
  }

  const steps = capability.steps.map((step) => {
    const overrideTarget = override.stepOverrides[step.id];
    if (!overrideTarget) return step;
    return { ...step, target: overrideTarget };
  });

  return CapabilitySchema.parse({
    ...capability,
    steps,
    successCondition: override.successCondition ?? capability.successCondition,
  });
}
