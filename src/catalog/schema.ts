// Derives an agent-callable JSON Schema view of a Capability's typed contract directly from its
// own inputs/outputs -- never a second, hand-authored schema that could drift from the real one.
// inputsToZodSchema is reused for BOTH list()'s advertised inputSchema (via capabilityToJsonSchema
// below) and invoke()'s runtime param validation (src/catalog/invoke.ts), so the schema an agent
// is shown and the schema invoke actually enforces are provably the same object, not two
// definitions that can diverge.
import { z } from "zod";
import type { Capability, TypedOutput, TypedParam, TypedValueType } from "../artifact/index.js";

function zodForType(type: TypedValueType): z.ZodString | z.ZodNumber | z.ZodBoolean {
  switch (type) {
    case "string":
      return z.string();
    case "number":
      return z.number();
    case "boolean":
      return z.boolean();
  }
}

export function inputsToZodSchema(inputs: TypedParam[]): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const input of inputs) {
    const field = zodForType(input.type).describe(input.description);
    shape[input.name] = input.required ? field : field.optional();
  }
  return z.object(shape);
}

export function outputsToZodSchema(outputs: TypedOutput[]): z.ZodObject<Record<string, z.ZodTypeAny>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const output of outputs) {
    shape[output.name] = zodForType(output.type).describe(output.shape);
  }
  return z.object(shape);
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  /** Only present when a --tenant/?tenant= was requested AND an override exists for it. */
  tenant?: string;
  entryUrl?: string;
  /** "draft" refuses unattended invoke without approveUnattended -- see src/confidence/. */
  approvalStatus: "draft" | "approved";
}

export function capabilityToJsonSchema(
  capability: Capability,
): { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> } {
  return {
    inputSchema: z.toJSONSchema(inputsToZodSchema(capability.inputs)) as Record<string, unknown>,
    outputSchema: z.toJSONSchema(outputsToZodSchema(capability.outputs)) as Record<string, unknown>,
  };
}
