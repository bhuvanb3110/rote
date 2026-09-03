// Invokes a capability by id: looks it up, validates params against its own declared inputs
// (fail fast, before any browser is ever launched), resolves an optional tenant override, then
// calls the EXISTING runReplay -- no new replay logic, this is a thin discovery/invocation layer
// over what already exists.
import { z } from "zod";
import type { ReplayResult } from "../artifact/index.js";
import { runReplay } from "../replay/index.js";
import { resolveTenant, DEFAULT_OVERRIDES_DIR } from "../tenant/index.js";
import { findCapability, DEFAULT_ARTIFACTS_DIR } from "./registry.js";
import { inputsToZodSchema } from "./schema.js";

export const DEFAULT_ENTRY_URL = "http://localhost:4100";

export interface InvokeCapabilityOptions {
  id: string;
  params: Record<string, unknown>;
  tenant?: string;
  entryUrl?: string;
  artifactsDir?: string;
  overridesDir?: string;
  headless?: boolean;
  approveRisky?: boolean;
  approveUnattended?: boolean;
}

export async function invokeCapability(options: InvokeCapabilityOptions): Promise<ReplayResult> {
  const capability = await findCapability(options.id, options.artifactsDir ?? DEFAULT_ARTIFACTS_DIR);
  if (!capability) {
    throw new Error(`No capability with id "${options.id}".`);
  }

  const parsedParams = inputsToZodSchema(capability.inputs).safeParse(options.params);
  if (!parsedParams.success) {
    throw new Error(
      `Invalid params for capability "${options.id}":\n${z.prettifyError(parsedParams.error)}`,
    );
  }

  const { capability: effective, entryUrl } = await resolveTenant(
    capability,
    options.tenant,
    options.entryUrl ?? DEFAULT_ENTRY_URL,
    options.overridesDir ?? DEFAULT_OVERRIDES_DIR,
  );

  return runReplay({
    capability: effective,
    params: parsedParams.data,
    entryUrl,
    headless: options.headless ?? true,
    approveRisky: options.approveRisky ?? false,
    approveUnattended: options.approveUnattended ?? false,
  });
}
