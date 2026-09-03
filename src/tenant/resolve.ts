// Shared tenant-resolution convention: when a tenantId is given, loads
// overrides/<capabilityId>.<tenantId>.json and applies it, returning the effective Capability AND
// the entry URL to replay against -- the override's own entryUrl, not the caller's fallback,
// since the whole point of passing a tenant is that the caller shouldn't have to also know each
// tenant's URL by hand. Without a tenantId, this is a no-op: same capability, same fallback URL.
// Used by both the CLI (replay/operator) and the catalog invoke path so the convention lives in
// exactly one place.
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Capability } from "../artifact/index.js";
import { applyTenantOverride } from "./apply.js";
import { deserializeTenantOverride } from "./types.js";

export const DEFAULT_OVERRIDES_DIR = "overrides";

export async function resolveTenant(
  capability: Capability,
  tenantId: string | undefined,
  fallbackUrl: string,
  overridesDir: string = DEFAULT_OVERRIDES_DIR,
): Promise<{ capability: Capability; entryUrl: string }> {
  if (!tenantId) return { capability, entryUrl: fallbackUrl };
  const overridePath = path.join(overridesDir, `${capability.id}.${tenantId}.json`);
  const override = deserializeTenantOverride(await readFile(overridePath, "utf8"));
  return { capability: applyTenantOverride(capability, override), entryUrl: override.entryUrl };
}
