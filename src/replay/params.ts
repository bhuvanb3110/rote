// Turns a Step's declarative ValueRef into the concrete string Surface.act() needs, and
// validates the caller supplied every required input before a browser is ever launched.
import type { Capability, Step } from "../artifact/index.js";

export function validateParams(capability: Capability, params: Record<string, unknown>): void {
  const missing = capability.inputs
    .filter((input) => input.required && params[input.name] === undefined)
    .map((input) => input.name);
  if (missing.length > 0) {
    throw new Error(`Missing required param(s): ${missing.join(", ")}.`);
  }
}

export function resolveStepValue(step: Step, params: Record<string, unknown>): string {
  const ref = step.value;
  if (!ref) {
    throw new Error(`Step "${step.id}" has no value to resolve.`);
  }
  if (ref.kind === "literal") {
    return ref.value;
  }
  const raw = params[ref.paramName];
  if (raw === undefined) {
    throw new Error(`Step "${step.id}" needs param "${ref.paramName}", which was not supplied.`);
  }
  return String(raw);
}
