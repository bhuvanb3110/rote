// Loads Capability artifacts from disk into an agent-facing catalog. Reuses the existing
// validated deserializeCapability loader -- an artifact that fails schema validation fails loudly
// here too, the same as it would loading a single file for replay.
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { deserializeCapability, type Capability } from "../artifact/index.js";
import { resolveTenant, DEFAULT_OVERRIDES_DIR } from "../tenant/index.js";
import { readCapabilityStatus } from "../confidence/index.js";
import { capabilityToJsonSchema, type CatalogEntry } from "./schema.js";

export const DEFAULT_ARTIFACTS_DIR = "artifacts";

export async function loadCapabilities(artifactsDir: string = DEFAULT_ARTIFACTS_DIR): Promise<Capability[]> {
  const files = (await readdir(artifactsDir)).filter((file) => file.endsWith(".json"));
  return Promise.all(
    files.map(async (file) => deserializeCapability(await readFile(path.join(artifactsDir, file), "utf8"))),
  );
}

export async function findCapability(
  id: string,
  artifactsDir: string = DEFAULT_ARTIFACTS_DIR,
): Promise<Capability | undefined> {
  const capabilities = await loadCapabilities(artifactsDir);
  return capabilities.find((capability) => capability.id === id);
}

export interface ListCapabilitiesOptions {
  tenant?: string;
  artifactsDir?: string;
  overridesDir?: string;
}

/**
 * Lists every capability as an agent-callable entry. When `tenant` is given, a per-capability
 * override is resolved best-effort: most capabilities won't have one for a given tenant, and a
 * missing override file is not an error -- that capability's entry just omits `entryUrl`, same
 * as if no tenant had been requested at all.
 */
export async function listCapabilities(options: ListCapabilitiesOptions = {}): Promise<CatalogEntry[]> {
  const capabilities = await loadCapabilities(options.artifactsDir);
  return Promise.all(
    capabilities.map(async (capability) => {
      const status = await readCapabilityStatus(capability.id);
      const entry: CatalogEntry = {
        id: capability.id,
        name: capability.name,
        description: capability.description,
        version: capability.version,
        approvalStatus: status.approvalStatus,
        ...capabilityToJsonSchema(capability),
      };
      if (!options.tenant) return entry;
      try {
        const { entryUrl } = await resolveTenant(
          capability,
          options.tenant,
          "",
          options.overridesDir ?? DEFAULT_OVERRIDES_DIR,
        );
        return { ...entry, tenant: options.tenant, entryUrl };
      } catch (err) {
        // No override file for this capability+tenant is expected (most capabilities won't have
        // a per-tenant override) -- omit entryUrl and move on. Anything else (a malformed
        // override that fails schema validation) is a real bug and should surface.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return entry;
        throw err;
      }
    }),
  );
}
