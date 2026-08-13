// A saved artifact must parse or fail loudly: validate on both write and read, never trust
// bytes on disk (or an in-memory object) just because they happen to be well-formed JSON.
import { z } from "zod";
import { CapabilitySchema, type Capability } from "./schema.js";

export function serializeCapability(capability: Capability): string {
  const validated = CapabilitySchema.parse(capability);
  return JSON.stringify(validated, null, 2);
}

export function deserializeCapability(json: string): Capability {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(`Invalid Capability JSON: ${(err as Error).message}`);
  }
  const result = CapabilitySchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Capability failed schema validation:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
