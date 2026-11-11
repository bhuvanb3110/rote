// Content digests of tenant overrides, so an approval can cover them (docs/DECISIONS.md D30). An
// override changes what a tenant's replay executes (its locators, its successCondition, its entry
// URL), so an approval of the base artifact alone says nothing about it. Same rule as the artifact
// digest (D24): SHA-256 of the canonical JSON of the schema-validated override, so whitespace, line
// endings and key order never change it, and any value change does.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "../artifact/index.js";
import { deserializeTenantOverride, TenantOverrideSchema, type TenantOverride } from "./types.js";

/** SHA-256 (64 lowercase hex) of the override's canonical JSON, after validation. */
export function tenantOverrideDigest(override: TenantOverride): string {
  const validated = TenantOverrideSchema.parse(override);
  return createHash("sha256").update(canonicalJson(validated), "utf8").digest("hex");
}

/**
 * Every override file of this capability in `overridesDir` (`<capabilityId>.<tenantId>.json`), as
 * tenantId -> digest. A file whose own tenantId/capabilityId disagree with its name is an error: the
 * approval would otherwise be recorded under the wrong tenant. A missing directory means no overrides.
 */
export async function tenantOverrideDigests(
  capabilityId: string,
  overridesDir: string,
): Promise<Record<string, string>> {
  let names: string[];
  try {
    names = await readdir(overridesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  const prefix = `${capabilityId}.`;
  const digests: Record<string, string> = {};
  for (const name of names.sort()) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const tenantFromName = name.slice(prefix.length, -".json".length);
    // "open-sub-account.x.json" must not be read as an override of "open-sub-account" with tenant
    // "x" when it belongs to a capability id containing a dot; ids and tenants here have none.
    if (tenantFromName === "" || tenantFromName.includes(".")) continue;
    const override = deserializeTenantOverride(await readFile(path.join(overridesDir, name), "utf8"));
    if (override.tenantId !== tenantFromName || override.capabilityId !== capabilityId) {
      throw new Error(
        `${name}: file name says ${capabilityId}/${tenantFromName}, content says ` +
          `${override.capabilityId}/${override.tenantId}.`,
      );
    }
    digests[tenantFromName] = tenantOverrideDigest(override);
  }
  return digests;
}
